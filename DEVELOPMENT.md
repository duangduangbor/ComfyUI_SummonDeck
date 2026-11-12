# 开发档案 · 怪兽牌组 / SummonDeck

| 项 | 值 |
|---|---|
| 版本 | 1.5.0 |
| 归档日期 | 2026-11-12 |
| 运行环境 | Windows 10 · ComfyUI · Python 3.13 (venv) · RTX 2080 SUPER 8G |
| 插件目录 | `ComfyUI/custom_nodes/ComfyUI_SummonDeck/` |
| 数据目录 | `ComfyUI/user/default/character_workbench/`（**与原名一致，故意没改**） |

---

## 1. 它要解决什么

AI 出图里最烦的不是画得难看，是**同一个人画两次就变脸**。

拆开看有三个原因，本插件对每一个都有对应手段：

| 漂移原因 | 表现 | 这里的解法 |
|---|---|---|
| 参考图角度不够 | 只有正面，出侧面全靠模型猜 | AI 补图：一个角度一张，补齐正面 / 侧面 / 背面 / 特写 |
| 身份描述不可靠 | 写两百字外貌，模型当成氛围词 | 参考图直接编进条件，文字只作补丁 |
| 每次手动拖图 | 换一个工作流就得重新找图、重新接 | 卡片 + `@卡名`，参考图和设定块自动进 batch |

核心命题：**一张卡 = 一个可复用的身份锚点**。

---

## 2. 名字

- 中文：**怪兽牌组**（游戏王怪兽卡的梗 —— 卡要召唤到场上才起作用）
- 英文：**SummonDeck**（summon + deck）
- 节点显示名：`🎴 怪兽牌组 · SummonDeck`
- 节点分类：`怪兽牌组`

**内部标识全部保留旧名**，这是刻意的：

| 标识 | 值 | 为什么不改 |
|---|---|---|
| 节点类型名 | `CharacterWorkbench` | 它是已存工作流里的标识，改了老工作流的节点会变红 |
| HTTP 前缀 | `/character_workbench` | 改了前端全部接口 404 |
| 存储目录 | `user/default/character_workbench/` | 改了现有多张卡的图全部找不到，还得写迁移 |

结论：**对外换名字，对内留标识**。文件名、目录名、显示名都可以变，只有这三样别动。

---

## 3. 五条设计原则

1. **卡片是唯一真相。** 所有补图都以 `main` 为参考，所有 `@` 都从库里取。不做"临时改一下"的旁路。
2. **`@` 只认台上的卡。** 卡库可以是几百张，工作台永远只有几张 —— 否则 `@` 的时候要翻半天。
3. **手动与 AI 平权。** 手里有现成图就不该被迫等模型。两条路产物落同一个位置，只是标 `source=upload` / `source=supplement`。
4. **面板可以关，任务不能停。** 一张要跑 4 分钟，手滑关面板不该丢任务。任务在服务端，界面只订阅。
5. **8G 显存优先。** 宁可慢不要炸：任务串行、20 步、参考图限长 1536、缩略图 512。

---

## 4. 模块职责

| 文件 | 职责 | 关键点 |
|---|---|---|
| `__init__.py` | 注册节点、挂载 HTTP 路由 | `WEB_DIRECTORY = "./js"` |
| `nodes.py` | 主节点：解析 `@`、拼设定块、组参考图 batch | 输出 11 路：batch / 提示词 / 对照 / 张数 / 原始提示词 + **参考图1..6 单路**（不 pad，给一路吃一张的模型） |
| `server.py` | 全部 HTTP 接口（卡库、上传、补图、预设） | `PREFIX = "/character_workbench"` |
| `storage.py` | `library.json` 读写、资源目录、缩略图 | 并发用 `mutate()` 串起来 |
| `presets.py` | 预设定义、`VIEWS`、`VIEW_GUIDES`、提示词组装、`apply_inject` | 视图文案与喂模型的指令**同源** |
| `preset_store.py` | 用户在画布上改过的预设覆写 | 内置基线 + `presets/<id>.json` 两层 |
| `runner.py` | 任务队列、提交 `/prompt`、轮询、入库 | 内存任务表 `JOBS`，单任务串行 |
| `probe.py` | 探测本机模型 | 读 safetensors 头里的层命名，不猜文件名 |
| `sheet_templates.py` | 整表模式的触发句模板 | 触发句不能动，只换身份条目 |
| `workflow_io.py` | UI 格式 workflow → API prompt | 预设存的是 UI 格式，提交要 API 格式 |
| `js/cw-core.js` | 接口封装、全局 store、样式注入 | 样式路径从 `import.meta.url` 推导 |
| `js/cw-workbench.js` | 节点内嵌创作台 | `beforeRegisterNodeDef` 注入 |
| `js/cw-library.js` | 全屏卡库 + 编辑抽屉 | 双击进编辑，单击是上台 |
| `js/cw-newcard.js` | 新建卡流程 | 只问名字和底稿 |
| `js/cw-supplement.js` | AI 补图面板 | 视图缩略图卡 + 悬停双入口 |
| `js/cw-crop.js` | 微信式裁切器 | 框固定、图能动 |
| `js/cw-wfedit.js` | 把预设载入画布编辑 | 快照 / 还原画布 |

---

## 5. 数据模型

```
user/default/character_workbench/
    library.json                 卡片 / 分类 / 工作台 / 快捷按钮 / 设置
    assets/<cardId>/
        main.png                 底稿
        thumb.jpg                底稿缩略图（最长边 512）
        e_<hash>.png             补充图（AI 补图 + 手动上传）
        th_<hash>.jpg            补充图缩略图
    presets/<presetId>.json      用户改过的预设覆写
```

单张卡：

```json
{
  "id": "c_bb2ee05b1b",
  "name": "丫丫",
  "main": "c_bb2ee05b1b/main.png",
  "thumb": "c_bb2ee05b1b/thumb.jpg",
  "identity": "亚裔女性，年轻女性，18岁",
  "variable": "服装",
  "detail": "长段设定，只影响提示词，不做参考图",
  "extras": [
    {
      "file": "c_bb2ee05b1b/e_36cf1ab1.png",
      "thumb": "c_bb2ee05b1b/th_36cf1ab1.jpg",
      "label": "面部特写",
      "view": "face",
      "source": "supplement",
      "presetId": "qwen_edit",
      "seed": 756833805,
      "createdAt": 1794385641472
    }
  ]
}
```

`extras` 里这几个字段是整个补图体验的地基：

- `view` —— 属于哪个角度。**同一个 view 只留一张**，再补就是替换。
- `source` —— `supplement`（AI 出的）/ `upload`（手动传的）。两者可靠性不一样，界面必须分开标。
- `seed` + `presetId` —— 「重跑这张」靠它，不依赖内存里的任务记录，隔天重启照样能重跑。
- `createdAt` —— 同时用作缩略图的 cache busting。

---

## 6. 关键决策与取舍

| 决策 | 为什么 | 放弃了什么 |
|---|---|---|
| 用 Qwen 参考图编辑，不做 IPAdapter / InstantID | 模型原生吃 `images.image_1`，脸型发型服装一起跟，不用额外挂一堆节点 | 换模型就得重配链路 |
| 图进条件，文字只当补丁 | 长段外貌描写会把人物往"描述中的样子"拉，反而更漂 | 纯文字方案的可移植性 |
| 补图预设分 `set`（逐张）和 `sheet`（整表） | 逐张可以单张重跑；整表一次画完，格与格联合生成，拆不开 | 整表模式不能单格重跑 |
| 同一角度覆盖而不是追加 | 一个角度堆三张，用户自己都分不清哪张是当前的 | 想保留多个版本得另想办法 |
| 补图面板做成全屏浮层，不塞进编辑抽屉 | 抽屉宽 400px，装不下缩略图和结果列表 | 层级多一层 |
| 视图用缩略图卡，不用文字行 | "侧面全身"四个字说不清该长什么样，图一眼就懂 | 一行一个角度时能塞更多引导文案（现在压到 2 行） |
| 视图操作做成**悬停浮出** | 默认画面干净，只有鼠标过去才出「AI 补这张 / 手动上传」 | 触屏要单独用 `@media (hover: none)` 常显 |
| 任务表放内存 | 8G 卡本来就只能跑一个，持久化收益极低 | 重启后"正在跑的任务"查不到（已入库的图不受影响） |
| 面板只有 ✕ 能关 | 以前点面板外就关，误触一次三分钟白等 | 少一处快捷关闭（Esc 仍可） |

---

## 7. 踩过的坑（技术）

**缩略图孤儿。** 删除补充图时只 `unlink()` 了原图，`th_*.jpg` 留在盘上。`extra/delete` 和 `asset/delete` 都改成 file + thumb 一起删。同角度替换时同样要删两样。

**裁切器的比例按钮写死 3:4。** 传 1:1 进来时框是方的、按钮却亮着 3:4，用户以为没生效又手点一次，反而把比例改掉。改成按 ratio 精确匹配；传 `aspect: 0`（原图比例）时点亮「原图比例」，否则一排按钮全灭。

**AI 补图面板点外面就关。** 表单长、跑一张 4 分钟，手滑点一下就没了。删掉 `mask` 上的 mousedown 关闭，只留 ✕ 和 Esc（跑着的时候 Esc 先拦一句）。

**关掉再打开又重新跑一遍。** 新面板 `job = null` 不查后端。补了 `/supplement/active` 接口，打开时若有在跑的任务就用 `watch()` 接回去，按钮直接变「取消」。

**跑完了但看不见成果。** 结果区默认 `display:none` 且从不读 `card.extras`，用户不知道上次补的图还在。补了「已补过的图」区块；现在更进一步——视图卡上直接显示该角度的图。

**首屏看不到重点。** 每张卡高 293px 时，一行五张把「已补过的图」挤出可视区。缩略图从 3:4 改成 4:5，面板高度 `min(calc(100vh - 40px), 820px)`，区块顺序调成「做法 → 视图 → 已补过 → 本次结果 → 身份描述」。

**视图行全铺橙底像报警。** 默认全勾时五行全橙，看着像全在报错。改成「没勾的变淡（opacity .58）」，勾选态只在左上角画一个橙勾。

**Windows 下 Git Bash 路径与原生 Python 不互通。** `/tmp/x.json` 在 bash 里能读写，`D:/ComfyUI/venv/Scripts/python.exe` 读不到。跨语言传文件一律用 `C:/Users/.../AppData/Local/Temp/` 这种绝对 Windows 路径。

**全屏浮层被别人的按钮戳穿。** 大图查看器给 `z-index: 12900` 看着够高，实测标题栏仍被一个「Models」按钮压住 —— 那是别的工作流插件用 Chakra portal 挂的常驻浮层，`z-index: 9999999`。生态里没人遵守同一套层级，全屏模态只能给到 `2147483000`。教训：**z-index 不要跟 ComfyUI 自己比，要跟装了哪些插件比**。

**Esc 监听挂错层会被自己人吃掉。** 补图面板在 `document` 捕获阶段监听 Esc（跑任务时先拦一句）。大图查看器如果也挂 `document`，因为同节点捕获监听按注册顺序执行，后注册的收不到已经 `stopPropagation` 的事件 —— 按 Esc 会把整个面板关掉。挂到更外层的 `window` 捕获阶段才能先吃掉。

**手写工作流 JSON 会被前端重新排序。** 给 H3 的 `ref_image_1` 后面插两个 autogrow 插槽，前端加载时把它们挪到输入列表末尾，于是后面所有 `target_slot` 整体错位 —— 「提示词」那根线会静默消失（`graphToPrompt` 里 `prompt` 变成空串，不报错）。两条规矩：
1. **autogrow 插槽只能追加在输入数组末尾**，不要插在中间；
2. **widget 转成的输入（prompt/width 这种）必须显式写 `input.link` 和 `origin.outputs[n].links`**，只靠 links 数组里那条记录，前端不认。
最省事的做法是别手写：用前端 API `node.connect(...)` 连好后 `app.graph.serialize()` 导出。

**「一路一张」的节点会把 batch 当第一张用。** `MiniMaxH3ReferenceToVideo` 里是 `_resize(img[:1], ...)`，一个 batch 接进 `ref_image_0` 只会用第一张。所以多卡不能靠 batch，必须给单独出口 —— 而且单独出口不能复用 batch 的预处理（batch 要求同尺寸，会补灰边）。

---

## 8. 性能基线（本机实测）

| 项 | 数值 |
|---|---|
| Qwen 参考图编辑 | 832×1216 · 20 步 · cfg 1.0 · euler/simple ≈ **241 秒 / 张** |
| 并发 | **1**（8G 显存下并行会炸，排队是刻意的） |
| 参考图上限 | 长边 1536（再大对模型没帮助，只拖慢上传） |
| 缩略图 | 最长边 512，`th_*.jpg` |
| 插件体积 | 约 658 KB（不含用户资源） |

跨年龄压力测试（同一张参考图、只换 prompt，5 张）：231 / 241 / 241 / 241 / 246 秒，稳定在 4 分钟量级。

---

## 9. 版本演进

| 版本 | 内容 |
|---|---|
| 1.0 | 卡库 + 工作台 + `@` 引用 + 设定块 |
| 1.1 | AI 补图（Qwen 参考编辑 / FLUX2 整表 / Krea2 整表）、预设探测、画布内改工作流 |
| 1.2 | 补图面板：多视图、角度引导、手动上传走裁切、同角度覆盖、任务接回、删除连带缩略图 |
| **1.3** | **改名 怪兽牌组 / SummonDeck；视图改缩略图卡 + 悬停「AI 补这张 / 手动上传」；抽屉「＋」也走裁切；裁切比例按钮修原图比例态** |
| 1.3.1 | 缩略图点开看大图（← → 翻页、1:1 实际像素、Esc 只关大图）；底部「保存」写回身份描述，关面板自动落盘 |
| 1.3.2 | 修「移除补充图跳回页首」（重建抽屉时保存/恢复 scrollTop） |
| 1.4.0 | 编辑抽屉封面常显按钮（裁切换图 / AI 重画）；补图面板改「加入队列」+ 一起补 N 个 + 单格红叉取消；结果区实时预览；快速参考图（拖/粘、`@参考N`、用完即扔） |
| **1.5.0** | **节点多出「参考图1..6」单路输出（原比例、不补灰），直连 H3 ref2va 这类一路吃一张图的模型；节点头部加「引用标记」下拉（`image {n}` / `<Picture {n}>` / `图{n}`），按节点选而不是全局一套** |

---

## 10. 已知边界

- **补图任务记录只在内存。** 重启 ComfyUI 后查不到"正在跑的任务"，但已入库的图还在，「重跑这张」照样能用（靠 extras 里的 `presetId / seed`）。
- **同时只能跑一个任务。** 队列是刻意的。
- **整表模式不能拆格重跑。** 格与格是联合生成的，单独重画一格必然接不上。
- **视角强度取决于 prompt 里的特征强度。** 实测：写 `a few grey strands`（几缕白发）会被完全忽略，写 `silver-white short hair` 才生效。改年龄、改状态时要用**看得见的强特征**。
- **四分之三侧容易不够 45°。** 想稳就在提示词里把角度写死，或换种子重跑。
- **`t2i` 预设不出现在补图面板。** 它只用于新建角色时画底稿。

---

## 11. 怎么验证（调试方法）

没有测试框架，全靠 CDP 驱动真实页面：

1. `msedge --headless=new --remote-debugging-port=9350 --user-data-dir=<temp> http://127.0.0.1:8188`
2. WebSocket 连 `webSocketDebuggerUrl`，用 `Runtime.evaluate` 执行真实 DOM 操作
3. **文件上传**：headless 下 `DOM.setFileInputFiles` 无效（`files.length` 仍是 0）。可行做法是 hook `HTMLInputElement.prototype.click`，用 `DataTransfer` 造 `FileList` 塞进 `input.files` 再派发 `change` —— 除了"用户选文件"这一步，后面全是真实链路。
4. **裁切框是否画对**：扫白色框线（亮度 > 200）的外接矩形。遮罩是 58% 半透明黑，绝对阈值会误判（白底 255 压完正好 113）。
5. **悬停态**：CSS `:hover` 用合成事件触发不了，必须 `Input.dispatchMouseEvent` 真移鼠标，再读 `getComputedStyle(...).opacity`。
6. 验证完务必清场：删除测试补图，确认 `extras` 归 0、目录里只剩 `main.png` + `thumb.jpg`。

---

## 12. 目录

```
ComfyUI_SummonDeck/
├── __init__.py
├── nodes.py
├── server.py
├── storage.py
├── presets.py
├── preset_store.py
├── runner.py
├── probe.py
├── sheet_templates.py
├── workflow_io.py
├── README.md               使用说明
├── DEVELOPMENT.md          本文件
├── presets_ui/             内置预设（UI 格式 workflow）
│   ├── qwen_edit.json
│   ├── flux2_sheet.json
│   ├── krea_sheet.json
│   └── qwen_t2i.json
└── js/
    ├── style.css
    ├── cw-core.js
    ├── cw-workbench.js
    ├── cw-library.js
    ├── cw-newcard.js
    ├── cw-supplement.js
    ├── cw-crop.js
    └── cw-wfedit.js
```
