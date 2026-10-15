# 砚台 · 人设同步服务端插件

把这个目录复制为 SillyTavern 根目录下的 `plugins/yantai-persona-sync`，并在 `config.yaml` 设置 `enableServerPlugins: true`，重启酒馆后才会加载。加载后路由前缀为 `/api/plugins/yantai-persona-sync`。

SillyTavern server plugin exposing `GET /state` and `PUT /state`. The plugin stores one JSON document per authenticated SillyTavern user under `data/yantai-persona-sync/` (or `YANTAI_PERSONA_SYNC_DIR`).

`GET /state` returns `{ schemaVersion, revision, updatedAt, state }`. `PUT /state` accepts `{ state, baseRevision }` (the `revision`, `expectedRevision`, and `If-Match` aliases are also accepted). A stale revision returns HTTP 409 and preserves the attempted payload in `conflicts/`; successful writes use a temporary-file replacement and retain the previous document as `.json.bak`. `POST /backups` makes an explicit `.bak` copy after checking the supplied revision.

This plugin protects the extension's groups, gallery manifest, assistant history and drafts. SillyTavern native personas and their bindings remain in SillyTavern's own settings store.

Run the minimal tests with `npm test` in this directory.
