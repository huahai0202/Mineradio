// ====================================================================
//  粒子音乐可视化播放器 — Server v2
//  - 网易云搜索 / 歌曲URL / 封面/音频代理
//  - 扫码登录 (login_qr_*) + cookie 持久化 (./.cookie)
//  - 试听检测 (freeTrialInfo) + 全 quality 探测
//  - 所有受保护 API 都会带上已登录用户的 cookie
// ====================================================================
const {
  search,
  cloudsearch,
  song_detail,
  song_url,
  song_url_v1,
  login_qr_key,
  login_qr_create,
  login_qr_check,
  login_status,
  logout,
  user_account,
  user_playlist,
  comment_music,
  artist_detail,
  artist_top_song,
  artist_songs,
  like: like_song,
  likelist,
  song_like_check,
  playlist_tracks,
  playlist_track_add,
  playlist_create,
  playlist_detail,
  playlist_track_all,
  personalized,
  recommend_resource,
  recommend_songs,
  dj_detail,
  dj_program,
  dj_hot,
  dj_sublist,
  user_audio,
  dj_paygift,
  record_recent_voice,
  sati_resource_sub_list,
  lyric,
  lyric_new,
} = require('NeteaseCloudMusicApi');
const http = require('http');
const https = require('https');
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const tls = require('tls');
const vm = require('vm');
const zlib = require('zlib');
const util = require('util');
const iconv = require('iconv-lite');
const { once } = require('events');
const { fileURLToPath } = require('url');
const { execFileSync } = require('child_process');
const { analyzePodcastDjStream, analyzePodcastDjIntro } = require('./dj-analyzer');

function configureWindowsConsoleEncoding() {
  if (process.platform !== 'win32' || process.env.MINERADIO_SKIP_CONSOLE_UTF8 === '1') return;
  try {
    if (process.stdout && process.stdout.setDefaultEncoding) process.stdout.setDefaultEncoding('utf8');
    if (process.stderr && process.stderr.setDefaultEncoding) process.stderr.setDefaultEncoding('utf8');
  } catch (e) {}
  try {
    execFileSync('cmd.exe', ['/d', '/s', '/c', 'chcp 65001 >NUL'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } catch (e) {}
}

function installWindowsPipeConsoleEncoding() {
  if (process.platform !== 'win32') return;
  const configured = String(process.env.MINERADIO_CONSOLE_ENCODING || '').trim().toLowerCase();
  const wantsGbk = configured === 'gbk' || configured === 'cp936' || configured === 'gb18030';
  const wantsUtf8 = configured === 'utf8' || configured === 'utf-8';
  if (wantsUtf8) return;
  if (!wantsGbk && process.stdout && process.stdout.isTTY && process.stderr && process.stderr.isTTY) return;
  const encoding = wantsGbk ? 'gb18030' : 'gb18030';
  function write(stream, fallback, args) {
    const line = util.format(...args) + '\n';
    try {
      stream.write(iconv.encode(line, encoding));
    } catch (e) {
      fallback(...args);
    }
  }
  const originalLog = console.log.bind(console);
  const originalInfo = console.info.bind(console);
  const originalWarn = console.warn.bind(console);
  const originalError = console.error.bind(console);
  console.log = (...args) => write(process.stdout, originalLog, args);
  console.info = (...args) => write(process.stdout, originalInfo, args);
  console.warn = (...args) => write(process.stderr, originalWarn, args);
  console.error = (...args) => write(process.stderr, originalError, args);
}

configureWindowsConsoleEncoding();
installWindowsPipeConsoleEncoding();

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const COOKIE_FILE = process.env.COOKIE_FILE || path.join(__dirname, '.cookie');
const QQ_COOKIE_FILE = process.env.QQ_COOKIE_FILE || path.join(__dirname, '.qq-cookie');
const LX_SOURCE_FILE = process.env.MINERADIO_LX_SOURCE_FILE || '';
const UPDATE_WORK_DIR = process.env.MINERADIO_UPDATE_DIR || path.join(__dirname, 'updates');
const UPDATE_DOWNLOAD_DIR = process.env.MINERADIO_UPDATE_DOWNLOAD_DIR || path.join(UPDATE_WORK_DIR, 'downloads');
const UPDATE_PATCH_BACKUP_DIR = process.env.MINERADIO_PATCH_BACKUP_DIR || path.join(UPDATE_WORK_DIR, 'backups', 'patches');
const BEATMAP_CACHE_DIR = process.env.MINERADIO_BEAT_CACHE_DIR || 'D:\\MineradioCache\\beatmaps';
const AUDIO_CACHE_DIR = process.env.MINERADIO_AUDIO_CACHE_DIR || 'D:\\MineradioCache\\audio';
const APP_PACKAGE = readPackageInfo();
const APP_VERSION = process.env.MINERADIO_VERSION || APP_PACKAGE.version || '0.9.11';
const APP_DISPLAY_NAME = APP_PACKAGE.productName || 'Mineradio';
const APP_ARTIFACT_PREFIX = APP_DISPLAY_NAME.replace(/\s+/g, '-');
const UPDATE_CONFIG = readUpdateConfig(APP_PACKAGE);
const PATCH_MAX_BYTES = 12 * 1024 * 1024;
const PATCH_ALLOWED_ROOTS = new Set(['public', 'desktop', 'build']);
const PATCH_ALLOWED_FILES = new Set(['server.js', 'dj-analyzer.js', 'package.json', 'package-lock.json']);
const UPDATE_FALLBACK_NOTES = [
  '电影镜头节奏更松',
  '音源失败自动换源',
  '右上角更新提示',
];
const OPEN_METEO_FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const OPEN_METEO_GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const WEATHER_IP_LOCATION_URL = 'http://ip-api.com/json/';
const WEATHER_DEFAULT_LOCATION = {
  name: '上海',
  country: 'China',
  latitude: 31.2304,
  longitude: 121.4737,
  timezone: 'Asia/Shanghai',
};

const updateDownloadJobs = new Map();

function applySystemCertificateAuthorities() {
  try {
    if (typeof tls.getCACertificates !== 'function' || typeof tls.setDefaultCACertificates !== 'function') return;
    const bundled = tls.getCACertificates('default') || [];
    const system = tls.getCACertificates('system') || [];
    if (!system.length) return;
    const seen = new Set();
    const merged = [];
    bundled.concat(system).forEach(cert => {
      if (!cert || seen.has(cert)) return;
      seen.add(cert);
      merged.push(cert);
    });
    if (merged.length > bundled.length) tls.setDefaultCACertificates(merged);
  } catch (e) {
    console.warn('[TLS] system CA merge skipped:', e.message);
  }
}

applySystemCertificateAuthorities();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.ico':  'image/x-icon',
  '.svg':  'image/svg+xml',
};

// ---------- Cookie 持久化 ----------
const COOKIE_ATTRIBUTE_NAMES = new Set(['path', 'domain', 'expires', 'max-age', 'samesite', 'secure', 'httponly']);
function collectCookiePair(picked, key, value) {
  key = String(key || '').trim();
  if (!key || COOKIE_ATTRIBUTE_NAMES.has(key.toLowerCase())) return;
  if (value === null || value === undefined) return;
  picked.set(key, String(value).trim());
}
function collectCookieInput(input, picked) {
  if (input === null || input === undefined) return;
  if (Array.isArray(input)) {
    input.forEach(item => collectCookieInput(item, picked));
    return;
  }
  if (typeof input === 'object') {
    if (input.name && Object.prototype.hasOwnProperty.call(input, 'value')) {
      collectCookiePair(picked, input.name, input.value);
      return;
    }
    Object.keys(input).forEach(key => {
      const value = input[key];
      if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'value')) {
        collectCookiePair(picked, key, value.value);
      } else if (typeof value !== 'object') {
        collectCookiePair(picked, key, value);
      }
    });
    return;
  }
  String(input).split(/\r?\n/).forEach(line => {
    line.split(';').forEach(part => {
      const raw = String(part || '').trim();
      const idx = raw.indexOf('=');
      if (idx <= 0) return;
      collectCookiePair(picked, raw.slice(0, idx), raw.slice(idx + 1));
    });
  });
}
function normalizeCookieHeader(input) {
  const picked = new Map();
  collectCookieInput(input, picked);
  return Array.from(picked.entries())
    .filter(([key, value]) => key && value != null && String(value) !== '')
    .map(([key, value]) => `${key}=${value}`)
    .join('; ');
}
function rawCookieFallback(input) {
  if (typeof input === 'string') return input.trim();
  if (Array.isArray(input) && input.every(item => typeof item === 'string')) return input.join('; ').trim();
  return '';
}
let userCookie = '';
try { if (fs.existsSync(COOKIE_FILE)) userCookie = fs.readFileSync(COOKIE_FILE, 'utf8').trim(); }
catch (e) { userCookie = ''; }
function saveCookie(c) {
  userCookie = normalizeCookieHeader(c) || rawCookieFallback(c);
  try { fs.writeFileSync(COOKIE_FILE, userCookie); } catch (e) {}
}

let qqCookie = '';
try { if (fs.existsSync(QQ_COOKIE_FILE)) qqCookie = fs.readFileSync(QQ_COOKIE_FILE, 'utf8').trim(); }
catch (e) { qqCookie = ''; }
function saveQQCookie(c) {
  qqCookie = normalizeCookieHeader(c) || rawCookieFallback(c);
  try { fs.writeFileSync(QQ_COOKIE_FILE, qqCookie); } catch (e) {}
}

// ---------- 工具 ----------
function serveStatic(res, filePath) {
  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(data);
  });
}
function sendJSON(res, data, status) {
  res.writeHead(status || 200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
  });
  res.end(JSON.stringify(data));
}
function readPackageInfo() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return {};
  }
}
function parseGitHubRepository(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const direct = raw.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (direct) return { owner: direct[1], repo: direct[2].replace(/\.git$/i, '') };
  const github = raw.match(/github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[#/?].*)?$/i);
  if (github) return { owner: github[1], repo: github[2].replace(/\.git$/i, '') };
  return null;
}
function readUpdateConfig(pkg) {
  const local = (pkg && pkg.mineradio && pkg.mineradio.update) || {};
  const repoHint = process.env.MINERADIO_UPDATE_REPOSITORY
    || process.env.GITHUB_REPOSITORY
    || local.repository
    || local.github
    || (pkg && pkg.repository && (pkg.repository.url || pkg.repository))
    || '';
  const parsed = parseGitHubRepository(repoHint) || {};
  const owner = process.env.MINERADIO_UPDATE_OWNER || local.owner || parsed.owner || '';
  const repo = process.env.MINERADIO_UPDATE_REPO || local.repo || parsed.repo || '';
  return {
    provider: local.provider || 'github',
    owner,
    repo,
    configured: !!(owner && repo),
    preview: local.preview !== false,
    preferMirrors: local.preferMirrors !== false,
    mirrors: readUpdateMirrors(local),
    manifest: process.env.MINERADIO_UPDATE_MANIFEST
      || process.env.MINERADIO_UPDATE_MANIFEST_URL
      || process.env.MINERADIO_UPDATE_MANIFEST_FILE
      || '',
  };
}
function parseUpdateMirrorList(value) {
  if (Array.isArray(value)) return value;
  return String(value || '').split(/[\n,;]/);
}
function readUpdateMirrors(local) {
  const envMirrors = process.env.MINERADIO_UPDATE_MIRRORS || process.env.MINERADIO_UPDATE_MIRROR || '';
  const raw = envMirrors
    ? parseUpdateMirrorList(envMirrors)
    : parseUpdateMirrorList(local.mirrors || local.downloadMirrors || []);
  const seen = new Set();
  const mirrors = [];
  raw.forEach(item => {
    const url = String(item || '').trim();
    if (!/^https?:\/\//i.test(url)) return;
    const key = url.replace(/\/+$/, '').toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    mirrors.push(url);
  });
  return mirrors.slice(0, 6);
}
function normalizeDigest(value, algorithm) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const prefix = new RegExp('^' + algorithm + ':', 'i');
  return raw.replace(prefix, '').trim().replace(/^['"]|['"]$/g, '');
}
function assetDigestInfo(asset) {
  const digest = String(asset && asset.digest || '').trim();
  return {
    sha256: normalizeDigest((asset && asset.sha256) || (/^sha256:/i.test(digest) ? digest : ''), 'sha256').toLowerCase(),
    sha512: normalizeDigest((asset && asset.sha512) || (/^sha512:/i.test(digest) ? digest : ''), 'sha512'),
  };
}
function buildMirrorUrl(originalUrl, mirror) {
  const source = String(originalUrl || '').trim();
  const base = String(mirror || '').trim();
  if (!/^https?:\/\//i.test(source) || !/^https?:\/\//i.test(base)) return '';
  if (base.includes('{encodedUrl}')) return base.replace(/\{encodedUrl\}/g, encodeURIComponent(source));
  if (base.includes('{url}')) return base.replace(/\{url\}/g, source);
  return base.replace(/\/+$/, '/') + source;
}
function uniqueDownloadCandidates(urls, opts) {
  opts = opts || {};
  const directUrls = (Array.isArray(urls) ? urls : [urls])
    .map(url => String(url || '').trim())
    .filter(url => /^https?:\/\//i.test(url));
  const directSet = new Set(directUrls.map(url => url.toLowerCase()));
  const mirrors = opts.useMirrors === false ? [] : (UPDATE_CONFIG.mirrors || []);
  const mirrored = [];
  directUrls.forEach(source => {
    mirrors.forEach((mirror, index) => {
      const url = buildMirrorUrl(source, mirror);
      if (url) mirrored.push({
        url,
        label: '国内加速线路 ' + (index + 1),
        mirrored: true,
      });
    });
  });
  const direct = directUrls.map(url => ({
    url,
    label: directSet.has(url.toLowerCase()) ? 'GitHub 直连' : '下载线路',
    mirrored: false,
  }));
  const ordered = UPDATE_CONFIG.preferMirrors === false ? direct.concat(mirrored) : mirrored.concat(direct);
  const seen = new Set();
  return ordered.filter(item => {
    const key = item.url.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function publicDownloadUrls(candidates) {
  return (Array.isArray(candidates) ? candidates : [])
    .map(item => item && item.url)
    .filter(Boolean);
}
function normalizeVersion(value) {
  return String(value || '').trim().replace(/^v/i, '').replace(/[+].*$/, '').replace(/-.+$/, '');
}
function compareVersions(a, b) {
  const aa = normalizeVersion(a).split('.').map(n => parseInt(n, 10) || 0);
  const bb = normalizeVersion(b).split('.').map(n => parseInt(n, 10) || 0);
  const len = Math.max(aa.length, bb.length, 3);
  for (let i = 0; i < len; i++) {
    const left = aa[i] || 0;
    const right = bb[i] || 0;
    if (left > right) return 1;
    if (left < right) return -1;
  }
  return 0;
}
function cleanReleaseLine(line) {
  return String(line || '')
    .replace(/^\s*#{1,6}\s*/, '')
    .replace(/^\s*[-*]\s+/, '')
    .replace(/^\s*\d+[.)]\s+/, '')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .trim();
}
function extractReleaseNotes(body) {
  const notes = [];
  String(body || '').split(/\r?\n/).forEach(line => {
    const text = cleanReleaseLine(line);
    if (!text) return;
    if (/^(what'?s changed|changes|changelog|full changelog|更新日志)$/i.test(text)) return;
    if (/^https?:\/\//i.test(text)) return;
    if (text.length > 72) return;
    notes.push(text);
  });
  return notes.slice(0, 4);
}
function pickReleaseAsset(assets) {
  const list = Array.isArray(assets) ? assets : [];
  const preferred = list.find(a => /\.(exe|msi)$/i.test(a && a.name || ''))
    || list.find(a => /\.(zip|7z)$/i.test(a && a.name || ''))
    || list[0];
  if (!preferred) return null;
  const digest = assetDigestInfo(preferred);
  const candidates = uniqueDownloadCandidates(preferred.browser_download_url || '');
  return {
    name: preferred.name || '',
    size: preferred.size || 0,
    contentType: preferred.content_type || '',
    downloadUrl: preferred.browser_download_url || '',
    downloadUrls: publicDownloadUrls(candidates),
    sha256: digest.sha256 || '',
    sha512: digest.sha512 || '',
  };
}
function patchAssetVersions(name) {
  const matches = String(name || '').match(/\d+(?:[._-]\d+){1,3}/g) || [];
  return matches.map(item => normalizeVersion(item.replace(/[._-]/g, '.'))).filter(Boolean);
}
function pickPatchAsset(assets, currentVersion, latestVersion) {
  const list = Array.isArray(assets) ? assets : [];
  const current = normalizeVersion(currentVersion || APP_VERSION);
  const latest = normalizeVersion(latestVersion || '');
  const preferred = list.find(a => {
    const name = String(a && a.name || '');
    if (!/\.(patch\.json|patch|json)$/i.test(name)) return false;
    const versions = patchAssetVersions(name);
    if (latest) return versions[0] === current && versions[versions.length - 1] === latest;
    return versions[0] === current && name.toLowerCase().includes('patch');
  }) || list.find(a => {
    const name = String(a && a.name || '');
    if (!/\.(patch\.json|patch|json)$/i.test(name)) return false;
    const versions = patchAssetVersions(name);
    return versions[0] === current && name.toLowerCase().includes('patch');
  }) || list.find(a => /\.(patch\.json|patch)$/i.test(a && a.name || ''));
  if (!preferred) return null;
  const digest = assetDigestInfo(preferred);
  const candidates = uniqueDownloadCandidates(preferred.browser_download_url || '');
  return {
    name: preferred.name || '',
    size: preferred.size || 0,
    contentType: preferred.content_type || '',
    downloadUrl: preferred.browser_download_url || '',
    downloadUrls: publicDownloadUrls(candidates),
    sha256: digest.sha256 || '',
    sha512: digest.sha512 || '',
  };
}
function updateAssetNameFromUrl(value) {
  try {
    const u = new URL(String(value || ''));
    const base = path.basename(decodeURIComponent(u.pathname || ''));
    if (base) return base;
  } catch (_) {}
  return path.basename(String(value || '').split('?')[0]) || '';
}
function normalizeManifestUpdateInfo(data) {
  data = data || {};
  const release = data.release || {};
  const asset = release.asset || data.asset || {};
  const latestVersion = normalizeVersion(
    data.latestVersion
    || data.version
    || release.version
    || release.tagName
    || release.tag_name
    || release.name
    || APP_VERSION
  ) || APP_VERSION;
  const downloadUrl = release.downloadUrl || data.downloadUrl || asset.downloadUrl || asset.browser_download_url || '';
  const patch = release.patch || data.patch || null;
  const assetUrls = [downloadUrl].concat(Array.isArray(asset.downloadUrls) ? asset.downloadUrls : []);
  const patchUrls = patch ? [patch.downloadUrl].concat(Array.isArray(patch.downloadUrls) ? patch.downloadUrls : []) : [];
  const patchInfo = patch && patch.downloadUrl ? {
    name: patch.name || updateAssetNameFromUrl(patch.downloadUrl) || `${APP_ARTIFACT_PREFIX}-${APP_VERSION}→${latestVersion}.patch.json`,
    size: Number(patch.size || 0) || 0,
    contentType: patch.contentType || patch.content_type || 'application/json',
    downloadUrl: patch.downloadUrl,
    downloadUrls: publicDownloadUrls(uniqueDownloadCandidates(patchUrls)),
    from: normalizeVersion(patch.from || APP_VERSION),
    to: normalizeVersion(patch.to || latestVersion),
    sha256: normalizeDigest(patch.sha256 || '', 'sha256').toLowerCase(),
    sha512: normalizeDigest(patch.sha512 || '', 'sha512'),
  } : null;
  const notes = Array.isArray(release.notes) && release.notes.length
    ? release.notes.slice(0, 4).map(cleanReleaseLine).filter(Boolean)
    : (extractReleaseNotes(release.body || data.body).length ? extractReleaseNotes(release.body || data.body) : UPDATE_FALLBACK_NOTES);
  const assetInfo = downloadUrl ? {
    name: asset.name || updateAssetNameFromUrl(downloadUrl) || `${APP_ARTIFACT_PREFIX}-${latestVersion}-Setup.exe`,
    size: Number(asset.size || 0) || 0,
    contentType: asset.contentType || asset.content_type || '',
    downloadUrl,
    downloadUrls: publicDownloadUrls(uniqueDownloadCandidates(assetUrls)),
    sha256: normalizeDigest(asset.sha256 || '', 'sha256').toLowerCase(),
    sha512: normalizeDigest(asset.sha512 || release.sha512 || data.sha512 || '', 'sha512'),
  } : null;
  return {
    configured: true,
    preview: false,
    updateAvailable: data.updateAvailable != null ? !!data.updateAvailable : compareVersions(latestVersion, APP_VERSION) > 0,
    currentVersion: APP_VERSION,
    latestVersion,
    release: {
      tagName: release.tagName || release.tag_name || data.tagName || ('v' + latestVersion),
      name: release.name || data.name || (APP_DISPLAY_NAME + ' v' + latestVersion),
      version: latestVersion,
      publishedAt: release.publishedAt || release.published_at || data.publishedAt || '',
      htmlUrl: release.htmlUrl || release.html_url || data.htmlUrl || '',
      downloadUrl,
      asset: assetInfo,
      patch: patchInfo,
      patchAvailable: !!(patchInfo && patchInfo.downloadUrl && compareVersions(latestVersion, APP_VERSION) > 0),
      summary: release.summary || data.summary || notes[0] || '发现新版本，建议更新。',
      notes,
    },
    source: 'manifest',
  };
}
async function readUpdateManifest(ref) {
  const value = String(ref || '').trim();
  if (!value) throw new Error('UPDATE_MANIFEST_MISSING');
  if (/^https?:\/\//i.test(value)) {
    const resp = await fetch(value, {
      headers: { 'User-Agent': `Mineradio/${APP_VERSION}` },
    });
    if (!resp.ok) throw new Error('Update manifest ' + resp.status);
    return resp.json();
  }
  const file = /^file:/i.test(value) ? fileURLToPath(value) : path.resolve(value);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
async function fetchManifestUpdateInfo(ref) {
  try {
    const data = await readUpdateManifest(ref);
    return normalizeManifestUpdateInfo(data);
  } catch (err) {
    return localUpdateFallback(err.message || 'Update manifest failed', { configured: true });
  }
}
function beatCacheRootInfo() {
  const dir = path.resolve(BEATMAP_CACHE_DIR);
  const root = path.parse(dir).root;
  const drive = root ? root.replace(/[\\\/]+$/, '').toUpperCase() : '';
  const allowed = !!root && !/^C:$/i.test(drive);
  const available = allowed && fs.existsSync(root);
  return { dir, root, drive, allowed, available };
}
function ensureBeatMapCacheDir() {
  const info = beatCacheRootInfo();
  if (!info.allowed) {
    const err = new Error('BEAT_CACHE_ON_C_DRIVE_DISABLED');
    err.code = 'BEAT_CACHE_ON_C_DRIVE_DISABLED';
    err.info = info;
    throw err;
  }
  if (!info.available) {
    const err = new Error('BEAT_CACHE_DRIVE_UNAVAILABLE');
    err.code = 'BEAT_CACHE_DRIVE_UNAVAILABLE';
    err.info = info;
    throw err;
  }
  fs.mkdirSync(info.dir, { recursive: true });
  return info.dir;
}
function safeBeatMapCacheFile(key) {
  const raw = String(key || '').trim();
  if (!raw || raw.length > 240) return null;
  const hash = crypto.createHash('sha1').update(raw).digest('hex');
  const label = raw.replace(/[^a-z0-9_.-]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'beatmap';
  return path.join(ensureBeatMapCacheDir(), `${label}-${hash}.json`);
}
function compactBeatMapCachePayload(body) {
  const key = String(body && body.key || '').trim();
  const map = body && body.map;
  if (!key || !map || typeof map !== 'object') return null;
  return {
    v: 1,
    key,
    savedAt: Date.now(),
    meta: {
      provider: String(body.provider || '').slice(0, 32),
      title: String(body.title || '').slice(0, 160),
      artist: String(body.artist || '').slice(0, 160),
      mode: String(body.mode || 'mr').slice(0, 32),
    },
    map,
  };
}
function readBeatMapCache(key) {
  const file = safeBeatMapCacheFile(key);
  if (!file || !fs.existsSync(file)) return null;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return raw && raw.map ? raw : null;
}
function writeBeatMapCache(body) {
  const payload = compactBeatMapCachePayload(body);
  if (!payload) return { ok: false, error: 'INVALID_BEATMAP_CACHE_PAYLOAD' };
  const file = safeBeatMapCacheFile(payload.key);
  if (!file) return { ok: false, error: 'INVALID_BEATMAP_CACHE_KEY' };
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(payload));
  fs.renameSync(tmp, file);
  return { ok: true, key: payload.key, savedAt: payload.savedAt, dir: path.dirname(file) };
}

function audioCacheRootInfo() {
  const dir = path.resolve(AUDIO_CACHE_DIR);
  const root = path.parse(dir).root;
  const drive = root ? root.replace(/[\\\/]+$/, '').toUpperCase() : '';
  const allowed = !!root && !/^C:$/i.test(drive);
  const available = allowed && fs.existsSync(root);
  return { dir, root, drive, allowed, available };
}

function ensureAudioCacheDir() {
  const info = audioCacheRootInfo();
  if (!info.allowed) {
    const err = new Error('AUDIO_CACHE_ON_C_DRIVE_DISABLED');
    err.code = 'AUDIO_CACHE_ON_C_DRIVE_DISABLED';
    err.info = info;
    throw err;
  }
  if (!fs.existsSync(info.root)) {
    const err = new Error('AUDIO_CACHE_DRIVE_UNAVAILABLE');
    err.code = 'AUDIO_CACHE_DRIVE_UNAVAILABLE';
    err.info = info;
    throw err;
  }
  fs.mkdirSync(info.dir, { recursive: true });
  return info.dir;
}

function cleanAudioCacheText(value, fallback) {
  const text = stripHtmlTags(value || fallback || '')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, 80);
}

function audioCacheStableSongKey(audioUrl, meta) {
  meta = meta || {};
  const id = cleanAudioCacheText(meta.songId || meta.musicId || meta.id || '', '');
  if (id) return 'id:' + id;
  const title = cleanAudioCacheText(meta.title || meta.name, '');
  const artist = cleanAudioCacheText(meta.artist || meta.singer, '');
  const album = cleanAudioCacheText(meta.album, '');
  if (!title && !artist && !album) return 'url:' + String(audioUrl || '');
  return [
    'meta',
    title,
    artist,
    album,
  ].join('|');
}

function audioCacheSourceKey(meta) {
  meta = meta || {};
  return cleanAudioCacheText(meta.sourceKey || meta.sourceId || meta.provider || meta.source || '', '');
}

function audioCacheQualityKey(meta) {
  meta = meta || {};
  return cleanAudioCacheText(meta.qualityKey || meta.quality || meta.level || '', '');
}

function audioCacheBaseIdentity(audioUrl, meta) {
  meta = meta || {};
  return [
    'audio-cache-v2',
    cleanAudioCacheText(meta.provider || '', ''),
    audioCacheSourceKey(meta),
    audioCacheStableSongKey(audioUrl, meta),
    audioCacheQualityKey(meta),
  ].join('\n');
}

function audioCacheFormat(audioUrl, contentType) {
  return audioCacheExt(audioUrl, contentType).replace(/^\./, '') || 'bin';
}

function audioCacheIdentity(audioUrl, meta, contentType) {
  return audioCacheBaseIdentity(audioUrl, meta) + '\nformat:' + audioCacheFormat(audioUrl, contentType);
}

function audioCacheExt(audioUrl, contentType) {
  const fromUrl = String(audioUrl || '').split('?')[0].match(/\.(mp3|flac|m4a|mp4|aac|ogg|opus|wav|ape)$/i);
  if (fromUrl) return '.' + fromUrl[1].toLowerCase();
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('flac')) return '.flac';
  if (ct.includes('mpeg')) return '.mp3';
  if (ct.includes('mp4')) return '.m4a';
  if (ct.includes('ogg')) return '.ogg';
  if (ct.includes('wav')) return '.wav';
  return '.bin';
}

function audioCacheDisplayName(audioUrl, meta, hash, ext) {
  meta = meta || {};
  const title = cleanAudioCacheText(meta.title || meta.name, '未知歌曲');
  const artist = cleanAudioCacheText(meta.artist || meta.singer, '未知歌手');
  const quality = cleanAudioCacheText(meta.quality || meta.level || '', '');
  const source = cleanAudioCacheText(meta.source || meta.provider || '', '');
  const bits = [title, artist, quality, source].filter(Boolean);
  return bits.join(' - ').slice(0, 180) + ' - ' + hash.slice(0, 10) + ext;
}

function audioCachePaths(audioUrl, contentType, meta) {
  const dir = ensureAudioCacheDir();
  const baseIdentity = audioCacheBaseIdentity(audioUrl, meta);
  const baseKey = crypto.createHash('sha1').update(baseIdentity).digest('hex');
  const identity = audioCacheIdentity(audioUrl, meta, contentType);
  const hash = crypto.createHash('sha1').update(identity).digest('hex');
  const ext = audioCacheExt(audioUrl, contentType);
  const filename = audioCacheDisplayName(audioUrl, meta, hash, ext);
  return {
    key: hash,
    baseKey,
    baseIdentity,
    identity,
    file: path.join(dir, filename),
    meta: path.join(dir, hash + '.json'),
    tmp: path.join(dir, hash + ext + '.tmp'),
  };
}

function audioCacheEntryFromMetaFile(metaFile, expectedBaseKey) {
  try {
    const savedMeta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    if (!savedMeta || savedMeta.version !== 2) return null;
    if (expectedBaseKey && savedMeta.baseKey !== expectedBaseKey) return null;
    const file = savedMeta.file;
    const dir = ensureAudioCacheDir();
    const resolved = path.resolve(file || '');
    if (!file || !resolved.startsWith(path.resolve(dir) + path.sep)) return null;
    if (!fs.existsSync(resolved)) return null;
    const stat = fs.statSync(resolved);
    if (!stat.size) return null;
    return Object.assign({}, savedMeta, { file: resolved, size: stat.size, key: savedMeta.key || path.basename(metaFile, '.json') });
  } catch (e) {
    return null;
  }
}

function isAudioCacheStableMeta(meta) {
  meta = meta || {};
  const songId = cleanAudioCacheText(meta.songId || meta.musicId || meta.id || '', '');
  const title = cleanAudioCacheText(meta.title || meta.name, '');
  const artist = cleanAudioCacheText(meta.artist || meta.singer, '');
  const provider = cleanAudioCacheText(meta.provider || '', '');
  const source = audioCacheSourceKey(meta);
  const quality = audioCacheQualityKey(meta);
  return !!((songId || (title && artist)) && provider && source && quality);
}

function findAudioCacheEntry(audioUrl, cacheMeta) {
  let paths;
  try { paths = audioCachePaths(audioUrl, '', cacheMeta); } catch (e) { return null; }
  const exact = fs.existsSync(paths.meta) ? audioCacheEntryFromMetaFile(paths.meta, paths.baseKey) : null;
  if (exact) {
    if (hasHigherQualityAudioCache(audioUrl, cacheMeta)) {
      removeAudioCacheEntry(exact);
      return null;
    }
    return exact;
  }
  try {
    const dir = ensureAudioCacheDir();
    for (const name of fs.readdirSync(dir)) {
      if (!/\.json$/i.test(name)) continue;
      const entry = audioCacheEntryFromMetaFile(path.join(dir, name), paths.baseKey);
      if (entry) {
        if (hasHigherQualityAudioCache(audioUrl, cacheMeta)) {
          removeAudioCacheEntry(entry);
          return null;
        }
        return entry;
      }
    }
  } catch (e) {
    return null;
  }
  return null;
}

function hasHigherQualityAudioCache(audioUrl, cacheMeta) {
  if (!isAudioCacheStableMeta(cacheMeta)) return false;
  const requestedRank = audioCacheQualityRank(audioCacheQualityKey(cacheMeta) || (cacheMeta && cacheMeta.quality));
  if (requestedRank <= 0) return false;
  let dir;
  try { dir = ensureAudioCacheDir(); } catch (e) { return false; }
  const groupKey = crypto.createHash('sha1').update(audioCacheGroupIdentity(audioUrl, cacheMeta)).digest('hex');
  for (const name of fs.readdirSync(dir)) {
    if (!/\.json$/i.test(name)) continue;
    let meta;
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch (e) { continue; }
    if (!meta || meta.version !== 2 || meta.groupKey !== groupKey) continue;
    const rank = Number(meta.qualityRank) || audioCacheQualityRank(meta.qualityKey || meta.quality);
    if (rank > requestedRank) return true;
  }
  return false;
}

function parseRangeHeader(range, size) {
  const m = String(range || '').match(/^bytes=(\d*)-(\d*)$/);
  if (!m || !size) return null;
  let start = m[1] === '' ? 0 : Number(m[1]);
  let end = m[2] === '' ? size - 1 : Number(m[2]);
  if (m[1] === '' && m[2] !== '') {
    const suffix = Number(m[2]) || 0;
    start = Math.max(0, size - suffix);
    end = size - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

function serveAudioCacheEntry(req, res, entry) {
  const size = entry.size;
  const range = parseRangeHeader(req.headers.range, size);
  const headers = {
    'Content-Type': audioContentTypeForUrl(entry.url || entry.identity || '', entry.contentType),
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': '*',
    'X-Mineradio-Audio-Cache': 'hit',
  };
  if (range) {
    headers['Content-Range'] = `bytes ${range.start}-${range.end}/${size}`;
    headers['Content-Length'] = String(range.end - range.start + 1);
    res.writeHead(206, headers);
    fs.createReadStream(entry.file, { start: range.start, end: range.end }).pipe(res);
    return true;
  }
  headers['Content-Length'] = String(size);
  res.writeHead(200, headers);
  fs.createReadStream(entry.file).pipe(res);
  return true;
}

const audioCacheDownloads = new Set();

function audioCacheQualityRank(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return 0;
  if (/jymaster|master|母带/.test(raw)) return 80;
  if (/atmos[_\s-]*plus|全景声\+|臻品全景声/.test(raw)) return 70;
  if (/atmos|全景声/.test(raw)) return 65;
  if (/hi[-_\s]*res|hires|flac24|24bit|24-bit|高清臻音/.test(raw)) return 60;
  if (/lossless|flac|ape|无损|sq/.test(raw)) return 50;
  if (/exhigh|320|高品|极高|hq/.test(raw)) return 40;
  if (/192/.test(raw)) return 30;
  if (/standard|128|标准/.test(raw)) return 20;
  if (/aac|m4a/.test(raw)) return 10;
  return 1;
}

function audioCacheGroupIdentity(audioUrl, meta) {
  meta = meta || {};
  return [
    'audio-cache-group-v2',
    cleanAudioCacheText(meta.provider || '', ''),
    audioCacheSourceKey(meta),
    audioCacheStableSongKey(audioUrl, meta),
  ].join('\n');
}

function audioCacheSafeRemove(file, dir) {
  if (!file) return false;
  try {
    const root = path.resolve(dir);
    const target = path.resolve(file);
    if (target !== root && !target.startsWith(root + path.sep)) return false;
    if (!fs.existsSync(target)) return false;
    fs.rmSync(target, { force: true });
    return true;
  } catch (e) {
    return false;
  }
}

function removeAudioCacheEntry(entry) {
  if (!entry) return;
  let dir;
  try { dir = ensureAudioCacheDir(); } catch (e) { return; }
  audioCacheSafeRemove(entry.file, dir);
  if (entry.key) audioCacheSafeRemove(path.join(dir, entry.key + '.json'), dir);
}

function pruneLowerQualityAudioCache(savedMeta) {
  if (!savedMeta || savedMeta.version !== 2) return;
  const rank = Number(savedMeta.qualityRank) || 0;
  if (rank <= 0) return;
  let dir;
  try { dir = ensureAudioCacheDir(); } catch (e) { return; }
  const groupKey = savedMeta.groupKey;
  if (!groupKey) return;
  for (const name of fs.readdirSync(dir)) {
    if (!/\.json$/i.test(name)) continue;
    const metaFile = path.join(dir, name);
    let meta;
    try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch (e) { continue; }
    if (!meta || meta.version !== 2 || meta.key === savedMeta.key) continue;
    if (meta.groupKey !== groupKey) continue;
    const oldRank = Number(meta.qualityRank) || audioCacheQualityRank(meta.qualityKey || meta.quality);
    if (oldRank >= rank) continue;
    audioCacheSafeRemove(meta.file, dir);
    audioCacheSafeRemove(metaFile, dir);
  }
}

async function cacheAudioInBackground(audioUrl, contentType, cacheMeta) {
  if (!isAudioCacheStableMeta(cacheMeta)) return;
  let paths;
  try { paths = audioCachePaths(audioUrl, contentType, cacheMeta); } catch (e) { return; }
  const downloadKey = paths.baseKey || paths.key;
  if (hasHigherQualityAudioCache(audioUrl, cacheMeta)) return;
  if (findAudioCacheEntry(audioUrl, cacheMeta) || audioCacheDownloads.has(downloadKey)) return;
  audioCacheDownloads.add(downloadKey);
  try {
    const up = await fetch(audioUrl, { headers: audioProxyHeadersFor(audioUrl, '') });
    if (!up.ok) throw new Error('HTTP ' + up.status);
    const finalType = audioContentTypeForUrl(audioUrl, up.headers.get('content-type') || contentType || '');
    const finalPaths = audioCachePaths(audioUrl, finalType, cacheMeta);
    const tmp = finalPaths.tmp;
    const ws = fs.createWriteStream(tmp);
    const reader = up.body.getReader();
    let size = 0;
    while (true) {
      const c = await reader.read();
      if (c.done) break;
      size += c.value.length;
      ws.write(Buffer.from(c.value));
    }
    await new Promise((resolve, reject) => ws.end(err => err ? reject(err) : resolve()));
    fs.renameSync(tmp, finalPaths.file);
    const savedMeta = {
      version: 2,
      key: finalPaths.key,
      baseKey: finalPaths.baseKey,
      groupKey: crypto.createHash('sha1').update(audioCacheGroupIdentity(audioUrl, cacheMeta)).digest('hex'),
      identity: finalPaths.identity,
      baseIdentity: finalPaths.baseIdentity,
      url: audioUrl,
      file: finalPaths.file,
      title: cleanAudioCacheText(cacheMeta && (cacheMeta.title || cacheMeta.name), ''),
      artist: cleanAudioCacheText(cacheMeta && (cacheMeta.artist || cacheMeta.singer), ''),
      album: cleanAudioCacheText(cacheMeta && cacheMeta.album, ''),
      source: cleanAudioCacheText(cacheMeta && (cacheMeta.source || cacheMeta.provider), ''),
      provider: cleanAudioCacheText(cacheMeta && cacheMeta.provider, ''),
      sourceKey: audioCacheSourceKey(cacheMeta),
      songId: cleanAudioCacheText(cacheMeta && (cacheMeta.songId || cacheMeta.musicId || cacheMeta.id), ''),
      qualityKey: audioCacheQualityKey(cacheMeta),
      quality: cleanAudioCacheText(cacheMeta && (cacheMeta.quality || cacheMeta.level), ''),
      qualityRank: audioCacheQualityRank(audioCacheQualityKey(cacheMeta) || (cacheMeta && cacheMeta.quality)),
      format: audioCacheFormat(audioUrl, finalType),
      contentType: finalType,
      size,
      savedAt: Date.now(),
    };
    fs.writeFileSync(finalPaths.meta, JSON.stringify(savedMeta), 'utf8');
    pruneLowerQualityAudioCache(savedMeta);
  } catch (e) {
    try { if (paths && fs.existsSync(paths.tmp)) fs.rmSync(paths.tmp, { force: true }); } catch (_) {}
    console.warn('[AudioCache]', e.message || e);
  } finally {
    audioCacheDownloads.delete(downloadKey);
  }
}

function audioCacheStatus() {
  const info = audioCacheRootInfo();
  let count = 0;
  let bytes = 0;
  if (fs.existsSync(info.dir)) {
    for (const name of fs.readdirSync(info.dir)) {
      if (/\.tmp$|\.json$/i.test(name)) continue;
      const file = path.join(info.dir, name);
      try {
        const stat = fs.statSync(file);
        if (stat.isFile()) {
          count++;
          bytes += stat.size;
        }
      } catch (e) {}
    }
  }
  return Object.assign({ enabled: info.allowed && !!info.root, count, bytes }, info);
}

function clearAudioCache() {
  const info = audioCacheRootInfo();
  if (!info.allowed) return Object.assign({ ok: false, error: 'AUDIO_CACHE_ON_C_DRIVE_DISABLED' }, info);
  if (!fs.existsSync(info.dir)) return Object.assign({ ok: true, removed: 0 }, info);
  let removed = 0;
  for (const name of fs.readdirSync(info.dir)) {
    try {
      fs.rmSync(path.join(info.dir, name), { recursive: true, force: true });
      removed++;
    } catch (e) {}
  }
  return Object.assign({ ok: true, removed }, audioCacheStatus());
}
function localUpdateFallback(reason, opts) {
  opts = opts || {};
  const configured = !!(opts.configured != null ? opts.configured : false);
  return {
    configured,
    preview: UPDATE_CONFIG.preview,
    updateAvailable: false,
    currentVersion: APP_VERSION,
    latestVersion: APP_VERSION,
    release: {
      tagName: 'v' + APP_VERSION,
      name: APP_DISPLAY_NAME + ' v' + APP_VERSION,
      version: APP_VERSION,
      htmlUrl: '',
      downloadUrl: '',
      summary: '当前版本，更新检测已就绪。',
      notes: UPDATE_FALLBACK_NOTES,
    },
    reason: reason || '',
  };
}
function updateError(code, message, cause) {
  const err = new Error(message || code);
  err.code = code;
  if (cause) err.cause = cause;
  return err;
}
function classifyUpdateError(err) {
  const code = String(err && err.code || '').trim();
  const message = String(err && err.message || err || '').trim();
  const detail = message || code || '未知错误';
  if (/HASH|DIGEST|CHECKSUM/i.test(code + ' ' + message)) {
    return { code: code || 'UPDATE_HASH_MISMATCH', reason: '文件校验失败，可能是线路缓存异常，已拦截该安装包。', detail };
  }
  if (/SIZE_MISMATCH|content length/i.test(code + ' ' + message)) {
    return { code: code || 'UPDATE_SIZE_MISMATCH', reason: '下载文件大小不一致，可能是网络中断或线路缓存不完整。', detail };
  }
  if (/AbortError|TIMEOUT|ETIMEDOUT|timeout/i.test(code + ' ' + message)) {
    return { code: code || 'UPDATE_TIMEOUT', reason: '连接超时，当前网络到更新线路不稳定。', detail };
  }
  if (/ENOTFOUND|EAI_AGAIN|DNS|fetch failed|getaddrinfo/i.test(code + ' ' + message)) {
    return { code: code || 'UPDATE_DNS_FAILED', reason: '域名解析失败，可能是当前网络无法连接该更新线路。', detail };
  }
  if (/ECONNRESET|ECONNREFUSED|socket|network/i.test(code + ' ' + message)) {
    return { code: code || 'UPDATE_NETWORK_FAILED', reason: '网络连接被中断，已尝试切换更新线路。', detail };
  }
  const http = message.match(/\bHTTP[_\s-]?(\d{3})\b/i) || message.match(/\b(\d{3})\b/);
  if (http) {
    const status = Number(http[1]);
    if (status === 403) return { code: code || 'UPDATE_HTTP_403', reason: '更新线路返回 403，可能被限流或拦截。', detail };
    if (status === 404) return { code: code || 'UPDATE_HTTP_404', reason: '更新文件不存在，可能 release 资源还没有同步完成。', detail };
    if (status >= 500) return { code: code || 'UPDATE_HTTP_5XX', reason: '更新线路服务器异常，请稍后重试。', detail };
    return { code: code || ('UPDATE_HTTP_' + status), reason: '更新线路返回 HTTP ' + status + '。', detail };
  }
  return { code: code || 'UPDATE_FAILED', reason: '更新失败：' + detail, detail };
}
async function fetchWithTimeout(url, opts, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 12000);
  try {
    return await fetch(url, Object.assign({}, opts || {}, { signal: controller.signal }));
  } finally {
    clearTimeout(timer);
  }
}
async function fetchTextFromCandidates(candidates, timeoutMs) {
  const list = Array.isArray(candidates) && candidates.length ? candidates : [];
  const failures = [];
  for (let i = 0; i < list.length; i++) {
    const candidate = list[i];
    try {
      const resp = await fetchWithTimeout(candidate.url, {
        headers: { 'User-Agent': `Mineradio/${APP_VERSION}` },
      }, timeoutMs || 6500);
      if (!resp.ok) throw updateError('HTTP_' + resp.status, 'HTTP ' + resp.status);
      return { text: await resp.text(), candidate };
    } catch (err) {
      const info = classifyUpdateError(err);
      failures.push(candidate.label + ': ' + info.reason);
    }
  }
  throw updateError('UPDATE_ALL_LINES_FAILED', failures.join('；') || 'All update lines failed');
}
function yamlScalar(text, key) {
  const pattern = new RegExp('^\\s*' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:\\s*(.+?)\\s*$', 'm');
  const match = String(text || '').match(pattern);
  if (!match) return '';
  return match[1].trim().replace(/^['"]|['"]$/g, '');
}
function githubReleaseDownloadUrl(version, fileName) {
  const tag = 'v' + normalizeVersion(version);
  const encodedOwner = encodeURIComponent(UPDATE_CONFIG.owner);
  const encodedRepo = encodeURIComponent(UPDATE_CONFIG.repo);
  const encodedName = String(fileName || '').split('/').map(part => encodeURIComponent(part)).join('/');
  return `https://github.com/${encodedOwner}/${encodedRepo}/releases/download/${tag}/${encodedName}`;
}
function parseLatestYmlUpdateInfo(text, reason) {
  const latestVersion = normalizeVersion(yamlScalar(text, 'version') || APP_VERSION) || APP_VERSION;
  const assetPath = yamlScalar(text, 'path') || yamlScalar(text, 'url') || `${APP_ARTIFACT_PREFIX}-${latestVersion}-Setup.exe`;
  const sha512 = normalizeDigest(yamlScalar(text, 'sha512'), 'sha512');
  const size = Number(yamlScalar(text, 'size') || 0) || 0;
  const releaseDate = yamlScalar(text, 'releaseDate');
  const downloadUrl = githubReleaseDownloadUrl(latestVersion, assetPath);
  const candidates = uniqueDownloadCandidates(downloadUrl);
  const asset = {
    name: updateAssetNameFromUrl(downloadUrl) || assetPath,
    size,
    contentType: 'application/octet-stream',
    downloadUrl,
    downloadUrls: publicDownloadUrls(candidates),
    sha256: '',
    sha512,
  };
  return {
    configured: true,
    preview: false,
    updateAvailable: compareVersions(latestVersion, APP_VERSION) > 0,
    currentVersion: APP_VERSION,
    latestVersion,
    release: {
      tagName: 'v' + latestVersion,
      name: APP_DISPLAY_NAME + ' v' + latestVersion,
      version: latestVersion,
      publishedAt: releaseDate,
      htmlUrl: `https://github.com/${UPDATE_CONFIG.owner}/${UPDATE_CONFIG.repo}/releases/tag/v${latestVersion}`,
      downloadUrl,
      asset,
      patch: null,
      patchAvailable: false,
      summary: '发现新版本，已启用备用更新线路。',
      notes: ['更新检测已切换到备用线路', '下载时会自动选择国内加速线路', '下载失败会显示具体原因和当前速度'],
    },
    source: 'latest-yml',
    reason: reason || '',
  };
}
async function fetchLatestYmlUpdateInfo(reason) {
  if (!UPDATE_CONFIG.configured || UPDATE_CONFIG.provider !== 'github') throw updateError('UPDATE_REPOSITORY_NOT_CONFIGURED');
  const latestYmlUrl = `https://github.com/${encodeURIComponent(UPDATE_CONFIG.owner)}/${encodeURIComponent(UPDATE_CONFIG.repo)}/releases/latest/download/latest.yml`;
  const candidates = uniqueDownloadCandidates(latestYmlUrl);
  const result = await fetchTextFromCandidates(candidates, 6500);
  return parseLatestYmlUpdateInfo(result.text, reason);
}
async function fetchLatestUpdateInfo() {
  if (UPDATE_CONFIG.manifest) return fetchManifestUpdateInfo(UPDATE_CONFIG.manifest);
  if (!UPDATE_CONFIG.configured || UPDATE_CONFIG.provider !== 'github') return localUpdateFallback();
  const apiUrl = `https://api.github.com/repos/${encodeURIComponent(UPDATE_CONFIG.owner)}/${encodeURIComponent(UPDATE_CONFIG.repo)}/releases/latest`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8500);
  try {
    const resp = await fetch(apiUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': `Mineradio/${APP_VERSION}`,
        'Accept': 'application/vnd.github+json',
      },
    });
    if (!resp.ok) {
      try { return await fetchLatestYmlUpdateInfo('GitHub Releases ' + resp.status); }
      catch (_) { return localUpdateFallback('GitHub Releases ' + resp.status, { configured: true }); }
    }
    const data = await resp.json();
    const latestVersion = normalizeVersion(data.tag_name || data.name || APP_VERSION) || APP_VERSION;
    const asset = pickReleaseAsset(data.assets);
    const patch = pickPatchAsset(data.assets, APP_VERSION, latestVersion);
    const notes = extractReleaseNotes(data.body).length ? extractReleaseNotes(data.body) : UPDATE_FALLBACK_NOTES;
    return {
      configured: true,
      preview: false,
      updateAvailable: compareVersions(latestVersion, APP_VERSION) > 0,
      currentVersion: APP_VERSION,
      latestVersion,
      release: {
        tagName: data.tag_name || ('v' + latestVersion),
        name: data.name || (APP_DISPLAY_NAME + ' v' + latestVersion),
        version: latestVersion,
        publishedAt: data.published_at || '',
        htmlUrl: data.html_url || '',
        downloadUrl: asset ? asset.downloadUrl : '',
        asset,
        patch,
        patchAvailable: !!(patch && patch.downloadUrl && compareVersions(latestVersion, APP_VERSION) > 0),
        summary: notes[0] || '发现新版本，建议更新。',
        notes,
      },
    };
  } catch (err) {
    const reason = err && err.message || 'Update check failed';
    try { return await fetchLatestYmlUpdateInfo(reason); }
    catch (fallbackErr) { return localUpdateFallback((fallbackErr && fallbackErr.message) || reason, { configured: true }); }
  } finally {
    clearTimeout(timer);
  }
}
function safeUpdateFileName(name, version) {
  const raw = String(name || '').trim() || `${APP_ARTIFACT_PREFIX}-${version || APP_VERSION}.exe`;
  const cleaned = raw
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
  return cleaned || `Mineradio-${version || APP_VERSION}.exe`;
}
function publicUpdateJob(job) {
  if (!job) return { ok: false, error: 'UPDATE_JOB_NOT_FOUND' };
  return {
    ok: job.status !== 'error',
    id: job.id,
    status: job.status,
    progress: job.progress || 0,
    received: job.received || 0,
    total: job.total || 0,
    speedBps: job.speedBps || 0,
    etaSeconds: job.etaSeconds || 0,
    sourceLabel: job.sourceLabel || '',
    attempt: job.attempt || 0,
    attempts: job.attempts || 0,
    mode: job.mode || 'installer',
    message: job.message || '',
    restartRequired: !!job.restartRequired,
    cached: !!job.cached,
    fileName: job.fileName || '',
    filePath: job.status === 'ready' ? job.filePath : '',
    version: job.version || '',
    releaseUrl: job.releaseUrl || '',
    error: job.error || '',
    errorReason: job.errorReason || '',
    errorDetail: job.errorDetail || '',
    failedAttempts: Array.isArray(job.failedAttempts) ? job.failedAttempts.slice(0, 6) : [],
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}
function activeUpdateJobFor(version) {
  const jobs = Array.from(updateDownloadJobs.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return jobs.find(job => job.version === version && (job.status === 'queued' || job.status === 'downloading' || job.status === 'ready'));
}
function trimUpdateJobs() {
  const jobs = Array.from(updateDownloadJobs.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  jobs.slice(8).forEach(job => updateDownloadJobs.delete(job.id));
}
async function downloadUpdateAsset(job) {
  const tmpPath = job.filePath + '.download';
  try {
    fs.mkdirSync(UPDATE_DOWNLOAD_DIR, { recursive: true });
    job.status = 'downloading';
    job.updatedAt = Date.now();

    const resp = await fetch(job.downloadUrl, {
      headers: {
        'User-Agent': `Mineradio/${APP_VERSION}`,
      },
    });
    if (!resp.ok) throw new Error('Download failed ' + resp.status);

    const totalHeader = parseInt(resp.headers.get('content-length') || '0', 10) || 0;
    job.total = totalHeader || job.total || 0;
    job.received = 0;
    job.progress = 0;
    job.speedBps = 0;
    job.etaSeconds = 0;
    job.message = job.total ? '正在下载完整安装包' : '正在下载完整安装包，等待服务器返回大小';
    job.updatedAt = Date.now();
    let speedWindowAt = Date.now();
    let speedWindowBytes = 0;

    const writer = fs.createWriteStream(tmpPath);
    const reader = resp.body.getReader();
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const buf = Buffer.from(chunk.value);
        job.received += buf.length;
        speedWindowBytes += buf.length;
        const now = Date.now();
        if (now - speedWindowAt >= 900) {
          job.speedBps = Math.round(speedWindowBytes / Math.max(0.001, (now - speedWindowAt) / 1000));
          speedWindowAt = now;
          speedWindowBytes = 0;
        }
        if (job.total > 0) {
          job.progress = Math.max(1, Math.min(99, Math.round((job.received / job.total) * 100)));
          job.etaSeconds = job.speedBps > 0 ? Math.max(0, Math.round((job.total - job.received) / job.speedBps)) : 0;
        } else {
          const kb = Math.max(1, job.received / 1024);
          job.progress = Math.max(1, Math.min(88, Math.round(Math.log10(kb + 1) * 24)));
        }
        job.message = job.total > 0 ? '正在下载完整安装包' : '正在下载完整安装包，服务器未提供总大小';
        job.updatedAt = Date.now();
        if (!writer.write(buf)) await once(writer, 'drain');
      }
    } finally {
      writer.end();
      await once(writer, 'finish').catch(() => {});
    }

    if (fs.existsSync(job.filePath)) fs.unlinkSync(job.filePath);
    fs.renameSync(tmpPath, job.filePath);
    job.status = 'ready';
    job.progress = 100;
    job.message = '安装包已下载';
    job.updatedAt = Date.now();
  } catch (e) {
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {}
    job.status = 'error';
    job.error = e.message || 'UPDATE_DOWNLOAD_FAILED';
    job.updatedAt = Date.now();
  }
}
function sha512Base64(buffer) {
  return crypto.createHash('sha512').update(buffer).digest('base64');
}
function sha512Hex(buffer) {
  return crypto.createHash('sha512').update(buffer).digest('hex');
}
function verifyUpdateBuffer(buffer, job) {
  const expectedSize = Number(job.expectedSize || job.total || 0) || 0;
  if (expectedSize > 0 && buffer.length !== expectedSize) {
    throw updateError('UPDATE_SIZE_MISMATCH', `Expected ${expectedSize} bytes, got ${buffer.length}`);
  }
  const expectedSha256 = normalizeDigest(job.sha256 || '', 'sha256').toLowerCase();
  if (expectedSha256 && sha256Hex(buffer) !== expectedSha256) {
    throw updateError('UPDATE_SHA256_MISMATCH', 'Downloaded sha256 mismatch');
  }
  const expectedSha512 = normalizeDigest(job.sha512 || '', 'sha512');
  if (expectedSha512) {
    const actualBase64 = sha512Base64(buffer);
    const actualHex = sha512Hex(buffer).toLowerCase();
    if (actualBase64 !== expectedSha512 && actualHex !== expectedSha512.toLowerCase()) {
      throw updateError('UPDATE_SHA512_MISMATCH', 'Downloaded sha512 mismatch');
    }
  }
}
function verifyUpdateFile(filePath, job) {
  verifyUpdateBuffer(fs.readFileSync(filePath), job);
}
function moveInvalidUpdateFile(filePath, reason) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return;
    const dir = path.dirname(filePath);
    const ext = path.extname(filePath);
    const base = path.basename(filePath, ext);
    const invalidPath = path.join(dir, `${base}.invalid-${Date.now()}${ext || '.bin'}`);
    fs.renameSync(filePath, invalidPath);
    console.warn('[UpdateDownload] cached installer moved aside:', reason || 'invalid', invalidPath);
  } catch (e) {
    console.warn('[UpdateDownload] failed to move invalid cached installer:', e.message);
  }
}
function reuseVerifiedInstallerJob(opts) {
  if (!opts || !opts.filePath || !fs.existsSync(opts.filePath)) return null;
  if (!opts.expectedSize && !opts.sha256 && !opts.sha512) return null;
  const now = Date.now();
  const stat = fs.statSync(opts.filePath);
  const job = {
    id: 'cached-' + now.toString(36) + '-' + Math.random().toString(36).slice(2, 8),
    status: 'ready',
    progress: 100,
    received: stat.size || 0,
    total: opts.expectedSize || stat.size || 0,
    speedBps: 0,
    etaSeconds: 0,
    sourceLabel: '本地缓存',
    attempt: 0,
    attempts: opts.attempts || 0,
    mode: 'installer',
    message: '安装包已下载，可直接打开安装',
    fileName: opts.fileName || path.basename(opts.filePath),
    filePath: opts.filePath,
    version: opts.version || '',
    downloadUrl: opts.downloadUrl || '',
    downloadCandidates: opts.downloadCandidates || [],
    expectedSize: opts.expectedSize || 0,
    sha256: opts.sha256 || '',
    sha512: opts.sha512 || '',
    releaseUrl: opts.releaseUrl || '',
    failedAttempts: [],
    cached: true,
    createdAt: now,
    updatedAt: now,
    error: '',
  };
  try {
    verifyUpdateFile(opts.filePath, job);
    updateDownloadJobs.set(job.id, job);
    trimUpdateJobs();
    return job;
  } catch (err) {
    moveInvalidUpdateFile(opts.filePath, (err && err.message) || 'cache verification failed');
    return null;
  }
}
function setUpdateJobError(job, err, fallbackMessage) {
  const info = classifyUpdateError(err);
  job.status = 'error';
  job.error = info.code;
  job.errorReason = info.reason;
  job.errorDetail = info.detail;
  job.message = fallbackMessage || info.reason;
  job.updatedAt = Date.now();
}
function prepareUpdateJobAttempt(job, candidate, index, total) {
  job.status = 'downloading';
  job.sourceLabel = candidate.label || '下载线路';
  job.attempt = index + 1;
  job.attempts = total;
  job.received = 0;
  job.speedBps = 0;
  job.etaSeconds = 0;
  job.error = '';
  job.errorReason = '';
  job.errorDetail = '';
  job.updatedAt = Date.now();
}
function ensureMirrorCanBeVerified(job, candidate) {
  if (!candidate || !candidate.mirrored) return;
  if (job.sha256 || job.sha512) return;
  throw updateError('MIRROR_HASH_MISSING', 'Mirror download skipped because no digest is available');
}
async function downloadUpdateAssetWithMirrors(job) {
  const tmpPath = job.filePath + '.download';
  const candidates = Array.isArray(job.downloadCandidates) && job.downloadCandidates.length
    ? job.downloadCandidates
    : uniqueDownloadCandidates(job.downloadUrl || '');
  const failures = [];
  fs.mkdirSync(UPDATE_DOWNLOAD_DIR, { recursive: true });
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    try {
      try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {}
      ensureMirrorCanBeVerified(job, candidate);
      prepareUpdateJobAttempt(job, candidate, i, candidates.length);
      job.message = job.total ? '正在下载完整安装包' : '正在下载完整安装包，等待服务器返回大小';

      const resp = await fetchWithTimeout(candidate.url, {
        headers: { 'User-Agent': `Mineradio/${APP_VERSION}` },
      }, 14000);
      if (!resp.ok) throw updateError('HTTP_' + resp.status, 'HTTP ' + resp.status);

      const totalHeader = parseInt(resp.headers.get('content-length') || '0', 10) || 0;
      job.total = totalHeader || job.expectedSize || job.total || 0;
      job.progress = 0;
      job.updatedAt = Date.now();
      let speedWindowAt = Date.now();
      let speedWindowBytes = 0;

      const writer = fs.createWriteStream(tmpPath);
      const reader = resp.body.getReader();
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          const buf = Buffer.from(chunk.value);
          job.received += buf.length;
          speedWindowBytes += buf.length;
          const now = Date.now();
          if (now - speedWindowAt >= 900) {
            job.speedBps = Math.round(speedWindowBytes / Math.max(0.001, (now - speedWindowAt) / 1000));
            speedWindowAt = now;
            speedWindowBytes = 0;
          }
          if (job.total > 0) {
            job.progress = Math.max(1, Math.min(99, Math.round((job.received / job.total) * 100)));
            job.etaSeconds = job.speedBps > 0 ? Math.max(0, Math.round((job.total - job.received) / job.speedBps)) : 0;
          } else {
            const kb = Math.max(1, job.received / 1024);
            job.progress = Math.max(1, Math.min(88, Math.round(Math.log10(kb + 1) * 24)));
          }
          job.message = job.total > 0 ? '正在下载完整安装包' : '正在下载完整安装包，服务器未提供总大小';
          job.updatedAt = Date.now();
          if (!writer.write(buf)) await once(writer, 'drain');
        }
      } finally {
        writer.end();
        await once(writer, 'finish').catch(() => {});
      }

      verifyUpdateFile(tmpPath, job);
      if (fs.existsSync(job.filePath)) fs.unlinkSync(job.filePath);
      fs.renameSync(tmpPath, job.filePath);
      job.status = 'ready';
      job.progress = 100;
      job.etaSeconds = 0;
      job.message = '安装包已下载';
      job.updatedAt = Date.now();
      return;
    } catch (err) {
      try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {}
      const info = classifyUpdateError(err);
      failures.push({ source: candidate.label || '下载线路', reason: info.reason, detail: info.detail });
      job.failedAttempts = failures.slice(-6);
      job.message = i < candidates.length - 1 ? ((candidate.label || '当前线路') + '失败，正在切换线路') : info.reason;
      job.updatedAt = Date.now();
      if (i >= candidates.length - 1) setUpdateJobError(job, err, '下载失败：' + info.reason);
    }
  }
}
function startUpdateDownloadJob(info) {
  const release = info && info.release ? info.release : {};
  const asset = release.asset || {};
  const downloadUrl = release.downloadUrl || asset.downloadUrl || '';
  if (!info || !info.configured) return { ok: false, error: 'UPDATE_REPOSITORY_NOT_CONFIGURED' };
  if (!info.updateAvailable) return { ok: false, error: 'NO_UPDATE_AVAILABLE' };
  if (!/^https?:\/\//i.test(downloadUrl)) return { ok: false, error: 'UPDATE_ASSET_MISSING' };

  const version = info.latestVersion || release.version || '';
  const existing = activeUpdateJobFor(version);
  if (existing) return publicUpdateJob(existing);

  const fileName = safeUpdateFileName(asset.name || '', version);
  const filePath = path.join(UPDATE_DOWNLOAD_DIR, fileName);
  const downloadCandidates = uniqueDownloadCandidates([downloadUrl].concat(Array.isArray(asset.downloadUrls) ? asset.downloadUrls : []));
  const expectedSize = asset.size || 0;
  const sha256 = normalizeDigest(asset.sha256 || '', 'sha256').toLowerCase();
  const sha512 = normalizeDigest(asset.sha512 || '', 'sha512');
  const cached = reuseVerifiedInstallerJob({
    fileName,
    filePath,
    version,
    downloadUrl,
    downloadCandidates,
    expectedSize,
    sha256,
    sha512,
    releaseUrl: release.htmlUrl || '',
    attempts: downloadCandidates.length,
  });
  if (cached) return publicUpdateJob(cached);

  const now = Date.now();
  const job = {
    id: now.toString(36) + '-' + Math.random().toString(36).slice(2, 8),
    status: 'queued',
    progress: 0,
    received: 0,
    total: expectedSize,
    mode: 'installer',
    fileName,
    filePath,
    version,
    downloadUrl,
    downloadCandidates,
    expectedSize,
    sha256,
    sha512,
    releaseUrl: release.htmlUrl || '',
    sourceLabel: '',
    attempt: 0,
    attempts: downloadCandidates.length,
    failedAttempts: [],
    createdAt: now,
    updatedAt: now,
    error: '',
  };
  updateDownloadJobs.set(job.id, job);
  trimUpdateJobs();
  downloadUpdateAssetWithMirrors(job);
  return publicUpdateJob(job);
}
function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}
function safePatchRelativePath(value) {
  const rel = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '').trim();
  if (!rel || rel.includes('\0')) return '';
  const parts = rel.split('/').filter(Boolean);
  if (!parts.length || parts.some(part => part === '..' || part === '.')) return '';
  const root = parts[0];
  if (PATCH_ALLOWED_FILES.has(rel)) return rel;
  if (!PATCH_ALLOWED_ROOTS.has(root)) return '';
  if (/\.(exe|dll|node|msi|bat|cmd|ps1|pfx|pem|key)$/i.test(rel)) return '';
  return parts.join('/');
}
function patchTargetPath(rel) {
  const safeRel = safePatchRelativePath(rel);
  if (!safeRel) return null;
  const target = path.resolve(__dirname, safeRel);
  const root = path.resolve(__dirname);
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  return target;
}
function decodePatchFile(file) {
  if (!file || typeof file !== 'object') return null;
  if (typeof file.contentBase64 === 'string') return Buffer.from(file.contentBase64, 'base64');
  if (typeof file.content === 'string') return Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8');
  return null;
}
function backupPatchTarget(job, rel, target) {
  if (!fs.existsSync(target)) return;
  const backup = path.join(UPDATE_PATCH_BACKUP_DIR, job.id, rel);
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  fs.copyFileSync(target, backup);
}
function writePatchFile(job, file) {
  const rel = safePatchRelativePath(file.path || file.name);
  const target = rel ? patchTargetPath(rel) : null;
  const content = decodePatchFile(file);
  if (!rel || !target || !content) throw new Error('INVALID_PATCH_FILE');
  if (content.length > PATCH_MAX_BYTES) throw new Error('PATCH_FILE_TOO_LARGE');
  const expected = String(file.sha256 || '').trim().toLowerCase();
  const actual = sha256Hex(content);
  if (expected && expected !== actual) throw new Error('PATCH_HASH_MISMATCH:' + rel);
  backupPatchTarget(job, rel, target);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = target + '.mineradio-patch';
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, target);
  if (expected && sha256Hex(fs.readFileSync(target)) !== expected) throw new Error('PATCH_WRITE_VERIFY_FAILED:' + rel);
  return rel;
}
function normalizePatchPayload(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('INVALID_PATCH_PAYLOAD');
  const type = String(payload.type || payload.kind || '');
  if (type && type !== 'mineradio-resource-patch') throw new Error('UNSUPPORTED_PATCH_TYPE');
  const from = normalizeVersion(payload.from || payload.baseVersion || '');
  const to = normalizeVersion(payload.to || payload.version || payload.targetVersion || '');
  const files = Array.isArray(payload.files) ? payload.files : [];
  if (!from || compareVersions(from, APP_VERSION) !== 0) throw new Error('PATCH_VERSION_MISMATCH');
  if (!to || compareVersions(to, APP_VERSION) <= 0) throw new Error('PATCH_TARGET_VERSION_INVALID');
  if (!files.length) throw new Error('PATCH_EMPTY');
  if (files.length > 40) throw new Error('PATCH_TOO_MANY_FILES');
  return { from, to, files, restartRequired: payload.restartRequired !== false };
}
async function downloadAndApplyPatch(job) {
  const chunks = [];
  try {
    fs.mkdirSync(UPDATE_DOWNLOAD_DIR, { recursive: true });
    job.status = 'downloading';
    job.mode = 'patch';
    job.message = '正在下载快速补丁';
    job.updatedAt = Date.now();

    const resp = await fetch(job.downloadUrl, {
      headers: { 'User-Agent': `Mineradio/${APP_VERSION}` },
    });
    if (!resp.ok) throw new Error('Patch download failed ' + resp.status);

    job.total = parseInt(resp.headers.get('content-length') || '0', 10) || job.total || 0;
    job.received = 0;
    const reader = resp.body.getReader();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const buf = Buffer.from(chunk.value);
      job.received += buf.length;
      if (job.received > PATCH_MAX_BYTES) throw new Error('PATCH_TOO_LARGE');
      chunks.push(buf);
      job.progress = job.total > 0
        ? Math.max(1, Math.min(84, Math.round((job.received / job.total) * 84)))
        : Math.max(1, Math.min(76, Math.round(Math.log10(job.received / 1024 + 1) * 24)));
      job.updatedAt = Date.now();
    }

    const raw = Buffer.concat(chunks);
    const expectedPatchHash = String(job.sha256 || '').trim().toLowerCase();
    if (expectedPatchHash && sha256Hex(raw) !== expectedPatchHash) throw new Error('PATCH_PACKAGE_HASH_MISMATCH');
    const patch = normalizePatchPayload(JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, '')));
    job.version = patch.to;
    job.message = '正在应用快速补丁';
    job.progress = 88;
    job.updatedAt = Date.now();
    const changed = [];
    patch.files.forEach(file => changed.push(writePatchFile(job, file)));
    job.changedFiles = changed;
    job.status = 'ready';
    job.progress = 100;
    job.restartRequired = patch.restartRequired;
    job.message = patch.restartRequired ? '快速补丁已应用，重启后生效' : '快速补丁已应用';
    job.updatedAt = Date.now();
  } catch (e) {
    job.status = 'error';
    job.error = e.message || 'PATCH_APPLY_FAILED';
    job.message = '快速补丁失败，可改用完整安装包';
    job.updatedAt = Date.now();
  }
}
async function downloadPatchBufferFromCandidate(job, candidate, index, total) {
  ensureMirrorCanBeVerified(job, candidate);
  prepareUpdateJobAttempt(job, candidate, index, total);
  job.mode = 'patch';
  job.message = '正在下载快速补丁';
  job.progress = 0;
  job.updatedAt = Date.now();

  const resp = await fetchWithTimeout(candidate.url, {
    headers: { 'User-Agent': `Mineradio/${APP_VERSION}` },
  }, 12000);
  if (!resp.ok) throw updateError('HTTP_' + resp.status, 'HTTP ' + resp.status);

  job.total = parseInt(resp.headers.get('content-length') || '0', 10) || job.expectedSize || job.total || 0;
  job.received = 0;
  const chunks = [];
  const reader = resp.body.getReader();
  let speedWindowAt = Date.now();
  let speedWindowBytes = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    const buf = Buffer.from(chunk.value);
    job.received += buf.length;
    speedWindowBytes += buf.length;
    if (job.received > PATCH_MAX_BYTES) throw updateError('PATCH_TOO_LARGE', 'Patch package is too large');
    chunks.push(buf);
    const now = Date.now();
    if (now - speedWindowAt >= 700) {
      job.speedBps = Math.round(speedWindowBytes / Math.max(0.001, (now - speedWindowAt) / 1000));
      speedWindowAt = now;
      speedWindowBytes = 0;
    }
    job.progress = job.total > 0
      ? Math.max(1, Math.min(84, Math.round((job.received / job.total) * 84)))
      : Math.max(1, Math.min(76, Math.round(Math.log10(job.received / 1024 + 1) * 24)));
    job.etaSeconds = job.total > 0 && job.speedBps > 0 ? Math.max(0, Math.round((job.total - job.received) / job.speedBps)) : 0;
    job.updatedAt = Date.now();
  }
  const raw = Buffer.concat(chunks);
  verifyUpdateBuffer(raw, job);
  return raw;
}
async function downloadAndApplyPatchWithMirrors(job) {
  const candidates = Array.isArray(job.downloadCandidates) && job.downloadCandidates.length
    ? job.downloadCandidates
    : uniqueDownloadCandidates(job.downloadUrl || '');
  const failures = [];
  fs.mkdirSync(UPDATE_DOWNLOAD_DIR, { recursive: true });
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    try {
      const raw = await downloadPatchBufferFromCandidate(job, candidate, i, candidates.length);
      const patch = normalizePatchPayload(JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, '')));
      job.version = patch.to;
      job.message = '正在应用快速补丁';
      job.progress = 88;
      job.etaSeconds = 0;
      job.updatedAt = Date.now();
      const changed = [];
      patch.files.forEach(file => changed.push(writePatchFile(job, file)));
      job.changedFiles = changed;
      job.status = 'ready';
      job.progress = 100;
      job.restartRequired = patch.restartRequired;
      job.message = patch.restartRequired ? '快速补丁已应用，重启后生效' : '快速补丁已应用';
      job.updatedAt = Date.now();
      return;
    } catch (err) {
      const info = classifyUpdateError(err);
      failures.push({ source: candidate.label || '下载线路', reason: info.reason, detail: info.detail });
      job.failedAttempts = failures.slice(-6);
      job.message = i < candidates.length - 1 ? ((candidate.label || '当前线路') + '失败，正在切换线路') : info.reason;
      job.updatedAt = Date.now();
      if (i >= candidates.length - 1) setUpdateJobError(job, err, '快速补丁失败：' + info.reason);
    }
  }
}
function startUpdatePatchJob(info) {
  const release = info && info.release ? info.release : {};
  const patch = release.patch || {};
  const downloadUrl = patch.downloadUrl || '';
  if (!info || !info.configured) return { ok: false, error: 'UPDATE_REPOSITORY_NOT_CONFIGURED' };
  if (!info.updateAvailable) return { ok: false, error: 'NO_UPDATE_AVAILABLE' };
  if (!release.patchAvailable || !/^https?:\/\//i.test(downloadUrl)) return { ok: false, error: 'PATCH_ASSET_MISSING' };

  const version = info.latestVersion || release.version || patch.to || '';
  const existing = Array.from(updateDownloadJobs.values())
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .find(job => job.mode === 'patch' && job.version === version && (job.status === 'queued' || job.status === 'downloading' || job.status === 'ready'));
  if (existing) return publicUpdateJob(existing);

  const now = Date.now();
  const downloadCandidates = uniqueDownloadCandidates([downloadUrl].concat(Array.isArray(patch.downloadUrls) ? patch.downloadUrls : []));
  const job = {
    id: 'patch-' + now.toString(36) + '-' + Math.random().toString(36).slice(2, 8),
    status: 'queued',
    progress: 0,
    received: 0,
    total: patch.size || 0,
    mode: 'patch',
    fileName: patch.name || safeUpdateFileName('', version).replace(/\.exe$/i, '.patch.json'),
    filePath: '',
    version,
    downloadUrl,
    downloadCandidates,
    releaseUrl: release.htmlUrl || '',
    expectedSize: patch.size || 0,
    sha256: normalizeDigest(patch.sha256 || '', 'sha256').toLowerCase(),
    sha512: normalizeDigest(patch.sha512 || '', 'sha512'),
    restartRequired: true,
    sourceLabel: '',
    attempt: 0,
    attempts: downloadCandidates.length,
    failedAttempts: [],
    message: '等待下载快速补丁',
    createdAt: now,
    updatedAt: now,
    error: '',
  };
  updateDownloadJobs.set(job.id, job);
  trimUpdateJobs();
  downloadAndApplyPatchWithMirrors(job);
  return publicUpdateJob(job);
}
function readRequestBody(req) {
  return new Promise(resolve => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 8 * 1024 * 1024) req.destroy();
    });
    req.on('end', () => {
      if (!raw) { resolve({}); return; }
      try { resolve(JSON.parse(raw)); }
      catch (e) {
        const params = new URLSearchParams(raw);
        const out = {};
        params.forEach((v, k) => { out[k] = v; });
        resolve(out);
      }
    });
    req.on('error', () => resolve({}));
  });
}
function normalizeApiCode(payload) {
  const body = payload && (payload.body || payload);
  return Number((body && body.code) || (body && body.body && body.body.code) || (payload && payload.status) || 0);
}
function normalizeApiMessage(payload) {
  const body = payload && (payload.body || payload);
  return (body && (body.message || body.msg || body.error)) || (body && body.body && (body.body.message || body.body.msg || body.body.error)) || '';
}
function parseCookieString(cookieText) {
  const out = {};
  String(cookieText || '').split(';').forEach(part => {
    const raw = String(part || '').trim();
    if (!raw) return;
    const idx = raw.indexOf('=');
    if (idx <= 0) return;
    const key = raw.slice(0, idx).trim();
    const value = raw.slice(idx + 1).trim();
    if (key) out[key] = value;
  });
  return out;
}
function serializeCookieObject(obj) {
  return Object.keys(obj || {})
    .filter(k => obj[k] != null && String(obj[k]) !== '')
    .map(k => k + '=' + String(obj[k]))
    .join('; ');
}
function qqCookieObject() {
  return parseCookieString(qqCookie);
}
function normalizeQQUin(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  return digits.replace(/^0+/, '') || digits;
}
function qqCookieUin(obj) {
  obj = obj || qqCookieObject();
  const raw = Number(obj.login_type) === 2 ? (obj.wxuin || obj.uin || obj.p_uin) : (obj.uin || obj.qqmusic_uin || obj.wxuin || obj.p_uin);
  return normalizeQQUin(raw);
}
function qqCookieMusicKey(obj) {
  obj = obj || qqCookieObject();
  return obj.qm_keyst || obj.qqmusic_key || obj.music_key || obj.p_skey || obj.skey ||
    obj.psrf_qqaccess_token || obj.psrf_qqrefresh_token || obj.wxrefresh_token || obj.wxskey || '';
}
function qqCookiePlaybackKey(obj) {
  obj = obj || qqCookieObject();
  return obj.qm_keyst || obj.qqmusic_key || obj.music_key || obj.wxskey || '';
}
function decodeQQCookieValue(value) {
  try { return decodeURIComponent(String(value || '').replace(/\+/g, '%20')).trim(); }
  catch (e) { return String(value || '').trim(); }
}
function qqCookieNickname(obj, uin) {
  obj = obj || qqCookieObject();
  uin = normalizeQQUin(uin || qqCookieUin(obj));
  const padded = uin ? '0' + uin : '';
  const keys = [
    uin && ('ptnick_' + uin),
    padded && ('ptnick_' + padded),
    'ptnick',
    'nick',
    'nickname',
    'qq_nickname'
  ].filter(Boolean);
  for (const key of keys) {
    if (obj[key]) {
      const nick = decodeQQCookieValue(obj[key]);
      if (nick) return nick;
    }
  }
  const ptnickKey = Object.keys(obj).find(key => /^ptnick_/i.test(key) && obj[key]);
  return ptnickKey ? decodeQQCookieValue(obj[ptnickKey]) : '';
}
function qqCookieAvatar(obj, uin) {
  obj = obj || qqCookieObject();
  const direct = obj.qqmusic_avatar || obj.avatar || obj.avatarUrl || obj.headpic || '';
  if (direct) return decodeQQCookieValue(direct);
  uin = normalizeQQUin(uin || qqCookieUin(obj));
  return uin ? `https://q1.qlogo.cn/g?b=qq&nk=${encodeURIComponent(uin)}&s=100` : '';
}
function normalizeQQCookieInput(cookieText) {
  const obj = parseCookieString(cookieText);
  if (Number(obj.login_type) === 2 && obj.wxuin && !obj.uin) obj.uin = obj.wxuin;
  if (!obj.uin && (obj.qqmusic_uin || obj.p_uin)) obj.uin = obj.qqmusic_uin || obj.p_uin;
  if (obj.uin) obj.uin = normalizeQQUin(obj.uin);
  return serializeCookieObject(obj);
}
function playbackRestriction(provider, category, message, action, extra) {
  return {
    provider,
    category,
    action: action || '',
    message,
    ...(extra || {}),
  };
}
function classifyNeteasePlaybackRestriction(lastData, loginInfo) {
  const loggedIn = !!(loginInfo && loginInfo.loggedIn);
  const fee = Number(lastData && lastData.fee);
  const code = Number(lastData && lastData.code);
  const freeTrial = lastData && lastData.freeTrialInfo;
  if (!loggedIn) {
    return playbackRestriction('netease', 'login_required', '网易云需要登录后尝试获取完整播放地址', 'login', { code, fee });
  }
  if (freeTrial) {
    return playbackRestriction('netease', 'trial_only', '网易云仅返回试听片段，完整播放需要会员或购买', 'upgrade', { code, fee });
  }
  if (fee === 1) {
    return playbackRestriction('netease', 'vip_required', '网易云歌曲需要 VIP 权限，当前无法获取完整播放地址', 'upgrade', { code, fee });
  }
  if (fee === 4 || fee === 8) {
    return playbackRestriction('netease', 'paid_required', '网易云歌曲需要单曲、专辑购买或更高权限', 'purchase', { code, fee });
  }
  if (code === 404 || code === 403) {
    return playbackRestriction('netease', 'copyright_unavailable', '网易云版权暂不可播，换源或稍后重试会更稳', 'switch_source', { code, fee });
  }
  return playbackRestriction('netease', 'url_unavailable', '网易云没有返回可播放地址，可能是版权、会员或地区限制', loggedIn ? 'switch_source' : 'login', { code, fee });
}
function classifyQQPlaybackRestriction(info, session) {
  const hasSession = typeof session === 'object' ? !!session.hasSession : !!session;
  const hasPlaybackKey = typeof session === 'object' ? !!session.hasPlaybackKey : hasSession;
  const rawMsg = String((info && (info.msg || info.tips || info.errmsg || info.message)) || '').trim();
  const code = Number((info && (info.result || info.code || info.errtype)) || 0);
  const lower = rawMsg.toLowerCase();
  if (!hasSession) {
    return playbackRestriction('qq', 'login_required', 'QQ 音乐需要登录或授权后才能获取播放地址', 'login', { code, rawMessage: rawMsg });
  }
  if (!hasPlaybackKey && code === 104003) {
    return playbackRestriction('qq', 'login_required', 'QQ 音乐当前只拿到了网页登录状态，还缺少播放授权，请重新打开官方 QQ 音乐登录窗口完成授权', 'login', { code, rawMessage: rawMsg, missingPlaybackKey: true });
  }
  if (code === 104003) {
    return playbackRestriction('qq', 'copyright_unavailable', 'QQ 音乐没有给当前版本返回播放地址，通常是版权、会员或官方版本限制，可以换一个搜索结果或切到网易云源', 'switch_source', { code, rawMessage: rawMsg });
  }
  if (/vip|会员|付费|购买|数字专辑|专辑|pay/.test(lower + rawMsg)) {
    return playbackRestriction('qq', 'paid_required', 'QQ 音乐歌曲需要会员、购买或数字专辑权限', 'upgrade', { code, rawMessage: rawMsg });
  }
  if (code && code !== 0) {
    return playbackRestriction('qq', 'copyright_unavailable', rawMsg || 'QQ 音乐版权暂不可播或仅官方客户端可播', 'switch_source', { code, rawMessage: rawMsg });
  }
  return playbackRestriction('qq', 'url_unavailable', 'QQ 音乐没有返回播放地址，可能受版权、会员或官方客户端限制', 'switch_source', { code, rawMessage: rawMsg });
}
const NETEASE_QUALITY_CANDIDATES = [
  { level: 'jymaster', br: 1999000, label: '超清母带', svip: true },
  { level: 'hires',    br: 1999000, label: '高清臻音' },
  { level: 'lossless', br: 1411000, label: '无损' },
  { level: 'exhigh',   br: 999000,  label: '极高' },
  { level: 'standard', br: 128000,  label: '标准' },
];
const QQ_QUALITY_CANDIDATE_TEMPLATES = [
  { prefix: 'RS01', ext: '.flac', level: 'hires', label: 'Hi-Res FLAC' },
  { prefix: 'F000', ext: '.flac', level: 'lossless', label: '无损 FLAC' },
  { prefix: 'M800', ext: '.mp3', level: 'exhigh', label: '320k MP3' },
  { prefix: 'M500', ext: '.mp3', level: 'standard', label: '128k MP3' },
  { prefix: 'C400', ext: '.m4a', level: 'aac', label: 'AAC/M4A' },
];
function normalizeQualityPreference(value) {
  const raw = String(value || '').toLowerCase().trim();
  if (['jymaster', 'master', 'studio', 'svip'].includes(raw)) return 'jymaster';
  if (['hires', 'hi-res', 'highres', 'zhenyin', 'spatial'].includes(raw)) return 'hires';
  if (['lossless', 'flac', 'sq'].includes(raw)) return 'lossless';
  if (['exhigh', 'high', '320', '320k', 'hq'].includes(raw)) return 'exhigh';
  if (['standard', 'normal', '128', '128k', 'std'].includes(raw)) return 'standard';
  return 'hires';
}
function qualityCandidatesFrom(target, candidates) {
  target = normalizeQualityPreference(target);
  let start = candidates.findIndex(item => item.level === target);
  if (start < 0) start = 0;
  return candidates.slice(start);
}
function hasNeteaseSvip(loginInfo) {
  return !!(loginInfo && loginInfo.loggedIn && (loginInfo.vipLevel === 'svip' || loginInfo.isSvip || Number(loginInfo.vipType || 0) >= 10));
}
function mapArtists(raw) {
  return (raw || [])
    .map(a => ({ id: a && a.id, name: (a && a.name) || '' }))
    .filter(a => a.name);
}
function neteaseQualityTypesFromSong(s) {
  s = s || {};
  const types = [];
  const typeMap = {};
  const privilege = s.privilege || {};
  const maxBrLevel = String(privilege.maxBrLevel || '').toLowerCase();
  if (maxBrLevel === 'jymaster' || maxBrLevel === 'sky' || maxBrLevel === 'dolby') {
    addLXQuality(types, typeMap, 'master', '', {});
  }
  if (maxBrLevel === 'hires' || s.hr) {
    addLXQuality(types, typeMap, 'hires', lxSizeFormat(s.hr && s.hr.size), {});
  }
  if (s.jm && s.jm.size) {
    addLXQuality(types, typeMap, 'master', lxSizeFormat(s.jm.size), {});
  }
  if (s.je && s.je.size) {
    addLXQuality(types, typeMap, 'atmos', lxSizeFormat(s.je.size), {});
  }
  if (s.sq || Number(privilege.maxbr) >= 999000) {
    addLXQuality(types, typeMap, 'flac', lxSizeFormat(s.sq && s.sq.size), {});
  }
  if (s.h || Number(privilege.maxbr) >= 320000) {
    addLXQuality(types, typeMap, '320k', lxSizeFormat(s.h && s.h.size), {});
  }
  if (s.m || s.l || types.length) {
    addLXQuality(types, typeMap, '128k', lxSizeFormat((s.l || s.m) && (s.l || s.m).size), {});
  }
  return { types, _types: typeMap };
}
function mapSongRecord(s) {
  s = s || {};
  const artists = mapArtists(s.ar || s.artists);
  const album = s.al || s.album || {};
  const qualityInfo = neteaseQualityTypesFromSong(s);
  return {
    provider: 'netease',
    source: 'netease',
    type: 'song',
    id: s.id,
    name: s.name,
    artist: artists.map(a => a.name).join(' / '),
    artists,
    artistId: artists[0] && artists[0].id,
    album: album.name || '',
    cover: album.picUrl || album.coverUrl || '',
    duration: s.dt || s.duration || 0,
    fee: s.fee,
    types: qualityInfo.types,
    _types: qualityInfo._types,
  };
}
function mapDiscoverPlaylist(pl, tag) {
  pl = pl || {};
  const creator = pl.creator || pl.user || {};
  const id = pl.id || pl.resourceId || pl.creativeId;
  return {
    provider: 'netease',
    source: 'netease',
    type: 'playlist',
    id,
    name: pl.name || pl.title || '',
    cover: pl.picUrl || pl.coverImgUrl || pl.coverUrl || pl.uiElement && pl.uiElement.image && pl.uiElement.image.imageUrl || '',
    trackCount: pl.trackCount || pl.songCount || pl.programCount || 0,
    playCount: pl.playCount || pl.playcount || 0,
    creator: creator.nickname || creator.name || '',
    tag: tag || pl.alg || '',
  };
}

function lowSignalText(value) {
  return String(value || '').trim().toLowerCase();
}

function isLowSignalPodcastItem(item) {
  const name = lowSignalText(item && (item.name || item.title || item.radioName));
  const sub = lowSignalText(item && (item.djName || item.category || item.desc || item.sub));
  const text = name + ' ' + sub;
  return /购买播客|付费精品|qzone|空间背景音乐|背景音乐|四只烤翅|试纸烤翅/i.test(text);
}

function isQQFavoritePlaylist(pl) {
  const name = String(pl && pl.name || '').trim();
  return /我喜欢|我的喜欢|喜欢的音乐/i.test(name);
}

function isQzoneBackgroundPlaylist(pl) {
  const text = String((pl && pl.name || '') + ' ' + (pl && pl.creator || '')).toLowerCase();
  return /qzone|空间|背景音乐/i.test(text);
}
async function requireLogin(res) {
  const info = await getLoginInfo();
  if (!info.loggedIn || !info.userId) {
    sendJSON(res, { error: 'LOGIN_REQUIRED', loggedIn: false }, 401);
    return null;
  }
  return info;
}

// ---------- 业务: 搜索 ----------
//   优先用 cloudsearch (新接口, 字段更全, picUrl 更稳定)
//   对于仍然缺失封面的歌曲, 用 song_detail 批量补齐
async function handleSearch(keywords, limit) {
  console.log('[Search]', keywords, 'limit:', limit);
  const result = await cloudsearch({ keywords, limit, cookie: userCookie });
  const songs = result.body && result.body.result && result.body.result.songs ? result.body.result.songs : [];

  let mapped = songs.map(s => {
    return mapSongRecord(s);
  });

  // 兜底: 补齐缺失的封面
  const missing = mapped.filter(s => !s.cover).map(s => s.id);
  if (missing.length) {
    try {
      console.log('[Search] backfilling covers for', missing.length, 'songs');
      const dd = await song_detail({ ids: missing.join(','), cookie: userCookie });
      const songsArr = (dd.body && dd.body.songs) || [];
      const idToPic = {};
      songsArr.forEach(s => {
        const pic = (s.al && s.al.picUrl) || (s.album && s.album.picUrl) || '';
        if (pic) idToPic[s.id] = pic;
      });
      mapped = mapped.map(s => s.cover ? s : { ...s, cover: idToPic[s.id] || '' });
    } catch (e) { console.warn('[Search] backfill failed:', e.message); }
  }

  return mapped;
}

async function handleDiscoverHome() {
  const info = await getLoginInfo();
  const loggedIn = !!(info && info.loggedIn);
  if (!loggedIn) {
    return {
      loggedIn: false,
      user: null,
      dailySongs: [],
      playlists: [],
      podcasts: [],
      mode: 'starter',
      updatedAt: Date.now(),
    };
  }
  const tasks = [
    personalized({ limit: 8, cookie: userCookie, timestamp: Date.now() }),
    dj_hot({ limit: 6, offset: 0, cookie: userCookie, timestamp: Date.now() }),
    recommend_resource({ cookie: userCookie, timestamp: Date.now() }),
    recommend_songs({ cookie: userCookie, timestamp: Date.now() }),
  ];
  const result = await Promise.allSettled(tasks);

  const personalizedBody = result[0].status === 'fulfilled' && result[0].value && result[0].value.body || {};
  const publicPlaylists = (personalizedBody.result || personalizedBody.data || [])
    .map(pl => mapDiscoverPlaylist(pl, '推荐歌单'))
    .filter(pl => pl.id && pl.name)
    .slice(0, 8);

  const podcastBody = result[1].status === 'fulfilled' && result[1].value && result[1].value.body || {};
  const podcastRaw = podcastBody.djRadios || podcastBody.djradios || podcastBody.radios || podcastBody.data || [];
  const podcasts = (Array.isArray(podcastRaw) ? podcastRaw : [])
    .map(mapPodcastRadio)
    .filter(p => p.id && !isLowSignalPodcastItem(p))
    .slice(0, 6);

  let privatePlaylists = [];
  if (result[2].status === 'fulfilled' && result[2].value) {
    const body = result[2].value.body || {};
    const raw = body.recommend || body.data || [];
    privatePlaylists = (Array.isArray(raw) ? raw : [])
      .map(pl => mapDiscoverPlaylist(pl, '私人推荐'))
      .filter(pl => pl.id && pl.name)
      .slice(0, 6);
  }

  let dailySongs = [];
  if (result[3].status === 'fulfilled' && result[3].value) {
    const body = result[3].value.body || {};
    const raw = body.data && (body.data.dailySongs || body.data.recommend) || body.recommend || [];
    dailySongs = (Array.isArray(raw) ? raw : [])
      .map(mapSongRecord)
      .filter(song => song.id && song.name)
      .slice(0, 12);
  }

  return {
    loggedIn,
    user: loggedIn ? { userId: info.userId, nickname: info.nickname || '', avatar: info.avatar || '' } : null,
    dailySongs,
    playlists: privatePlaylists.concat(publicPlaylists).slice(0, 10),
    podcasts,
    updatedAt: Date.now(),
  };
}

const QQ_MUSICU_URL = 'https://u.y.qq.com/cgi-bin/musicu.fcg';
const QQ_SMARTBOX_URL = 'https://c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg';
const QQ_HEADERS = {
  Referer: 'https://y.qq.com/',
  'User-Agent': UA,
};

function requestText(targetUrl, opts, body) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const u = new URL(targetUrl);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, {
      method: opts.method || 'GET',
      headers: opts.headers || {},
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (response.statusCode >= 400) {
          const err = new Error('HTTP ' + response.statusCode);
          err.statusCode = response.statusCode;
          err.body = text;
          reject(err);
          return;
        }
        resolve(text);
      });
    });
    req.setTimeout(10000, () => req.destroy(new Error('Request timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function requestJson(targetUrl, opts, body) {
  const text = await requestText(targetUrl, opts, body);
  try {
    return JSON.parse(text);
  } catch (e) {
    const err = new Error('Invalid JSON from ' + targetUrl);
    err.cause = e;
    throw err;
  }
}

async function lxFetchResponse(targetUrl, opts) {
  opts = opts || {};
  const headers = Object.assign({ 'User-Agent': UA }, opts.headers || {});
  const response = await fetchWithTimeout(targetUrl, {
    method: opts.method || 'GET',
    headers,
    body: opts.body,
  }, opts.timeoutMs || 12000);
  if (!response.ok) {
    const err = new Error('HTTP ' + response.status);
    err.statusCode = response.status;
    throw err;
  }
  return response;
}

async function lxFetchText(targetUrl, opts) {
  const response = await lxFetchResponse(targetUrl, opts);
  return response.text();
}

async function lxFetchJson(targetUrl, opts) {
  const text = await lxFetchText(targetUrl, opts);
  return parseJSONText(text);
}

async function lxFetchRaw(targetUrl, opts) {
  const response = await lxFetchResponse(targetUrl, opts);
  return Buffer.from(await response.arrayBuffer());
}

function lxFormBody(data) {
  const params = new URLSearchParams();
  Object.keys(data || {}).forEach(key => {
    if (data[key] != null) params.append(key, String(data[key]));
  });
  return params.toString();
}

function stripHtmlTags(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#40;/g, '(')
    .replace(/&#41;/g, ')')
    .trim();
}

function normalizeLxCoverUrl(url, size) {
  url = String(url || '').trim();
  if (!url) return '';
  if (url.includes('{size}')) url = url.replace(/\{size\}/g, String(size || 500));
  if (url && !/^https?:\/\//i.test(url)) url = 'http://d.musicapp.migu.cn' + url;
  return url;
}

function lxFormatDurationMs(seconds) {
  const n = Number(seconds) || 0;
  return n > 0 ? Math.round(n * 1000) : 0;
}

function lxArtistsFromText(text) {
  return String(text || '')
    .split(/\s*\/\s*|\s*,\s*|、|&| feat\.? | ft\.? /i)
    .map(name => ({ name: stripHtmlTags(name) }))
    .filter(a => a.name);
}

function lxSizeFormat(bytes) {
  const n = Number(bytes) || 0;
  if (!n) return '';
  if (n >= 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(2).replace(/\.?0+$/, '') + 'GB';
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(2).replace(/\.?0+$/, '') + 'MB';
  if (n >= 1024) return (n / 1024).toFixed(2).replace(/\.?0+$/, '') + 'KB';
  return n + 'B';
}

function addLXQuality(types, typeMap, type, size, extra) {
  if (extra && extra.requireEvidence && !size && !extra.hash) return;
  if (!type || typeMap[type]) return;
  const meta = {};
  if (size) meta.size = String(size).toUpperCase();
  if (extra && extra.hash) meta.hash = extra.hash;
  if (extra && extra.label) meta.label = String(extra.label);
  types.push(Object.assign({ type }, meta));
  typeMap[type] = meta;
}

function addLXQualityFromObject(types, typeMap, item, fallbackType) {
  if (!item) return;
  if (typeof item !== 'object') {
    addLXQuality(types, typeMap, normalizeLxSourceQuality(item || fallbackType), '');
    return;
  }
  const type = normalizeLxSourceQuality(item.type || item.quality || item.id || item.value || fallbackType);
  const size = item.size || item.sizeText || item.filesize || item.fileSize || item.FileSize || lxSizeFormat(item.info && item.info.filesize);
  const hash = item.hash || item.Hash || item.FileHash || '';
  const label = item.label || item.title || item.displayName || item.qualityName || item.quality_name || '';
  addLXQuality(types, typeMap, type, size, { hash, label });
}

function addLXQualitiesFromMap(types, typeMap, map) {
  if (!map || typeof map !== 'object') return;
  Object.keys(map).forEach(key => {
    const meta = map[key];
    if (meta === false || meta == null) return;
    if (meta && typeof meta === 'object') addLXQualityFromObject(types, typeMap, Object.assign({ type: key }, meta), key);
    else addLXQuality(types, typeMap, normalizeLxSourceQuality(key), '');
  });
}

function kgQualityTypeFromLevel(level, quality) {
  const raw = String(quality || '').toLowerCase().trim();
  if (raw === '128') return '128k';
  if (raw === '320') return '320k';
  if (raw === 'flac') return 'flac';
  if (raw === 'high') return 'hires';
  if (raw === 'dolby' || raw === 'viper_atmos') return 'atmos';
  if (raw === 'viper_clear') return 'master';
  if (raw === 'viper_tape') return '';
  const n = Number(level) || 0;
  if (n === 2) return '128k';
  if (n === 4) return '320k';
  if (n === 5) return 'flac';
  if (n === 6) return 'hires';
  return normalizeLxSourceQuality(quality || (n ? ('kg_level_' + n) : ''));
}

function addKugouRelateGoodsQuality(types, typeMap, item) {
  if (!item || typeof item !== 'object') return;
  const quality = item.quality || item.type || '';
  const type = kgQualityTypeFromLevel(item.level, quality);
  const size = item.size || item.filesize || item.fileSize || lxSizeFormat(item.info && item.info.filesize);
  const hash = item.hash || item.Hash || '';
  const label = item.qualityName || item.quality_name || item.label || item.title || '';
  addLXQuality(types, typeMap, type, size, { hash, label, requireEvidence: true });
}

async function getKugouBatchMusicQualityInfo(hashList) {
  const hashes = Array.from(new Set((hashList || []).map(hash => String(hash || '').trim()).filter(Boolean)));
  const qualityInfoMap = {};
  if (!hashes.length) return qualityInfoMap;
  const resources = hashes.map(hash => ({ id: 0, type: 'audio', hash }));
  const body = JSON.stringify({
    behavior: 'play',
    clientver: '20049',
    resource: resources,
    area_code: '1',
    quality: '128',
    qualities: ['128', '320', 'flac', 'high', 'dolby', 'viper_atmos', 'viper_tape', 'viper_clear'],
  });
  const json = await requestJson(
    'https://gateway.kugou.com/goodsmstore/v1/get_res_privilege?appid=1005&clientver=20049&clienttime=' + Date.now() + '&mid=NeZha',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': UA,
        Referer: 'https://www.kugou.com/',
      },
    },
    body
  );
  const list = json && Array.isArray(json.data) ? json.data : [];
  list.forEach((songData, index) => {
    const hash = hashes[index];
    const types = [];
    const _types = {};
    if (songData && Array.isArray(songData.relate_goods)) {
      songData.relate_goods.forEach(item => addKugouRelateGoodsQuality(types, _types, item));
    }
    qualityInfoMap[hash] = { types, _types };
  });
  return qualityInfoMap;
}

function lxQualityTypesFromRaw(source, raw) {
  raw = raw || {};
  const types = [];
  const typeMap = {};
  if (raw.meta && typeof raw.meta === 'object') {
    if (Array.isArray(raw.meta.qualitys)) raw.meta.qualitys.forEach(item => addLXQualityFromObject(types, typeMap, item));
    addLXQualitiesFromMap(types, typeMap, raw.meta._qualitys);
  }
  if (Array.isArray(raw.types)) {
    raw.types.forEach(item => addLXQualityFromObject(types, typeMap, item));
  }
  addLXQualitiesFromMap(types, typeMap, raw._types);
  if (Array.isArray(raw.qualitys)) raw.qualitys.forEach(item => addLXQualityFromObject(types, typeMap, item));
  if (Array.isArray(raw.qualities)) raw.qualities.forEach(item => addLXQualityFromObject(types, typeMap, item));

  if (source === 'kw' && raw.N_MINFO) {
    String(raw.N_MINFO).split(';').forEach(info => {
      const m = String(info || '').match(/level:(\w+),bitrate:(\d+),format:(\w+),size:([\w.]+)/);
      if (!m) return;
      const size = m[4];
      if (m[2] === '20900') addLXQuality(types, typeMap, 'master', size);
      else if (m[2] === '20501') addLXQuality(types, typeMap, 'atmos_plus', size);
      else if (m[2] === '20201') addLXQuality(types, typeMap, 'atmos', size);
      else if (m[2] === '4000') addLXQuality(types, typeMap, 'hires', size);
      else if (m[2] === '2000') addLXQuality(types, typeMap, 'flac', size);
      else if (m[2] === '320') addLXQuality(types, typeMap, '320k', size);
      else if (m[2] === '128') addLXQuality(types, typeMap, '128k', size);
    });
    types.reverse();
  } else if (source === 'kg') {
    addLXQuality(types, typeMap, '128k', lxSizeFormat(raw.FileSize), { hash: raw.FileHash, requireEvidence: true });
    addLXQuality(types, typeMap, '320k', lxSizeFormat(raw.HQFileSize), { hash: raw.HQFileHash, requireEvidence: true });
    addLXQuality(types, typeMap, 'flac', lxSizeFormat(raw.SQFileSize), { hash: raw.SQFileHash, requireEvidence: true });
    addLXQuality(types, typeMap, 'hires', lxSizeFormat(raw.ResFileSize), { hash: raw.ResFileHash, requireEvidence: true });
    if (raw.audio_info && typeof raw.audio_info === 'object') {
      const audio = raw.audio_info;
      addLXQuality(types, typeMap, '128k', lxSizeFormat(audio.filesize), { hash: audio.hash, requireEvidence: true });
      addLXQuality(types, typeMap, '320k', lxSizeFormat(audio.filesize_320), { hash: audio.hash_320, requireEvidence: true });
      addLXQuality(types, typeMap, 'ape', lxSizeFormat(audio.filesize_ape), { hash: audio.hash_ape, requireEvidence: true });
      addLXQuality(types, typeMap, 'flac', lxSizeFormat(audio.filesize_flac), { hash: audio.hash_flac, requireEvidence: true });
      addLXQuality(types, typeMap, 'hires', lxSizeFormat(audio.filesize_high), { hash: audio.hash_high, requireEvidence: true });
    }
    if (Array.isArray(raw.relate_goods)) raw.relate_goods.forEach(item => addKugouRelateGoodsQuality(types, typeMap, item));
  } else if (source === 'mg' && Array.isArray(raw.audioFormats)) {
    raw.audioFormats.forEach(format => {
      const size = lxSizeFormat(format && (format.asize != null ? format.asize : format.isize));
      if (!format) return;
      if (format.formatType === 'PQ') addLXQuality(types, typeMap, '128k', size);
      else if (format.formatType === 'HQ') addLXQuality(types, typeMap, '320k', size);
      else if (format.formatType === 'SQ') addLXQuality(types, typeMap, 'flac', size);
      else if (format.formatType === 'ZQ24') addLXQuality(types, typeMap, 'hires', size);
    });
  }
  return { types, _types: typeMap };
}

function lxIntervalSeconds(raw, durationMs) {
  const interval = raw && raw.interval;
  if (typeof interval === 'number') return interval;
  if (typeof interval === 'string') {
    const parts = interval.split(':').map(v => parseInt(v, 10));
    if (parts.length === 2 && parts.every(n => Number.isFinite(n))) return parts[0] * 60 + parts[1];
    if (parts.length === 3 && parts.every(n => Number.isFinite(n))) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  if (raw && raw._interval) return Number(raw._interval) || 0;
  return durationMs ? Math.round(durationMs / 1000) : 0;
}

function normalizeLxSourceQuality(value) {
  const raw = String(value || '').toLowerCase().trim().replace(/\s+/g, '').replace(/-/g, '');
  if (!raw) return '';
  if (['jymaster', 'master', 'studio', 'svip'].includes(raw)) return 'master';
  if (['atmosplus', 'atmos_plus', 'dolbyatmosplus'].includes(raw)) return 'atmos_plus';
  if (['atmos', 'dolby', 'dolbyatmos'].includes(raw)) return 'atmos';
  if (['hires', 'highres', 'hr'].includes(raw)) return 'hires';
  if (['flac24bit', 'flac24', 'flac32bit', 'flac32', '32bit', '24bit', '24bitflac', 'zq24'].includes(raw)) return 'hires';
  if (['lossless', 'flac', 'sq'].includes(raw)) return 'flac';
  if (raw === 'ape') return 'ape';
  if (raw === 'wav') return 'wav';
  if (['192', '192k'].includes(raw)) return '192k';
  if (['exhigh', 'high', 'hq', '320', '320k'].includes(raw)) return '320k';
  if (['standard', 'normal', 'std', '128', '128k'].includes(raw)) return '128k';
  return raw;
}

function normalizeLxRequestedQuality(value) {
  return normalizeLxSourceQuality(value) || normalizeQualityPreference(value);
}

function lxQualityToSourceType(quality, supported) {
  const requested = normalizeLxRequestedQuality(quality);
  const rawRequested = String(quality || '').trim();
  const rawSupported = Array.isArray(supported) && supported.length ? supported.map(item => String(item || '').trim()).filter(Boolean) : [];
  const normalizedSupported = rawSupported.map(item => ({ raw: item, normalized: normalizeLxSourceQuality(item) }));
  if (rawRequested) {
    const direct = rawSupported.find(item => item.toLowerCase() === rawRequested.toLowerCase());
    if (direct) return direct;
  }
  if (requested) {
    const alias = normalizedSupported.find(item => item.normalized === requested);
    if (alias) return alias.raw;
    return requested;
  }
  return rawRequested || rawSupported[0] || '128k';
}

function mapLxSong(source, raw) {
  raw = raw || {};
  const songmid = raw.songmid || raw.songId || raw.id || raw.Audioid || '';
  const hash = raw.hash || raw.FileHash || '';
  const artist = stripHtmlTags(raw.artist || raw.singer || raw.singers || '');
  const artists = Array.isArray(raw.artists) ? raw.artists : lxArtistsFromText(artist);
  const name = stripHtmlTags(raw.name || raw.songName || raw.SongName || '');
  const album = stripHtmlTags(raw.album || raw.albumName || raw.AlbumName || '');
  const cover = normalizeLxCoverUrl(raw.cover || raw.img || raw.pic || raw.Image || raw.AlbumImage || '', 500);
  const duration = raw.duration || lxFormatDurationMs(raw._interval || raw.interval);
  const qualityInfo = lxQualityTypesFromRaw(source, raw);
  const lxMusicInfo = Object.assign({}, raw, {
    source,
    songmid,
    mid: raw.mid || raw.songmid || songmid,
    hash,
    name,
    singer: artist,
    artist,
    albumName: album,
    album,
    albumId: raw.albumId || raw.albumMid || '',
    img: cover || null,
    cover,
    interval: raw.interval || lxIntervalSeconds(raw, duration),
    _interval: raw._interval || lxIntervalSeconds(raw, duration),
    types: qualityInfo.types,
    _types: qualityInfo._types,
    typeUrl: raw.typeUrl || {},
  });
  return {
    provider: 'lx',
    source: 'lx',
    type: 'lx',
    lxSource: source,
    lxSourceName: LX_SOURCE_NAMES[source] || source.toUpperCase(),
    id: source + ':' + (songmid || hash || crypto.createHash('md5').update(name + '|' + artist + '|' + album).digest('hex').slice(0, 12)),
    songmid,
    hash,
    mid: raw.mid || raw.songmid || songmid,
    mediaMid: raw.mediaMid || raw.strMediaMid || raw.media_mid || '',
    qqId: raw.qqId || raw.songId || '',
    copyrightId: raw.copyrightId || '',
    name,
    artist,
    artists,
    album,
    albumId: raw.albumId || raw.albumMid || '',
    cover,
    duration,
    playable: false,
    fee: 0,
    lxMusicInfo,
  };
}

const LX_SOURCE_NAMES = {
  kw: '酷我',
  kg: '酷狗',
  tx: 'QQ',
  wy: '网易云',
};
const LX_DEFAULT_SEARCH_SOURCES = ['kw', 'kg', 'wy', 'tx'];
const LX_SEARCH_SOURCE_TIMEOUT_MS = Math.max(900, Math.min(8000, Number(process.env.MINERADIO_LX_SEARCH_TIMEOUT_MS) || 2600));
const lxSearchSourceCache = new Map();

function lxSearchCacheKey(source, keywords, limit) {
  return [source, String(keywords || '').trim().toLowerCase(), limit].join('\x1f');
}

async function runCachedLXSourceSearch(source, keywords, limit) {
  const key = lxSearchCacheKey(source, keywords, limit);
  const cached = lxSearchSourceCache.get(key);
  if (cached && Date.now() - cached.time < 3 * 60 * 1000) return cached.list.map(song => Object.assign({}, song));
  let list;
  if (source === 'kw') list = await handleLXKuwoSearch(keywords, limit);
  else if (source === 'kg') list = await handleLXKugouSearch(keywords, limit);
  else if (source === 'mg') list = await handleLXMiguSearch(keywords, limit);
  else list = await handleLXMappedSearch(source, keywords, limit);
  list = Array.isArray(list) ? list : [];
  lxSearchSourceCache.set(key, { time: Date.now(), list: list.map(song => Object.assign({}, song)) });
  if (lxSearchSourceCache.size > 80) {
    const now = Date.now();
    for (const [cacheKey, item] of lxSearchSourceCache) {
      if (now - item.time > 90 * 1000 || lxSearchSourceCache.size > 64) lxSearchSourceCache.delete(cacheKey);
    }
  }
  return list;
}

function settleLXSourceSearch(source, promise, timeoutMs) {
  const started = Date.now();
  return Promise.race([
    promise.then(value => ({
      status: 'fulfilled',
      source,
      value: Array.isArray(value) ? value : [],
      elapsedMs: Date.now() - started,
    })).catch(reason => ({
      status: 'rejected',
      source,
      reason,
      value: [],
      elapsedMs: Date.now() - started,
    })),
    new Promise(resolve => setTimeout(() => resolve({
      status: 'timeout',
      source,
      reason: new Error('LX_SOURCE_SEARCH_TIMEOUT'),
      value: [],
      elapsedMs: Date.now() - started,
    }), timeoutMs)),
  ]);
}

async function handleLXKuwoSearch(keywords, limit) {
  const u = 'http://search.kuwo.cn/r.s?client=kt&all=' + encodeURIComponent(keywords) +
    '&pn=0&rn=' + encodeURIComponent(limit) +
    '&uid=794762570&ver=kwplayer_ar_9.2.2.1&vipver=1&show_copyright_off=1&newver=1&ft=music&cluster=0&strategy=2012&encoding=utf8&rformat=json&vermerge=1&mobi=1&issubtitle=1';
  const json = await requestJson(u, { headers: { 'User-Agent': UA, Referer: 'http://www.kuwo.cn/' } });
  const raw = Array.isArray(json && json.abslist) ? json.abslist : [];
  return raw.map(item => mapLxSong('kw', {
    songmid: String(item.MUSICRID || '').replace(/^MUSIC_/, ''),
    name: item.SONGNAME,
    singer: item.ARTIST,
    albumName: item.ALBUM,
    albumId: item.ALBUMID,
    interval: Number(item.DURATION) || 0,
    N_MINFO: item.N_MINFO,
  })).filter(song => song.songmid && song.name);
}

async function handleLXKugouSearch(keywords, limit) {
  const u = 'https://songsearch.kugou.com/song_search_v2?keyword=' + encodeURIComponent(keywords) +
    '&page=1&pagesize=' + encodeURIComponent(limit) + '&userid=0&clientver=&platform=WebFilter&filter=2&iscorrection=1&privilege_filter=0&area_code=1';
  const json = await requestJson(u, { headers: { 'User-Agent': UA, Referer: 'https://www.kugou.com/' } });
  const raw = json && json.data && Array.isArray(json.data.lists) ? json.data.lists : [];
  const rows = [];
  const seen = new Set();
  raw.forEach(item => {
    [item].concat(Array.isArray(item.Grp) ? item.Grp : []).forEach(data => {
      const key = data && (data.Audioid + ':' + data.FileHash);
      if (!data || !data.Audioid || !data.FileHash || seen.has(key)) return;
      seen.add(key);
      rows.push(data);
    });
  });
  let qualityInfoMap = {};
  try {
    qualityInfoMap = await getKugouBatchMusicQualityInfo(rows.slice(0, limit).map(item => item.FileHash));
  } catch (e) {
    warnLXOptionalUserApi('[LXKugouQualityDetail]', 'kg', e);
  }
  const out = [];
  rows.forEach(data => {
      const qualityInfo = qualityInfoMap[data.FileHash] || {};
      out.push(mapLxSong('kg', {
        songmid: data.Audioid,
        hash: data.FileHash,
        name: data.SongName,
        singer: Array.isArray(data.Singers) ? data.Singers.map(s => s && s.name).filter(Boolean).join(' / ') : data.SingerName,
        albumName: data.AlbumName,
        albumId: data.AlbumID,
        interval: Number(data.Duration) || 0,
        FileHash: data.FileHash,
        FileSize: data.FileSize,
        HQFileHash: data.HQFileHash,
        HQFileSize: data.HQFileSize,
        SQFileHash: data.SQFileHash,
        SQFileSize: data.SQFileSize,
        ResFileHash: data.ResFileHash,
        ResFileSize: data.ResFileSize,
        types: Array.isArray(qualityInfo.types) && qualityInfo.types.length ? qualityInfo.types : data.types,
        _types: qualityInfo._types && Object.keys(qualityInfo._types).length ? qualityInfo._types : data._types,
        img: data.Image || data.AlbumImage || '',
      }));
  });
  return out.filter(song => song.hash && song.name).slice(0, limit);
}

function createMiguSignature(time, keywords) {
  const deviceId = '963B7AA0D21511ED807EE5846EC87D20';
  const signatureMd5 = '6cdc72a439cef99a3418d2a78aa28c73';
  const raw = `${keywords}${signatureMd5}yyapp2d16148780a1dcc7408e06336b98cfd50${deviceId}${time}`;
  return {
    deviceId,
    sign: crypto.createHash('md5').update(raw).digest('hex'),
  };
}

async function handleLXMiguSearch(keywords, limit) {
  const time = Date.now().toString();
  const signData = createMiguSignature(time, keywords);
  const u = 'https://jadeite.migu.cn/music_search/v3/search/searchAll?isCorrect=0&isCopyright=1' +
    '&searchSwitch=%7B%22song%22%3A1%2C%22album%22%3A0%2C%22singer%22%3A0%2C%22tagSong%22%3A1%2C%22mvSong%22%3A0%2C%22bestShow%22%3A1%2C%22songlist%22%3A0%2C%22lyricSong%22%3A0%7D' +
    '&pageSize=' + encodeURIComponent(limit) + '&text=' + encodeURIComponent(keywords) + '&pageNo=1&sort=0&sid=USS';
  const json = await requestJson(u, {
    headers: {
      uiVersion: 'A_music_3.6.1',
      deviceId: signData.deviceId,
      timestamp: time,
      sign: signData.sign,
      channel: '0146921',
      'User-Agent': 'Mozilla/5.0 (Linux; Android 11; MI 11) AppleWebKit/534.30 Mobile Safari/534.30',
    },
  });
  const groups = json && json.songResultData && Array.isArray(json.songResultData.resultList) ? json.songResultData.resultList : [];
  const out = [];
  const seen = new Set();
  groups.forEach(group => {
    (Array.isArray(group) ? group : []).forEach(item => {
      if (!item || !item.songId || !item.copyrightId || seen.has(item.copyrightId)) return;
      seen.add(item.copyrightId);
      let img = item.img3 || item.img2 || item.img1 || '';
      if (img && !/^https?:\/\//i.test(img)) img = 'http://d.musicapp.migu.cn' + img;
      out.push(mapLxSong('mg', {
        songmid: item.songId,
        copyrightId: item.copyrightId,
        name: item.name,
        singer: Array.isArray(item.singerList) ? item.singerList.map(s => s && (s.name || s.singerName)).filter(Boolean).join(' / ') : '',
        albumName: item.album,
        albumId: item.albumId,
        interval: Number(item.duration) || 0,
        img,
        audioFormats: item.audioFormats,
        lrcUrl: item.lrcUrl,
        mrcUrl: item.mrcurl,
        trcUrl: item.trcUrl,
      }));
    });
  });
  return out.filter(song => song.songmid && song.name).slice(0, limit);
}

async function handleLXMappedSearch(source, keywords, limit) {
  if (source === 'wy') {
    const songs = await handleSearch(keywords, limit);
    return songs.map(song => mapLxSong('wy', {
      songmid: song.id,
      id: song.id,
      name: song.name,
      singer: song.artist,
      artists: song.artists,
      albumName: song.album,
      img: song.cover,
      duration: song.duration,
      types: song.types,
      _types: song._types,
    }));
  }
  if (source === 'tx') {
    const songs = await handleQQSearch(keywords, limit);
    return songs.map(song => mapLxSong('tx', {
      songmid: song.mid || song.songmid || song.id,
      mid: song.mid || song.songmid,
      songId: song.qqId,
      strMediaMid: song.mediaMid,
      name: song.name,
      singer: song.artist,
      artists: song.artists,
      albumName: song.album,
      albumMid: song.albumMid,
      img: song.cover,
      duration: song.duration,
      types: song.types,
      _types: song._types,
    }));
  }
  return [];
}

async function handleLXSearch(keywords, limit, sources, opts) {
  opts = opts || {};
  const kw = String(keywords || '').trim();
  if (!kw) return [];
  const perSourceLimit = Math.max(4, Math.min(12, parseInt(limit || '8', 10) || 8));
  const timeoutMs = Math.max(700, Math.min(8000, Number(opts.timeoutMs) || LX_SEARCH_SOURCE_TIMEOUT_MS));
  const hasExplicitSources = String(sources || '').trim() !== '';
  const requested = String(sources || LX_DEFAULT_SEARCH_SOURCES.join(','))
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(s => LX_SOURCE_NAMES[s]);
  if (hasExplicitSources && !requested.length) {
    const empty = [];
    Object.defineProperty(empty, '_lxSearchMeta', { value: { partial: false, timeoutMs, sources: {} }, enumerable: false });
    return empty;
  }
  const uniqueSources = Array.from(new Set(requested.length ? requested : LX_DEFAULT_SEARCH_SOURCES));
  const tasks = uniqueSources.map(source => settleLXSourceSearch(
    source,
    runCachedLXSourceSearch(source, kw, perSourceLimit),
    timeoutMs
  ));
  const settled = await Promise.all(tasks);
  const maxResult = Math.max(8, Math.min(36, parseInt(limit || '18', 10) || 18));
  const buckets = [];
  const seen = new Set();
  const meta = { partial: false, timeoutMs, sources: {} };
  settled.forEach((result) => {
    meta.sources[result.source] = {
      status: result.status,
      count: Array.isArray(result.value) ? result.value.length : 0,
      elapsedMs: result.elapsedMs || 0,
    };
    if (result.status !== 'fulfilled') {
      meta.partial = true;
      console.warn('[LXSearch]', result.source, result.reason && result.reason.message || result.reason);
      return;
    }
    const bucket = [];
    (result.value || []).forEach(song => {
      const key = song && (song.lxSource + ':' + (song.songmid || song.hash || song.name + '|' + song.artist));
      if (!key || seen.has(key)) return;
      seen.add(key);
      bucket.push(song);
    });
    if (bucket.length) buckets.push(bucket);
  });
  const out = [];
  for (let i = 0; out.length < maxResult; i++) {
    let added = false;
    for (const bucket of buckets) {
      if (out.length >= maxResult) break;
      if (i < bucket.length) {
        out.push(bucket[i]);
        added = true;
      }
    }
    if (!added) break;
  }
  Object.defineProperty(out, '_lxSearchMeta', { value: meta, enumerable: false });
  return out;
}

const LX_EVENT_NAMES = {
  inited: 'inited',
  request: 'request',
  updateAlert: 'updateAlert',
};
const LX_USER_API_SUPPORT_ACTIONS = {
  kw: ['musicUrl'],
  kg: ['musicUrl'],
  tx: ['musicUrl'],
  wy: ['musicUrl'],
  local: ['musicUrl', 'lyric', 'pic'],
};
let lxUserApiCache = null;

function normalizeLXUserApiQualitys(qualitys) {
  const list = [];
  function add(value) {
    if (value && typeof value === 'object') value = value.type || value.quality || value.name || value.id || value.value;
    value = String(value || '').trim();
    if (value && !list.includes(value)) list.push(value);
  }
  if (Array.isArray(qualitys)) qualitys.forEach(add);
  else if (qualitys && typeof qualitys === 'object') Object.keys(qualitys).forEach(key => {
    if (qualitys[key] !== false && qualitys[key] != null) add(key);
  });
  else add(qualitys);
  return list;
}

function normalizeLXUserApiSources(sources) {
  const out = {};
  sources = sources && typeof sources === 'object' ? sources : {};
  Object.keys(LX_USER_API_SUPPORT_ACTIONS).forEach(source => {
    const info = sources[source];
    if (!info || info.type !== 'music') return;
    const declaredActions = Array.isArray(info.actions) ? info.actions : [];
    const actions = LX_USER_API_SUPPORT_ACTIONS[source].filter(action => declaredActions.includes(action));
    const qualitys = normalizeLXUserApiQualitys(info.qualitys);
    if (!actions.length) return;
    out[source] = {
      name: info.name || source,
      type: 'music',
      actions,
      qualitys,
    };
  });
  return out;
}

function lxSourceScriptCandidates() {
  const candidates = [];
  if (LX_SOURCE_FILE) candidates.push(LX_SOURCE_FILE);
  candidates.push(path.join(__dirname, 'lx-source.js'));
  candidates.push(path.join(__dirname, 'lx-music-source.js'));
  candidates.push(path.join(__dirname, 'lx-sources', 'source.js'));
  return candidates.map(p => path.resolve(p));
}

function resolveLXSourceScriptPath() {
  return lxSourceScriptCandidates().find(file => {
    try { return fs.existsSync(file) && fs.statSync(file).isFile(); }
    catch (e) { return false; }
  }) || '';
}

function writableLXSourceScriptPath() {
  const target = path.resolve(LX_SOURCE_FILE || path.join(__dirname, 'lx-source.js'));
  return target;
}

function validateLXSourceScript(script) {
  script = String(script || '').replace(/^\uFEFF/, '');
  if (!script.trim()) throw new Error('LX_SOURCE_EMPTY');
  if (Buffer.byteLength(script, 'utf8') > 2 * 1024 * 1024) throw new Error('LX_SOURCE_TOO_LARGE');
  if (!/@name\s+/.test(script.slice(0, 4096))) throw new Error('LX_SOURCE_MISSING_NAME');
  if (!/EVENT_NAMES|globalThis\.lx|lx\.send|send\(EVENT_NAMES\.inited/.test(script)) throw new Error('LX_SOURCE_FORMAT_UNCLEAR');
  return script;
}

function saveLXSourceScript(script) {
  const content = validateLXSourceScript(script);
  const target = writableLXSourceScriptPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, target);
  lxUserApiCache = null;
  return target;
}

function clearLXSourceScript() {
  const targets = Array.from(new Set(lxSourceScriptCandidates()));
  const removed = [];
  targets.forEach(file => {
    try {
      if (fs.existsSync(file) && fs.statSync(file).isFile()) {
        fs.unlinkSync(file);
        removed.push(file);
      }
    } catch (e) {
      console.warn('[LXSourceClear]', file, e.message);
    }
  });
  lxUserApiCache = null;
  return removed;
}

function parseLXResponseBody(text, contentType) {
  const raw = String(text || '');
  const trimmed = raw.trim();
  if (/json/i.test(String(contentType || '')) || /^[\[{]/.test(trimmed)) {
    try { return JSON.parse(trimmed); } catch (e) {}
  }
  return raw;
}

function lxScriptRequest(targetUrl, options, callback) {
  options = options || {};
  callback = typeof callback === 'function' ? callback : function() {};
  const method = String(options.method || (options.body || options.data || options.form || options.formData ? 'POST' : 'GET')).toUpperCase();
  const headers = Object.assign({}, options.headers || {});
  let body = options.body || options.data || null;
  if (!body && options.form && typeof options.form === 'object') {
    body = new URLSearchParams();
    Object.keys(options.form).forEach(key => {
      if (options.form[key] != null) body.append(key, String(options.form[key]));
    });
    if (!headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
  } else if (!body && options.formData && typeof options.formData === 'object') {
    body = new URLSearchParams();
    Object.keys(options.formData).forEach(key => {
      if (options.formData[key] != null) body.append(key, String(options.formData[key]));
    });
    if (!headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
  }
  if (body && typeof body === 'object' && !Buffer.isBuffer(body) && !(body instanceof URLSearchParams)) {
    body = JSON.stringify(body);
    if (!headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = 'application/json';
  }
  const timeoutMs = Math.max(1000, Math.min(60000, Number(options.timeout) || 12000));
  fetchWithTimeout(targetUrl, { method, headers, body }, timeoutMs).then(async response => {
    const text = await response.text();
    const resp = {
      statusCode: response.status,
      status: response.status,
      statusMessage: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
      body: parseLXResponseBody(text, response.headers.get('content-type')),
      rawBody: text,
      raw: Buffer.from(text),
    };
    callback(null, resp, resp.body);
  }).catch(err => callback(err));
}

function createLXScriptUtils() {
  return {
    crypto: {
      aesEncrypt(buffer, mode, key, iv) {
        const cipher = crypto.createCipheriv(mode, key, iv);
        return Buffer.concat([cipher.update(buffer), cipher.final()]);
      },
      rsaEncrypt(buffer, key) {
        const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
        const padded = Buffer.concat([Buffer.alloc(Math.max(0, 128 - buf.length)), buf]);
        return crypto.publicEncrypt({ key, padding: crypto.constants.RSA_NO_PADDING }, padded);
      },
      randomBytes(size) {
        return crypto.randomBytes(size);
      },
      md5(value) {
        return crypto.createHash('md5').update(String(value)).digest('hex');
      },
    },
    buffer: {
      from(...args) {
        return Buffer.from(...args);
      },
      bufToString(buf, format) {
        return Buffer.from(buf, 'binary').toString(format);
      },
    },
    zlib: {
      inflate(buf) {
        return new Promise((resolve, reject) => {
          zlib.inflate(buf, (err, data) => err ? reject(new Error(err.message)) : resolve(data));
        });
      },
      deflate(data) {
        return new Promise((resolve, reject) => {
          zlib.deflate(data, (err, buf) => err ? reject(new Error(err.message)) : resolve(buf));
        });
      },
    },
  };
}

function createLXScriptContext(scriptFile) {
  const events = {};
  const apiInfo = { status: false, sources: {}, openDevTools: false, updateAlert: null };
  const lxApi = {
    version: '2.0.0',
    compatVersion: 'mineradio-1',
    env: 'desktop',
    EVENT_NAMES: LX_EVENT_NAMES,
    currentScriptInfo: { rawScript: fs.readFileSync(scriptFile, 'utf8') },
    utils: createLXScriptUtils(),
    request: lxScriptRequest,
    on(eventName, handler) {
      if (!Object.values(LX_EVENT_NAMES).includes(eventName)) return Promise.reject(new Error('The event is not supported: ' + eventName));
      if (eventName !== LX_EVENT_NAMES.request) return Promise.reject(new Error('The event is not supported: ' + eventName));
      if (typeof handler === 'function') events[eventName] = handler;
      return Promise.resolve();
    },
    send(eventName, datas) {
      if (eventName === LX_EVENT_NAMES.inited) {
        apiInfo.status = datas && datas.status !== false;
        apiInfo.sources = normalizeLXUserApiSources(datas && datas.sources);
        apiInfo.openDevTools = !!(datas && datas.openDevTools);
      } else if (eventName === LX_EVENT_NAMES.updateAlert) {
        apiInfo.updateAlert = datas || null;
      } else {
        return Promise.reject(new Error('The event is not supported: ' + eventName));
      }
      return Promise.resolve();
    },
  };
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Promise,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    encodeURIComponent,
    decodeURIComponent,
    Buffer,
    FormData,
    Headers,
    Request,
    Response,
    atob: value => Buffer.from(String(value), 'base64').toString('binary'),
    btoa: value => Buffer.from(String(value), 'binary').toString('base64'),
    lx: lxApi,
  };
  sandbox.globalThis = sandbox;
  sandbox.lx = lxApi;
  return { sandbox, events, apiInfo, script: lxApi.currentScriptInfo.rawScript };
}

function loadLXUserApi() {
  const scriptFile = resolveLXSourceScriptPath();
  if (!scriptFile) return { ok: false, error: 'LX_SOURCE_NOT_CONFIGURED', message: '未找到落雪自定义源脚本，请设置 MINERADIO_LX_SOURCE_FILE 或把脚本放到 lx-source.js。', sources: {} };
  let stat;
  try { stat = fs.statSync(scriptFile); } catch (e) { return { ok: false, error: e.message, sources: {} }; }
  if (lxUserApiCache && lxUserApiCache.file === scriptFile && lxUserApiCache.mtimeMs === stat.mtimeMs) return lxUserApiCache.api;
  const context = createLXScriptContext(scriptFile);
  try {
    vm.runInNewContext(context.script, context.sandbox, { filename: scriptFile, timeout: 5000 });
    if (!context.apiInfo.status || typeof context.events[LX_EVENT_NAMES.request] !== 'function') {
      throw new Error('LX_SOURCE_INIT_FAILED');
    }
    const api = { ok: true, file: scriptFile, events: context.events, sources: context.apiInfo.sources || {} };
    lxUserApiCache = { file: scriptFile, mtimeMs: stat.mtimeMs, api };
    return api;
  } catch (e) {
    lxUserApiCache = null;
    return { ok: false, file: scriptFile, error: e.message || 'LX_SOURCE_INIT_FAILED', sources: {} };
  }
}

async function callLXUserApi(source, action, info) {
  const api = loadLXUserApi();
  if (!api.ok) {
    const restriction = playbackRestriction('lx', 'source_not_configured', api.message || '落雪自定义源未配置，无法获取播放地址', 'configure_source', { error: api.error });
    return { provider: 'lx', url: '', playable: false, reason: restriction.category, message: restriction.message, restriction, sources: api.sources || {} };
  }
  const handler = api.events[LX_EVENT_NAMES.request];
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('LX_SOURCE_TIMEOUT')), 15000));
  const result = await Promise.race([
    Promise.resolve(handler({ source, action, info })),
    timeout,
  ]);
  return result;
}

function lxSourceInfoFor(source) {
  const api = loadLXUserApi();
  return api && api.ok && api.sources ? api.sources[source] : null;
}

function normalizeLXMusicInfo(source, info) {
  const raw = info && typeof info === 'object' ? Object.assign({}, info) : {};
  raw.source = source;
  if (raw.hash === '') delete raw.hash;
  if (!raw.songmid && raw.mid) raw.songmid = raw.mid;
  if (!raw.songmid && raw.id && !String(raw.id).includes(':')) raw.songmid = raw.id;
  if (!raw.hash && raw.FileHash) raw.hash = raw.FileHash;
  if (!raw.singer && raw.artist) raw.singer = raw.artist;
  if (!raw.albumName && raw.album) raw.albumName = raw.album;
  if (!raw.img && raw.cover) raw.img = raw.cover;
  if (!Array.isArray(raw.types)) raw.types = [];
  if (!raw._types || typeof raw._types !== 'object') raw._types = {};
  if (!raw.typeUrl || typeof raw.typeUrl !== 'object') raw.typeUrl = {};
  return raw;
}

function extractLXMusicUrl(result) {
  function from(value, depth) {
    if (!value || depth > 4) return '';
    if (typeof value === 'string') return /^https?:\/\//i.test(value) ? value : '';
    if (typeof value !== 'object') return '';
    if (typeof value.url === 'string' && /^https?:\/\//i.test(value.url)) return value.url;
    if (typeof value.location === 'string' && /^https?:\/\//i.test(value.location)) return value.location;
    return from(value.data, depth + 1) || from(value.body, depth + 1) || from(value.result, depth + 1);
  }
  return from(result, 0);
}

function extractLXLyricInfo(result) {
  function from(value, depth) {
    if (!value || depth > 5) return null;
    if (typeof value === 'string') return value.trim() ? { lyric: value } : null;
    if (typeof value !== 'object') return null;
    const lyric = value.lyric || value.lrc || value.lrcText || value.text || '';
    const tlyric = value.tlyric || value.tlrc || value.trans || value.transLyric || '';
    const rlyric = value.rlyric || value.rlrc || '';
    const yrc = value.yrc || '';
    const lxlyric = value.lxlyric || '';
    if (lyric || tlyric || rlyric || yrc || lxlyric) {
      return { provider: 'lx', lyric: lyric || '', tlyric: tlyric || '', rlyric: rlyric || '', yrc: yrc || '', lxlyric: lxlyric || '' };
    }
    return from(value.data, depth + 1) || from(value.body, depth + 1) || from(value.result, depth + 1);
  }
  return from(result, 0) || { provider: 'lx', lyric: '' };
}

function extractLXPicUrl(result) {
  function from(value, depth) {
    if (!value || depth > 5) return '';
    if (typeof value === 'string') return normalizeLxCoverUrl(value, 500);
    if (typeof value !== 'object') return '';
    const direct = value.url || value.pic || value.img || value.cover || value.location || '';
    if (direct) return normalizeLxCoverUrl(direct, 500);
    return from(value.data, depth + 1) || from(value.body, depth + 1) || from(value.result, depth + 1);
  }
  return from(result, 0);
}

function compactErrorMessage(error) {
  if (!error) return '';
  if (error.message) return error.message;
  if (typeof error === 'string') return error;
  try { return String(error); } catch (e) { return ''; }
}

function warnLXOptionalUserApi(label, source, error) {
  const message = compactErrorMessage(error);
  if (message && message !== 'undefined') {
    console.warn(label, source, message);
  } else if (process.env.MINERADIO_LX_DEBUG === '1') {
    console.warn(label, source, 'empty response');
  }
}

function lxDecodeName(value) {
  return decodeHtmlEntities(String(value || ''));
}

const lxKuwoWordLrcTools = {
  rxps: {
    wordLine: /^(\[\d{1,2}:.*\d{1,4}\])\s*(\S+(?:\s+\S+)*)?\s*/,
    tagLine: /\[(ver|ti|ar|al|offset|by|kuwo):\s*(\S+(?:\s+\S+)*)\s*\]/,
    wordTimeAll: /<(-?\d+),(-?\d+)(?:,-?\d+)?>/g,
    wordTime: /<(-?\d+),(-?\d+)(?:,-?\d+)?>/,
  },
  parse(lrc) {
    const state = { isOK: true, offset: 1, offset2: 1, lines: [], tags: [] };
    String(lrc || '').split(/\r\n|\r|\n/).forEach(line => {
      if (!state.isOK) return;
      if (line.length < 6) return;
      let result = this.rxps.wordLine.exec(line);
      if (result) {
        const time = result[1];
        let words = result[2] == null ? '' : result[2];
        const wordTimes = words.match(this.rxps.wordTimeAll);
        if (!wordTimes) return;
        let previous = null;
        wordTimes.forEach(timeStr => {
          const m = this.rxps.wordTime.exec(timeStr);
          if (!m) return;
          const offset = parseInt(m[1], 10);
          const offset2 = parseInt(m[2], 10);
          const startTime = Math.abs((offset + offset2) / (state.offset * 2));
          const endTime = Math.abs((offset - offset2) / (state.offset2 * 2)) + startTime;
          const info = { startTime, endTime, timeStr: `<${startTime},${endTime - startTime}>` };
          if (previous && startTime < previous.endTime) {
            previous.endTime = Math.max(previous.startTime, startTime);
            previous.newTimeStr = `<${previous.startTime},${previous.endTime - previous.startTime}>`;
          }
          words = words.replace(timeStr, info.timeStr);
          if (previous && previous.newTimeStr) words = words.replace(previous.timeStr, previous.newTimeStr);
          previous = info;
        });
        state.lines.push(time + words);
        return;
      }
      result = this.rxps.tagLine.exec(line);
      if (!result) return;
      if (result[1] === 'kuwo') {
        let content = result[2] || '';
        if (content.includes('][')) content = content.substring(0, content.indexOf(']['));
        const valueOf = parseInt(content, 8);
        state.offset = Math.trunc(valueOf / 10);
        state.offset2 = Math.trunc(valueOf % 10);
        if (!state.offset || Number.isNaN(state.offset) || !state.offset2 || Number.isNaN(state.offset2)) state.isOK = false;
      } else {
        state.tags.push(line);
      }
    });
    if (!state.lines.length) return '';
    return (state.tags.length ? state.tags.join('\n') + '\n' : '') + state.lines.join('\n');
  },
};

function lxDecodeKuwoLyric(raw, isGetLyricx) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw || '');
    if (buf.toString('utf8', 0, 10) !== 'tp=content') {
      resolve('');
      return;
    }
    const dataStart = buf.indexOf('\r\n\r\n') + 4;
    zlib.inflate(buf.subarray(dataStart), (err, inflated) => {
      if (err) {
        reject(err);
        return;
      }
      if (!isGetLyricx) {
        resolve(iconv.decode(inflated, 'gb18030'));
        return;
      }
      const key = Buffer.from('yeelion');
      const encrypted = Buffer.from(inflated.toString(), 'base64');
      const output = Buffer.alloc(encrypted.length);
      for (let i = 0; i < encrypted.length; i++) output[i] = encrypted[i] ^ key[i % key.length];
      resolve(iconv.decode(output, 'gb18030'));
    });
  });
}

function lxKuwoBuildLyricParams(id, isGetLyricx) {
  let params = `user=12345,web,web,web&requester=localhost&req=1&rid=MUSIC_${id}`;
  if (isGetLyricx) params += '&lrcx=1';
  const key = Buffer.from('yeelion');
  const input = Buffer.from(params);
  const output = new Uint16Array(input.length);
  for (let i = 0; i < input.length; i++) output[i] = key[i % key.length] ^ input[i];
  return Buffer.from(output).toString('base64');
}

function lxKuwoParseLrc(lrc) {
  const lines = String(lrc || '').split(/\r\n|\r|\n/);
  const tags = [];
  const lrcArr = [];
  const lrcSet = new Set();
  const lrcMain = [];
  const lrcT = [];
  let isLyricx = false;
  lines.forEach(lineRaw => {
    const line = lineRaw.trim();
    const m = /^\[([\d:.]*)\]{1}/g.exec(line);
    if (m) {
      let time = m[1];
      if (/\.\d\d$/.test(time)) time += '0';
      lrcArr.push({ time, text: line.replace(/^\[([\d:.]*)\]{1}/g, '').trim() });
    } else if (lxKuwoWordLrcTools.rxps.tagLine.test(line)) {
      tags.push(line);
    }
  });
  for (const item of lrcArr) {
    if (lrcSet.has(item.time)) {
      if (lrcMain.length < 2) continue;
      const tItem = lrcMain.pop();
      tItem.time = lrcMain[lrcMain.length - 1].time;
      lrcT.push(tItem);
      lrcMain.push(item);
    } else {
      lrcMain.push(item);
      lrcSet.add(item.time);
    }
    if (!isLyricx && /^<-?\d+,-?\d+>/.test(item.text)) isLyricx = true;
  }
  if (!isLyricx && lrcT.length > lrcMain.length * 0.3 && lrcMain.length - lrcT.length > 6) throw new Error('Get lyric failed');
  const transform = list => `${tags.join('\n')}\n${list.map(l => `[${l.time}]${l.text}\n`).join('')}`;
  const info = {
    lyric: lxDecodeName(transform(lrcMain)),
    tlyric: lrcT.length ? lxDecodeName(transform(lrcT)).replace(lxKuwoWordLrcTools.rxps.wordTimeAll, '') : '',
    rlyric: '',
    lxlyric: '',
  };
  try { info.lxlyric = lxKuwoWordLrcTools.parse(info.lyric); } catch (e) { info.lxlyric = ''; }
  info.lyric = info.lyric.replace(lxKuwoWordLrcTools.rxps.wordTimeAll, '');
  if (!/\[\d{1,2}:.*\d{1,4}\]/.test(info.lyric)) throw new Error('Get lyric failed');
  return info;
}

async function lxGetKuwoLyric(musicInfo) {
  const id = musicInfo.songmid || musicInfo.mid || musicInfo.id;
  if (!id) throw new Error('Missing Kuwo song id');
  const raw = await lxFetchRaw(`http://newlyric.kuwo.cn/newlyric.lrc?${lxKuwoBuildLyricParams(id, true)}`);
  const decoded = await lxDecodeKuwoLyric(raw, true);
  return Object.assign({ provider: 'lx', source: 'kw' }, lxKuwoParseLrc(decoded));
}

async function lxGetKuwoPic(musicInfo) {
  const id = musicInfo.songmid || musicInfo.mid || musicInfo.id;
  if (!id) throw new Error('Missing Kuwo song id');
  const body = await lxFetchText(`http://artistpicserver.kuwo.cn/pic.web?corp=kuwo&type=rid_pic&pictype=500&size=500&rid=${encodeURIComponent(id)}`);
  const pic = /^http/i.test(String(body || '').trim()) ? String(body).trim() : '';
  if (!pic) throw new Error('Pic get failed');
  return { provider: 'lx', source: 'kw', cover: pic, pic };
}

function lxDecodeKugouKrc(data) {
  const key = Buffer.from([0x40, 0x47, 0x61, 0x77, 0x5e, 0x32, 0x74, 0x47, 0x51, 0x36, 0x31, 0x2d, 0xce, 0xd2, 0x6e, 0x69], 'binary');
  return new Promise((resolve, reject) => {
    const buf = Buffer.from(String(data || ''), 'base64').subarray(4);
    for (let i = 0; i < buf.length; i++) buf[i] = buf[i] ^ key[i % 16];
    zlib.inflate(buf, (err, result) => err ? reject(err) : resolve(result.toString()));
  }).then(str => {
    str = String(str || '').replace(/\r/g, '').replace(/^.*\[id:\$\w+\]\n/, '');
    let rlyric = '';
    let tlyric = '';
    const trans = str.match(/\[language:([\w=\\/+]+)\]/);
    if (trans) {
      str = str.replace(/\[language:[\w=\\/+]+\]\n/, '');
      const json = JSON.parse(Buffer.from(trans[1], 'base64').toString());
      for (const item of json.content || []) {
        if (item.type === 0) rlyric = item.lyricContent;
        else if (item.type === 1) tlyric = item.lyricContent;
      }
    }
    let i = 0;
    let lxlyric = str.replace(/\[((\d+),\d+)\].*/g, line => {
      const m = line.match(/\[((\d+),\d+)\].*/);
      let timeMs = parseInt(m[2], 10);
      const ms = timeMs % 1000;
      timeMs = Math.floor(timeMs / 1000);
      const min = Math.floor(timeMs / 60).toString().padStart(2, '0');
      const sec = Math.floor(timeMs % 60).toString().padStart(2, '0');
      const time = `${min}:${sec}.${ms}`;
      if (rlyric) rlyric[i] = `[${time}]${(rlyric[i] || []).join('')}`;
      if (tlyric) tlyric[i] = `[${time}]${(tlyric[i] || []).join('')}`;
      i++;
      return line.replace(m[1], time);
    });
    rlyric = rlyric ? lxDecodeName(rlyric.join('\n')) : '';
    tlyric = tlyric ? lxDecodeName(tlyric.join('\n')) : '';
    lxlyric = lxDecodeName(lxlyric.replace(/<(\d+,\d+),\d+>/g, '<$1>'));
    return {
      lyric: lxlyric.replace(/<\d+,\d+>/g, ''),
      tlyric,
      rlyric,
      lxlyric,
    };
  });
}

function lxIntervalToSeconds(interval) {
  if (!interval) return 0;
  if (typeof interval === 'number') return interval;
  return String(interval).split(':').reverse().reduce((sum, part, index) => sum + (parseInt(part, 10) || 0) * Math.pow(60, index), 0);
}

async function lxGetKugouLyric(musicInfo) {
  const name = musicInfo.name || '';
  const hash = musicInfo.hash || musicInfo.FileHash || '';
  const duration = musicInfo._interval || lxIntervalToSeconds(musicInfo.interval);
  if (!name || !hash) throw new Error('Missing Kugou lyric keys');
  const searchResult = await lxFetchJson(`http://lyrics.kugou.com/search?ver=1&man=yes&client=pc&keyword=${encodeURIComponent(name)}&hash=${encodeURIComponent(hash)}&timelength=${encodeURIComponent(duration)}&lrctxt=1`, {
    headers: { 'KG-RC': '1', 'KG-THash': 'expand_search_manager.cpp:852736169:451', 'User-Agent': 'KuGou2012-9020-ExpandSearchManager' },
  });
  const candidate = searchResult && searchResult.candidates && searchResult.candidates[0];
  if (!candidate) throw new Error('Get lyric failed');
  const fmt = candidate.krctype == 1 && candidate.contenttype != 1 ? 'krc' : 'lrc';
  const body = await lxFetchJson(`http://lyrics.kugou.com/download?ver=1&client=pc&id=${encodeURIComponent(candidate.id)}&accesskey=${encodeURIComponent(candidate.accesskey)}&fmt=${fmt}&charset=utf8`, {
    headers: { 'KG-RC': '1', 'KG-THash': 'expand_search_manager.cpp:852736169:451', 'User-Agent': 'KuGou2012-9020-ExpandSearchManager' },
  });
  const info = body.fmt === 'krc'
    ? await lxDecodeKugouKrc(body.content)
    : { lyric: Buffer.from(body.content || '', 'base64').toString('utf8'), tlyric: '', rlyric: '', lxlyric: '' };
  if (!info.lyric) throw new Error('Get lyric failed');
  return Object.assign({ provider: 'lx', source: 'kg' }, info);
}

async function lxGetKugouPic(musicInfo) {
  const songmid = String(musicInfo.songmid || musicInfo.mid || '');
  const albumAudioId = songmid.length === 32 && musicInfo.audioId ? String(musicInfo.audioId).split('_')[0] : songmid;
  const body = await lxFetchJson('http://media.store.kugou.com/v1/get_res_privilege', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'KG-RC': '1',
      'KG-THash': 'expand_search_manager.cpp:852736169:451',
      'User-Agent': 'KuGou2012-9020-ExpandSearchManager',
    },
    body: JSON.stringify({
      appid: 1001,
      area_code: '1',
      behavior: 'play',
      clientver: '9020',
      need_hash_offset: 1,
      relate: 1,
      resource: [{
        album_audio_id: albumAudioId,
        album_id: musicInfo.albumId || musicInfo.albumID || '',
        hash: musicInfo.hash || musicInfo.FileHash || '',
        id: 0,
        name: `${musicInfo.singer || musicInfo.artist || ''} - ${musicInfo.name || ''}.mp3`,
        type: 'audio',
      }],
      token: '',
      userid: 2626431536,
      vip: 1,
    }),
  });
  if (body.error_code !== 0) throw new Error('Pic get failed');
  const info = body.data && body.data[0] && body.data[0].info;
  const img = info && info.imgsize ? String(info.image || '').replace('{size}', info.imgsize[0]) : (info && info.image);
  if (!img) throw new Error('Pic get failed');
  return { provider: 'lx', source: 'kg', cover: img, pic: img };
}

const lxMiguMrcDelta = 2654435769n;
const lxMiguMrcKey = [
  27303562373562475n, 18014862372307051n, 22799692160172081n,
  34058940340699235n, 30962724186095721n, 27303523720101991n,
  27303523720101998n, 31244139033526382n, 28992395054481524n,
];
const lxLongMax = 9223372036854775807n;
const lxLongMin = -9223372036854775808n;
function lxToLong(value) {
  const num = typeof value === 'string' ? BigInt('0x' + value) : BigInt(value);
  if (num > lxLongMax) return lxToLong(num - (1n << 64n));
  if (num < lxLongMin) return lxToLong(num + (1n << 64n));
  return num;
}
function lxMiguLongToBytes(value) {
  const result = Buffer.alloc(8);
  let n = value;
  for (let i = 0; i < 8; i++) {
    result[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return result;
}
function lxMiguDecryptMrc(data) {
  data = String(data || '');
  if (data.length < 32) return data;
  const arr = [];
  for (let i = 0; i < Math.floor(data.length / 16); i++) arr.push(lxToLong(data.substring(i * 16, i * 16 + 16)));
  const len = BigInt(arr.length);
  if (arr.length >= 1) {
    let j2 = arr[0];
    let j3 = lxToLong((6n + (52n / len)) * lxMiguMrcDelta);
    while (j3 !== 0n) {
      const j5 = lxToLong(3n & lxToLong(j3 >> 2n));
      let j6 = len;
      while (true) {
        j6--;
        if (j6 > 0n) {
          const prev = arr[Number(j6 - 1n)];
          const idx = Number(j6);
          j2 = lxToLong(arr[idx] - (lxToLong(lxToLong(j2 ^ j3) + lxToLong(prev ^ lxMiguMrcKey[Number(lxToLong(3n & j6) ^ j5)])) ^ lxToLong(lxToLong(lxToLong(prev >> 5n) ^ lxToLong(j2 << 2n)) + lxToLong(lxToLong(j2 >> 3n) ^ lxToLong(prev << 4n)))));
          arr[idx] = j2;
        } else break;
      }
      const last = arr[Number(len - 1n)];
      j2 = lxToLong(arr[0] - lxToLong(lxToLong(lxToLong(lxMiguMrcKey[Number(lxToLong(j6 & 3n) ^ j5)] ^ last) + lxToLong(j2 ^ j3)) ^ lxToLong(lxToLong(lxToLong(last >> 5n) ^ lxToLong(j2 << 2n)) + lxToLong(lxToLong(j2 >> 3n) ^ lxToLong(last << 4n)))));
      arr[0] = j2;
      j3 = lxToLong(j3 - lxMiguMrcDelta);
    }
  }
  return arr.map(v => lxMiguLongToBytes(v).toString('utf16le')).join('');
}

function lxMsFormat(timeMs) {
  if (!Number.isFinite(timeMs)) return '';
  const ms = timeMs % 1000;
  let secTotal = Math.floor(timeMs / 1000);
  const min = Math.floor(secTotal / 60).toString().padStart(2, '0');
  const sec = Math.floor(secTotal % 60).toString().padStart(2, '0');
  return `[${min}:${sec}.${String(ms).padStart(3, '0')}]`;
}

function lxParseMiguMrc(str) {
  str = String(str || '').replace(/\r/g, '');
  const lxlrcLines = [];
  const lrcLines = [];
  str.split('\n').forEach(line => {
    if (line.length < 6) return;
    const m = /^\s*\[(\d+),\d+\]/.exec(line);
    if (!m) return;
    const start = parseInt(m[1], 10);
    const time = lxMsFormat(start);
    let words = line.replace(/^\s*\[(\d+),\d+\]/, '');
    lrcLines.push(`${time}${words.replace(/(\(\d+,\d+\))/g, '')}`);
    const times = words.match(/(\(\d+,\d+\))/g);
    if (!times) return;
    const parts = words.split(/\(\d+,\d+\)/);
    const newWords = times.map((item, index) => {
      const mm = /\((\d+),(\d+)\)/.exec(item);
      return `<${parseInt(mm[1], 10) - start},${mm[2]}>${parts[index]}`;
    }).join('');
    lxlrcLines.push(`${time}${newWords}`);
  });
  return { lyric: lrcLines.join('\n'), lxlyric: lxlrcLines.join('\n') };
}

async function lxMiguGetText(url) {
  return lxFetchText(url, {
    headers: {
      Referer: 'https://app.c.nf.migu.cn/',
      'User-Agent': 'Mozilla/5.0 (Linux; Android 5.1.1; Nexus 6 Build/LYZ28E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/59.0.3071.115 Mobile Safari/537.36',
      channel: '0146921',
    },
  });
}

async function lxMiguGetMusicInfo(copyrightId) {
  if (!copyrightId) throw new Error('Missing Migu copyright id');
  const body = await lxFetchJson('https://c.musicapp.migu.cn/MIGUM2.0/v1.0/content/resourceinfo.do?resourceType=2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: lxFormBody({ resourceId: copyrightId }),
  });
  const item = body && body.resource && body.resource[0];
  if (!item) throw new Error('Get music info failed');
  return {
    songmid: item.songId,
    copyrightId: item.copyrightId,
    lrcUrl: item.lrcUrl,
    mrcUrl: item.mrcUrl,
    trcUrl: item.trcUrl,
  };
}

async function lxGetMiguLyric(musicInfo) {
  const info = (musicInfo.mrcUrl || musicInfo.lrcUrl)
    ? musicInfo
    : await lxMiguGetMusicInfo(musicInfo.copyrightId || musicInfo.songmid);
  let lrcInfo = null;
  if (info.mrcUrl) lrcInfo = lxParseMiguMrc(lxMiguDecryptMrc(await lxMiguGetText(info.mrcUrl)));
  else if (info.lrcUrl) lrcInfo = { lyric: await lxMiguGetText(info.lrcUrl), lxlyric: '' };
  if (!lrcInfo) throw new Error('Get lyric failed');
  const tlyric = info.trcUrl ? await lxMiguGetText(info.trcUrl).catch(() => '') : '';
  return { provider: 'lx', source: 'mg', lyric: lrcInfo.lyric || '', tlyric, rlyric: '', lxlyric: lrcInfo.lxlyric || '' };
}

async function lxGetMiguPic(musicInfo) {
  let songId = musicInfo.songmid || musicInfo.id;
  if ((!songId || songId === musicInfo.copyrightId) && musicInfo.copyrightId) {
    const info = await lxMiguGetMusicInfo(musicInfo.copyrightId);
    songId = info.songmid || songId;
  }
  if (!songId) throw new Error('Missing Migu song id');
  const body = await lxFetchJson(`http://music.migu.cn/v3/api/music/audioPlayer/getSongPic?songId=${encodeURIComponent(songId)}`, {
    headers: { Referer: 'http://music.migu.cn/v3/music/player/audio?from=migu' },
  });
  if (body.returnCode !== '000000') throw new Error('Pic get failed');
  let pic = body.largePic || body.mediumPic || body.smallPic || '';
  if (pic && !/^https?:/i.test(pic)) pic = 'http:' + pic;
  if (!pic) throw new Error('Pic get failed');
  return { provider: 'lx', source: 'mg', cover: pic, pic };
}

const lxNeteaseEapiKey = Buffer.from('e82ckenh8dichen8');
function lxNeteaseEapi(urlPath, object) {
  const text = typeof object === 'object' ? JSON.stringify(object) : String(object);
  const message = `nobody${urlPath}use${text}md5forencrypt`;
  const digest = crypto.createHash('md5').update(message).digest('hex');
  const data = `${urlPath}-36cd479b6b5-${text}-36cd479b6b5-${digest}`;
  const cipher = crypto.createCipheriv('aes-128-ecb', lxNeteaseEapiKey, null);
  cipher.setAutoPadding(true);
  return { params: Buffer.concat([cipher.update(Buffer.from(data)), cipher.final()]).toString('hex').toUpperCase() };
}

const lxNeteaseParseTools = {
  parseHeaderInfo(str) {
    str = String(str || '').trim().replace(/\r/g, '');
    if (!str) return null;
    return str.split('\n').map(line => {
      if (!/^{"/.test(line)) return line;
      try {
        const info = JSON.parse(line);
        const timeTag = lxMsFormat(info.t);
        return timeTag ? `${timeTag}${(info.c || []).map(t => t.tx).join('')}` : '';
      } catch (e) { return ''; }
    });
  },
  parseLyric(lines) {
    const lxlrcLines = [];
    const lrcLines = [];
    (lines || []).forEach(lineRaw => {
      let line = String(lineRaw || '').trim();
      const m = /^\[(\d+),\d+\]/.exec(line);
      if (!m) {
        if (line.startsWith('[offset')) {
          lxlrcLines.push(line);
          lrcLines.push(line);
        }
        return;
      }
      const start = parseInt(m[1], 10);
      const time = lxMsFormat(start);
      let words = line.replace(/^\[(\d+),\d+\]/, '');
      lrcLines.push(`${time}${words.replace(/(\(\d+,\d+,\d+\))/g, '')}`);
      const times = words.match(/(\(\d+,\d+,\d+\))/g);
      if (!times) return;
      const parts = words.split(/\(\d+,\d+,\d+\)/);
      parts.shift();
      lxlrcLines.push(`${time}${times.map((item, index) => {
        const mm = /\((\d+),(\d+),\d+\)/.exec(item);
        return `<${Math.max(parseInt(mm[1], 10) - start, 0)},${mm[2]}>${parts[index]}`;
      }).join('')}`);
    });
    return { lyric: lrcLines.join('\n'), lxlyric: lxlrcLines.join('\n') };
  },
  timeToMs(value) {
    if (!value) return 0;
    if (!String(value).includes('.')) value += '.0';
    const arr = String(value).split(/:|\./);
    while (arr.length < 3) arr.unshift('0');
    return (parseInt(arr[0], 10) || 0) * 3600000 + (parseInt(arr[1], 10) || 0) * 1000 + (parseInt(arr[2], 10) || 0);
  },
  fixTimeTag(lrc, target) {
    let lrcLines = String(lrc || '').split('\n');
    const timeRxp = /^\[([\d:.]+)\]/;
    const out = [];
    String(target || '').split('\n').forEach(line => {
      const m = timeRxp.exec(line);
      if (!m || !line.replace(timeRxp, '').trim()) return;
      const t1 = this.timeToMs(m[1]);
      const stash = [];
      while (lrcLines.length) {
        const base = lrcLines.shift();
        const bm = timeRxp.exec(base);
        if (!bm) continue;
        const t2 = this.timeToMs(bm[1]);
        if (Math.abs(t1 - t2) < 100) {
          const fixed = line.replace(timeRxp, bm[0]).trim();
          if (fixed) out.push(fixed);
          break;
        }
        stash.push(base);
      }
      lrcLines = stash.concat(lrcLines);
    });
    return out.join('\n');
  },
  parse(ylrc, ytlrc, yrlrc, lrc, tlrc, rlrc) {
    const info = { lyric: '', tlyric: '', rlyric: '', lxlyric: '' };
    if (ylrc) {
      const lines = this.parseHeaderInfo(ylrc);
      if (lines) {
        const result = this.parseLyric(lines);
        if (ytlrc) {
          const tLines = this.parseHeaderInfo(ytlrc);
          if (tLines) info.tlyric = this.fixTimeTag(result.lyric, tLines.join('\n'));
        }
        if (yrlrc) {
          const rLines = this.parseHeaderInfo(yrlrc);
          if (rLines) info.rlyric = this.fixTimeTag(result.lyric, rLines.join('\n'));
        }
        const headers = lines.filter(line => /^\[[\d:.]+\]/.test(line)).join('\n');
        info.lyric = `${headers}\n${result.lyric}`;
        info.lxlyric = result.lxlyric;
        return info;
      }
    }
    if (lrc) {
      const lines = this.parseHeaderInfo(lrc);
      if (lines) info.lyric = lines.join('\n');
    }
    if (tlrc) {
      const lines = this.parseHeaderInfo(tlrc);
      if (lines) info.tlyric = lines.join('\n');
    }
    if (rlrc) {
      const lines = this.parseHeaderInfo(rlrc);
      if (lines) info.rlyric = lines.join('\n');
    }
    return info;
  },
};

function lxFixNeteaseTimeLabel(lrc, tlrc, rlyric) {
  if (lrc) {
    const fixedLrc = lrc.replace(/\[(\d{2}:\d{2}):(\d{2})]/g, '[$1.$2]');
    const fixedTlrc = tlrc ? tlrc.replace(/\[(\d{2}:\d{2}):(\d{2})]/g, '[$1.$2]') : tlrc;
    let fixedR = rlyric;
    if (fixedR) fixedR = fixedR.replace(/\[(\d{2}:\d{2}):(\d{2,3})]/g, '[$1.$2]').replace(/\[(\d{2}:\d{2}\.\d{2})0]/g, '[$1]');
    return { lrc: fixedLrc, tlrc: fixedTlrc, rlyric: fixedR };
  }
  return { lrc, tlrc, rlyric };
}

async function lxGetNeteaseLyric(musicInfo) {
  const id = musicInfo.songmid || musicInfo.id || musicInfo.mid;
  if (!id) throw new Error('Missing Netease song id');
  const body = await lxFetchJson('https://interface3.music.163.com/eapi/song/lyric/v1', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/60.0.3112.90 Safari/537.36',
      origin: 'https://music.163.com',
    },
    body: lxFormBody(lxNeteaseEapi('/api/song/lyric/v1', { id, cp: false, tv: 0, lv: 0, rv: 0, kv: 0, yv: 0, ytv: 0, yrv: 0 })),
  });
  if (body.code !== 200 || !(body.lrc && body.lrc.lyric)) throw new Error('Get lyric failed');
  const fixed = lxFixNeteaseTimeLabel(body.lrc.lyric, body.tlyric && body.tlyric.lyric, body.romalrc && body.romalrc.lyric);
  const info = lxNeteaseParseTools.parse(body.yrc && body.yrc.lyric, body.ytlrc && body.ytlrc.lyric, body.yromalrc && body.yromalrc.lyric, fixed.lrc, fixed.tlrc, fixed.rlyric);
  if (!info.lyric) throw new Error('Get lyric failed');
  return Object.assign({ provider: 'lx', source: 'wy', yrc: body.yrc && body.yrc.lyric || '' }, info);
}

async function lxGetNeteasePic(musicInfo) {
  const id = musicInfo.songmid || musicInfo.id || musicInfo.mid;
  if (!id) throw new Error('Missing Netease song id');
  const detail = await song_detail({ ids: String(id), timestamp: Date.now() });
  const song = detail && detail.body && detail.body.songs && detail.body.songs[0];
  const pic = song && song.al && song.al.picUrl;
  if (!pic) throw new Error('Pic get failed');
  return { provider: 'lx', source: 'wy', cover: pic, pic };
}

const lxQqParseTools = {
  parseLyric(lrc) {
    lrc = String(lrc || '').trim().replace(/\r/g, '');
    if (!lrc) return { lyric: '', lxlyric: '' };
    const lxlrcLines = [];
    const lrcLines = [];
    lrc.split('\n').forEach(lineRaw => {
      const line = String(lineRaw || '').trim();
      const m = /^\[(\d+),\d+\]/.exec(line);
      if (!m) {
        if (line.startsWith('[offset')) {
          lxlrcLines.push(line);
          lrcLines.push(line);
        } else if (/^\[([\d:.]+)\]/.test(line)) {
          lrcLines.push(line);
        }
        return;
      }
      const start = parseInt(m[1], 10);
      const time = lxMsFormat(start);
      const words = line.replace(/^\[(\d+),\d+\]/, '');
      lrcLines.push(`${time}${words.replace(/(\(\d+,\d+\))/g, '')}`);
      const times = words.match(/(\(\d+,\d+\))/g);
      if (!times) return;
      const parts = words.split(/\(\d+,\d+\)/);
      lxlrcLines.push(`${time}${times.map((item, index) => {
        const mm = /\((\d+),(\d+)\)/.exec(item);
        return `<${Math.max(parseInt(mm[1], 10) - start, 0)},${mm[2]}>${parts[index]}`;
      }).join('')}`);
    });
    return { lyric: lrcLines.join('\n'), lxlyric: lxlrcLines.join('\n') };
  },
  parseRlyric(lrc) {
    return String(lrc || '').trim().replace(/\r/g, '').split('\n').map(line => {
      const m = /^\[(\d+),\d+\]/.exec(line.trim());
      if (!m) return '';
      return `${lxMsFormat(parseInt(m[1], 10))}${line.replace(/^\[(\d+),\d+\]/, '').replace(/(\(\d+,\d+\))/g, '')}`;
    }).filter(Boolean).join('\n');
  },
  removeTag(str) {
    return String(str || '').replace(/^[\S\s]*?LyricContent="/, '').replace(/"\/>[\S\s]*?$/, '');
  },
  timeToMs(value) {
    if (!value) return 0;
    if (!String(value).includes('.')) value += '.0';
    const arr = String(value).split(/:|\./);
    while (arr.length < 3) arr.unshift('0');
    return (parseInt(arr[0], 10) || 0) * 3600000 + (parseInt(arr[1], 10) || 0) * 1000 + (parseInt(arr[2], 10) || 0);
  },
  fixTimeTag(target, lrc) {
    const targetLines = String(target || '').split('\n');
    let lrcLines = String(lrc || '').split('\n');
    const timeRxp = /^\[([\d:.]+)\]/;
    const out = [];
    targetLines.forEach(line => {
      const m = timeRxp.exec(line);
      if (!m || !line.replace(timeRxp, '').trim()) return;
      const t1 = this.timeToMs(m[1]);
      while (lrcLines.length) {
        const base = lrcLines.shift();
        const bm = timeRxp.exec(base);
        if (!bm) continue;
        if (Math.abs(t1 - this.timeToMs(bm[1])) < 100) {
          out.push(line.replace(timeRxp, bm[0]));
          break;
        }
      }
    });
    return out.join('\n');
  },
  parse(lrc, tlrc, rlrc) {
    const info = { lyric: '', tlyric: '', rlyric: '', lxlyric: '' };
    if (lrc) {
      const parsed = this.parseLyric(this.removeTag(lrc));
      info.lyric = parsed.lyric;
      info.lxlyric = parsed.lxlyric;
    }
    if (rlrc) info.rlyric = this.fixTimeTag(this.parseRlyric(this.removeTag(rlrc)), info.lyric);
    if (tlrc) info.tlyric = this.fixTimeTag(tlrc, info.lyric);
    return info;
  },
};

let lxQqDecodeAddon = null;
function lxLoadQqDecodeAddon() {
  if (lxQqDecodeAddon) return lxQqDecodeAddon;
  const candidates = [];
  if (process.platform === 'win32' && process.arch === 'x64') {
    candidates.push(path.join(__dirname, 'build', `qrc_decode_electron-v${process.versions.modules}-win32-x64.node`));
  }
  candidates.push(path.join(__dirname, 'build', 'qrc_decode.node'));
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) {
        lxQqDecodeAddon = require(file);
        return lxQqDecodeAddon;
      }
    } catch (e) {
      console.warn('[LXQqDecode] native addon load failed:', e.message);
    }
  }
  throw new Error('QQ_QRC_DECODE_NOT_AVAILABLE');
}

function lxInflateQqBuffer(buffer) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const stream = zlib.createInflate()
      .on('data', chunk => chunks.push(chunk))
      .on('close', () => resolve(Buffer.concat(chunks).toString()))
      .on('error', err => {
        if (err && err.errno === zlib.constants.Z_BUF_ERROR) return;
        reject(err);
      });
    stream.end(buffer);
  });
}

async function lxDecodeQqHexLyric(hex) {
  if (!hex) return '';
  const addon = lxLoadQqDecodeAddon();
  const buf = Buffer.from(String(hex), 'hex');
  return lxInflateQqBuffer(addon.qrc_decode(buf, buf.length));
}

async function lxDecodeQqLyrics(lrc, tlrc, rlrc) {
  const [lyric, tlyric, rlyric] = await Promise.all([
    lxDecodeQqHexLyric(lrc),
    lxDecodeQqHexLyric(tlrc),
    lxDecodeQqHexLyric(rlrc),
  ]);
  return { lyric, tlyric, rlyric };
}

async function lxQqSongId(musicInfo) {
  const direct = musicInfo.qqId || musicInfo.songId || musicInfo.songID || musicInfo.id;
  if (direct && /^\d+$/.test(String(direct))) return Number(direct);
  const mid = musicInfo.songmid || musicInfo.mid;
  if (!mid) return 0;
  const detail = await qqSongDetail(mid, { mid });
  return normalizeQQSongId(detail && detail.qqId);
}

async function lxGetQqLyric(musicInfo) {
  const songId = await lxQqSongId(musicInfo);
  if (!songId) throw new Error('Missing QQ song id');
  const body = await qqMusicRequest({
    comm: { ct: '19', cv: '1859', uin: '0' },
    req: {
      method: 'GetPlayLyricInfo',
      module: 'music.musichallSong.PlayLyricInfo',
      param: { format: 'json', crypt: 1, ct: 19, cv: 1873, interval: 0, lrc_t: 0, qrc: 1, qrc_t: 0, roma: 1, roma_t: 0, songID: songId, trans: 1, trans_t: 0, type: -1 },
    },
  }, { cookie: false });
  if (body.code !== 0 || !body.req || body.req.code !== 0) throw new Error('Get lyric failed');
  const data = body.req.data || {};
  const decoded = await lxDecodeQqLyrics(data.lyric, data.trans, data.roma);
  const info = lxQqParseTools.parse(decoded.lyric, decoded.tlyric, decoded.rlyric);
  if (!info.lyric) throw new Error('Get lyric failed');
  return Object.assign({ provider: 'lx', source: 'tx' }, info);
}

async function lxGetQqPic(musicInfo) {
  const albumId = musicInfo.albumId || musicInfo.albumMid || musicInfo.albummid || '';
  let pic = albumId && albumId !== '空' ? `https://y.gtimg.cn/music/photo_new/T002R500x500M000${albumId}.jpg` : '';
  if (!pic && Array.isArray(musicInfo.singer) && musicInfo.singer[0] && musicInfo.singer[0].mid) pic = `https://y.gtimg.cn/music/photo_new/T001R500x500M000${musicInfo.singer[0].mid}.jpg`;
  if (!pic && Array.isArray(musicInfo.artists) && musicInfo.artists[0] && musicInfo.artists[0].mid) pic = `https://y.gtimg.cn/music/photo_new/T001R500x500M000${musicInfo.artists[0].mid}.jpg`;
  if (!pic) throw new Error('Pic get failed');
  return { provider: 'lx', source: 'tx', cover: pic, pic };
}

async function callLXUserApiIfConfigured(source, action, info) {
  const api = loadLXUserApi();
  if (!api.ok) return null;
  const handler = api.events[LX_EVENT_NAMES.request];
  if (typeof handler !== 'function') return null;
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('LX_SOURCE_TIMEOUT')), 15000));
  return Promise.race([
    Promise.resolve(handler({ source, action, info })),
    timeout,
  ]);
}

async function handleLXSongUrl(source, musicInfo, qualityPreference) {
  source = String(source || '').trim().toLowerCase();
  if (!LX_SOURCE_NAMES[source]) {
    return { provider: 'lx', url: '', playable: false, error: 'LX_SOURCE_INVALID', message: '不支持的落雪源: ' + source };
  }
  const sourceInfo = lxSourceInfoFor(source);
  const requestedQuality = normalizeLxRequestedQuality(qualityPreference);
  const quality = lxQualityToSourceType(qualityPreference, sourceInfo && sourceInfo.qualitys);
  try {
    const result = await callLXUserApi(source, 'musicUrl', {
      type: quality,
      musicInfo: normalizeLXMusicInfo(source, musicInfo),
    });
    const url = extractLXMusicUrl(result);
    if (!url) {
      const restriction = playbackRestriction('lx', 'url_unavailable', '落雪自定义源没有返回播放地址', 'switch_source');
      return { provider: 'lx', url: '', playable: false, reason: restriction.category, message: restriction.message, restriction, level: requestedQuality, quality: requestedQuality, requestedQuality, lxSourceQuality: quality };
    }
    return {
      provider: 'lx',
      url,
      playable: true,
      trial: false,
      level: requestedQuality,
      quality: requestedQuality,
      requestedQuality,
      lxSourceQuality: quality,
      lxSource: source,
    };
  } catch (e) {
    const restriction = playbackRestriction('lx', 'url_unavailable', e.message || '落雪自定义源取播放地址失败', 'switch_source');
    return { provider: 'lx', url: '', playable: false, error: e.message, reason: restriction.category, message: restriction.message, restriction, level: requestedQuality, quality: requestedQuality, requestedQuality, lxSourceQuality: quality, lxSource: source };
  }
}

async function handleLXLyric(source, musicInfo) {
  source = String(source || '').trim().toLowerCase();
  const normalized = normalizeLXMusicInfo(source, musicInfo);
  try {
    if (source === 'kw') return await lxGetKuwoLyric(normalized);
    if (source === 'kg') return await lxGetKugouLyric(normalized);
    if (source === 'mg') return await lxGetMiguLyric(normalized);
    if (source === 'tx') return await lxGetQqLyric(normalized);
    if (source === 'wy') return await lxGetNeteaseLyric(normalized);
  } catch (e) {
    warnLXOptionalUserApi('[LXLyricOfficial]', source, e);
  }
  return { provider: 'lx', source, lyric: '', tlyric: '', rlyric: '', yrc: '', lxlyric: '' };
}

async function handleLXPic(source, musicInfo) {
  source = String(source || '').trim().toLowerCase();
  const normalized = normalizeLXMusicInfo(source, musicInfo);
  try {
    if (source === 'kw') return await lxGetKuwoPic(normalized);
    if (source === 'kg') return await lxGetKugouPic(normalized);
    if (source === 'mg') return await lxGetMiguPic(normalized);
    if (source === 'tx') return await lxGetQqPic(normalized);
    if (source === 'wy') return await lxGetNeteasePic(normalized);
  } catch (e) {
    warnLXOptionalUserApi('[LXPicOfficial]', source, e);
  }
  return { provider: 'lx', source, cover: '', pic: '' };
}

function clampNumber(value, min, max, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function openMeteoWeatherLabel(code) {
  code = Number(code);
  if (code === 0) return '晴';
  if (code === 1 || code === 2) return '少云';
  if (code === 3) return '阴';
  if (code === 45 || code === 48) return '雾';
  if (code === 51 || code === 53 || code === 55) return '毛毛雨';
  if (code === 56 || code === 57) return '冻雨';
  if (code === 61 || code === 63 || code === 65) return '雨';
  if (code === 66 || code === 67) return '冻雨';
  if (code === 71 || code === 73 || code === 75 || code === 77) return '雪';
  if (code === 80 || code === 81 || code === 82) return '阵雨';
  if (code === 85 || code === 86) return '阵雪';
  if (code === 95 || code === 96 || code === 99) return '雷雨';
  return '天气';
}

function buildWeatherMood(weather, date) {
  const now = date || new Date();
  const hour = now.getHours();
  const code = Number(weather && weather.weatherCode);
  const temp = Number(weather && weather.temperature);
  const apparent = Number(weather && weather.apparentTemperature);
  const rain = Number(weather && weather.precipitation) || 0;
  const humidity = Number(weather && weather.humidity) || 0;
  const wind = Number(weather && weather.windSpeed) || 0;
  const isNight = weather && weather.isDay === 0 || hour < 6 || hour >= 20;
  const isMorning = hour >= 5 && hour < 11;
  const isDusk = hour >= 17 && hour < 20;
  const isRain = rain > 0 || [51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99].includes(code);
  const isSnow = [71, 73, 75, 77, 85, 86].includes(code);
  const isCloud = [2, 3, 45, 48].includes(code);
  const isStorm = [95, 96, 99].includes(code);
  const feels = Number.isFinite(apparent) ? apparent : temp;

  let mood = {
    key: 'clear',
    title: '晴朗电台',
    tagline: '让节奏亮一点，像窗边的光',
    energy: 0.62,
    warmth: 0.58,
    focus: 0.48,
    melancholy: 0.24,
    keywords: ['轻快 华语', 'city pop', 'indie pop', 'chill pop', '阳光 歌单'],
  };
  if (isStorm) {
    mood = {
      key: 'storm',
      title: '雷雨电台',
      tagline: '低频更厚，适合把世界关小一点',
      energy: 0.46,
      warmth: 0.34,
      focus: 0.66,
      melancholy: 0.62,
      keywords: ['暗色 R&B', 'trip hop', '夜晚 电子', '氛围 摇滚', '雨夜 歌单'],
    };
  } else if (isRain) {
    mood = {
      key: 'rain',
      title: '雨天电台',
      tagline: '留一点潮湿的空间给旋律',
      energy: 0.38,
      warmth: 0.42,
      focus: 0.64,
      melancholy: 0.66,
      keywords: ['雨天 R&B', 'lofi rainy', '华语 慢歌', 'dream pop', '雨夜 歌单'],
    };
  } else if (isSnow || feels <= 3) {
    mood = {
      key: 'snow',
      title: '冷空气电台',
      tagline: '干净、慢速、带一点冬天的颗粒感',
      energy: 0.34,
      warmth: 0.28,
      focus: 0.72,
      melancholy: 0.54,
      keywords: ['冬天 民谣', 'ambient piano', '日系 冬天', 'indie folk', '安静 歌单'],
    };
  } else if (feels >= 31 || humidity >= 78) {
    mood = {
      key: 'humid',
      title: '闷热电台',
      tagline: '降低密度，留出一点呼吸',
      energy: 0.48,
      warmth: 0.76,
      focus: 0.46,
      melancholy: 0.30,
      keywords: ['夏日 chill', 'bossa nova', 'city pop 夏天', '轻电子', '海边 歌单'],
    };
  } else if (isCloud) {
    mood = {
      key: 'cloudy',
      title: '阴天电台',
      tagline: '不急着明亮，先让声音变软',
      energy: 0.40,
      warmth: 0.46,
      focus: 0.58,
      melancholy: 0.52,
      keywords: ['阴天 华语', 'indie rock mellow', 'neo soul', 'chillhop', '独立 民谣'],
    };
  }

  if (isNight) {
    mood.key += '-night';
    mood.title = mood.key.startsWith('clear') ? '夜色电台' : mood.title.replace('电台', '夜听');
    mood.tagline = '音量放低一点，让夜色参与编曲';
    mood.energy = Math.min(mood.energy, 0.42);
    mood.focus = Math.max(mood.focus, 0.68);
    mood.melancholy = Math.max(mood.melancholy, 0.52);
    mood.keywords = ['夜晚 R&B', 'late night jazz', 'ambient', 'lofi sleep', '夜跑 歌单'].concat(mood.keywords.slice(0, 3));
  } else if (isMorning) {
    mood.title = mood.key.startsWith('rain') ? '雨晨电台' : '早晨电台';
    mood.energy = Math.max(mood.energy, 0.52);
    mood.keywords = ['早晨 通勤', 'morning acoustic', '清晨 indie', '轻快 华语'].concat(mood.keywords.slice(0, 3));
  } else if (isDusk) {
    mood.title = mood.key.startsWith('rain') ? '黄昏雨声' : '黄昏电台';
    mood.melancholy = Math.max(mood.melancholy, 0.48);
    mood.keywords = ['黄昏 city pop', '日落 歌单', '落日飞车', 'soul pop'].concat(mood.keywords.slice(0, 3));
  }

  if (wind >= 28) {
    mood.energy = Math.max(mood.energy, 0.56);
    mood.keywords = ['公路 摇滚', 'windy day playlist'].concat(mood.keywords.slice(0, 4));
  }
  mood.keywords = Array.from(new Set(mood.keywords)).slice(0, 7);
  return mood;
}

async function resolveOpenMeteoLocation(query) {
  const raw = String(query || '').trim();
  if (!raw) return WEATHER_DEFAULT_LOCATION;
  const u = new URL(OPEN_METEO_GEOCODE_URL);
  u.searchParams.set('name', raw);
  u.searchParams.set('count', '1');
  u.searchParams.set('language', 'zh');
  u.searchParams.set('format', 'json');
  const body = await requestJson(u.toString(), { headers: { 'User-Agent': UA } });
  const first = body && Array.isArray(body.results) && body.results[0];
  if (!first) return { ...WEATHER_DEFAULT_LOCATION, query: raw, fallback: true };
  return {
    name: first.name || raw,
    country: first.country || '',
    admin1: first.admin1 || '',
    latitude: first.latitude,
    longitude: first.longitude,
    timezone: first.timezone || 'auto',
  };
}

async function fetchOpenMeteoWeather(params) {
  params = params || {};
  let location;
  const lat = clampNumber(params.lat, -90, 90, NaN);
  const lon = clampNumber(params.lon, -180, 180, NaN);
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    location = {
      name: String(params.city || params.name || '当前位置').trim() || '当前位置',
      country: '',
      latitude: lat,
      longitude: lon,
      timezone: params.timezone || 'auto',
    };
  } else {
    location = await resolveOpenMeteoLocation(params.city || params.q || params.location);
  }
  const u = new URL(OPEN_METEO_FORECAST_URL);
  u.searchParams.set('latitude', String(location.latitude));
  u.searchParams.set('longitude', String(location.longitude));
  u.searchParams.set('current', 'temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,rain,showers,snowfall,weather_code,cloud_cover,wind_speed_10m,wind_gusts_10m');
  u.searchParams.set('hourly', 'precipitation_probability,weather_code,temperature_2m');
  u.searchParams.set('forecast_days', '1');
  u.searchParams.set('timezone', location.timezone || 'auto');
  const body = await requestJson(u.toString(), { headers: { 'User-Agent': UA } });
  const cur = body && body.current || {};
  const weather = {
    provider: 'open-meteo',
    location: {
      name: location.name,
      country: location.country || '',
      admin1: location.admin1 || '',
      latitude: location.latitude,
      longitude: location.longitude,
      timezone: body.timezone || location.timezone || '',
      fallback: !!location.fallback,
    },
    label: openMeteoWeatherLabel(cur.weather_code),
    weatherCode: Number(cur.weather_code),
    temperature: Number(cur.temperature_2m),
    apparentTemperature: Number(cur.apparent_temperature),
    humidity: Number(cur.relative_humidity_2m),
    precipitation: Number(cur.precipitation || cur.rain || cur.showers || cur.snowfall || 0),
    cloudCover: Number(cur.cloud_cover),
    windSpeed: Number(cur.wind_speed_10m),
    windGusts: Number(cur.wind_gusts_10m),
    isDay: Number(cur.is_day),
    time: cur.time || '',
    updatedAt: Date.now(),
  };
  weather.mood = buildWeatherMood(weather);
  return weather;
}

async function fetchIpWeatherLocation() {
  const u = new URL(WEATHER_IP_LOCATION_URL);
  u.searchParams.set('fields', 'status,message,country,regionName,city,lat,lon,timezone,query');
  u.searchParams.set('lang', 'zh-CN');
  const body = await requestJson(u.toString(), { headers: { 'User-Agent': UA } });
  if (!body || body.status !== 'success' || !Number.isFinite(Number(body.lat)) || !Number.isFinite(Number(body.lon))) {
    const err = new Error(body && body.message || 'IP_LOCATION_FAILED');
    err.body = body;
    throw err;
  }
  return {
    provider: 'ip-api',
    city: body.city || WEATHER_DEFAULT_LOCATION.name,
    region: body.regionName || '',
    country: body.country || '',
    latitude: Number(body.lat),
    longitude: Number(body.lon),
    timezone: body.timezone || 'auto',
    ip: body.query || '',
  };
}

function weatherRadioSeedQueries(mood) {
  const key = String(mood && mood.key || '');
  if (key.includes('rain') || key.includes('storm')) return ['陈奕迅 阴天快乐', '周杰伦 雨下一整晚', '孙燕姿 遇见', '林宥嘉 说谎', '毛不易 消愁'];
  if (key.includes('snow') || key.includes('cloudy')) return ['陈奕迅 好久不见', '莫文蔚 阴天', '李健 贝加尔湖畔', '朴树 平凡之路', '蔡健雅 达尔文'];
  if (key.includes('humid')) return ['落日飞车 My Jinji', '告五人 爱人错过', '夏日入侵企画 想去海边', '陈绮贞 旅行的意义', '王若琳 Lost in Paradise'];
  if (key.includes('night')) return ['方大同 特别的人', '陶喆 爱很简单', 'Frank Ocean Pink + White', '林忆莲 夜太黑', "Norah Jones Don't Know Why"];
  return ['孙燕姿 天黑黑', '周杰伦 晴天', '五月天 温柔', '陈奕迅 稳稳的幸福', '王菲'];
}

function fallbackWeatherForRadio(params, err) {
  params = params || {};
  const name = String(params.city || params.q || params.location || WEATHER_DEFAULT_LOCATION.name).trim() || WEATHER_DEFAULT_LOCATION.name;
  return {
    provider: 'open-meteo',
    location: {
      name,
      country: '',
      admin1: '',
      latitude: null,
      longitude: null,
      timezone: params.timezone || WEATHER_DEFAULT_LOCATION.timezone,
      fallback: true,
    },
    label: '天气暂不可用',
    weatherCode: null,
    temperature: null,
    apparentTemperature: null,
    humidity: null,
    precipitation: null,
    cloudCover: null,
    windSpeed: null,
    windGusts: null,
    isDay: null,
    time: '',
    updatedAt: Date.now(),
    error: err && err.message || '',
    mood: {
      key: 'fallback',
      title: '临时电台',
      tagline: '天气暂时没有回来，先放一组稳妥的歌',
      energy: 0.54,
      warmth: 0.55,
      focus: 0.55,
      melancholy: 0.35,
      keywords: ['华语 流行', 'indie pop', 'city pop', '轻快 歌单', 'chill pop'],
    },
  };
}

function uniqueSongsByKey(songs) {
  const seen = new Set();
  const out = [];
  (songs || []).forEach(song => {
    const key = String(song && (song.id || song.name + '|' + song.artist) || '').trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(song);
  });
  return out;
}

function tagWeatherPoolSongs(songs, source) {
  return (songs || []).map(song => ({ ...song, weatherSource: source }));
}

async function fetchWeatherPlaylistSongs(playlist, limit) {
  const id = playlist && playlist.id;
  if (!id) return [];
  let rawTracks = [];
  try {
    if (typeof playlist_track_all === 'function') {
      const all = await playlist_track_all({ id, limit: limit || 36, offset: 0, cookie: userCookie, timestamp: Date.now() });
      rawTracks = (all.body && (all.body.songs || all.body.tracks)) || [];
    }
  } catch (e) {
    console.warn('[WeatherRadio] playlist_track_all failed:', playlist && playlist.name, e.message);
  }
  if (!rawTracks.length && typeof playlist_detail === 'function') {
    try {
      const detail = await playlist_detail({ id, s: 0, cookie: userCookie, timestamp: Date.now() });
      const pl = (detail.body && detail.body.playlist) || {};
      rawTracks = pl.tracks || [];
    } catch (e) {
      console.warn('[WeatherRadio] playlist_detail failed:', playlist && playlist.name, e.message);
    }
  }
  return rawTracks.map(mapSongRecord).filter(song => song.id && song.name).slice(0, limit || 36);
}

async function filterLikelyPlayableWeatherSongs(songs) {
  const source = uniqueSongsByKey(songs)
    .filter(song => song && song.name && song.id && !isLowSignalWeatherSong(song))
    .slice(0, 24);
  const playable = [];
  const fallback = source.slice(0, 24);
  for (let i = 0; i < source.length; i += 4) {
    const chunk = source.slice(i, i + 4);
    const settled = await Promise.allSettled(chunk.map(async song => {
      const info = await handleSongUrl(song.id, { loggedIn: !!userCookie }, 'standard');
      return info && info.url ? song : null;
    }));
    settled.forEach((result, idx) => {
      if (result.status === 'fulfilled' && result.value) playable.push(result.value);
      else if (result.status === 'rejected') console.warn('[WeatherRadio] playable probe failed:', chunk[idx] && chunk[idx].name, result.reason && result.reason.message);
    });
    if (playable.length >= 12) break;
  }
  return (playable.length ? playable : fallback).slice(0, 24);
}

function isLowSignalWeatherSong(song) {
  const text = String([
    song && song.name,
    song && song.artist,
    song && song.album,
  ].filter(Boolean).join(' ')).toLowerCase();
  if (!text) return true;
  if (/(^|[\s\-_/（(])ai(?:\s*(歌|歌曲|音乐|cover|翻唱|生成|作曲|演唱|女声|男声)|$|[\s\-_/）)])/i.test(text)) return true;
  if (/suno|udio|人工智能|生成歌曲|ai歌曲|虚拟歌手|测试音频|demo|beat\s*maker/i.test(text)) return true;
  if (/翻自|翻唱|cover|remix|伴奏|纯音乐|钢琴|dj|live\s*版|live版|唯美钢琴|karaoke|instrumental/i.test(text)) return true;
  if (/白噪音|雨声|睡眠|助眠|冥想|疗愈频率|环境音|自然声音|asmr/i.test(text)) return true;
  if (/[（(](r&b|lofi|jazz|dj|edm|trap|remix|伴奏|纯音乐|钢琴|电子|治愈|古风|女声|男声|英文|中文版|抖音|ai)[）)]/i.test(text)) return true;
  if (/^(纯音乐|轻音乐|治愈系|放松|睡眠|雨天|阴天|夜晚|夏日|海边)$/i.test(String(song.name || '').trim())) return true;
  return false;
}

function scoreWeatherSong(song, mood) {
  const text = String((song && song.name || '') + ' ' + (song && song.artist || '') + ' ' + (song && song.album || '')).toLowerCase();
  let score = 0;
  if (song && song.cover) score += 4;
  if (song && song.duration) score += 2;
  if (song && song.weatherSource === 'daily') score += 6;
  if (song && song.weatherSource === 'private') score += 4;
  if (/周杰伦|陈奕迅|孙燕姿|五月天|王菲|陶喆|方大同|林宥嘉|蔡健雅|莫文蔚|李健|毛不易|告五人|落日飞车|陈绮贞|朴树/.test(text)) score += 10;
  const key = String(mood && mood.key || '');
  if (key.includes('rain') && /雨|阴|夜|慢|r&b|soul|陈奕迅|林宥嘉|孙燕姿/.test(text)) score += 5;
  if (key.includes('humid') && /夏|海|city|pop|落日|告五人|方大同|陶喆/.test(text)) score += 5;
  if (key.includes('night') && /夜|moon|jazz|soul|r&b|方大同|陶喆|王菲/.test(text)) score += 5;
  if (key.includes('cloudy') && /阴|民谣|indie|陈绮贞|朴树|李健/.test(text)) score += 5;
  return score;
}

function weatherArtistKey(song) {
  const raw = String(song && song.artist || song && song.name || '').split(/\s*\/\s*|、|,|&/)[0] || '';
  return raw.trim().toLowerCase() || 'unknown';
}

function weatherTitleKey(song) {
  return String(song && song.name || '')
    .toLowerCase()
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[\s._\-·'’"“”「」《》:：/\\|]+/g, '')
    .trim();
}

function uniqueWeatherTitles(sorted) {
  const seen = new Set();
  const out = [];
  (sorted || []).forEach(song => {
    const key = weatherTitleKey(song);
    if (key && seen.has(key)) return;
    if (key) seen.add(key);
    out.push(song);
  });
  return out;
}

function diversifyWeatherSongs(sorted, artistLimit) {
  const primary = [];
  const deferred = [];
  const counts = new Map();
  (sorted || []).forEach(song => {
    const key = weatherArtistKey(song);
    const count = counts.get(key) || 0;
    if (count < artistLimit) {
      primary.push(song);
      counts.set(key, count + 1);
    } else {
      deferred.push(song);
    }
  });
  return primary.length >= 8 ? primary : primary.concat(deferred.slice(0, 8 - primary.length));
}

function orderWeatherSongs(songs, mood) {
  const sorted = uniqueSongsByKey(songs)
    .filter(song => song && song.name && song.id && !isLowSignalWeatherSong(song))
    .sort((a, b) => scoreWeatherSong(b, mood) - scoreWeatherSong(a, mood));
  return diversifyWeatherSongs(uniqueWeatherTitles(sorted), 2);
}

async function buildWeatherRadio(params) {
  let weather;
  try {
    weather = await fetchOpenMeteoWeather(params);
  } catch (e) {
    console.warn('[WeatherRadio] weather provider failed, using fallback radio:', e.message);
    weather = fallbackWeatherForRadio(params, e);
  }
  const queries = weatherRadioSeedQueries(weather.mood);
  let songs = [];
  const settled = await Promise.allSettled(queries.slice(0, 4).map(q => handleSearch(q, 6)));
  settled.forEach(result => {
    if (result.status === 'fulfilled' && Array.isArray(result.value)) songs = songs.concat(result.value);
  });
  if (songs.length < 10 && weather.mood && Array.isArray(weather.mood.keywords)) {
    const more = await Promise.allSettled(weather.mood.keywords.slice(0, 2).map(q => handleSearch(q, 6)));
    more.forEach(result => {
      if (result.status === 'fulfilled' && Array.isArray(result.value)) songs = songs.concat(result.value);
    });
  }
  songs = orderWeatherSongs(songs, weather.mood);
  return {
    ok: true,
    weather,
    radio: {
      title: weather.mood.title,
      subtitle: weather.mood.tagline,
      seedQueries: queries.slice(0, 4),
      songs: songs.slice(0, 18),
      updatedAt: Date.now(),
    },
  };
}

function parseJSONText(text) {
  const raw = String(text || '').trim();
  const json = raw.replace(/^callback\(([\s\S]*)\);?$/, '$1');
  return JSON.parse(json);
}

async function qqMusicRequest(payload, opts) {
  opts = opts || {};
  const body = JSON.stringify(payload);
  const headers = {
    ...QQ_HEADERS,
    'Content-Type': 'application/json;charset=UTF-8',
    'Content-Length': Buffer.byteLength(body),
  };
  if (opts.cookie && qqCookie) headers.Cookie = qqCookie;
  const text = await requestText(QQ_MUSICU_URL, {
    method: 'POST',
    headers,
  }, body);
  return parseJSONText(text);
}

function normalizeQQProfile(body, cookieObj) {
  cookieObj = cookieObj || qqCookieObject();
  const uin = qqCookieUin(cookieObj);
  const data = (body && (body.data || body.profile || body.creator || body.result)) || {};
  const creator = (data.creator || data.user || data.profile || data) || {};
  const vipInfo = data.vipInfo || data.vipinfo || data.vip || creator.vipInfo || creator.vipinfo || {};
  const profileNick = creator.nick || creator.nickname || creator.name || creator.hostname || creator.title || '';
  const profileAvatar = creator.headpic || creator.avatar || creator.avatarUrl || creator.logo || '';
  const cookieNick = qqCookieNickname(cookieObj, uin);
  const nick = profileNick || cookieNick || '';
  const avatar = profileAvatar || qqCookieAvatar(cookieObj, uin);
  let vipType = Number(
    cookieObj.vipType || cookieObj.vip_type ||
    data.vipType || data.vip_type || data.viptype || data.music_vip_level || data.green_vip_level || data.luxury_vip_level ||
    creator.vipType || creator.vip_type || creator.music_vip_level || creator.green_vip_level || creator.luxury_vip_level ||
    vipInfo.vipType || vipInfo.vip_type || vipInfo.music_vip_level || vipInfo.green_vip_level || vipInfo.luxury_vip_level || 0
  ) || 0;
  if (!vipType) {
    const vipFlag = data.isVip || data.is_vip || data.vipFlag || data.vipflag || creator.isVip || creator.is_vip || vipInfo.isVip || vipInfo.is_vip || vipInfo.vipFlag;
    if (vipFlag === true || Number(vipFlag) > 0 || String(vipFlag || '').toLowerCase() === 'true') vipType = 1;
  }
  return {
    provider: 'qq',
    loggedIn: !!(uin && qqCookieMusicKey(cookieObj)),
    preview: false,
    userId: uin,
    nickname: nick || (uin ? ('QQ ' + uin) : 'QQ 音乐'),
    avatar,
    vipType,
    hasCookie: !!qqCookie,
    playbackKeyReady: !!qqCookiePlaybackKey(cookieObj),
    profileSource: profileNick || profileAvatar ? 'qq-profile' : (cookieNick || avatar ? 'cookie' : 'fallback'),
  };
}

async function getQQLoginInfo() {
  const cookieObj = qqCookieObject();
  const uin = qqCookieUin(cookieObj);
  const musicKey = qqCookieMusicKey(cookieObj);
  if (!uin || !musicKey) return { provider: 'qq', loggedIn: false, hasCookie: !!qqCookie };
  const fallback = normalizeQQProfile(null, cookieObj);
  try {
    const u = new URL('https://c.y.qq.com/rsc/fcgi-bin/fcg_get_profile_homepage.fcg');
    u.searchParams.set('cid', '205360838');
    u.searchParams.set('userid', uin);
    u.searchParams.set('reqfrom', '1');
    u.searchParams.set('g_tk', '5381');
    u.searchParams.set('loginUin', uin);
    u.searchParams.set('hostUin', '0');
    u.searchParams.set('format', 'json');
    u.searchParams.set('inCharset', 'utf8');
    u.searchParams.set('outCharset', 'utf-8');
    u.searchParams.set('notice', '0');
    u.searchParams.set('platform', 'yqq.json');
    u.searchParams.set('needNewCode', '0');
    const text = await requestText(u.toString(), {
      headers: { ...QQ_HEADERS, Cookie: qqCookie },
    });
    const body = parseJSONText(text);
    const info = normalizeQQProfile(body, cookieObj);
    if (body && (body.code === 1000 || body.result === 301)) {
      return { ...fallback, profileUnavailable: true };
    }
    return info;
  } catch (e) {
    console.warn('[QQLogin] profile check failed:', e.message);
    return { ...fallback, profileUnavailable: true };
  }
}

async function qqGetJSON(targetUrl, params, opts) {
  opts = opts || {};
  const u = new URL(targetUrl);
  Object.keys(params || {}).forEach(k => {
    if (params[k] != null) u.searchParams.set(k, String(params[k]));
  });
  const headers = { ...QQ_HEADERS, ...(opts.headers || {}) };
  if (opts.cookie !== false && qqCookie) headers.Cookie = qqCookie;
  const text = await requestText(u.toString(), { headers });
  return parseJSONText(text);
}

function audioProxyHeadersFor(audioUrl, range) {
  const headers = { 'User-Agent': UA, Referer: 'https://music.163.com/' };
  try {
    const host = new URL(audioUrl).hostname.toLowerCase();
    if (host.includes('qq.com') || host.includes('qpic.cn')) headers.Referer = 'https://y.qq.com/';
  } catch (e) {}
  if (range) headers.Range = range;
  return headers;
}

function audioContentTypeForUrl(audioUrl, upstreamType) {
  let pathname = '';
  try { pathname = new URL(audioUrl).pathname.toLowerCase(); } catch (e) {}
  if (/\.flac$/.test(pathname)) return 'audio/flac';
  if (/\.mp3$/.test(pathname)) return 'audio/mpeg';
  if (/\.(m4a|mp4)$/.test(pathname)) return 'audio/mp4';
  if (/\.ogg$/.test(pathname)) return 'audio/ogg';
  if (/\.wav$/.test(pathname)) return 'audio/wav';
  return upstreamType || 'audio/mpeg';
}

function mapQQPlaylist(pl, kind) {
  pl = pl || {};
  const id = pl.dissid || pl.tid || pl.dirid || pl.id || pl.diss_id;
  return {
    provider: 'qq',
    source: 'qq',
    id: id ? String(id) : '',
    name: pl.diss_name || pl.name || pl.title || '',
    cover: pl.diss_cover || pl.logo || pl.picurl || pl.cover || '',
    trackCount: pl.song_cnt || pl.songnum || pl.total_song_num || pl.song_count || 0,
    playCount: pl.listen_num || pl.visitnum || pl.play_count || 0,
    creator: pl.hostname || pl.nick || pl.creator || 'QQ 音乐',
    subscribed: kind === 'collect',
    specialType: 0,
  };
}

function mapQQPlaylistTrack(raw) {
  raw = raw || {};
  const track = raw.songid || raw.songmid || raw.mid || raw.name ? raw : (raw.track_info || raw.songInfo || raw.songinfo || raw.song || {});
  const album = track.album || {};
  const artists = mapQQArtists(track.singer || track.singers || []);
  const mid = track.mid || track.songmid || raw.mid || raw.songmid || '';
  const albumMid = album.mid || track.albummid || raw.albummid || '';
  return {
    provider: 'qq',
    source: 'qq',
    type: 'qq',
    id: mid || String(track.id || track.songid || raw.id || raw.songid || ''),
    qqId: track.id || track.songid || raw.id || raw.songid || '',
    mid,
    songmid: mid,
    mediaMid: (track.file && track.file.media_mid) || track.strMediaMid || track.media_mid || raw.strMediaMid || '',
    name: track.name || track.songname || raw.songname || '',
    artist: artists.map(a => a.name).join(' / ') || track.singername || raw.singername || '',
    artists,
    artistId: artists[0] && (artists[0].id || artists[0].mid),
    artistMid: artists[0] && artists[0].mid,
    album: album.name || album.title || track.albumname || raw.albumname || '',
    albumMid,
    cover: qqAlbumCover(albumMid, 300),
    duration: (Number(track.interval || raw.interval) || 0) * 1000,
    fee: track.pay && Number(track.pay.pay_play) ? 1 : 0,
    playable: false,
  };
}

async function handleQQUserPlaylists() {
  const info = await getQQLoginInfo();
  if (!info.loggedIn || !info.userId) return { loggedIn: false, provider: 'qq', playlists: [] };
  const uin = info.userId;
  const createdReq = qqGetJSON('https://c.y.qq.com/rsc/fcgi-bin/fcg_user_created_diss', {
    hostUin: 0,
    hostuin: uin,
    sin: 0,
    size: 200,
    g_tk: 5381,
    loginUin: uin,
    format: 'json',
    inCharset: 'utf8',
    outCharset: 'utf-8',
    notice: 0,
    platform: 'yqq.json',
    needNewCode: 0,
  }, { headers: { Referer: 'https://y.qq.com/portal/profile.html' } });
  const collectReq = qqGetJSON('https://c.y.qq.com/fav/fcgi-bin/fcg_get_profile_order_asset.fcg', {
    ct: 20,
    cid: 205360956,
    userid: uin,
    reqtype: 3,
    sin: 0,
    ein: 80,
  }, { headers: { Referer: 'https://y.qq.com/portal/profile.html' } });
  const [createdRaw, collectRaw] = await Promise.allSettled([createdReq, collectReq]);
  const created = createdRaw.status === 'fulfilled' && createdRaw.value && createdRaw.value.data && Array.isArray(createdRaw.value.data.disslist)
    ? createdRaw.value.data.disslist.map(pl => mapQQPlaylist(pl, 'created')) : [];
  const collected = collectRaw.status === 'fulfilled' && collectRaw.value && collectRaw.value.data && Array.isArray(collectRaw.value.data.cdlist)
    ? collectRaw.value.data.cdlist.map(pl => mapQQPlaylist(pl, 'collect')) : [];
  const seen = new Set();
  const playlists = created.concat(collected).filter(pl => {
    if (!pl.id || !pl.name || seen.has(pl.id)) return false;
    if (isQzoneBackgroundPlaylist(pl)) return false;
    seen.add(pl.id);
    return true;
  }).sort((a, b) => Number(isQQFavoritePlaylist(b)) - Number(isQQFavoritePlaylist(a)));
  return { loggedIn: true, provider: 'qq', userId: uin, playlists };
}

async function handleQQPlaylistTracks(id) {
  const info = await getQQLoginInfo();
  if (!info.loggedIn || !info.userId) return { loggedIn: false, provider: 'qq', tracks: [] };
  const pid = String(id || '').trim();
  if (!pid) return { loggedIn: true, provider: 'qq', error: 'Missing QQ playlist id', tracks: [] };
  const result = await qqGetJSON('https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg', {
    type: 1,
    utf8: 1,
    disstid: pid,
    loginUin: info.userId,
    format: 'json',
    inCharset: 'utf8',
    outCharset: 'utf-8',
    notice: 0,
    platform: 'yqq.json',
    needNewCode: 0,
  }, { headers: { Referer: 'https://y.qq.com/n/yqq/playlist' } });
  const detail = result && result.cdlist && result.cdlist[0] ? result.cdlist[0] : {};
  const rawTracks = Array.isArray(detail.songlist) ? detail.songlist : [];
  const tracks = rawTracks.map(mapQQPlaylistTrack).filter(s => s.name && (s.mid || s.id));
  const playlist = {
    provider: 'qq',
    id: pid,
    name: detail.dissname || detail.diss_name || detail.name || '',
    cover: detail.logo || detail.diss_cover || '',
    trackCount: tracks.length,
  };
  return { loggedIn: true, provider: 'qq', playlist, tracks };
}

function qqAlbumCover(albumMid, size) {
  if (!albumMid) return '';
  const px = size || 300;
  return 'https://y.qq.com/music/photo_new/T002R' + px + 'x' + px + 'M000' + albumMid + '.jpg?max_age=2592000';
}

function qqSingerAvatar(singerMid, size) {
  if (!singerMid) return '';
  const px = size || 300;
  return 'https://y.qq.com/music/photo_new/T001R' + px + 'x' + px + 'M000' + singerMid + '.jpg?max_age=2592000';
}

function mapQQArtists(raw) {
  return (raw || [])
    .map(a => ({
      id: a && a.id,
      mid: a && a.mid,
      name: (a && (a.name || a.title)) || '',
    }))
    .filter(a => a.name);
}

function qqQualityTypesFromFile(file) {
  file = file || {};
  const types = [];
  const _types = {};
  function add(type, size) {
    if (!size || _types[type]) return;
    const meta = { size: lxSizeFormat(size) };
    types.push(Object.assign({ type }, meta));
    _types[type] = meta;
  }
  add('128k', file.size_128mp3);
  add('320k', file.size_320mp3);
  add('flac', file.size_flac);
  add('hires', file.size_hires);
  if (Array.isArray(file.size_new)) {
    add('master', file.size_new[0]);
    add('atmos', file.size_new[1]);
    add('atmos_plus', file.size_new[2]);
  }
  return { types, _types };
}

function mapQQSmartSong(item) {
  item = item || {};
  const mid = item.mid || item.songmid || item.id || '';
  return {
    provider: 'qq',
    source: 'qq',
    type: 'qq',
    id: mid,
    qqId: item.id || item.docid || '',
    mid,
    songmid: mid,
    name: item.name || item.title || '',
    artist: item.singer || '',
    artists: item.singer ? [{ name: item.singer }] : [],
    album: '',
    cover: '',
    duration: 0,
    fee: 0,
    playable: false,
  };
}

function mapQQTrack(track, fallback) {
  track = track || {};
  fallback = fallback || {};
  const album = track.album || {};
  const artists = mapQQArtists(track.singer || []);
  const mid = track.mid || fallback.mid || fallback.songmid || '';
  const albumMid = album.mid || album.pmid || '';
  const qualityInfo = qqQualityTypesFromFile(track.file || {});
  return {
    provider: 'qq',
    source: 'qq',
    type: 'qq',
    id: mid,
    qqId: track.id || fallback.qqId || fallback.id || '',
    mid,
    songmid: mid,
    mediaMid: track.file && track.file.media_mid,
    name: track.name || track.title || fallback.name || '',
    artist: artists.map(a => a.name).join(' / ') || fallback.artist || '',
    artists: artists.length ? artists : (fallback.artists || []),
    artistId: artists[0] && (artists[0].id || artists[0].mid),
    artistMid: artists[0] && artists[0].mid,
    album: album.name || album.title || fallback.album || '',
    albumMid,
    cover: qqAlbumCover(albumMid, 300) || fallback.cover || '',
    duration: (Number(track.interval) || 0) * 1000,
    types: qualityInfo.types,
    _types: qualityInfo._types,
    fee: track.pay && Number(track.pay.pay_play) ? 1 : 0,
    playable: false,
  };
}

async function qqSmartboxSearch(keywords, limit) {
  const u = new URL(QQ_SMARTBOX_URL);
  u.searchParams.set('format', 'json');
  u.searchParams.set('key', keywords);
  u.searchParams.set('g_tk', '5381');
  u.searchParams.set('loginUin', '0');
  u.searchParams.set('hostUin', '0');
  u.searchParams.set('inCharset', 'utf8');
  u.searchParams.set('outCharset', 'utf-8');
  u.searchParams.set('notice', '0');
  u.searchParams.set('platform', 'yqq.json');
  u.searchParams.set('needNewCode', '0');
  const text = await requestText(u.toString(), { headers: QQ_HEADERS });
  const json = parseJSONText(text);
  const items = json && json.data && json.data.song && json.data.song.itemlist;
  return (Array.isArray(items) ? items : []).slice(0, Math.max(1, Math.min(limit || 6, 10))).map(mapQQSmartSong);
}

async function qqSongDetail(mid, fallback) {
  if (!mid) return fallback;
  const json = await qqMusicRequest({
    comm: { ct: 24, cv: 0 },
    songinfo: {
      module: 'music.pf_song_detail_svr',
      method: 'get_song_detail_yqq',
      param: { song_mid: mid },
    },
  });
  const data = json && json.songinfo && json.songinfo.data;
  return mapQQTrack(data && data.track_info, fallback);
}

async function handleQQArtistDetail(mid, limit) {
  const singerMid = String(mid || '').trim();
  const num = Math.max(10, Math.min(80, parseInt(limit || '36', 10) || 36));
  if (!singerMid) return { provider: 'qq', error: 'MISSING_SINGER_MID', artist: null, songs: [] };
  const json = await qqMusicRequest({
    comm: { ct: 24, cv: 0 },
    singer: {
      module: 'music.web_singer_info_svr',
      method: 'get_singer_detail_info',
      param: { sort: 5, singermid: singerMid, sin: 0, num },
    },
  }, { cookie: true });
  const block = json && json.singer;
  if (!block || Number(block.code || 0) !== 0) {
    return { provider: 'qq', error: block && (block.message || block.msg || block.code) || 'QQ_ARTIST_DETAIL_FAILED', artist: null, songs: [] };
  }
  const data = block.data || {};
  const info = data.singer_info || data.singerInfo || {};
  const rawSongs = Array.isArray(data.songlist) ? data.songlist : [];
  const songs = rawSongs
    .map(raw => mapQQTrack(raw && (raw.track_info || raw.songInfo || raw.songinfo || raw.song) || raw, {}))
    .filter(song => song && song.name && (song.mid || song.id));
  const matchedSongArtist = songs[0] && (songs[0].artists || []).find(a => a && a.mid === singerMid);
  const artistMid = info.mid || singerMid;
  const artistName = info.name || info.title || (matchedSongArtist && matchedSongArtist.name) || '';
  const totalSong = Number(data.total_song || data.song_count || 0) || songs.length;
  return {
    provider: 'qq',
    artist: {
      provider: 'qq',
      id: info.id || '',
      mid: artistMid,
      name: artistName,
      avatar: info.pic || info.avatar || qqSingerAvatar(artistMid, 300),
      fans: Number(info.fans || 0) || 0,
      musicSize: totalSong,
      albumSize: Number(data.total_album || 0) || 0,
      mvSize: Number(data.total_mv || 0) || 0,
    },
    total: totalSong,
    songs,
  };
}

async function handleQQSearch(keywords, limit) {
  const kw = String(keywords || '').trim();
  if (!kw) return [];
  console.log('[QQSearch]', kw, 'limit:', limit);
  const base = await qqSmartboxSearch(kw, limit);
  const detailed = await Promise.all(base.map(async item => {
    try { return await qqSongDetail(item.mid, item); }
    catch (e) {
      console.warn('[QQSearch] detail failed:', item.mid, e.message);
      return item;
    }
  }));
  const seen = new Set();
  return detailed.filter(song => {
    const key = song && (song.mid || song.id || (song.name + '|' + song.artist));
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return !!song.name;
  });
}

async function handleQQSongUrl(mid, mediaMid, qualityPreference) {
  const songmid = String(mid || '').trim();
  if (!songmid) return { provider: 'qq', url: '', error: 'MISSING_MID', message: 'Missing QQ song mid' };
  const guid = String(10000000 + Math.floor(Math.random() * 90000000));
  const cookieObj = qqCookieObject();
  const uin = qqCookieUin(cookieObj) || '0';
  const musicKey = qqCookieMusicKey(cookieObj);
  const playbackKey = qqCookiePlaybackKey(cookieObj);
  const fileMediaMid = String(mediaMid || '').trim();
  const requestedQuality = normalizeQualityPreference(qualityPreference);
  const mediaIds = [];
  if (fileMediaMid) mediaIds.push(fileMediaMid);
  if (songmid && !mediaIds.includes(songmid)) mediaIds.push(songmid);
  const fileCandidates = mediaIds.flatMap(mediaId =>
    qualityCandidatesFrom(requestedQuality, QQ_QUALITY_CANDIDATE_TEMPLATES)
      .map(item => ({ ...item, mediaId, filename: item.prefix + mediaId + item.ext }))
  );
  const filenames = fileCandidates.map(item => item.filename);
  const param = {
    guid,
    songmid: filenames.length ? filenames.map(() => songmid) : [songmid],
    songtype: filenames.length ? filenames.map(() => 0) : [0],
    uin,
    loginflag: 1,
    platform: '20',
  };
  if (filenames.length) param.filename = filenames;
  const comm = { uin, format: 'json', ct: musicKey ? 19 : 24, cv: 0 };
  if (musicKey) comm.authst = musicKey;
  const json = await qqMusicRequest({
    comm,
    req_0: {
      module: 'vkey.GetVkeyServer',
      method: 'CgiGetVkey',
      param,
    },
  }, { cookie: true });
  const data = json && json.req_0 && json.req_0.data;
  const infos = (data && Array.isArray(data.midurlinfo)) ? data.midurlinfo : [];
  const info = infos.find(item => item && item.purl) || infos[0];
  const purl = info && info.purl;
  if (purl) {
    const sip = (data.sip && data.sip[0]) || 'https://ws.stream.qqmusic.qq.com/';
    const fileMeta = fileCandidates.find(item => item.filename === info.filename) || {};
    return {
      provider: 'qq',
      url: sip + purl,
      trial: false,
      playable: true,
      level: fileMeta.level || info.filename || '',
      quality: fileMeta.label || info.filename || '',
      filename: info.filename || '',
      requestedQuality,
    };
  }
  const restriction = classifyQQPlaybackRestriction(info, {
    hasSession: !!(uin && musicKey),
    hasPlaybackKey: !!(uin && playbackKey),
  });
  return {
    provider: 'qq',
    url: '',
    playable: false,
    error: 'QQ_URL_UNAVAILABLE',
    loggedIn: !!(uin && musicKey),
    playbackKeyReady: !!(uin && playbackKey),
    restriction,
    reason: restriction.category,
    message: restriction.message,
    qqCode: info && (info.result || info.code || info.errtype),
    rawMessage: info && (info.msg || info.tips || info.errmsg || ''),
    tried: fileCandidates.map(item => item.label + ' · ' + item.filename),
    requestedQuality,
  };
}

function mapQQComment(raw) {
  raw = raw || {};
  const user = raw.user || raw.uin || {};
  const nickname = raw.nick || raw.nickname || raw.encrypt_uin || user.nick || user.nickname || user.name || 'QQ 音乐用户';
  const avatar = raw.avatarurl || raw.avatar || user.avatarurl || user.avatar || '';
  const timeRaw = Number(raw.time || raw.commenttime || raw.createTime || 0) || 0;
  return {
    id: raw.commentid || raw.commentId || raw.id || '',
    content: raw.rootcommentcontent || raw.content || raw.comment || '',
    likedCount: Number(raw.praisenum || raw.praise_num || raw.likedCount || 0) || 0,
    time: timeRaw && timeRaw < 10000000000 ? timeRaw * 1000 : timeRaw,
    user: {
      id: raw.encrypt_uin || raw.uin || user.uin || '',
      nickname,
      avatar,
    },
  };
}

async function handleQQSongComments(id, mid, limit, offset) {
  let topid = String(id || '').replace(/\D/g, '');
  if (!topid && mid) {
    try {
      const detail = await qqSongDetail(mid, { mid });
      topid = String((detail && (detail.qqId || detail.id)) || '').replace(/\D/g, '');
    } catch (e) {
      console.warn('[QQComments] detail fallback failed:', e.message);
    }
  }
  if (!topid) return { provider: 'qq', error: 'Missing QQ song id', comments: [] };
  const page = Math.max(0, Math.floor((offset || 0) / Math.max(1, limit || 20)));
  const uin = qqCookieUin() || '0';
  const body = await qqGetJSON('https://c.y.qq.com/base/fcgi-bin/fcg_global_comment_h5.fcg', {
    g_tk: '5381',
    loginUin: uin,
    hostUin: '0',
    format: 'json',
    inCharset: 'utf8',
    outCharset: 'utf-8',
    notice: '0',
    platform: 'yqq.json',
    needNewCode: '0',
    cid: '205360772',
    reqtype: '2',
    biztype: '1',
    topid,
    cmd: '8',
    needmusiccrit: '0',
    pagenum: String(page),
    pagesize: String(limit || 20),
  }, { headers: { Referer: 'https://y.qq.com/n/ryqq/songDetail/' + encodeURIComponent(mid || topid) } });
  const hotList = body && body.hot_comment && body.hot_comment.commentlist;
  const normalList = body && body.comment && body.comment.commentlist;
  const raw = (offset === 0 && Array.isArray(hotList) && hotList.length) ? hotList : (normalList || []);
  const comments = (raw || []).map(mapQQComment).filter(c => c.content);
  const total = Number(body && body.comment && (body.comment.commenttotal || body.comment.comment_total)) || comments.length;
  return { provider: 'qq', id: topid, total, comments, hot: !!(offset === 0 && Array.isArray(hotList) && hotList.length) };
}

function decodeHtmlEntities(text) {
  return String(text || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ');
}

function decodeQQLyricText(text) {
  let raw = decodeHtmlEntities(String(text || '').trim());
  if (!raw) return '';
  const compact = raw.replace(/\s+/g, '');
  const looksBase64 = compact.length >= 8 && compact.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(compact);
  if (looksBase64 && !/^\s*\[/.test(raw)) {
    try {
      const decoded = Buffer.from(compact, 'base64').toString('utf8').replace(/^\uFEFF/, '');
      if (decoded && (decoded.includes('[') || /[\u4e00-\u9fa5]/.test(decoded))) raw = decoded;
    } catch (e) {
      console.warn('[QQLyric] base64 decode failed:', e.message);
    }
  }
  return decodeHtmlEntities(raw).replace(/\r\n/g, '\n').trim();
}

function normalizeQQSongId(id) {
  const n = String(id || '').replace(/\D/g, '');
  return n ? Number(n) : 0;
}

async function handleQQLyric(mid, id) {
  const songMID = String(mid || '').trim();
  const songID = normalizeQQSongId(id);
  if (!songMID && !songID) return { provider: 'qq', error: 'Missing QQ song mid or id', lyric: '' };

  let lyricText = '';
  let transText = '';
  let qrcText = '';
  let romaText = '';
  let source = 'qq-musicu';

  try {
    const param = {};
    if (songMID) param.songMID = songMID;
    if (songID) param.songID = songID;
    const json = await qqMusicRequest({
      comm: { ct: 24, cv: 0 },
      lyric: {
        module: 'music.musichallSong.PlayLyricInfo',
        method: 'GetPlayLyricInfo',
        param,
      },
    }, { cookie: true });
    const data = json && json.lyric && json.lyric.data;
    lyricText = decodeQQLyricText(data && data.lyric);
    transText = decodeQQLyricText(data && data.trans);
    qrcText = decodeQQLyricText(data && data.qrc);
    romaText = decodeQQLyricText(data && data.roma);
  } catch (e) {
    console.warn('[QQLyric] musicu failed:', e.message);
  }

  if (!lyricText && songMID) {
    try {
      const body = await qqGetJSON('https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg', {
        songmid: songMID,
        songtype: '0',
        format: 'json',
        nobase64: '1',
        g_tk: '5381',
        loginUin: qqCookieUin() || '0',
        hostUin: '0',
        inCharset: 'utf8',
        outCharset: 'utf-8',
        notice: '0',
        platform: 'yqq.json',
        needNewCode: '0',
      }, { headers: { Referer: 'https://y.qq.com/portal/player.html' } });
      lyricText = decodeQQLyricText(body && body.lyric);
      transText = decodeQQLyricText(body && (body.trans || body.tlyric)) || transText;
      source = 'qq-legacy';
    } catch (e) {
      console.warn('[QQLyric] legacy failed:', e.message);
    }
  }

  return {
    provider: 'qq',
    id: songID || '',
    mid: songMID,
    lyric: lyricText,
    tlyric: transText,
    yrc: '',
    qrc: qrcText,
    roma: romaText,
    source: lyricText ? source : 'qq-empty',
  };
}

function mapPodcastRadio(r) {
  r = r || {};
  const dj = r.dj || r.djSimple || r.djUser || r.creator || {};
  const id = r.id || r.rid || r.radioId;
  return {
    id,
    rid: id,
    name: r.name || r.radioName || '',
    cover: r.picUrl || r.picURL || r.coverUrl || r.coverImgUrl || r.avatarUrl || '',
    desc: r.desc || r.description || r.rcmdText || '',
    djName: dj.nickname || r.djName || r.nickname || '',
    category: r.category || r.categoryName || '',
    programCount: r.programCount || r.programNum || r.programCnt || 0,
    subCount: r.subCount || r.subedCount || r.subscriberCount || 0,
  };
}

function mapPodcastProgram(p, fallbackRadio) {
  p = p || {};
  const mainSong = p.mainSong || p.song || p.mainTrack || {};
  const radio = p.radio || fallbackRadio || {};
  const mappedRadio = mapPodcastRadio(radio);
  const artists = mapArtists(mainSong.ar || mainSong.artists || []);
  const album = mainSong.al || mainSong.album || {};
  const dj = p.dj || radio.dj || {};
  const playableId = mainSong.id || p.mainSongId || p.songId;
  return {
    type: 'podcast',
    source: 'podcast',
    id: playableId,
    programId: p.id || p.programId,
    radioId: mappedRadio.id,
    name: p.name || mainSong.name || '',
    artist: mappedRadio.name || dj.nickname || artists.map(a => a.name).join(' / ') || mappedRadio.djName || '',
    artists,
    artistId: artists[0] && artists[0].id,
    album: mappedRadio.name || album.name || 'Podcast',
    cover: p.coverUrl || p.cover || p.blurCoverUrl || mappedRadio.cover || album.picUrl || '',
    duration: p.duration || mainSong.dt || mainSong.duration || 0,
    fee: mainSong.fee,
    djName: mappedRadio.djName || dj.nickname || '',
    radioName: mappedRadio.name || '',
    desc: p.description || p.desc || '',
    createTime: p.createTime || 0,
    serialNum: p.serialNum || p.serial || 0,
  };
}

function firstArrayFrom(obj, keys) {
  obj = obj || {};
  for (const key of keys) {
    const value = obj[key];
    if (Array.isArray(value)) return value;
    if (value && Array.isArray(value.list)) return value.list;
    if (value && Array.isArray(value.data)) return value.data;
    if (value && Array.isArray(value.resources)) return value.resources;
  }
  return [];
}

function mapPodcastVoice(v) {
  v = v || {};
  const raw = v.resource || v.voice || v.data || v.program || v;
  const mainSong = raw.mainSong || raw.song || raw.track || {};
  const radio = raw.radio || raw.djRadio || raw.voiceList || raw.podcast || {};
  const playableId = raw.trackId || raw.songId || raw.mainSongId || mainSong.id || raw.id;
  return {
    type: 'podcast',
    source: 'podcast',
    sourceType: 'podcast-voice',
    id: playableId,
    programId: raw.programId || raw.voiceId || raw.id,
    radioId: radio.id || radio.radioId || radio.voiceListId || raw.radioId || raw.voiceListId,
    name: raw.name || raw.songName || raw.title || mainSong.name || '',
    artist: (radio.name || radio.radioName || radio.voiceListName || raw.podcastName || raw.djName || 'Voice'),
    album: radio.name || radio.radioName || raw.podcastName || 'Podcast',
    cover: raw.coverUrl || raw.cover || raw.picUrl || raw.coverImgUrl || radio.picUrl || radio.coverUrl || '',
    duration: raw.duration || raw.durationMs || mainSong.dt || mainSong.duration || 0,
    djName: raw.djName || (radio.dj && radio.dj.nickname) || '',
    radioName: radio.name || radio.radioName || raw.podcastName || '',
    desc: raw.desc || raw.description || '',
  };
}

function mapPodcastCollectionRadio(r, key) {
  const radio = mapPodcastRadio(r);
  return {
    ...radio,
    type: 'podcast-radio',
    sourceType: 'podcast-radio',
    collectionKey: key || '',
    radioId: radio.id,
    name: radio.name,
    artist: radio.djName || radio.category || 'Podcast',
    album: radio.category || 'Podcast',
  };
}

function podcastCollectionMeta(key, items) {
  const meta = {
    collect: { key: 'collect', title: '收藏播客', sub: '你收藏的播客', itemType: 'radio' },
    created: { key: 'created', title: '创建播客', sub: '你创建的播客', itemType: 'radio' },
    liked: { key: 'liked', title: '喜欢的声音', sub: '收藏或最近喜欢的声音', itemType: 'voice' },
  }[key] || { key, title: key, sub: '', itemType: 'radio' };
  const first = (items || [])[0] || {};
  return {
    ...meta,
    count: (items || []).length,
    cover: first.cover || first.picUrl || first.coverUrl || '',
  };
}

async function fetchMyPodcastItems(key, info, limit, offset) {
  limit = Math.max(8, Math.min(60, Number(limit) || 30));
  offset = Math.max(0, Number(offset) || 0);
  if (key === 'collect') {
    const r = await dj_sublist({ limit, offset, cookie: userCookie, timestamp: Date.now() });
    const raw = firstArrayFrom(r.body, ['djRadios', 'djradios', 'radios', 'data']);
    return { itemType: 'radio', items: raw.map(x => mapPodcastCollectionRadio(x, key)).filter(x => x.id) };
  }
  if (key === 'created') {
    const r = await user_audio({ uid: info.userId, cookie: userCookie, timestamp: Date.now() });
    const raw = firstArrayFrom(r.body, ['data', 'djRadios', 'djradios', 'radios']);
    return { itemType: 'radio', items: raw.map(x => mapPodcastCollectionRadio(x, key)).filter(x => x.id) };
  }
  if (key === 'paid') {
    const r = await dj_paygift({ limit, offset, cookie: userCookie, timestamp: Date.now() });
    const raw = firstArrayFrom(r.body, ['data', 'djRadios', 'djradios', 'radios']);
    return { itemType: 'radio', items: raw.map(x => mapPodcastCollectionRadio(x, key)).filter(x => x.id) };
  }
  if (key === 'liked') {
    let raw = [];
    try {
      const sati = await sati_resource_sub_list({ cookie: userCookie, timestamp: Date.now() });
      raw = firstArrayFrom(sati.body, ['data', 'resources', 'list']);
    } catch (e) {
      console.warn('[MyPodcastLiked] sati sub list failed:', e.message);
    }
    if (!raw.length) {
      try {
        const recent = await record_recent_voice({ limit, cookie: userCookie, timestamp: Date.now() });
        raw = firstArrayFrom(recent.body, ['data', 'list', 'resources']);
      } catch (e) {
        console.warn('[MyPodcastLiked] recent voice fallback failed:', e.message);
      }
    }
    return { itemType: 'voice', items: raw.map(mapPodcastVoice).filter(x => x.id && x.name) };
  }
  return { itemType: 'radio', items: [] };
}

// ---------- 业务: 取歌曲URL (探测试听) ----------
//   返回 { url, trial, level, br }
//   trial=true 表示这是试听片段 (freeTrialInfo 非空)
async function handleSongUrl(id, loginInfo, qualityPreference) {
  console.log('[SongUrl] id:', id, 'logged-in:', !!userCookie);
  const requestedQuality = normalizeQualityPreference(qualityPreference);
  const svipReady = hasNeteaseSvip(loginInfo);
  const qualities = qualityCandidatesFrom(requestedQuality, NETEASE_QUALITY_CANDIDATES)
    .filter(q => !q.svip || svipReady);

  let trialFallback = null; // 兜底: 即使是试听也要能播
  let lastData = null;
  let lastError = null;

  for (const q of qualities) {
    try {
      // 优先用 v1 接口 (支持更高音质 level 字段)
      let result;
      try {
        result = await song_url_v1({ id, level: q.level, cookie: userCookie });
      } catch (e) {
        result = await song_url({ id, br: q.br, cookie: userCookie });
      }
      const d = result.body && result.body.data && result.body.data[0];
      if (d) lastData = d;
      const url = d && d.url;
      const freeTrial = d && d.freeTrialInfo;
      console.log('[SongUrl]', q.level, '->', url ? 'OK' : 'no url', freeTrial ? '(TRIAL)' : '');
      if (url && !freeTrial) {
        return { url, trial: false, playable: true, level: q.level, quality: q.label, br: d.br, requestedQuality };
      }
      if (url && freeTrial && !trialFallback) {
        trialFallback = {
          url,
          trial: true,
          playable: true,
          level: q.level,
          quality: q.label,
          br: d.br,
          requestedQuality,
          trialInfo: freeTrial,
          restriction: classifyNeteasePlaybackRestriction(d, loginInfo),
        };
      }
    } catch (err) {
      lastError = err;
      console.log('[SongUrl]', q.level, 'failed:', err.message);
    }
  }
  if (trialFallback) return trialFallback;
  const restriction = classifyNeteasePlaybackRestriction(lastData, loginInfo);
  return {
    url: null,
    trial: false,
    playable: false,
    reason: restriction.category,
    message: restriction.message,
    restriction,
    lastCode: lastData && lastData.code,
    fee: lastData && lastData.fee,
    error: lastError && lastError.message,
    requestedQuality,
  };
}

// ---------- 业务: 登录态/用户信息 ----------
function readCookieFromResponse(resp) {
  const candidates = [
    resp && resp.cookie,
    resp && resp.body && resp.body.cookie,
    resp && resp.body && resp.body.data && resp.body.data.cookie,
    resp && resp.body && resp.body.data && resp.body.data.cookies,
  ];
  for (const candidate of candidates) {
    const cookie = normalizeCookieHeader(candidate);
    if (cookie) return cookie;
  }
  return '';
}
function firstPositiveNumberFrom(objects, keys) {
  for (const obj of objects) {
    if (!obj || typeof obj !== 'object') continue;
    for (const key of keys) {
      const value = Number(obj[key]);
      if (Number.isFinite(value) && value > 0) return value;
    }
  }
  return 0;
}
function collectStringValues(value, out, depth) {
  if (depth > 4 || value == null) return out;
  if (typeof value === 'string') {
    if (value) out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach(item => collectStringValues(item, out, depth + 1));
    return out;
  }
  if (typeof value === 'object') {
    Object.keys(value).forEach(key => collectStringValues(value[key], out, depth + 1));
  }
  return out;
}
function collectVipStringValues(value, out, depth) {
  if (depth > 4 || value == null) return out;
  if (Array.isArray(value)) {
    value.forEach(item => collectVipStringValues(item, out, depth + 1));
    return out;
  }
  if (typeof value !== 'object') return out;
  Object.keys(value).forEach(key => {
    const child = value[key];
    if (/vip|svip|member|associator|privilege|right|level|package|label|title|type/i.test(key)) {
      collectStringValues(child, out, depth + 1);
    } else if (child && typeof child === 'object') {
      collectVipStringValues(child, out, depth + 1);
    }
  });
  return out;
}
function normalizeNeteaseVip(profile, account, extra) {
  profile = profile || {};
  account = account || {};
  extra = extra || {};
  const vipInfo = profile.vipInfo || profile.vipinfo || account.vipInfo || account.vipinfo || extra.vipInfo || extra.vipinfo || {};
  const objects = [account, profile, vipInfo, extra];
  const vipType = firstPositiveNumberFrom(objects, [
    'vipType', 'vip_type', 'viptype', 'musicVipType', 'music_vip_type',
    'musicVipLevel', 'music_vip_level', 'redVipLevel', 'red_vip_level',
    'blackVipLevel', 'black_vip_level', 'luxuryVipLevel', 'luxury_vip_level',
    'svipType', 'svip_type',
  ]);
  const text = collectVipStringValues({ account, profile, vipInfo, extra }, [], 0).join(' ').toLowerCase();
  const svipFlag = objects.some(obj => obj && (
    obj.isSvip === true || obj.is_svip === true || obj.svip === true ||
    Number(obj.isSvip || obj.is_svip || obj.svip || obj.svipType || obj.svip_type || 0) > 0
  )) || /svip|supervip|super_vip|blackvip|black_vip|黑胶svip|超级会员/.test(text);
  const vipFlag = objects.some(obj => obj && (
    obj.isVip === true || obj.is_vip === true || obj.vip === true ||
    Number(obj.isVip || obj.is_vip || obj.vip || obj.vipFlag || obj.vipflag || 0) > 0
  )) || /vip|黑胶|会员/.test(text);
  const isSvip = svipFlag || vipType >= 10;
  const isVip = isSvip || vipFlag || vipType > 0;
  const vipLevel = isSvip ? 'svip' : (isVip ? 'vip' : 'none');
  return {
    vipType,
    vipLevel,
    isVip,
    isSvip,
    vipLabel: vipLevel === 'svip' ? 'SVIP' : (vipLevel === 'vip' ? 'VIP' : '无VIP'),
  };
}
function normalizeLoginInfo(profile, account, extra) {
  profile = profile || {};
  account = account || {};
  const userId = profile.userId || profile.user_id || profile.id || account.userId || account.id || '';
  if (!(userId || userId === 0)) return { loggedIn: false };
  const vip = normalizeNeteaseVip(profile, account, extra);
  return {
    loggedIn: true,
    userId,
    nickname: profile.nickname || profile.userName || '网易云用户',
    avatar: profile.avatarUrl || profile.avatar || '',
    ...vip,
  };
}
function isNeteaseAuthInvalidPayload(payload) {
  const code = normalizeApiCode(payload);
  if (code === 301 || code === 401) return true;
  const msg = normalizeApiMessage(payload);
  return /未登录|需要登录|请先登录|login/i.test(msg) && code >= 300;
}
async function getLoginInfo() {
  if (!userCookie) return { loggedIn: false, vipType: 0, vipLevel: 'none', isVip: false, isSvip: false, vipLabel: '无VIP' };

  // login_status 对二维码 cookie 的资料刷新通常更及时；失败时再降级到 user_account。
  try {
    const st = await login_status({ cookie: userCookie, timestamp: Date.now() });
    const body = st.body || {};
    const data = body.data || body;
    const info = normalizeLoginInfo(data.profile || body.profile, data.account || body.account, data);
    if (info.loggedIn) return info;
  } catch (e) {
    console.warn('[Login] login_status failed:', e.message);
  }

  try {
    const acc = await user_account({ cookie: userCookie, timestamp: Date.now() });
    const body = acc.body || {};
    const info = normalizeLoginInfo(body.profile, body.account, body);
    if (info.loggedIn) return info;
    if (isNeteaseAuthInvalidPayload(acc)) saveCookie('');
    return { loggedIn: false, hasCookie: !!userCookie, vipType: 0, vipLevel: 'none', isVip: false, isSvip: false, vipLabel: '无VIP' };
  } catch (e) {
    console.warn('[Login] account check failed:', e.message);
    return { loggedIn: false, hasCookie: !!userCookie, vipType: 0, vipLevel: 'none', isVip: false, isSvip: false, vipLabel: '无VIP' };
  }
}

// ====================================================================
//  HTTP Server
// ====================================================================
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:' + PORT);
  const pn = url.pathname;

  if (pn === '/api/app/version') {
    sendJSON(res, {
      name: APP_PACKAGE.name || 'mineradio',
      productName: APP_PACKAGE.productName || 'Mineradio',
      version: APP_VERSION,
      update: {
        provider: UPDATE_CONFIG.provider,
        configured: UPDATE_CONFIG.configured,
        owner: UPDATE_CONFIG.owner,
        repo: UPDATE_CONFIG.repo,
        preview: UPDATE_CONFIG.preview,
        manifestOverride: !!UPDATE_CONFIG.manifest,
      },
    });
    return;
  }

  if (pn === '/api/update/latest') {
    try {
      sendJSON(res, await fetchLatestUpdateInfo());
    } catch (err) {
      sendJSON(res, {
        ...localUpdateFallback(err.message || 'Update check failed', { configured: UPDATE_CONFIG.configured }),
        error: err.message || 'Update check failed',
      });
    }
    return;
  }

  if (pn === '/api/update/download') {
    try {
      const info = await fetchLatestUpdateInfo();
      const job = startUpdateDownloadJob(info);
      sendJSON(res, job, job.ok ? 200 : 400);
    } catch (err) {
      console.error('[UpdateDownload]', err);
      sendJSON(res, { ok: false, error: err.message || 'UPDATE_DOWNLOAD_START_FAILED' }, 500);
    }
    return;
  }

  if (pn === '/api/update/download/status') {
    const id = url.searchParams.get('id') || '';
    const job = id
      ? updateDownloadJobs.get(id)
      : Array.from(updateDownloadJobs.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
    sendJSON(res, publicUpdateJob(job), job ? 200 : 404);
    return;
  }

  if (pn === '/api/update/patch') {
    try {
      const info = await fetchLatestUpdateInfo();
      const job = startUpdatePatchJob(info);
      sendJSON(res, job, job.ok ? 200 : 400);
    } catch (err) {
      console.error('[UpdatePatch]', err);
      sendJSON(res, { ok: false, error: err.message || 'UPDATE_PATCH_START_FAILED' }, 500);
    }
    return;
  }

  if (pn === '/api/update/patch/status') {
    const id = url.searchParams.get('id') || '';
    const job = id
      ? updateDownloadJobs.get(id)
      : Array.from(updateDownloadJobs.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).find(item => item.mode === 'patch');
    sendJSON(res, publicUpdateJob(job), job ? 200 : 404);
    return;
  }

  if (pn === '/api/beatmap/cache/status') {
    const info = beatCacheRootInfo();
    sendJSON(res, {
      enabled: info.allowed && info.available,
      dir: info.dir,
      drive: info.drive,
      reason: !info.allowed ? 'C_DRIVE_DISABLED' : (!info.available ? 'TARGET_DRIVE_UNAVAILABLE' : ''),
      mode: info.allowed && info.available ? 'disk' : 'memory-only',
    });
    return;
  }

  if (pn === '/api/beatmap/cache') {
    if (req.method === 'GET') {
      const key = url.searchParams.get('key') || '';
      try {
        const entry = readBeatMapCache(key);
        sendJSON(res, entry
          ? { ok: true, hit: true, key: entry.key || key, map: entry.map, meta: entry.meta || {}, savedAt: entry.savedAt || 0 }
          : { ok: true, hit: false, key });
      } catch (err) {
        const info = err.info || beatCacheRootInfo();
        sendJSON(res, {
          ok: false,
          hit: false,
          enabled: false,
          mode: 'memory-only',
          key,
          reason: err.code || err.message || 'BEAT_CACHE_READ_FAILED',
          dir: info.dir,
        });
      }
      return;
    }

    if (req.method === 'POST') {
      try {
        const body = await readRequestBody(req);
        sendJSON(res, writeBeatMapCache(body));
      } catch (err) {
        const info = err.info || beatCacheRootInfo();
        sendJSON(res, {
          ok: false,
          enabled: false,
          mode: 'memory-only',
          reason: err.code || err.message || 'BEAT_CACHE_WRITE_FAILED',
          dir: info.dir,
        });
      }
      return;
    }

    sendJSON(res, { ok: false, error: 'METHOD_NOT_ALLOWED' }, 405);
    return;
  }

  if (pn === '/api/discover/home') {
    try {
      sendJSON(res, await handleDiscoverHome());
    } catch (err) {
      console.error('[DiscoverHome]', err);
      sendJSON(res, { error: err.message, loggedIn: false, dailySongs: [], playlists: [], podcasts: [] }, 500);
    }
    return;
  }

  if (pn === '/api/weather/radio') {
    try {
      const data = await buildWeatherRadio({
        city: url.searchParams.get('city') || url.searchParams.get('q') || '',
        lat: url.searchParams.get('lat'),
        lon: url.searchParams.get('lon'),
        timezone: url.searchParams.get('timezone') || '',
      });
      sendJSON(res, data);
    } catch (err) {
      console.error('[WeatherRadio]', err);
      sendJSON(res, {
        ok: false,
        error: err.message,
        weather: null,
        radio: { title: '天气电台', subtitle: '天气暂时没有回来，可以先听今日推荐。', seedQueries: [], songs: [] },
      }, 500);
    }
    return;
  }

  if (pn === '/api/weather/ip-location') {
    try {
      sendJSON(res, { ok: true, location: await fetchIpWeatherLocation() });
    } catch (err) {
      console.error('[WeatherIpLocation]', err);
      sendJSON(res, { ok: false, error: err.message, location: null }, 500);
    }
    return;
  }

  // ---------- 搜索 ----------
  if (pn === '/api/search') {
    try {
      const kw    = url.searchParams.get('keywords') || '';
      const limit = parseInt(url.searchParams.get('limit') || '20');
      const songs = await handleSearch(kw, limit);
      sendJSON(res, { songs });
    } catch (err) { console.error('[Search]', err); sendJSON(res, { error: err.message, songs: [] }, 500); }
    return;
  }

  if (pn === '/api/qq/search') {
    try {
      const kw = url.searchParams.get('keywords') || '';
      const limit = Math.max(4, Math.min(12, parseInt(url.searchParams.get('limit') || '8', 10) || 8));
      const songs = await handleQQSearch(kw, limit);
      sendJSON(res, { provider: 'qq', songs });
    } catch (err) {
      console.error('[QQSearch]', err);
      sendJSON(res, { provider: 'qq', error: err.message, songs: [] }, 500);
    }
    return;
  }

  if (pn === '/api/lx/search') {
    try {
      const kw = url.searchParams.get('keywords') || '';
      const limit = Math.max(6, Math.min(36, parseInt(url.searchParams.get('limit') || '18', 10) || 18));
      const sources = url.searchParams.get('sources') || '';
      const timeoutMs = Math.max(700, Math.min(8000, parseInt(url.searchParams.get('timeout') || url.searchParams.get('timeoutMs') || String(LX_SEARCH_SOURCE_TIMEOUT_MS), 10) || LX_SEARCH_SOURCE_TIMEOUT_MS));
      const songs = await handleLXSearch(kw, limit, sources, { timeoutMs });
      sendJSON(res, { provider: 'lx', songs, partial: !!songs._lxSearchMeta?.partial, meta: songs._lxSearchMeta || null });
    } catch (err) {
      console.error('[LXSearch]', err);
      sendJSON(res, { provider: 'lx', error: err.message, songs: [] }, 500);
    }
    return;
  }

  if (pn === '/api/lx/source/status') {
    const api = loadLXUserApi();
    sendJSON(res, {
      provider: 'lx',
      configured: !!api.ok,
      file: api.file || '',
      error: api.ok ? '' : (api.error || ''),
      message: api.ok ? '' : (api.message || ''),
      sources: api.sources || {},
    });
    return;
  }

  if (pn === '/api/lx/source/import') {
    if (req.method !== 'POST') { sendJSON(res, { provider: 'lx', ok: false, error: 'METHOD_NOT_ALLOWED' }, 405); return; }
    try {
      const body = await readRequestBody(req);
      const script = body.script || body.content || body.text || '';
      const target = saveLXSourceScript(script);
      const api = loadLXUserApi();
      sendJSON(res, {
        provider: 'lx',
        ok: !!api.ok,
        configured: !!api.ok,
        file: target,
        sources: api.sources || {},
        error: api.ok ? '' : (api.error || 'LX_SOURCE_INIT_FAILED'),
      }, api.ok ? 200 : 400);
    } catch (err) {
      console.error('[LXSourceImport]', err);
      sendJSON(res, { provider: 'lx', ok: false, configured: false, error: err.message || 'LX_SOURCE_IMPORT_FAILED' }, 400);
    }
    return;
  }

  if (pn === '/api/lx/source/clear') {
    if (req.method !== 'POST' && req.method !== 'DELETE') { sendJSON(res, { provider: 'lx', ok: false, error: 'METHOD_NOT_ALLOWED' }, 405); return; }
    const removed = clearLXSourceScript();
    sendJSON(res, { provider: 'lx', ok: true, configured: false, removed });
    return;
  }

  if (pn === '/api/qq/song/url') {
    try {
      const mid = url.searchParams.get('mid') || url.searchParams.get('id') || '';
      const mediaMid = url.searchParams.get('mediaMid') || url.searchParams.get('media_mid') || '';
      const quality = url.searchParams.get('quality') || '';
      const info = await handleQQSongUrl(mid, mediaMid, quality);
      sendJSON(res, info);
    } catch (err) {
      console.error('[QQSongUrl]', err);
      sendJSON(res, { provider: 'qq', url: '', playable: false, error: err.message }, 500);
    }
    return;
  }

  if (pn === '/api/lx/song/url') {
    try {
      const source = url.searchParams.get('source') || url.searchParams.get('lxSource') || '';
      const quality = url.searchParams.get('quality') || '';
      let info = {};
      const rawInfo = url.searchParams.get('info') || '';
      if (rawInfo) {
        try { info = JSON.parse(rawInfo); } catch (e) { info = {}; }
      }
      ['id', 'songmid', 'mid', 'hash', 'mediaMid', 'name', 'artist', 'album', 'copyrightId'].forEach(key => {
        const value = url.searchParams.get(key);
        if (value !== null && value !== '') info[key] = value;
      });
      const data = await handleLXSongUrl(source, info, quality);
      sendJSON(res, data);
    } catch (err) {
      console.error('[LXSongUrl]', err);
      sendJSON(res, { provider: 'lx', url: '', playable: false, error: err.message }, 500);
    }
    return;
  }

  if (pn === '/api/lx/lyric') {
    try {
      const source = url.searchParams.get('source') || url.searchParams.get('lxSource') || '';
      let info = {};
      const rawInfo = url.searchParams.get('info') || '';
      if (rawInfo) {
        try { info = JSON.parse(rawInfo); } catch (e) { info = {}; }
      }
      ['id', 'songmid', 'mid', 'hash', 'name', 'artist', 'album', 'copyrightId'].forEach(key => {
        const value = url.searchParams.get(key);
        if (value !== null && value !== '') info[key] = value;
      });
      const data = await handleLXLyric(source, info);
      sendJSON(res, data);
    } catch (err) {
      console.error('[LXLyric]', err);
      sendJSON(res, { provider: 'lx', lyric: '', error: err.message }, 500);
    }
    return;
  }

  if (pn === '/api/lx/pic' || pn === '/api/lx/cover') {
    try {
      const source = url.searchParams.get('source') || url.searchParams.get('lxSource') || '';
      let info = {};
      const rawInfo = url.searchParams.get('info') || '';
      if (rawInfo) {
        try { info = JSON.parse(rawInfo); } catch (e) { info = {}; }
      }
      ['id', 'songmid', 'mid', 'hash', 'name', 'artist', 'album', 'copyrightId', 'img', 'cover', 'pic', 'Image', 'AlbumImage'].forEach(key => {
        const value = url.searchParams.get(key);
        if (value !== null && value !== '') info[key] = value;
      });
      const data = await handleLXPic(source, info);
      sendJSON(res, data);
    } catch (err) {
      console.error('[LXPic]', err);
      sendJSON(res, { provider: 'lx', cover: '', pic: '', error: err.message }, 500);
    }
    return;
  }

  if (pn === '/api/qq/lyric') {
    try {
      const mid = url.searchParams.get('mid') || url.searchParams.get('songmid') || '';
      const id = url.searchParams.get('id') || url.searchParams.get('qqId') || '';
      if (!mid && !id) { sendJSON(res, { provider: 'qq', error: 'Missing QQ song mid or id', lyric: '' }, 400); return; }
      const data = await handleQQLyric(mid, id);
      sendJSON(res, data);
    } catch (err) {
      console.error('[QQLyric]', err);
      sendJSON(res, { provider: 'qq', error: err.message, lyric: '' }, 500);
    }
    return;
  }

  // ---------- 歌曲URL ----------
  if (pn === '/api/qq/login/status') {
    try {
      const info = await getQQLoginInfo();
      sendJSON(res, info);
    } catch (err) {
      console.error('[QQLoginStatus]', err);
      sendJSON(res, { provider: 'qq', loggedIn: false, error: err.message }, 500);
    }
    return;
  }

  if (pn === '/api/qq/login/cookie') {
    try {
      const body = await readRequestBody(req);
      const raw = body.cookie || body.data || body.text || '';
      const normalized = normalizeQQCookieInput(raw);
      const obj = parseCookieString(normalized);
      if (!qqCookieUin(obj) || !qqCookieMusicKey(obj)) {
        sendJSON(res, { provider: 'qq', loggedIn: false, error: 'INVALID_QQ_COOKIE', message: 'QQ cookie 缺少 uin 或有效登录票据' }, 400);
        return;
      }
      saveQQCookie(normalized);
      const info = await getQQLoginInfo();
      sendJSON(res, { ...info, saved: true });
    } catch (err) {
      console.error('[QQLoginCookie]', err);
      sendJSON(res, { provider: 'qq', loggedIn: false, error: err.message }, 500);
    }
    return;
  }

  if (pn === '/api/qq/logout') {
    saveQQCookie('');
    sendJSON(res, { provider: 'qq', ok: true, loggedIn: false });
    return;
  }

  if (pn === '/api/qq/user/playlists') {
    try {
      const data = await handleQQUserPlaylists();
      sendJSON(res, data);
    } catch (err) {
      console.error('[QQUserPlaylists]', err);
      sendJSON(res, { provider: 'qq', loggedIn: false, error: err.message, playlists: [] }, 500);
    }
    return;
  }

  if (pn === '/api/qq/playlist/tracks') {
    try {
      const id = url.searchParams.get('id') || url.searchParams.get('disstid') || '';
      const data = await handleQQPlaylistTracks(id);
      sendJSON(res, data);
    } catch (err) {
      console.error('[QQPlaylistTracks]', err);
      sendJSON(res, { provider: 'qq', error: err.message, tracks: [] }, 500);
    }
    return;
  }

  if (pn === '/api/qq/artist/detail') {
    try {
      const mid = url.searchParams.get('mid') || url.searchParams.get('singermid') || '';
      const limit = Math.max(10, Math.min(80, parseInt(url.searchParams.get('limit') || '36', 10) || 36));
      if (!mid) {
        sendJSON(res, { provider: 'qq', error: 'MISSING_SINGER_MID', artist: null, songs: [] }, 400);
        return;
      }
      const data = await handleQQArtistDetail(mid, limit);
      sendJSON(res, data);
    } catch (err) {
      console.error('[QQArtistDetail]', err);
      sendJSON(res, { provider: 'qq', error: err.message, artist: null, songs: [] }, 500);
    }
    return;
  }

  if (pn === '/api/qq/song/comments') {
    try {
      const id = url.searchParams.get('id') || url.searchParams.get('qqId') || '';
      const mid = url.searchParams.get('mid') || url.searchParams.get('songmid') || '';
      const limit = Math.max(6, Math.min(50, parseInt(url.searchParams.get('limit') || '20', 10) || 20));
      const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
      const data = await handleQQSongComments(id, mid, limit, offset);
      sendJSON(res, data);
    } catch (err) {
      console.error('[QQSongComments]', err);
      sendJSON(res, { provider: 'qq', error: err.message, comments: [] }, 500);
    }
    return;
  }

  if (pn === '/api/podcast/search') {
    try {
      const kw = String(url.searchParams.get('keywords') || '').trim();
      const limit = Math.max(6, Math.min(30, parseInt(url.searchParams.get('limit') || '18', 10) || 18));
      if (!kw) { sendJSON(res, { podcasts: [] }); return; }
      const r = await cloudsearch({ keywords: kw, type: 1009, limit, cookie: userCookie, timestamp: Date.now() });
      const result = (r.body && r.body.result) || {};
      const raw = result.djRadios || result.djradios || result.radios || [];
      const podcasts = raw.map(mapPodcastRadio).filter(p => p.id);
      sendJSON(res, { podcasts, total: result.djRadiosCount || result.djradiosCount || podcasts.length });
    } catch (err) {
      console.error('[PodcastSearch]', err);
      sendJSON(res, { error: err.message, podcasts: [] }, 500);
    }
    return;
  }

  if (pn === '/api/podcast/hot') {
    try {
      const limit = Math.max(6, Math.min(30, parseInt(url.searchParams.get('limit') || '18', 10) || 18));
      const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
      const r = await dj_hot({ limit, offset, cookie: userCookie, timestamp: Date.now() });
      const body = r.body || {};
      const raw = body.djRadios || body.djradios || body.radios || body.data || [];
      const podcasts = (Array.isArray(raw) ? raw : []).map(mapPodcastRadio).filter(p => p.id);
      sendJSON(res, { podcasts, more: !!body.hasMore });
    } catch (err) {
      console.error('[PodcastHot]', err);
      sendJSON(res, { error: err.message, podcasts: [] }, 500);
    }
    return;
  }

  if (pn === '/api/podcast/detail') {
    try {
      const rid = url.searchParams.get('id') || url.searchParams.get('rid');
      if (!rid) { sendJSON(res, { error: 'Missing podcast id' }, 400); return; }
      const r = await dj_detail({ rid, cookie: userCookie, timestamp: Date.now() });
      const body = r.body || {};
      const radio = mapPodcastRadio(body.data || body.djRadio || body.radio || body);
      sendJSON(res, { podcast: radio });
    } catch (err) {
      console.error('[PodcastDetail]', err);
      sendJSON(res, { error: err.message }, 500);
    }
    return;
  }

  if (pn === '/api/podcast/programs') {
    try {
      const rid = url.searchParams.get('id') || url.searchParams.get('rid');
      if (!rid) { sendJSON(res, { error: 'Missing podcast id', programs: [] }, 400); return; }
      const limit = Math.max(10, Math.min(60, parseInt(url.searchParams.get('limit') || '30', 10) || 30));
      const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
      const r = await dj_program({ rid, limit, offset, asc: false, cookie: userCookie, timestamp: Date.now() });
      const body = r.body || {};
      const raw = body.programs || (body.data && (body.data.list || body.data.programs)) || [];
      const radio = raw[0] && raw[0].radio ? mapPodcastRadio(raw[0].radio) : { id: rid, rid };
      const programs = (Array.isArray(raw) ? raw : [])
        .map(p => mapPodcastProgram(p, radio))
        .filter(p => p.id && p.name);
      sendJSON(res, { radio, programs, more: !!body.more, total: body.count || programs.length });
    } catch (err) {
      console.error('[PodcastPrograms]', err);
      sendJSON(res, { error: err.message, programs: [] }, 500);
    }
    return;
  }

  if (pn === '/api/podcast/my') {
    try {
      const info = await getLoginInfo();
      if (!info.loggedIn || !info.userId) {
        const empty = ['collect', 'created', 'liked'].map(k => podcastCollectionMeta(k, []));
        sendJSON(res, { loggedIn: false, collections: empty });
        return;
      }
      const keys = ['collect', 'created', 'liked'];
      const collections = await Promise.all(keys.map(async key => {
        try {
          const data = await fetchMyPodcastItems(key, info, 12, 0);
          return podcastCollectionMeta(key, data.items || []);
        } catch (e) {
          console.warn('[MyPodcast]', key, e.message);
          return podcastCollectionMeta(key, []);
        }
      }));
      sendJSON(res, { loggedIn: true, collections });
    } catch (err) {
      console.error('[MyPodcast]', err);
      sendJSON(res, { error: err.message, collections: [] }, 500);
    }
    return;
  }

  if (pn === '/api/podcast/my/items') {
    try {
      const info = await getLoginInfo();
      if (!info.loggedIn || !info.userId) { sendJSON(res, { loggedIn: false, items: [] }); return; }
      const key = String(url.searchParams.get('key') || 'collect');
      const limit = parseInt(url.searchParams.get('limit') || '36', 10) || 36;
      const offset = parseInt(url.searchParams.get('offset') || '0', 10) || 0;
      const data = await fetchMyPodcastItems(key, info, limit, offset);
      sendJSON(res, { loggedIn: true, key, ...podcastCollectionMeta(key, data.items || []), itemType: data.itemType, items: data.items || [] });
    } catch (err) {
      console.error('[MyPodcastItems]', err);
      sendJSON(res, { error: err.message, items: [] }, 500);
    }
    return;
  }

  if (pn === '/api/song/url') {
    try {
      const sid = url.searchParams.get('id');
      const quality = url.searchParams.get('quality') || '';
      const loginInfo = await getLoginInfo();
      const info = await handleSongUrl(sid, loginInfo, quality);
      sendJSON(res, {
        ...info,
        loggedIn: loginInfo.loggedIn,
        vipType: loginInfo.vipType || 0,
        vipLevel: loginInfo.vipLevel || 'none',
        isVip: !!loginInfo.isVip,
        isSvip: !!loginInfo.isSvip,
        vipLabel: loginInfo.vipLabel || '无VIP',
      });
    } catch (err) { console.error('[SongUrl]', err); sendJSON(res, { error: err.message }, 500); }
    return;
  }

  if (pn === '/api/login/cookie') {
    try {
      const body = await readRequestBody(req);
      const raw = body.cookie || body.data || body.text || '';
      const normalized = normalizeCookieHeader(raw);
      const obj = parseCookieString(normalized);
      if (!obj.MUSIC_U) {
        sendJSON(res, { loggedIn: false, error: 'INVALID_NETEASE_COOKIE', message: '网易云 cookie 缺少 MUSIC_U' }, 400);
        return;
      }
      saveCookie(normalized);
      let info = await getLoginInfo();
      if (!info.loggedIn && userCookie) {
        info = {
          loggedIn: true,
          pendingProfile: true,
          nickname: '网易云用户',
          avatar: '',
          vipType: 0,
          vipLevel: 'none',
          isVip: false,
          isSvip: false,
          vipLabel: '无VIP',
        };
      }
      sendJSON(res, { ...info, saved: true, hasCookie: !!userCookie });
    } catch (err) {
      console.error('[LoginCookie]', err);
      sendJSON(res, { loggedIn: false, error: err.message }, 500);
    }
    return;
  }

  // ---------- 登录: QR Key ----------
  // ---------- 播客 DJ 长音频后端离线锁拍 ----------
  if (pn === '/api/podcast/dj-beatmap') {
    try {
      const audioUrl = url.searchParams.get('url');
      const durationSec = Math.max(0, Number(url.searchParams.get('duration') || 0) || 0);
      if (!audioUrl || !/^https?:\/\//i.test(audioUrl)) {
        sendJSON(res, { error: 'Invalid audio url' }, 400);
        return;
      }
      console.log('[PodcastDjBeatmap] start', Math.round(durationSec || 0) + 's');
      const started = Date.now();
      const introSec = Math.max(0, Number(url.searchParams.get('intro') || 0) || 0);
      const map = introSec
        ? await analyzePodcastDjIntro(audioUrl, { durationSec, introSec, userAgent: UA })
        : await analyzePodcastDjStream(audioUrl, { durationSec, userAgent: UA });
      console.log('[PodcastDjBeatmap] done beats:', map.visualBeatCount || 0, 'ms:', Date.now() - started, 'decode:', map.decode || {});
      sendJSON(res, { ok: true, map });
    } catch (err) {
      console.error('[PodcastDjBeatmap]', err);
      sendJSON(res, { ok: false, error: err.message || String(err) }, 500);
    }
    return;
  }

  if (pn === '/api/login/qr/key') {
    try {
      const r = await login_qr_key({ timestamp: Date.now() });
      const key = r.body && r.body.data && r.body.data.unikey;
      sendJSON(res, { key });
    } catch (err) { sendJSON(res, { error: err.message }, 500); }
    return;
  }

  // ---------- 登录: QR 二维码图片 ----------
  if (pn === '/api/login/qr/create') {
    try {
      const key = url.searchParams.get('key');
      const r = await login_qr_create({ key, qrimg: true, timestamp: Date.now() });
      const d = r.body && r.body.data;
      sendJSON(res, { img: d && d.qrimg, url: d && d.qrurl });
    } catch (err) { sendJSON(res, { error: err.message }, 500); }
    return;
  }

  // ---------- 登录: 轮询扫码状态 ----------
  if (pn === '/api/login/qr/check') {
    try {
      const key = url.searchParams.get('key');
      let r = await login_qr_check({ key, noCookie: true, timestamp: Date.now() });
      let body = r.body || {};
      let code = Number(body.code || r.code);
      let msg  = body.message || r.message || '';
      let cookie = readCookieFromResponse(r);
      if (code === 803 && !cookie) {
        try {
          const retry = await login_qr_check({ key, timestamp: Date.now() });
          const retryCookie = readCookieFromResponse(retry);
          if (retryCookie) {
            r = retry;
            body = retry.body || body;
            code = Number(body.code || retry.code || code);
            msg = body.message || retry.message || msg;
            cookie = retryCookie;
          }
        } catch (retryErr) {
          console.warn('[Login] qr cookie retry failed:', retryErr.message);
        }
      }
      // 803 = 授权成功, 802 = 已扫待确认, 801 = 等待扫码, 800 = 二维码过期
      if (code === 803) {
        if (cookie) saveCookie(cookie);
        let info = await getLoginInfo();
        if (!info.loggedIn) {
          const profile = body.profile || (body.data && body.data.profile) || {};
          info = normalizeLoginInfo(profile, body.account || (body.data && body.data.account), body.data || body);
        }
        if (!info.loggedIn && cookie) {
          info = {
            loggedIn: true,
            pendingProfile: true,
            nickname: (body.nickname || (body.profile && body.profile.nickname) || '网易云用户'),
            avatar: body.avatarUrl || (body.profile && body.profile.avatarUrl) || '',
            vipType: 0,
            vipLevel: 'none',
            isVip: false,
            isSvip: false,
            vipLabel: '无VIP',
          };
        }
        sendJSON(res, { code, message: msg, ...info, hasCookie: !!cookie });
        return;
      }
      sendJSON(res, { code, message: msg, nickname: body.nickname, avatar: body.avatarUrl });
    } catch (err) { sendJSON(res, { error: err.message }, 500); }
    return;
  }

  // ---------- 登录态查询 ----------
  if (pn === '/api/login/status') {
    const info = await getLoginInfo();
    sendJSON(res, info);
    return;
  }

  // ---------- 登出 ----------
  if (pn === '/api/logout') {
    try { await logout({ cookie: userCookie }); } catch (e) {}
    saveCookie('');
    sendJSON(res, { ok: true });
    return;
  }

  // ---------- 用户歌单 ----------
  if (pn === '/api/user/playlists') {
    try {
      const info = await getLoginInfo();
      if (!info.loggedIn || !info.userId) { sendJSON(res, { loggedIn: false, playlists: [] }); return; }
      const limit = Math.max(12, Math.min(100, parseInt(url.searchParams.get('limit') || '60', 10) || 60));
      const r = await user_playlist({ uid: info.userId, limit, cookie: userCookie, timestamp: Date.now() });
      const list = ((r.body && r.body.playlist) || []).map(pl => ({
        id: pl.id,
        name: pl.name,
        cover: pl.coverImgUrl || '',
        trackCount: pl.trackCount || 0,
        playCount: pl.playCount || 0,
        creator: (pl.creator && pl.creator.nickname) || '',
        subscribed: !!pl.subscribed,
        specialType: pl.specialType || 0,
      }));
      sendJSON(res, { loggedIn: true, userId: info.userId, playlists: list });
    } catch (err) {
      console.error('[UserPlaylists]', err);
      sendJSON(res, { error: err.message, loggedIn: false, playlists: [] }, 500);
    }
    return;
  }

  // ---------- 红心状态 ----------
  if (pn === '/api/song/like/check') {
    try {
      const info = await requireLogin(res);
      if (!info) return;
      const ids = String(url.searchParams.get('ids') || url.searchParams.get('id') || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
      if (!ids.length) { sendJSON(res, { error: 'Missing song id', liked: {}, ids: [] }, 400); return; }
      let likedIds = [];
      try {
        if (typeof song_like_check === 'function') {
          const checked = await song_like_check({ ids: JSON.stringify(ids.map(Number).filter(Boolean)), cookie: userCookie, timestamp: Date.now() });
          const data = (checked.body && (checked.body.data || checked.body.ids)) || checked.body || {};
          if (Array.isArray(data)) likedIds = data.map(String);
          else if (data && typeof data === 'object') {
            ids.forEach(id => {
              if (data[id] || data[String(id)] || data[Number(id)]) likedIds.push(String(id));
            });
          }
        }
      } catch (e) {
        console.warn('[LikeCheck] direct check failed:', e.message);
      }
      if (!likedIds.length) {
        const r = await likelist({ uid: info.userId, cookie: userCookie, timestamp: Date.now() });
        likedIds = ((r.body && r.body.ids) || []).map(String);
      }
      const set = new Set(likedIds);
      const liked = {};
      ids.forEach(id => { liked[id] = set.has(String(id)); });
      sendJSON(res, { loggedIn: true, ids, liked });
    } catch (err) {
      console.error('[LikeCheck]', err);
      sendJSON(res, { error: err.message }, 500);
    }
    return;
  }

  // ---------- 红心/取消红心 ----------
  if (pn === '/api/song/like') {
    try {
      const info = await requireLogin(res);
      if (!info) return;
      const body = req.method === 'POST' ? await readRequestBody(req) : {};
      const id = body.id || url.searchParams.get('id');
      const nextLike = String(body.like != null ? body.like : (url.searchParams.get('like') || 'true')) !== 'false';
      if (!id) { sendJSON(res, { error: 'Missing song id' }, 400); return; }
      const r = await like_song({ id, like: String(nextLike), cookie: userCookie, timestamp: Date.now() });
      const code = (r.body && r.body.code) || r.code || 200;
      sendJSON(res, { loggedIn: true, id, liked: nextLike, code, body: r.body || r });
    } catch (err) {
      console.error('[Like]', err);
      sendJSON(res, { error: err.message }, 500);
    }
    return;
  }

  // ---------- 创建歌单 ----------
  if (pn === '/api/playlist/create') {
    try {
      const info = await requireLogin(res);
      if (!info) return;
      const body = req.method === 'POST' ? await readRequestBody(req) : {};
      const name = String(body.name || url.searchParams.get('name') || '').trim();
      const privacy = String(body.privacy || url.searchParams.get('privacy') || '0');
      if (!name) { sendJSON(res, { error: 'Missing playlist name' }, 400); return; }
      const r = await playlist_create({ name, privacy, cookie: userCookie, timestamp: Date.now() });
      const created = (r.body && (r.body.playlist || r.body.data)) || {};
      sendJSON(res, { loggedIn: true, playlist: created, body: r.body || r });
    } catch (err) {
      console.error('[PlaylistCreate]', err);
      sendJSON(res, { error: err.message }, 500);
    }
    return;
  }

  // ---------- 收藏歌曲到歌单 ----------
  if (pn === '/api/playlist/add-song') {
    try {
      const info = await requireLogin(res);
      if (!info) return;
      const body = req.method === 'POST' ? await readRequestBody(req) : {};
      const pid = body.pid || url.searchParams.get('pid');
      const id = body.id || body.ids || url.searchParams.get('id') || url.searchParams.get('ids');
      if (!pid || !id) { sendJSON(res, { error: 'Missing playlist id or song id' }, 400); return; }
      const attempts = [];
      let finalBody = null;
      let finalCode = 0;
      let finalMessage = '';
      let success = false;

      const primary = await playlist_tracks({ op: 'add', pid, tracks: String(id), cookie: userCookie, timestamp: Date.now() });
      finalBody = primary.body || primary;
      finalCode = normalizeApiCode(primary);
      finalMessage = normalizeApiMessage(primary);
      success = finalCode === 200 && !(finalBody && finalBody.error);
      attempts.push({ api: 'playlist_tracks', code: finalCode, message: finalMessage, body: finalBody });

      if (!success && typeof playlist_track_add === 'function') {
        try {
          const fallback = await playlist_track_add({ pid, ids: String(id), cookie: userCookie, timestamp: Date.now() });
          finalBody = fallback.body || fallback;
          finalCode = normalizeApiCode(fallback);
          finalMessage = normalizeApiMessage(fallback);
          success = finalCode === 200 && !(finalBody && finalBody.error);
          attempts.push({ api: 'playlist_track_add', code: finalCode, message: finalMessage, body: finalBody });
        } catch (fallbackErr) {
          const errBody = fallbackErr.body || fallbackErr.response || {};
          finalBody = errBody;
          finalCode = normalizeApiCode(errBody);
          finalMessage = normalizeApiMessage(errBody) || fallbackErr.message || '';
          attempts.push({ api: 'playlist_track_add', code: finalCode, message: finalMessage, body: errBody });
        }
      }

      if (!success) {
        sendJSON(res, { loggedIn: true, pid, id, success: false, code: finalCode, error: finalMessage || 'PLAYLIST_ADD_FAILED', attempts }, finalCode === 401 ? 401 : 409);
        return;
      }
      sendJSON(res, { loggedIn: true, pid, id, success: true, code: finalCode, body: finalBody, attempts });
    } catch (err) {
      console.error('[PlaylistAddSong]', err);
      sendJSON(res, { error: err.message }, 500);
    }
    return;
  }

  // ---------- 歌词 ----------
  if (pn === '/api/lyric') {
    try {
      const id = url.searchParams.get('id');
      if (!id) { sendJSON(res, { error: 'Missing song id', lyric: '' }, 400); return; }
      let body = {};
      let source = 'lyric';
      try {
        if (typeof lyric_new === 'function') {
          const nr = await lyric_new({ id, cookie: userCookie, timestamp: Date.now() });
          body = nr.body || {};
          source = 'lyric_new';
        }
      } catch (errNew) {
        console.warn('[LyricNew]', errNew.message);
      }
      if (!((body.lrc && body.lrc.lyric) || (body.yrc && body.yrc.lyric))) {
        const r = await lyric({ id, cookie: userCookie, timestamp: Date.now() });
        body = r.body || body || {};
        source = 'lyric';
      }
      sendJSON(res, {
        lyric: (body.lrc && body.lrc.lyric) || '',
        tlyric: (body.tlyric && body.tlyric.lyric) || '',
        yrc: (body.yrc && body.yrc.lyric) || '',
        source,
      });
    } catch (err) {
      console.error('[Lyric]', err);
      sendJSON(res, { error: err.message, lyric: '' }, 500);
    }
    return;
  }

  // ---------- 歌曲评论 ----------
  if (pn === '/api/song/comments') {
    try {
      const id = url.searchParams.get('id');
      const limit = Math.max(6, Math.min(50, parseInt(url.searchParams.get('limit') || '20', 10) || 20));
      const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
      if (!id) { sendJSON(res, { error: 'Missing song id', comments: [] }, 400); return; }
      const r = await comment_music({ id, limit, offset, cookie: userCookie, timestamp: Date.now() });
      const body = r.body || r || {};
      const raw = body.hotComments && offset === 0 ? body.hotComments : (body.comments || []);
      const comments = (raw || []).map(c => ({
        id: c.commentId,
        content: c.content || '',
        likedCount: c.likedCount || 0,
        time: c.time || 0,
        user: c.user ? { id: c.user.userId, nickname: c.user.nickname || '', avatar: c.user.avatarUrl || '' } : null,
      })).filter(c => c.content);
      sendJSON(res, { id, total: body.total || 0, comments, hot: !!(body.hotComments && offset === 0), body });
    } catch (err) {
      console.error('[SongComments]', err);
      sendJSON(res, { error: err.message, comments: [] }, 500);
    }
    return;
  }

  // ---------- 歌手主页 / 热门歌曲 ----------
  if (pn === '/api/artist/detail') {
    try {
      const id = url.searchParams.get('id');
      const limit = Math.max(10, Math.min(80, parseInt(url.searchParams.get('limit') || '30', 10) || 30));
      if (!id) { sendJSON(res, { error: 'Missing artist id', songs: [] }, 400); return; }
      let detailBody = {};
      try {
        const detail = await artist_detail({ id, cookie: userCookie, timestamp: Date.now() });
        detailBody = detail.body || detail || {};
      } catch (e) {
        console.warn('[ArtistDetail] detail failed:', e.message);
      }
      let rawSongs = [];
      try {
        const list = await artist_songs({ id, order: 'hot', limit, offset: 0, cookie: userCookie, timestamp: Date.now() });
        const b = list.body || list || {};
        rawSongs = (b.songs || (b.data && b.data.songs) || []);
      } catch (e) {
        console.warn('[ArtistSongs] hot failed:', e.message);
      }
      if (!rawSongs.length) {
        const top = await artist_top_song({ id, cookie: userCookie, timestamp: Date.now() });
        const b = top.body || top || {};
        rawSongs = b.songs || [];
      }
      const artist = detailBody.artist || (detailBody.data && (detailBody.data.artist || detailBody.data)) || {};
      const songs = rawSongs.map(mapSongRecord).filter(s => s.id).slice(0, limit);
      sendJSON(res, {
        id,
        artist: {
          id: artist.id || id,
          name: artist.name || artist.artistName || '',
          avatar: artist.avatar || artist.cover || artist.picUrl || artist.img1v1Url || '',
          brief: artist.briefDesc || artist.description || artist.desc || '',
          musicSize: artist.musicSize || artist.songSize || 0,
          albumSize: artist.albumSize || 0,
        },
        songs,
        body: detailBody,
      });
    } catch (err) {
      console.error('[ArtistDetail]', err);
      sendJSON(res, { error: err.message, songs: [] }, 500);
    }
    return;
  }

  // ---------- 歌单曲目详情 ----------
  if (pn === '/api/playlist/tracks') {
    try {
      const id = url.searchParams.get('id');
      if (!id) { sendJSON(res, { error: 'Missing playlist id', tracks: [] }, 400); return; }

      let playlistMeta = { id, name: '', cover: '', trackCount: 0 };
      let rawTracks = [];

      // 新版本 NeteaseCloudMusicApi 通常提供 playlist_track_all；旧版本退回 playlist_detail。
      if (typeof playlist_track_all === 'function') {
        try {
          const all = await playlist_track_all({ id, limit: 500, offset: 0, cookie: userCookie, timestamp: Date.now() });
          rawTracks = (all.body && (all.body.songs || all.body.tracks)) || [];
        } catch (err) {
          console.warn('[PlaylistTracks] playlist_track_all failed, fallback to detail:', err.message);
        }
      }

      if (!rawTracks.length && typeof playlist_detail === 'function') {
        const detail = await playlist_detail({ id, s: 0, cookie: userCookie, timestamp: Date.now() });
        const pl = (detail.body && detail.body.playlist) || {};
        playlistMeta = { id: pl.id || id, name: pl.name || '', cover: pl.coverImgUrl || '', trackCount: pl.trackCount || 0 };
        rawTracks = pl.tracks || [];
      }

      const tracks = rawTracks.map(mapSongRecord).filter(t => t.id);

      if (!playlistMeta.trackCount) playlistMeta.trackCount = tracks.length;
      sendJSON(res, { playlist: playlistMeta, tracks });
    } catch (err) {
      console.error('[PlaylistTracks]', err);
      sendJSON(res, { error: err.message, tracks: [] }, 500);
    }
    return;
  }

  // ---------- 封面代理 (带 CORS 头, 给 canvas 提取像素用) ----------
  if (pn === '/api/cover') {
    try {
      const coverUrl = url.searchParams.get('url');
      // URL 校验: 必须是 http(s) 开头, 否则直接 404 (不要让 fetch 抛错)
      if (!coverUrl || !/^https?:\/\//i.test(coverUrl)) {
        res.writeHead(400, { 'Access-Control-Allow-Origin': '*' });
        res.end('Invalid cover url');
        return;
      }
      const resp = await fetch(coverUrl, { headers: { 'User-Agent': UA, 'Referer': 'https://music.163.com/' } });
      const ct  = resp.headers.get('content-type') || 'image/jpeg';
      const cl  = resp.headers.get('content-length');
      const hdr = {
        'Content-Type': ct,
        'Access-Control-Allow-Origin': '*',
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'Cache-Control': 'public, max-age=86400',
      };
      if (cl) hdr['Content-Length'] = cl;
      res.writeHead(resp.status, hdr);
      const reader = resp.body.getReader();
      while (true) { const c = await reader.read(); if (c.done) break; res.write(c.value); }
      res.end();
    } catch (err) { console.error('[Cover]', err); res.writeHead(500); res.end(); }
    return;
  }

  if (pn === '/api/audio/cache/status') {
    sendJSON(res, audioCacheStatus());
    return;
  }

  if (pn === '/api/audio/cache/clear') {
    if (req.method !== 'POST' && req.method !== 'DELETE') { sendJSON(res, { ok: false, error: 'METHOD_NOT_ALLOWED' }, 405); return; }
    sendJSON(res, clearAudioCache());
    return;
  }

  // ---------- 音频代理 (支持 Range) ----------
  if (pn === '/api/audio') {
    try {
      const audioUrl = url.searchParams.get('url');
      if (!audioUrl) { res.writeHead(400); res.end('Missing url'); return; }
      const cacheMeta = {
        provider: url.searchParams.get('provider') || '',
        sourceKey: url.searchParams.get('sourceKey') || url.searchParams.get('sourceId') || '',
        songId: url.searchParams.get('songId') || url.searchParams.get('musicId') || url.searchParams.get('id') || '',
        qualityKey: url.searchParams.get('qualityKey') || '',
        title: url.searchParams.get('title') || url.searchParams.get('name') || '',
        artist: url.searchParams.get('artist') || url.searchParams.get('singer') || '',
        album: url.searchParams.get('album') || '',
        source: url.searchParams.get('source') || url.searchParams.get('provider') || '',
        quality: url.searchParams.get('quality') || url.searchParams.get('level') || '',
      };
      const stableCacheMeta = isAudioCacheStableMeta(cacheMeta);
      if (stableCacheMeta) {
        const cached = findAudioCacheEntry(audioUrl, cacheMeta);
        if (cached && serveAudioCacheEntry(req, res, cached)) return;
      }
      const range = req.headers.range || '';
      const hdr = audioProxyHeadersFor(audioUrl, range);
      const up = await fetch(audioUrl, { headers: hdr });
      const out = {
        'Content-Type': audioContentTypeForUrl(audioUrl, up.headers.get('content-type')),
        'Access-Control-Allow-Origin': '*',
        'Accept-Ranges': 'bytes',
        'X-Mineradio-Audio-Cache': 'miss',
      };
      const cl = up.headers.get('content-length'); if (cl) out['Content-Length'] = cl;
      const cr = up.headers.get('content-range');  if (cr) out['Content-Range']  = cr;
      res.writeHead(up.status, out);
      if (up.ok && stableCacheMeta) setTimeout(() => cacheAudioInBackground(audioUrl, up.headers.get('content-type'), cacheMeta), 0);
      const reader = up.body.getReader();
      while (true) { const c = await reader.read(); if (c.done) break; res.write(c.value); }
      res.end();
    } catch (err) { console.error('[Audio]', err); res.writeHead(500); res.end(); }
    return;
  }

  // ---------- 静态资源 ----------
  if (pn === '/favicon.ico') {
    serveStatic(res, path.join(__dirname, 'build', 'icon.ico'));
    return;
  }

  let filePath = pn === '/' ? '/index.html' : pn;
  filePath = path.join(__dirname, 'public', filePath);
  serveStatic(res, filePath);
});

server.listen(PORT, HOST, () => {
  console.log('======================================================');
  console.log(' Mineradio visual player v2 -> http://localhost:' + PORT);
  console.log(' Login: ' + (userCookie ? 'loaded from cookie' : 'not logged in'));
  console.log('======================================================');
});

module.exports = server;
