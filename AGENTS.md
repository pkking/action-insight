# AGENTS.md - Action Insight Repository Context

## 项目简介 (Project Overview)
**Action Insight** 是一个用于监控和可视化 GitHub Actions 工作流状态的 Web 应用。
- **技术栈**：Next.js, TypeScript, Tailwind CSS, Recharts, Lucide React, date-fns。
- **核心组件**：采用 Server/Client Components 结合 (`'use client'`指令处理 React Hooks)。

## 核心业务逻辑 (Core Business Logic)
1.  **数据抓取与缓存**：通过 GitHub API 获取 Runs 和 Jobs 数据，并在本地进行缓存处理。
2.  **筛选与匹配规则**：
    - **Runner Label 筛选**：Workflow 级别匹配采用“任意 Job 命中即选中 Workflow”的原则。只要 Workflow 中的任何一个 Job 带有用户指定的 Runner Label，即在列表中展示该 Workflow。
3.  **多视图可视化**：支持作业数据的“时间线 (timeline)”和“表格 (table)”视图，并通过图表 (`LineChart`, `ReferenceArea`) 展示排队、耗时等性能数据。

## AI 协助开发规范 (AI Development Guidelines)

当 AI 助手在这个仓库中工作时，必须遵守以下约定：
1.  **保持技术栈一致性**：新创建的组件如果在浏览器端交互，必须带有 `'use client'` 声明。
2.  **样式规范**：使用 Tailwind CSS 进行样式编写，并确保所有新增 UI 支持 `dark:` 模式适配。
3.  **容错处理**：在渲染图表和列表时，必须优雅处理数据空状态 (Empty State) 和加载中状态 (`jobsLoading`)。
4.  **成本意识**：避免无意义地频繁调用 GitHub API 列表，尽可能重用现有的离线/本地缓存策略，对于长链路的数据解析，采用二级查询 + 本地脚本离线筛选方案。
5.  **Git 规范**：所有修改在得到确认后，应当立即使用 [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/#specification) 规范进行 commit 并推送到 origin。提交信息应遵循 `type(scope): description` 或 `type: description` 格式，常用类型包括 `feat`、`fix`、`ci`、`docs`、`test`、`refactor`、`chore`。

## 相关关联 (Relations)
此仓库针对 `vllm-project/vllm-ascend` 等带有复杂 CI/CD 标签的仓库进行了专门的适配（例如针对 `npu` 或 `large-disk` 标签）。
