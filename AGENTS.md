# Folio 个人数字空间 · 工程协作与架构守则 (AGENTS.md)

> 本文档为 `Folio`（个人数字空间项目）的最高工程守则与协作规范，适用于所有在此仓库进行代码、排版、内容及构建维护的 AI 代理与开发者。

---

## 一、核心工程协作铁律 (Universal Engineering Rules)

1. **单步验证后提交 (Verify Before Commit)**：
   - 每次对核心模板（`layouts/`）、业务样式（`static/css/`）、页面数据或内容规范（`content/`）做出修改后，必须在终端执行本地自动化回归验证：
     ```powershell
     npm test
     ```
   - 必须确保 **100% 通过（0 报错、0 失败）** 后，方可执行 Git 提交。
   - 提交信息严格遵循 Conventional Commits 格式：`<type>: <description>`（如 `feat: ...`, `fix: ...`, `docs: ...`, `style: ...`），一句话说清改动。

2. **任务理解与大影响面预先确认 (Confirm Breaking Changes)**：
   - 当任务涉及重构站点全局母版（`baseof.html`）、调整卡片网格系统、变更路由结构或大修设计系统时：
     - **必须先复述对任务的理解（明确拟调整文件、视觉与交互预期、受影响页面范围）**；
     - **得到用户明确确认后方可动工**，严禁凭猜测擅自大规模覆盖现有设计。

3. **证据优先与客观事实 (Evidence Over Assumption)**：
   - 反馈或排查页面渲染异常、死链或样式失效时，严格区分三类信息：
     - ① **已验证事实**（实际生成的 HTML、终端测试日志、文件系统路径）；
     - ② **推测或担忧**；
     - ③ **待核实项**。
   - 不为了顺从表面现象而随意打补丁，以实际构建证据和规范基准为准。

4. **Bug 修复的“同类主动排查”原则 (Peer Inspection)**：
   - 定位并修复一个 Bug 后（例如修复了某一处死链、某一处标签颜色、或某一处多语言编码路径问题）：
     - 必须**主动排查整个系统内所有同类模板、同类链接、同类 Frontmatter 字段**；
     - 确认全盘排查无虞并纳入自动化测试后方可收尾，并在回复中明确说明排查范围。

5. **测试驱动与修改即回归 (Regression Guardrails)**：
   - 任何新增的栏目（如新增作品集、新模块）、模板规则或样式变量，必须在 `tests/site.test.mjs` 中补充对应的断言守则。
   - 修改任何代码均以 `npm test` 全绿为交付验收基准。

---

## 二、项目特化架构与技术约定 (Project Architecture)

### 1. 极简静态原则 (Zero-Runtime Bloat)
- **纯粹的静态生成**：使用 Hugo 编译，严禁引入未经许可的重量级前端框架（如 React/Vue/Node.js SSR）、外部数据库或后端服务。
- **零外部 CDN 依赖**：全站无第三方外部追踪代码、无外链 Google Fonts、无不稳定的公网 CDN 依赖，保障数十年后本地仍可瞬间复现。
- **现代化原生 CSS**：采用纯原生 CSS 变量系统与 Flexbox/Grid 布局，样式表单文件体积严格控制在 50KB 以内。

### 2. 目录规范与单一真源 (Source of Truth)
```
d:\my-site\
├── .gitignore              # Git 忽略文件（public/、resources/ 等构建产物）
├── package.json            # 统一管理 npm test 与 build 命令
├── hugo.toml               # 站点核心配置（品牌、语言、菜单、参数单一真源）
├── content/                # Markdown 内容源文件
│   ├── about.md            # 关于页面
│   ├── posts/              # 文章手记
│   ├── projects/           # 项目作品
│   └── artworks/           # 图画作品
├── layouts/                # 原生 HTML 模板
│   ├── _default/           # 默认模板 (baseof.html, list.html, single.html)
│   ├── index.html          # 首页极简卡片流
│   ├── partials/           # 公共组件 (head.html, header.html, footer.html)
│   ├── posts/              # 文章列表与详情
│   ├── projects/           # 项目列表与详情
│   └── artworks/           # 画作列表与详情
├── static/                 # 纯静态资源（直接复制到 public/）
│   ├── css/style.css       # 核心样式表与色彩变量
│   └── images/posts/       # 文章配图静态资产库
├── scripts/                # 自动化工具链
│   ├── sync-obsidian.mjs   # Obsidian 勾选发布提取引擎
│   └── sync-notion.mjs     # Notion 云端提取脚本
├── tests/                  # 自动化回归测试套件
│   └── site.test.mjs       # 构建、死链、契约全量断言
├── AGENTS.md               # 本规范文档
├── 业务逻辑链条.md          # 业务与内容生命周期单一真源
├── 上线前验收清单.md        # 端到端品控验收剧本
├── publish-blog.cmd        # Windows 一键勾选发布与云端同步脚本
└── 启动本地预览.cmd        # Windows 一键本地热重载预览脚本
```

### 3. 内容 Frontmatter 规范
- **文章 (`content/posts/*.md`)**：
  ```yaml
  ---
  title: "文章标题"
  date: 2026-10-28T20:00:00+08:00
  draft: false
  tags: ["思考", "数字花园"]
  description: "文章一句话概括与摘要。"
  ---
  ```
- **项目 (`content/projects/*.md`)**：
  ```yaml
  ---
  title: "项目名称"
  date: 2026-10-25T14:30:00+08:00
  draft: false
  status: "原型设计" # 允许值: 原型设计 / 机制重塑中 / 进行中 / 概念构思 / 已上线
  tags: ["微信小程序", "产品设计"]
  description: "项目核心解决的问题与定位。"
  ---
  ```

### 4. 色彩变量与深浅模式契约
- 主题变量统一挂载在 `:root` 与 `[data-theme="dark"]`：
  - `--page`：页面基础底色（浅色 `#e7e7e7` / 深色 `#141517`）
  - `--card`：卡片背景色（浅色 `#f5f5f5` / 深色 `#1c1d21`）
  - `--ink`：正文字体主色（浅色 `#15191e` / 深色 `#f0f1f3`）
  - `--muted`：辅助说明文字（浅色 `#425066` / 深色 `#9ba1a9`）
  - `--quiet`：弱化标签与次级信息（浅色 `#78808a` / 深色 `#6d737d`）
  - `--line`：分割线与细边框（浅色 `#d1d2d3` / 深色 `#2e3036`）
  - `--accent`：强调色（墨绿 `#24543d` / 薄荷绿 `#5bb389`）
- 必须同时支持系统偏好监听 `(prefers-color-scheme: dark)` 与右上角手动按钮切换持久化（`localStorage`）。
