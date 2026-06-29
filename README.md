# Mineradio LX

![Mineradio 暗场启动页](./docs/assets/readme/cinema-beat-smoke.png)

Mineradio LX 是基于 [XxHuberrr/Mineradio](https://github.com/XxHuberrr/Mineradio) 二次开发的 Windows 桌面沉浸式音乐播放器。这一版保留原版的天气电台、歌词舞台、粒子视觉、3D 歌单架和网易云 / QQ 音乐能力，同时重点适配落雪音乐自定义音源，让 Mineradio 可以使用更接近 LX Music 的跨平台音源体验。

本仓库由 `huahai0202` 维护，不是 Mineradio 官方原仓库。原版设计、视觉体系和主要基础能力来自官方 Mineradio；本 fork 的主要目标是把落雪音源、音质选择、缓存和本地歌单体验补齐到更适合日常使用的状态。

## 当前版本

当前版本：`1.1.2`

打包产物：`Mineradio-LX-1.1.2-Setup.exe`

Release 仓库：[huahai0202/Mineradio](https://github.com/huahai0202/Mineradio/releases)

## 和官方版的主要不同

- 新增 LX 音源入口，支持通过本地落雪自定义源脚本获取播放链接。
- LX 搜索支持酷我、酷狗、网易云、QQ 等子源，并可在设置中控制搜索渠道。
- 音质列表以当前歌曲实际返回的音质为准，不把源声明的全量音质直接当成可播音质。
- 保留源返回的第一层音质名称，减少不必要的音质名称映射。
- 过滤 `.mgg`、`.mflac`、`.mmp4` 等加密音频格式，避免界面展示无法直接播放的地址。
- 调整 LX 播放失败后的换源逻辑，尽量按同歌曲、同音质倾向寻找可播候选。
- 歌曲缓存增加歌曲名、歌手、来源、音质等元数据，并按音质区分缓存。
- 缓存策略改为“选哪个音质就播放哪个音质”；低音质请求不会直接命中高音质缓存。
- 同一首歌已有更高音质缓存时，低音质播放不再新增低音质缓存，减少重复缓存。
- 本地歌单不再强依赖登录账号，可收藏 LX / 网易云 / QQ / 本地来源歌曲。
- 设置中增加缓存位置查看和清理入口，重点覆盖歌曲缓存。
- 调整若干播放页、歌单页和新手指引触发细节，减少误触和界面堆叠。

## 继承自官方 Mineradio 的能力

- Open-Meteo 天气电台，根据位置、城市和天气 mood 生成播放队列。
- 首页包含天气电台、每日推荐、私人电台、继续听、听歌画像和我的歌单入口。
- Wallpaper 银河首页背景，播放后切换到歌词舞台与粒子舞台。
- 基于节奏分析的电影镜头视觉系统。
- 面向长播客和 DJ 曲目的专属视觉模式。
- 自定义歌词、歌词位置、视觉预设和用户存档。
- 自定义专辑封面上传与裁剪。
- 右键唤起 3D 歌单架，支持歌单队列浏览。
- 网易云音乐账号、搜索、歌单、播客等体验接入。
- QQ 音乐搜索、登录态与音源补充接入。
- GitHub Releases 更新检测与下载入口。

## LX 自定义源说明

本 fork 借鉴 `lyswhut/lx-music-desktop` 和相关 LX 移动端实现方式，使用落雪自定义源脚本的 `musicUrl` action 获取播放地址。项目不会内置绕过会员、破解音质或重新分发音乐内容的能力；能否播放、可用音质和返回格式取决于用户本地配置的自定义源脚本及其上游平台状态。

LX 音源相关技术笔记见 [docs/LX_MUSIC_PROVIDER_NOTES.md](./docs/LX_MUSIC_PROVIDER_NOTES.md)。

## 开发运行

```bash
npm install
npm start
npm run build:win
```

桌面版入口由 Electron 主进程加载本地服务。`npm run build:win` 会生成 Windows NSIS 安装包，产物位于 `dist/`。

为了避免占用 C 盘，建议构建时把 electron-builder 缓存放到 `D:\Cache`：

```powershell
$env:ELECTRON_BUILDER_CACHE='D:\Cache\electron-builder'
npm run build:win
```

## 更新机制

Mineradio LX 会请求 [huahai0202/Mineradio](https://github.com/huahai0202/Mineradio) 的 GitHub Releases latest 检测新版本。远端版本高于本地版本时，应用内更新入口会展示 Release 内容、下载安装包到本机用户数据目录，并通过系统打开安装包。

本地验证更新链路时，可以通过 `MINERADIO_UPDATE_MANIFEST` 指向一个本地 manifest JSON 或 HTTP 地址来模拟线上 Release。

## 第三方音乐平台说明

Mineradio LX 不是网易云音乐、QQ 音乐、酷我音乐、酷狗音乐、咪咕音乐、落雪音乐或腾讯音乐娱乐集团的官方客户端，也不隶属于任何音乐平台。

项目中的第三方平台接入仅用于个人学习、本地客户端体验和用户自有账号的播放辅助。请遵守对应平台的用户协议、版权规则和会员权益规则。

## 用户数据与隐私

登录 Cookie、搜索历史、自定义封面、自定义歌词、节奏分析缓存、歌曲缓存等数据只应保存在本机用户数据目录、本机缓存目录或浏览器本地存储中，不应提交到仓库。

更多说明见 [PRIVACY.md](./PRIVACY.md)。

## 致谢

感谢 [XxHuberrr/Mineradio](https://github.com/XxHuberrr/Mineradio) 提供原始项目、视觉设计和桌面播放器基础能力。本仓库是在原项目基础上的二次开发版本。

感谢 [lyswhut/lx-music-desktop](https://github.com/lyswhut/lx-music-desktop) 及 LX 生态中公开实现的思路，为自定义音源协议和多平台音源适配提供了重要参考。

## 版权与授权

本项目基于 GPL-3.0 授权继续分发。详见 [LICENSE](./LICENSE)。

原版 Mineradio 的名称、Logo、界面视觉设计与原创视觉表达归原作者所有；本 fork 中新增的 LX 适配、缓存、本地歌单等改动由本仓库维护者继续维护。第三方依赖和第三方服务分别遵循其各自授权与服务条款。
