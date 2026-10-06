# 小王.EXE — 复古像素风个人网站

一个纯 **HTML + CSS + JavaScript** 的像素风个人主页，零框架、零构建、零外部依赖。
站点本身双击 `index.html` 就能跑；只有 AI 聊天功能需要跑一个本地小服务（见下文）。

## 目录结构

```
个人网站/
├── index.html            # 页面结构
├── css/style.css         # 全部样式
├── js/main.js            # 站点交互（音效 / 像素精灵 / 彩蛋…）
├── js/chat.js            # AI 聊天挂件的交互逻辑
├── server.py             # 本地开发服务器（静态文件 + /api/dify 代理）
├── api/dify.js           # 线上部署用的 Serverless 函数（Vercel）
├── .env.local            # 密钥（已被 .gitignore 忽略，不会进 Git）
├── .env.example          # 密钥模板
├── assets/fonts/         # 本地像素字体（Fusion Pixel，中英文全覆盖）
└── README.md
```

## 功能一览

| 功能 | 位置 |
| --- | --- |
| CRT 开机动画 + `PRESS START` | 页面加载时 |
| 8-bit 背景音乐 / 音效（Web Audio 实时合成，无需音频文件） | 左下角 HUD |
| 打字机字幕轮播 | Hero 区 |
| 像素机器人头像（眨眼 / 点击有反应 / 点 5 次解锁成就） | Hero 区 |
| NPC 逐字对话 | 关于我 |
| 属性条动画 | 技能 |
| 关卡卡片 | 作品 |
| 闯关地图时间线 | 历程 |
| 点击复制邮箱 / 公众号 | 联系 |
| 像素彩带 + 成就提示 | 输入 `↑↑↓↓←→←→BA` |
| 自定义像素光标、扫描线、故障标题 | 全站 |
| **像素风 AI 聊天挂件**（流式输出 / 历史记录 / 点赞点踩 / 全屏） | 右下角 `ASK AI` 按钮 |

## AI 聊天挂件
右下角的聊天窗是**自己写的前端**，通过 `/api/dify` 调用 Dify 的接口。
不是 Dify 的官方嵌入，因此**界面上没有任何第三方品牌标识**，风格和整站完全统一。

### 功能对照（与官方 WebApp 一致，配置都来自 Dify 后台）

| 功能 | 界面位置 | 数据来源 |
| --- | --- | --- |
| 新对话设置（`role` 下拉） | 面板顶部设置栏 | `GET /parameters` → `user_input_form` |
| 开场白 | 打开时第一条消息 | `GET /parameters` → `opening_statement` |
| 推荐问题 | 开场白下方的快捷按钮 | `GET /parameters` → `suggested_questions` |
| 历史对话列表 | 标题栏 `☰` | `GET /conversations` |
| 点击历史回看消息 | 历史列表里点任意一条 | `GET /messages` |
| 接着历史继续聊 | （点开历史后直接输入即可） | 复用该会话的 `conversation_id` |
| 点赞 / 点踩 | 每条机器人回答下方 | `POST /messages/{id}/feedbacks` |
| 开启新对话 | 历史视图顶部的按钮 | — |
| 全屏 | 标题栏 `⛶` | — |
| 关闭 | 标题栏 `✕`（或 `Esc`） | — |

因为设置项是动态渲染的，**在 Dify 后台加/改输入项或推荐问题，网站会自动跟着变**，不用改代码。

> `role` 这类输入项只在「一段对话的第一条消息」生效，这和官方 WebApp 行为一致。
> 所以聊天中途改设置时，代码会自动开一段新对话并提示你。

### 架构

```
浏览器 (js/chat.js)
      │  GET  /api/dify?action=parameters | conversations | messages
      │  POST /api/dify?action=chat | feedback
      ▼
服务端代理（本地 server.py ｜ 线上 api/dify.js）   ← API Key 只存在这里
      │  转发到 https://api.dify.ai/v1/...
      ▼
Dify
```

**为什么必须有这一层代理？** Dify 官方明确要求 API Key 只能放在服务端。
一旦写进前端 JS，任何人打开浏览器控制台都能拿走它、烧你的额度。

### 本地怎么跑

**最省事：双击 `启动网站.command`** —— 它会自动启动服务器并打开浏览器。
（首次双击若被 macOS 拦下，右键 → 打开，或到「系统设置 → 隐私与安全性」放行一次。）

**或者手动：**

```bash
cd "/Users/younghs/Desktop/个人网站"
python3 server.py            # 只用标准库，不需要 pip 安装任何东西
# 打开 http://localhost:8899
```

> ⚠️ **别直接双击 `index.html`。** 那样地址栏是 `file://`，
> 浏览器里没有 `/api/dify` 接口，聊天窗会提示「请改用本地服务器」。
> 站点其它部分（动画、字体、音效）在 `file://` 下都正常，只有聊天不可用。

密钥从 `.env.local` 读取。要换成你自己的：

1. 复制 `.env.example` 为 `.env.local`
2. 填入 Dify 后台 → 你的应用 → 「访问 API」→「API 密钥」里创建的 Key（形如 `app-xxxxxxxx`）
3. 重启 `server.py`

没配密钥时聊天窗不会崩，会提示「聊天服务还没配置好」并告诉你怎么做。

### 怎么部署到线上

静态部分随便放（GitHub Pages / Netlify / Vercel 都行），
但 `/api/dify` 需要一个能跑服务端代码的地方：

**Vercel**（最省事，仓库里的 `api/dify.js` 已经写好了）

1. 把整个文件夹推到 Git 仓库
2. Vercel 里 Import 这个仓库
3. Settings → Environment Variables 添加 `DIFY_API_KEY`
4. 重新部署

Vercel 会自动把 `api/dify.js` 映射成 `/api/dify`，和前端写死的路径正好对上，前端代码不用改。

**其他平台**：`api/dify.js` 的逻辑（Node / Edge 版）可以照搬，
在 Netlify 放成 `netlify/functions/dify.js` 并把前端路径改成 `/.netlify/functions/dify`；
Cloudflare Workers 同理。

### 踩过的坑

| 坑 | 说明 |
| --- | --- |
| **Cloudflare 会拦 Python 的默认 UA** | Dify 前面挂着 Cloudflare，`Python-urllib/3.9` 直接返回 **403**，换成浏览器 UA 就是 200。`server.py` 和 `api/dify.js` 里都已显式设置了 `User-Agent`。**别把那行删掉。** |
| **`agent-chat` 应用不支持 `blocking` 模式** | 实测返回 `400 invalid_param: Agent Chat App does not support blocking mode`。所以 `/chat-messages` 只能用 `response_mode: streaming`，不要为了图省事改成阻塞式。 |
| **模型额度用尽要单独提示** | Dify 免费托管的模型额度耗尽时返回 `{"code":"provider_quota_exceeded"}`。代码里把它翻译成了「去 Dify 后台配置自己的模型供应商」的提示 —— 原样丢给用户只会看到一坨 JSON。 |
| **别用 `rem` 定尺寸** | 本站在 `html` 上设了 `font-size: 12px`（像素字要整数倍缩放才不糊），所以 `rem` 只有 12px。聊天窗尺寸一律用 `px`。 |
| **聊天窗必须在 CRT 遮罩之上** | `.crt` 那层扫描线带暗角，**屏幕边缘处最重**，而聊天窗正好在右下角 —— 放在它下面会被压暗到几乎看不见文字。所以 `.chatw` 的 `z-index` 是 `9991`，比 `.crt` 的 `9990` 高一级；面板自己用 `::after` 补一层很淡的扫描线保持质感。 |
| **`display:flex` 会盖掉 `[hidden]`** | 面板/消息区/历史区都用 `hidden` 属性切换，但 `display:flex` 优先级更高，必须对每个都补一条 `[hidden] { display: none; }`，否则会一直显示。 |
| **滚动要能收起来** | 消息区在 flex 布局里必须配 `min-height: 0`，否则内容多了会把面板撑高、滚动条失效。 |
| **必须用 http(s) 打开** | 站点主体在 `file://` 下完全正常，但聊天需要 `/api/dify`。代码会检测 `location.protocol === 'file:'` 并直接给出「请用 python3 server.py」的操作指引，而不是抛一个看不懂的 `Load failed`。 |
| **模型输出一律当纯文本渲染** | `js/chat.js` 全部用 `textContent` 写入，不拼 HTML，避免模型输出里的内容被当成标签执行。 |
| **开机动画期间会隐藏** | `body.is-booting` 时挂件隐藏，避免盖在 BIOS 开机画面上。 |


### 关于 Dify 的品牌标识（背景说明）

一开始是直接用 Dify 的官方嵌入代码（一个跨域 iframe 气泡），
但它有两个绕不过去的问题：**内部样式永远改不了**（跨域），
以及带「POWERED BY Dify」标识，而去掉它违反 Dify 的许可条款：

> Dify 采用「Apache 2.0 + 附加条款」的修改版许可，第 1.b 条：
> **LOGO and copyright information:** In the process of using Dify's frontend,
> you may not remove or modify the LOGO or copyright information in the Dify
> console or applications.

同一份许可里也写明：*"This restriction is inapplicable to uses of Dify that do not
involve its frontend."* —— **不使用它的前端，就不受这条限制**。
所以最终改成了「自己写 UI + 调 API」，既解决了样式问题，也没有品牌标识问题。

## 怎么改成你自己的内容

所有文案都集中在两个地方，直接搜中文关键词就能定位：

**1. 静态文案 → `index.html`**

- 名字：搜 `小王.EXE`（出现在标题、导航 logo、Hero 大标题、页脚）
- Hero 副标题描述、四个属性（LV./HP/MP/EXP）：Hero 区
- 四张"关于我"卡片：`.facts` 里的 `.fact`
- 装备标签：`.equip__list` 里的 `.chip`
- 项目卡片：`.quests` 里的 `.quest`
- 邮箱 / 小红书 / 公众号：`#contact` 区块
- 页脚：`.footer`

**2. 动态数据 → `js/main.js`**

| 常量 | 作用 |
| --- | --- |
| `BOOT_LINES` | 开机画面的逐行日志 |
| `SKILLS` | 技能面板（`v` 是 0–100 的数值，`c` 是颜色） |
| `ROADMAP` | 升级路线时间线 |
| `DIALOGUE` | 关于我的 NPC 对话，点一下翻一页 |
| `HERO_PHRASES` | Hero 区循环打字的句子 |

**3. 聊天挂件 → `js/chat.js`**

| 常量 | 作用 |
| --- | --- |
| `GREETING` | 打开聊天窗时的第一句话 |
| `SUGGESTIONS` | 开场那三个推荐问题（点一下直接发送） |
| `STORE_CONVERSATION` | 会话 ID 的存储键，存在 `sessionStorage`，刷新后还能接着上一轮聊 |

## 主题配色

想换配色只需要改 `css/style.css` 顶部的 `:root` 变量：

```css
--bg: #0f0524;     /* 背景 */
--cyan: #00f0ff;   /* 主霓虹色 */
--pink: #ff2e88;   /* 强调色 */
--yellow: #ffe600; /* 高亮 */
--green: #39ff14;  /* 成功 / CTA */
--purple: #a06bff; /* 次要强调 */
```

## 本地预览

**双击 `启动网站.command`** 最省事（自动起服务 + 开浏览器）。

站点主体在 `file://` 下也能看（双击 `index.html` 即可），
但**要用 AI 聊天就必须起本地服务器**（因为需要 `/api/dify`）：

```bash
python3 server.py
# 然后打开 http://localhost:8899
```

## 部署

**没有聊天功能时**：纯静态站点，把文件夹丢上去就行，无需任何构建配置。
**要保留聊天功能**：见上文「AI 聊天挂件 → 怎么部署到线上」，
静态部分可以放任意平台，`/api/dify` 需要一个能跑服务端代码的地方（Vercel 最简单）。

## 无障碍 / 兼容

- 支持 `prefers-reduced-motion`：开启后会关闭动画、跳过开机动画
- 键盘可操作：`Tab` 可聚焦，`Enter` / `Space` 可触发
- 响应式：桌面 / 平板 / 手机三档断点，320px 宽无横向滚动
- 移动端自动关闭自定义光标与悬浮音效

## 字体许可

`assets/fonts/` 中的字体为 [Fusion Pixel Font](https://github.com/TakWolf/fusion-pixel-font)，
基于 SIL Open Font License 1.1 发布，可自由商用。
