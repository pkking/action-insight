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
6.  **PR 工作流**：**禁止直接推送到 `main` 分支**。所有变更必须通过 feature 分支 → Pull Request → 合并流程：
    - **创建分支前必须先切换到 `main` 并同步远端代码**：`git fetch origin main && git checkout -B main origin/main`，确保 feature 分支基于最新的 `main`。
    - 从 `main` 创建 feature 分支，命名格式：`feat/<descriptive-name>` 或 `fix/<descriptive-name>`
    - 推送分支到 origin 并创建 PR
    - PR 标题使用 Conventional Commits 格式，PR 描述需说明变更内容、测试情况、相关文档链接
    - **PR 打开后禁止 force push**：审查过程中产生的任何修改都必须追加新的 Conventional Commit 并正常 push，禁止使用 `git commit --amend`、`git rebase` 或 `git push --force/--force-with-lease` 重写 PR 历史，除非用户明确要求。
    - **一个分支只对应一个 PR**：push 过 origin 的分支在 PR 合入后不再用于新任务。每次新任务都必须基于最新 main 创建新分支并新建 PR，禁止复用已合入的 feature 分支。审查期间对同一 PR 的修改仍可追加 commit。
    - 等待审查通过后合并，合并后删除 feature 分支
    - **Gitignore 规范**：**AI 工具相关目录不应被加入 .gitignore**。例如 `.codex`、`.sisyphus`、`.serena/memories` 等目录包含有用的 AI 会话信息和上下文，应当保留在仓库中以便跨会话共享和延续上下文。只有临时缓存文件（如 `.serena/cache/`）和编译产物（如 `__pycache__/`）才应被忽略。

## 本地维护工具使用建议 (Local Maintenance Tools)

AI 助手在维护 ETL、Supabase 数据或恢复指标时，应优先使用以下本地入口，并遵守成本控制原则：

1.  **Schema 迁移**：当修改 `supabase/schema.sql`、新增表/函数，或本地/CI 需要补齐数据库结构时，使用 `npm run migrate:supabase`。需要设置 `SUPABASE_DB_URL`，CI 中可设置 `AUTO_MIGRATE_SUPABASE=1`，证书链异常时才使用 `SUPABASE_DB_SSL=no-verify`。
2.  **Raw CI 采集**：当 `runs` 或 `jobs` 缺失/过期时，使用 `npx tsx etl/scripts/collect.ts --repo owner/repo`。该脚本只负责抓取 GitHub Actions runs/jobs 并写 Supabase，不再重建 PR metrics。避免无范围、无目的地重复运行，以免浪费 GitHub API 配额。
3.  **PR 指标重建**：当 raw runs 已存在，但 `pr_metrics` / `pr_workflows` 缺失、落后或部分解析时，优先使用 `npm run rebuild:pr-artifacts -- --repo owner/repo --start-date yyyy-mm-dd --end-date yyyy-mm-dd`。尽量提供日期范围，避免全量扫描。`GITHUB_TOKEN` 可选；没有 token 时只能依赖 run payload 和 `pr_resolution_cache`。
    - **Token 配置**：Rebuild workflow 使用 per-repo token 机制，优先级为 `GITHUB_TOKEN_PER_REPO_<OWNER>_<REPO>` → `GITHUB_TOKEN_PER_REPO_TRITON_LANG_TRITON_ASCEND`（fallback PAT）。新增 repo 时需确保在 GitHub Settings → Secrets 中配置对应的 `GITHUB_TOKEN_PER_REPO_<OWNER>_<REPO>`，否则会降级使用 triton-ascend 的 token（共享 rate limit 5,000/h）。
4.  **兼容入口**：`etl/scripts/rebuild-pr-artifacts-local.ts` 仅作为旧路径兼容 wrapper，新的说明、脚本和自动化应使用 `npm run rebuild:pr-artifacts` 或 `etl/scripts/rebuild-pr-artifacts.ts`。
5.  **回填策略**：只有在需要从保留窗口最早日期重新构建 raw history 时才使用 `collect.ts --force-full-backfill`；当最新数据优先级更高时使用 `collect.ts --reverse`。
6.  **验证命令**：改动完成后至少运行与改动相关的测试；通用验证为 `npm run lint` 和 `npm test`。ETL 脚本改动应额外跑相关 `vitest` 文件和脚本 `--help`。

## 相关关联 (Relations)
此仓库针对 `vllm-project/vllm-ascend` 等带有复杂 CI/CD 标签的仓库进行了专门的适配（例如针对 `npu` 或 `large-disk` 标签）。
