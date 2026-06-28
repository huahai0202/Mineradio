// ====================================================================
//  Mineradio · 落雪音乐 (LX Music) 音源适配
//  - 兼容 LX Music 自定义音源脚本规范 (globalThis.lx + inited/request 事件)
//  - 兼容 lx-music-api-server 系聚合 HTTP API (GET /url/{source}/{id}/{quality})
//  - 配置持久化到 .lx-source-config.json
//  - 不引入任何 npm 依赖, 全部用 Node 内置模块 (vm / https / fs / crypto)
// ====================================================================
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const https = require('https');
const http = require('http');
const crypto = require('crypto');

const CONFIG_FILE = process.env.LX_SOURCE_CONFIG_FILE || path.join(__dirname, '.lx-source-config.json');
const DEFAULT_API_TIMEOUT_MS = 12000;
const DEFAULT_SCRIPT_TIMEOUT_MS = 12000;

// LX 自定义源脚本规范常量
const LX_EVENT_NAMES = Object.freeze({
  request: 'request',
  inited: 'inited',
  updateAlert: 'updateAlert',
});
const LX_API_VERSION = '2.0.0';
const LX_ENV = 'desktop';

// Mineradio provider -> LX source code (LX 脚本使用 kw/kg/tx/wy/mg 两字母码)
const PROVIDER_TO_LX_SOURCE = {
  netease: 'wy',
  qq: 'tx',
  wy: 'wy',
  tx: 'tx',
  kw: 'kw',
  kg: 'kg',
  mg: 'mg',
};

// Mineradio quality -> LX quality 枚举 (128k / 320k / flac / flac24bit)
const QUALITY_TO_LX = {
  standard: '128k',
  exhigh: '320k',
  lossless: 'flac',
  hires: 'flac24bit',
  jymaster: 'flac24bit',
};

// LX 错误码 -> 友好提示 (来自 lx-music-api-server example.js 约定)
const LX_API_ERROR_MAP = {
  1: 'block ip',
  2: 'get music url failed',
  4: 'internal server error',
  5: 'too many requests',
  6: 'param error',
};

// ---------- 配置持久化 ----------
function defaultConfig() {
  return {
    enabled: false,
    mode: 'api',          // 'api' | 'script'
    apiUrl: '',
    apiKey: '',
    scriptUrl: '',        // 远程脚本 URL (可选)
    scriptCode: '',       // 本地粘贴的脚本代码 (可选, 优先级高于 scriptUrl)
    scriptName: '',
    defaultSource: 'wy',  // 默认 LX source code
    timeoutMs: 0,         // 0 表示用默认值
  };
}

function readConfig() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return defaultConfig();
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8').trim();
    if (!raw) return defaultConfig();
    const parsed = JSON.parse(raw);
    return Object.assign(defaultConfig(), parsed || {});
  } catch (e) {
    console.warn('[LX] config read failed:', e.message);
    return defaultConfig();
  }
}

function writeConfig(cfg) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  } catch (e) {
    console.warn('[LX] config write failed:', e.message);
  }
}

let config = readConfig();

// ---------- HTTP 工具 (供聚合 API 模式和脚本 request() 共用) ----------
function httpRequest(targetUrl, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(targetUrl); } catch (e) { reject(new Error('Invalid url: ' + targetUrl)); return; }
    const lib = u.protocol === 'https:' ? https : http;
    const headers = Object.assign({}, opts.headers || {});
    let body = null;
    if (opts.body != null) {
      body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
      if (!headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const method = (opts.method || 'GET').toUpperCase();
    const req = lib.request(u, { method, headers }, (response) => {
      const chunks = [];
      response.on('data', (c) => chunks.push(c));
      response.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({
          statusCode: response.statusCode || 0,
          headers: response.headers || {},
          body: buf.toString('utf8'),
          raw: buf,
        });
      });
    });
    const timeoutMs = Number(opts.timeoutMs) || (opts.timeoutMs === 0 ? 0 : DEFAULT_API_TIMEOUT_MS);
    if (timeoutMs > 0) {
      req.setTimeout(timeoutMs, () => req.destroy(new Error('Request timeout')));
    }
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// LX 脚本规范的 request() 是回调风格: request(url, options, cb)
// cb(err, resp), resp = { statusCode, headers, body, raw }
function lxRequestCallback(url, options, cb) {
  if (typeof options === 'function') { cb = options; options = {}; }
  if (typeof cb !== 'function') cb = function () {};
  // 脚本里经常不带 timeout, 用默认值
  const opts = Object.assign({}, options || {});
  if (!opts.timeoutMs) opts.timeoutMs = DEFAULT_API_TIMEOUT_MS;
  // 脚本里 body 可能是对象, 保留原样让 httpRequest 处理
  httpRequest(url, opts).then((resp) => {
    // LX 脚本期望 body 已经是解析好的对象 (如果 Content-Type 是 JSON) 或者字符串
    let parsedBody = resp.body;
    const ct = String((resp.headers && (resp.headers['content-type'] || resp.headers['Content-Type'])) || '').toLowerCase();
    if (ct.indexOf('application/json') >= 0 || ct.indexOf('text/json') >= 0) {
      try { parsedBody = JSON.parse(resp.body); } catch (e) { /* 保留字符串 */ }
    }
    cb(null, {
      statusCode: resp.statusCode,
      headers: resp.headers,
      body: parsedBody,
      raw: resp.raw,
    });
  }).catch((err) => cb(err));
}

// ---------- LX 脚本沙盒 ----------
let scriptState = {
  loaded: false,
  ready: false,
  sources: {},           // 脚本声明支持的 source -> { name, type, actions, qualitys }
  scriptName: '',
  scriptVersion: '',
  requestHandler: null,  // 脚本通过 on(EVENT_NAMES.request, handler) 注册的 handler
  lastError: '',
};

function parseScriptHeader(code) {
  const info = { name: '', description: '', version: '', author: '', homepage: '' };
  const head = String(code || '').slice(0, 4096);
  const nameMatch = head.match(/@name\s+(.+)/);
  const descMatch = head.match(/@description\s+(.+)/);
  const verMatch = head.match(/@version\s+([^\s]+)/);
  const authorMatch = head.match(/@author\s+(.+)/);
  const homeMatch = head.match(/@homepage\s+(\S+)/);
  if (nameMatch) info.name = nameMatch[1].trim();
  if (descMatch) info.description = descMatch[1].trim();
  if (verMatch) info.version = verMatch[1].trim();
  if (authorMatch) info.author = authorMatch[1].trim();
  if (homeMatch) info.homepage = homeMatch[1].trim();
  return info;
}

function resetScriptState() {
  scriptState = {
    loaded: false,
    ready: false,
    sources: {},
    scriptName: '',
    scriptVersion: '',
    requestHandler: null,
    lastError: '',
  };
}

// 构造 globalThis.lx 对象, 注入到 vm 沙盒
function buildLxRuntime(headerInfo) {
  const initedResolvers = [];
  let initedPayload = null;

  const lx = {
    version: LX_API_VERSION,
    env: LX_ENV,
    currentScriptInfo: headerInfo,
    EVENT_NAMES: LX_EVENT_NAMES,
    request: lxRequestCallback,
    utils: {
      crypto: {
        // 脚本偶尔会用到的 crypto 辅助
        md5: (text) => crypto.createHash('md5').update(String(text || '')).digest('hex'),
        sha256: (text) => crypto.createHash('sha256').update(String(text || '')).digest('hex'),
        randomBytes: (n) => crypto.randomBytes(Number(n) || 0),
      },
      buffer: {
        from: (data, enc) => Buffer.from(data, enc),
        bufToString: (buf, enc) => Buffer.from(buf).toString(enc || 'utf8'),
      },
    },
    on: (eventName, handler) => {
      if (eventName === LX_EVENT_NAMES.request) {
        if (typeof handler !== 'function') {
          scriptState.lastError = 'request handler is not a function';
          return;
        }
        scriptState.requestHandler = handler;
      }
      // 其他事件忽略 (updateAlert 等)
    },
    send: (eventName, payload) => {
      if (eventName === LX_EVENT_NAMES.inited) {
        initedPayload = payload;
        while (initedResolvers.length) {
          try { initedResolvers.shift()(payload); } catch (e) { /* ignore */ }
        }
      }
      // updateAlert 等忽略
    },
    // 桌面端 console 可用
    console: {
      log: (...args) => console.log('[LX-Script]', ...args),
      warn: (...args) => console.warn('[LX-Script]', ...args),
      error: (...args) => console.error('[LX-Script]', ...args),
      group: () => {},
      groupEnd: () => {},
    },
  };

  lx._waitForInited = () => new Promise((resolve) => {
    if (initedPayload) resolve(initedPayload);
    else initedResolvers.push(resolve);
  });

  return lx;
}

async function loadScriptCode() {
  // 优先 scriptCode (用户直接粘贴), 其次 scriptUrl (远程拉取)
  if (config.scriptCode && String(config.scriptCode).trim()) {
    return String(config.scriptCode);
  }
  if (config.scriptUrl && String(config.scriptUrl).trim()) {
    const url = String(config.scriptUrl).trim();
    const resp = await httpRequest(url, { method: 'GET', timeoutMs: DEFAULT_API_TIMEOUT_MS, headers: { 'User-Agent': 'Mineradio/LX-Source-Loader' } });
    if (resp.statusCode >= 400) throw new Error('HTTP ' + resp.statusCode + ' loading script from ' + url);
    return resp.body;
  }
  return '';
}

async function reloadScript() {
  resetScriptState();
  if (config.mode !== 'script') return { ok: true, skipped: true };
  let code;
  try {
    code = await loadScriptCode();
  } catch (e) {
    scriptState.lastError = e.message;
    throw new Error('脚本加载失败: ' + e.message);
  }
  if (!code || !code.trim()) {
    scriptState.lastError = '脚本内容为空';
    throw new Error('脚本内容为空, 请在设置里填入 scriptUrl 或直接粘贴 scriptCode');
  }

  const headerInfo = parseScriptHeader(code);
  const lx = buildLxRuntime(headerInfo);
  const sandbox = {
    lx,
    globalThis: lx,           // 脚本里既可能用 globalThis.lx 也可能直接用 lx
    console: lx.console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Buffer,
    URL,
    URLSearchParams,
    JSON,
    Math,
    Date,
    Object,
    Array,
    String,
    Number,
    Boolean,
    RegExp,
    Error,
    Promise,
    Map,
    Set,
    Symbol,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    encodeURIComponent,
    decodeURIComponent,
    encodeURI,
    decodeURI,
    // 部分脚本会用 btoa/atob
    btoa: (s) => Buffer.from(String(s), 'binary').toString('base64'),
    atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
  };
  // 让 sandbox.globalThis 指向 sandbox 自身 (脚本里 globalThis.lx 能取到)
  sandbox.globalThis = sandbox;

  try {
    const context = vm.createContext(sandbox);
    vm.runInContext(code, context, { filename: 'lx-source-script.js', timeout: 4000 });
    scriptState.loaded = true;
    scriptState.scriptName = headerInfo.name || config.scriptName || '未命名脚本';
    scriptState.scriptVersion = headerInfo.version || '';
  } catch (e) {
    scriptState.lastError = e.message;
    throw new Error('脚本执行失败: ' + e.message);
  }

  // 等待脚本 send(inited)
  try {
    const payload = await Promise.race([
      lx._waitForInited(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('脚本初始化超时 (未发送 inited 事件)')), 4000)),
    ]);
    const p = payload || {};
    if (p.status === false || p.status === 'failed') {
      scriptState.lastError = (p.message || '脚本初始化失败');
      throw new Error(scriptState.lastError);
    }
    scriptState.sources = (p.sources && typeof p.sources === 'object') ? p.sources : {};
    scriptState.ready = !!scriptState.requestHandler;
    if (!scriptState.ready) {
      scriptState.lastError = '脚本未注册 request 处理器';
    }
    return {
      ok: scriptState.ready,
      scriptName: scriptState.scriptName,
      scriptVersion: scriptState.scriptVersion,
      sources: scriptState.sources,
    };
  } catch (e) {
    scriptState.lastError = e.message;
    throw e;
  }
}

// ---------- 对外: 解析播放 URL ----------
function mapProviderToLxSource(provider) {
  const key = String(provider || '').toLowerCase();
  return PROVIDER_TO_LX_SOURCE[key] || config.defaultSource || 'wy';
}

function mapQualityToLx(quality) {
  const key = String(quality || '').toLowerCase();
  return QUALITY_TO_LX[key] || '320k';
}

function buildMusicInfo(song) {
  // LX 脚本期望 musicInfo.songmid (kw/tx/wy/mg) 或 musicInfo.hash (kg)
  song = song || {};
  const info = {
    songmid: String(song.songmid || song.mid || song.id || ''),
    hash: String(song.hash || song.songmid || song.mid || song.id || ''),
    name: song.name || song.title || '',
    singer: song.artist || song.singer || '',
    source: song.lxSource || mapProviderToLxSource(song.provider || song.source),
  };
  // 兜底: songmid 不能为空
  if (!info.songmid) info.songmid = info.hash;
  return info;
}

async function resolveMusicUrlViaScript(song, quality) {
  if (!scriptState.ready || !scriptState.requestHandler) {
    throw new Error('LX 脚本未就绪: ' + (scriptState.lastError || '未加载'));
  }
  const musicInfo = buildMusicInfo(song);
  if (!musicInfo.songmid) throw new Error('缺少 songmid, 无法调用 LX 脚本');
  const lxSource = musicInfo.source;
  const lxQuality = mapQualityToLx(quality);
  const sources = scriptState.sources || {};
  if (sources[lxSource]) {
    const qualitys = Array.isArray(sources[lxSource].qualitys) ? sources[lxSource].qualitys : [];
    if (qualitys.length && qualitys.indexOf(lxQuality) < 0) {
      // 降级到脚本支持的音质
      const fallback = ['flac24bit', 'flac', '320k', '128k'].find((q) => qualitys.indexOf(q) >= 0);
      if (fallback) musicInfo._qualityDowngrade = { from: lxQuality, to: fallback };
    }
  }
  const reqPayload = { source: lxSource, action: 'musicUrl', info: { type: lxQuality, musicInfo } };
  let result;
  try {
    const ret = await Promise.race([
      Promise.resolve(scriptState.requestHandler(reqPayload)),
      new Promise((_, reject) => setTimeout(() => reject(new Error('脚本 musicUrl 超时')), DEFAULT_SCRIPT_TIMEOUT_MS)),
    ]);
    result = ret;
  } catch (e) {
    throw new Error('LX 脚本取链失败: ' + e.message);
  }
  if (typeof result === 'string' && result) return { url: result, quality: lxQuality, source: lxSource };
  if (result && typeof result === 'object' && result.url) return { url: String(result.url), quality: lxQuality, source: lxSource };
  throw new Error('LX 脚本未返回有效 URL');
}

async function resolveMusicUrlViaApi(song, quality) {
  if (!config.apiUrl) throw new Error('未配置聚合 API URL');
  const lxSource = mapProviderToLxSource(song.provider || song.source);
  const lxQuality = mapQualityToLx(quality);
  const songId = String(song.songmid || song.mid || song.id || '').trim();
  if (!songId) throw new Error('缺少 song id, 无法调用聚合 API');
  const base = config.apiUrl.replace(/\/+$/, '');
  const u = base + '/url/' + encodeURIComponent(lxSource) + '/' + encodeURIComponent(songId) + '/' + encodeURIComponent(lxQuality);
  const headers = { 'User-Agent': 'Mineradio/LX-API-Client' };
  if (config.apiKey) headers['X-Request-Key'] = config.apiKey;
  const resp = await httpRequest(u, { method: 'GET', headers, timeoutMs: Number(config.timeoutMs) || DEFAULT_API_TIMEOUT_MS });
  let body;
  try { body = JSON.parse(resp.body); } catch (e) {
    throw new Error('聚合 API 返回非 JSON (HTTP ' + resp.statusCode + '): ' + String(resp.body).slice(0, 200));
  }
  if (body && typeof body === 'object' && body.code === 0 && body.url) {
    return { url: String(body.url), quality: lxQuality, source: lxSource };
  }
  const code = Number(body && body.code);
  const reason = (code && LX_API_ERROR_MAP[code]) || (body && body.msg) || 'unknown error';
  throw new Error('聚合 API 取链失败: ' + reason + ' (code=' + (code || '?)') + ')');
}

// 主入口: 解析播放 URL
async function resolveMusicUrl(song, quality) {
  if (!config.enabled) throw new Error('LX 源未启用');
  if (config.mode === 'script') return resolveMusicUrlViaScript(song, quality);
  return resolveMusicUrlViaApi(song, quality);
}

// ---------- 对外: 状态 / 配置 ----------
function getStatus() {
  return {
    provider: 'lx',
    enabled: !!config.enabled,
    mode: config.mode,
    ready: config.mode === 'script' ? scriptState.ready : (!!config.apiUrl),
    scriptName: scriptState.scriptName || config.scriptName || '',
    scriptVersion: scriptState.scriptVersion,
    sources: scriptState.sources || {},
    apiUrl: config.apiUrl ? maskUrl(config.apiUrl) : '',
    apiKeyConfigured: !!config.apiKey,
    scriptUrl: config.scriptUrl || '',
    scriptCodeConfigured: !!config.scriptCode,
    defaultSource: config.defaultSource,
    lastError: scriptState.lastError || '',
  };
}

function maskUrl(url) {
  try {
    const u = new URL(url);
    return u.origin + u.pathname.replace(/\/+$/, '');
  } catch (e) {
    return String(url || '').slice(0, 32);
  }
}

function maskConfigForClient() {
  return {
    enabled: !!config.enabled,
    mode: config.mode,
    apiUrl: config.apiUrl || '',
    apiKey: config.apiKey ? '••••••' + String(config.apiKey).slice(-4) : '',
    apiKeyConfigured: !!config.apiKey,
    scriptUrl: config.scriptUrl || '',
    scriptCode: config.scriptCode || '',
    scriptCodeConfigured: !!config.scriptCode,
    scriptName: scriptState.scriptName || config.scriptName || '',
    defaultSource: config.defaultSource || 'wy',
    timeoutMs: Number(config.timeoutMs) || 0,
  };
}

async function applyConfigUpdate(input) {
  input = input || {};
  const next = Object.assign({}, config);
  if (typeof input.enabled === 'boolean') next.enabled = input.enabled;
  if (input.mode === 'api' || input.mode === 'script') next.mode = input.mode;
  if (typeof input.apiUrl === 'string') next.apiUrl = input.apiUrl.trim();
  if (typeof input.apiKey === 'string') {
    // "••••••" 前缀表示用户没改 key, 保留原值
    if (!input.apiKey || !/^•+/.test(input.apiKey)) next.apiKey = input.apiKey.trim();
  }
  if (typeof input.scriptUrl === 'string') next.scriptUrl = input.scriptUrl.trim();
  if (typeof input.scriptCode === 'string') next.scriptCode = input.scriptCode;
  if (typeof input.scriptName === 'string') next.scriptName = input.scriptName.trim();
  if (typeof input.defaultSource === 'string' && PROVIDER_TO_LX_SOURCE[input.defaultSource.toLowerCase()]) {
    next.defaultSource = PROVIDER_TO_LX_SOURCE[input.defaultSource.toLowerCase()];
  } else if (typeof input.defaultSource === 'string' && ['kw', 'kg', 'tx', 'wy', 'mg'].indexOf(input.defaultSource) >= 0) {
    next.defaultSource = input.defaultSource;
  }
  if (input.timeoutMs != null) {
    const t = Number(input.timeoutMs);
    next.timeoutMs = Number.isFinite(t) && t >= 0 ? t : 0;
  }
  config = next;
  writeConfig(config);
  // 脚本模式需要重新加载
  if (config.enabled && config.mode === 'script') {
    try {
      const r = await reloadScript();
      return { ok: true, status: getStatus(), scriptLoad: r };
    } catch (e) {
      return { ok: false, status: getStatus(), error: e.message };
    }
  } else {
    resetScriptState();
    if (config.mode === 'script' && config.scriptName) scriptState.scriptName = config.scriptName;
    return { ok: true, status: getStatus() };
  }
}

async function testSource(input) {
  // 用一个最小 songmid 测试当前配置是否能取到 URL
  const testSong = {
    provider: 'netease',
    source: 'netease',
    id: String((input && input.id) || '1493812858'),  // 默认用一个公开的网易云 songmid
    songmid: String((input && input.id) || '1493812858'),
    name: 'LX Test',
    artist: 'Mineradio',
  };
  const quality = (input && input.quality) || '320k';
  try {
    const r = await resolveMusicUrl(testSong, quality);
    return { ok: true, url: r.url, quality: r.quality, source: r.source };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// 启动时如果是脚本模式且已启用, 尝试预加载
function initOnStartup() {
  if (config.enabled && config.mode === 'script') {
    reloadScript().then(() => {
      console.log('[LX] script loaded:', scriptState.scriptName, 'ready:', scriptState.ready);
    }).catch((e) => {
      console.warn('[LX] script load failed on startup:', e.message);
    });
  }
}

module.exports = {
  config,
  getStatus,
  maskConfigForClient,
  applyConfigUpdate,
  resolveMusicUrl,
  testSource,
  reloadScript,
  mapProviderToLxSource,
  mapQualityToLx,
  initOnStartup,
  // 暴露内部函数方便排查
  _internal: { readConfig, writeConfig },
};

// 自动初始化 (require 时即执行)
initOnStartup();
