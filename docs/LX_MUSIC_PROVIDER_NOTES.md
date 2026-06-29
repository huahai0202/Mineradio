# LX Music Provider Notes

Mineradio 的 LX 兼容层借鉴 `lyswhut/lx-music-desktop` 的两块能力：

- 搜索元数据：默认聚合 `kw`、`kg`、`mg`、`wy`、`tx`。其中 `wy` / `tx` 使用 Mineradio 现有网易云 / QQ 搜索映射，但返回为独立的 LX 曲目，和原生 NE / QQ 搜索结果共存。
- 自定义源协议：播放 URL 不内置在 Mineradio 中，而是调用用户本地的落雪自定义源脚本 `musicUrl` action。

## Source Script

Mineradio 会按以下顺序加载自定义源脚本：

1. `MINERADIO_LX_SOURCE_FILE` 环境变量指向的文件。
2. 应用目录下的 `lx-source.js`。
3. 应用目录下的 `lx-music-source.js`。
4. 应用目录下的 `lx-sources/source.js`。

这些本地源脚本已加入 `.gitignore`，不要提交第三方 key、赞助音源或用户私有脚本。

Electron 桌面版启动时会把 `MINERADIO_LX_SOURCE_FILE` 指向用户数据目录下的 `lx-source.js`。用户可以在软件顶部导入区点击 `LX` 按钮选择 `.js` 源脚本；右键该按钮会清除已导入脚本。

## Local API

- `GET /api/lx/search?keywords=<q>&limit=18&sources=kw,kg,mg,wy,tx`
- `GET /api/lx/song/url?source=<kw|kg|mg|wy|tx>&quality=<quality>&info=<encoded-json>`
- `GET /api/lx/lyric?source=<source>&info=<encoded-json>`
- `GET /api/lx/pic?source=<source>&info=<encoded-json>`
- `GET /api/lx/source/status`
- `POST /api/lx/source/import` with `{ "script": "..." }`
- `POST /api/lx/source/clear`

`/api/lx/song/url` 支持直接请求落雪脚本的 `128k`、`320k`、`flac`、`flac24bit`、`hires`、`atmos`、`master` 等质量标识；若传入 Mineradio 旧式偏好，也会根据脚本 `inited.sources` 中声明的 `qualitys` 自动映射。
LX 当前曲目的音质菜单不受网易云 SVIP 状态限制；前端会优先读取曲目 `types` / `_types`，没有曲目级数据时再使用当前源声明的 `qualitys`。

歌词和封面优先使用自定义源的 `lyric` / `pic` action。未配置或未返回时，`kw` / `kg` / `mg` 会尽量使用公开接口兜底；其中酷我支持播放时补封面，酷狗优先使用搜索结果自带的 `Image` / `AlbumImage`。

## Boundaries

- 不把网易云登录态作为 LX 播放前置条件。
- 不内置破解、付费或赞助音源，也不把第三方 API key 写进仓库。
- LX 搜索结果可以无登录展示；是否能播放取决于用户本地自定义源是否返回有效 URL。
- LX 歌曲暂不支持红心/收藏同步，前端会给出明确提示。
