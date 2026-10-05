# 砚台 · 人设馆恢复记录

这份目录是 2026-10-04 继续开发时的本地工作底稿。暂不连接 GitHub，完成最终版前只在本地迭代。

## 0.2.1-dev1 接管修复

- 移除扩展菜单（魔法棒/拼图）中的人设馆重复入口。
- 保留酒馆顶部原生人设按钮为唯一入口，只同步其打开/关闭状态，不再二次点击按钮。
- 在 `#persona-management-block` 上使用 `ytps-takeover`，隐藏原生左右双栏但保留 DOM、事件和数据；砚台工作区占满同一个面板。
- 点击“打开原生编辑”或“新建”时临时显示原生编辑区；关闭并重新打开顶部人设按钮可回到砚台工作区。

## 已核对的 SillyTavern 原生结构

- 人设名称与描述：`context.powerUserSettings.personas`、`context.powerUserSettings.persona_descriptions`
- 当前人设：`/scripts/personas.js` 的实时导出 `user_avatar`
- 当前存档绑定：`context.chatMetadata.persona`
- 角色卡绑定：对应人设描述中的 `connections: [{ type: 'character', id: avatar }]`
- 默认人设：`context.powerUserSettings.default_persona`
- 原生入口：`#persona-management-button`，内容区为 `#PersonaManagement`，人设列表为 `#user_avatar_block`
- 原生操作：`setUserAvatar`、`setPersonaLockState`、`getUserAvatars` 等均来自 `/scripts/personas.js`
- 本轮对照的本体版本：本地 SillyTavern `1.19.0`
- 头像缩略图：`context.getThumbnailUrl('persona'|'avatar', file)`

## 本轮已修正

- 0.2.2-dev1：加入 Milo 片场搭档；提案固定两条方向，支持继续聊天；按用户、角色卡、存档和会话隔离最近十轮，界面显示最近三轮。
- 0.2.2-dev1：修正“新开一段”线程选择，后续请求会继续使用新线程，不会跳回旧会话；补充主 API 耗时说明与 Gemini 拒答后的安全重试提示。
- 0.2.2-dev2：人设档案与角色卡图库优先使用酒馆原图地址，避免缩略图放大后发糊；图库改为点图选中、统一确认应用。

- 不再用猜测的 `persona_links` 读取角色卡锁定，改读原生 `persona_descriptions[*].connections`。
- 存档和角色卡绑定直接写入原生的 `chatMetadata` 与 `connections`，不依赖版本相关的 Slash Command 文本。
- 原生人设模块只加载一次，当前人设使用实时 `user_avatar`。
- 打开原生抽屉时等待移动端延迟渲染；找不到原生面板时不再把工具栏错误挂到 `document.body`。
- 原生角色卡图库使用 `getThumbnailUrl('avatar', avatar)`。
- AI 助手的“当前角色卡／世界书／当前存档”复选框现在会真正裁剪传给 API 的资料。
- 修复保存的当前 Tab 不恢复的问题。
- 增加原生 DOM 重渲染后的短时重新挂钩观察器。
- 保存绑定后发出原生 `PERSONA_UPDATED` 事件，让酒馆自己的列表状态同步刷新。
- 原生默认人设清空时删除原生字段而不是写入 `null`；补监听人设新建、改名、删除和更新事件。
- 修复整理页搜索输入重绘后丢失焦点的问题。
- 增加运行时单例与 dispose：重复注入会先移除旧监听、入口、工具栏和短时观察器，避免热重载后事件叠加。
- 开发版关闭自动更新，避免未发布的 GitHub 地址产生误导。

## 尚未宣称完成

- 尚未在真实桌面端、手机端和不同主题上运行回归。
- 图库还没有解析 PNG 内嵌角色卡，也没有与书架共享资源索引。
- AI 候选目前仍需交给原生新建流程，尚未自动填入原生字段。
- 需要继续确认旧版 SillyTavern、TauriTavern 和主题重排下的入口表现。

## 验证

2026-10-03：`index.js`、`adapter.js`、`ui.js`、`storage.js`、`ai.js` 均通过 Node 语法检查；适配层完成了两个人设、存档绑定、角色卡绑定和默认人设的离线 smoke test；生命周期 hook 完成重复注入清理 smoke test；开发压缩包通过 `unzip -t`。当前快照：`recovered-yantai-persona-studio-v0.2.0-dev1.zip`（可用 `sha256sum` 复核）。

- 0.2.2-dev3：编辑页去掉重复标题，Milo 的资料开关文案明确说明会发送当前生效人设摘要。
- 0.2.2-dev4：接入精修版 Milo 固定预设，扩大人物设计规则与资料边界；Milo 页面改为聊天气泡，API 保持最近十轮窗口，本地会话不再截断为十轮。
- 0.2.2-dev5：取消 Milo 气泡对两条提案的合计显示截断；单个人设正文上限从 900 放宽到 1800，避免提案显示半截。
- 0.2.2-dev6：世界书改从酒馆 world-info 模块读取关联书籍，存档改读取当前 chat；入口默认打开当前页，原生标题改为“人设管理”并隐藏问号，档案绑定信息分行显示。
- 0.2.2-dev7：删除普通人设时按目标 ID 调用酒馆原生删除，避免先切换人设造成默认/存档绑定变化；编辑档案前同步保存编辑页状态。
- 0.2.2-dev8：档案操作失败会显示酒馆返回的错误，编辑页保存按钮靠近名称，原生编辑移到绑定区，删除集中到档案页；助手资料横排、操作按钮收紧，模型 reply 上限 1000 字，并允许重构姓名与关系网以避免暴露原卡。
