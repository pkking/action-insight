# Split Architecture Design: Data + Frontend Separation

**Date**: 2026-04-05
**Status**: Draft — Awaiting Review

## 1. Problem Statement

当前 action-insight 是单体 Next.js 应用，所有逻辑（数据获取、缓存、渲染）都在浏览器端完成：
- 客户端直接调用 GitHub API，受限于 rate limit（60 req/hr 无 token，5000 req/hr 有 token）
- localStorage 缓存有 5MB 限制，高频 repo 容易超限
- 用户需要手动提供 GitHub PAT 才能正常使用
- 每次打开页面都需要重新拉取数据，体验差

目标：拆分为 **数据获取层（ETL）** 和 **数据展示层（Frontend）**，ETL 定时采集数据写入 GitHub 仓库，前端只读渲染。

## 2. Architecture Overview

### 方案选择：单仓库 + 独立数据分支

```
action-insight/
├── main 分支 (Vercel 部署)
│   ├── src/
│   │   ├── app/
│   │   │   ├── page.tsx        ← 前端 Dashboard（改造后）
│   │   │   └── layout.tsx
│   │   ├── components/
│   │   └── lib/
│   │       └── data-fetcher.ts ← 新增：从 data 分支读取 JSON
│   └── package.json
│
└── data 分支 (ETL 写入)
    ├── data/
    │   ├── index.json          ← 索引文件
    │   ├── 2024-01-16.json     ← 按天切分
    │   ├── 2024-01-15.json
    │   └── ...
    └── etl/
        ├── .github/workflows/
        │   └── collect.yml     ← GitHub Actions cron
        └── scripts/
            └── collect.ts      ← ETL 采集脚本
```

### 关键决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 仓库策略 | 单仓库双分支 | 一个仓库管理，数据和代码隔离 |
| 数据格式 | JSON 文件 | 前端直接 fetch 解析，无需额外服务 |
| 切分粒度 | 按天 | 单文件 < 500KB，避免 GitHub 单文件限制 |
| ETL 运行方式 | GitHub Actions cron | 每 6 小时自动运行，也支持手动触发 |
| 前端数据源 | GitHub Raw URL | 免费、无需后端、CDN 缓存 |

## 3. Data Format

### 3.1 `data/index.json` — 索引文件

```json
{
  "version": 1,
  "repos": {
    "vllm-project/vllm-ascend": {
      "latest": "2024-01-16",
      "files": [
        "2024-01-16.json",
        "2024-01-15.json",
        "2024-01-14.json"
      ],
      "retention_days": 90
    }
  },
  "last_updated": "2024-01-16T12:00:00Z"
}
```

### 3.2 `data/YYYY-MM-DD.json` — 单日数据

```json
{
  "date": "2024-01-16",
  "repo": "vllm-project/vllm-ascend",
  "runs": [
    {
      "id": 123456,
      "name": "CI",
      "head_branch": "main",
      "status": "completed",
      "conclusion": "success",
      "created_at": "2024-01-16T10:00:00Z",
      "updated_at": "2024-01-16T10:15:00Z",
      "html_url": "https://github.com/...",
      "durationInSeconds": 900,
      "jobs": [
        {
          "id": 789,
          "name": "test-npu",
          "status": "completed",
          "conclusion": "success",
          "created_at": "2024-01-16T10:00:00Z",
          "started_at": "2024-01-16T10:02:00Z",
          "completed_at": "2024-01-16T10:15:00Z",
          "html_url": "https://github.com/...",
          "queueDurationInSeconds": 120,
          "durationInSeconds": 780
        }
      ]
    }
  ]
}
```

**约束**：
- 单文件大小控制在 ~500KB 以内
- 每天一个文件，超过 retention_days 自动清理
- 包含完整的 runs + jobs 数据，前端无需二次请求

## 4. ETL Pipeline

### 4.1 GitHub Actions Workflow

```yaml
name: Collect CI Data
on:
  schedule:
    - cron: '0 */6 * * *'
  workflow_dispatch:

jobs:
  collect:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: data
          fetch-depth: 0
      - uses: actions/setup-node@v4
      - run: npm install
      - run: npx tsx etl/scripts/collect.ts
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          TARGET_REPOS: "vllm-project/vllm-ascend"
          RETENTION_DAYS: 90
      - run: |
          git config user.name "action-insight-bot"
          git config user.email "bot@action-insight.local"
          git add data/
          git diff --staged --quiet || git commit -m "data: update $(date -u +%Y-%m-%d)"
          git push origin data
```

### 4.2 ETL 脚本逻辑 (`etl/scripts/collect.ts`)

```
1. 读取 data/index.json → 获取 last_updated
2. 对每个 target repo:
   a. 增量拉取 runs（只拉取 last_updated 之后的）
   b. 对每个 run，调用 /jobs API 获取 jobs
   c. 按日期分组，合并到对应的 data/YYYY-MM-DD.json
   d. 更新 index.json（files 列表、latest、last_updated）
3. 清理超过 retention_days 的旧文件
4. 幂等保证：同一天的数据覆盖写入
```

### 4.3 API 速率控制

- GitHub API 限制：5000 req/hr（使用 GITHUB_TOKEN）
- 每 6 小时运行一次，每次 ~200 runs × 2 API calls = ~400 requests
- 安全余量充足

## 5. Frontend Changes

### 5.1 新增数据读取层

`src/lib/data-fetcher.ts`:

```typescript
const DATA_BRANCH = 'data';
const RAW_BASE = `https://raw.githubusercontent.com/${OWNER}/${REPO}/${DATA_BRANCH}`;

async function fetchIndex(): Promise<Index>;
async function fetchDay(repo: string, date: string): Promise<DayData>;
export async function fetchRuns(repo: string, days: number): Promise<Run[]>;
```

### 5.2 `src/app/page.tsx` 改造

**删除**：
- 所有 `fetch('https://api.github.com/...')` 调用
- localStorage 缓存逻辑（`localStorage.getItem/setItem`）
- GitHub Token 设置 UI（Settings modal、token 状态管理）
- `githubToken` 相关 state 和 useEffect

**保留**：
- 所有 UI 组件（Stats Cards、Chart、Timeline、Table）
- 筛选、排序、缩放交互逻辑
- URL 状态同步（searchParams）
- JobDetailsView 组件

**修改**：
- `useEffect` 中的数据获取改为调用 `fetchRuns()`
- 数据类型从 Record<string, unknown> 改为强类型 Run[]

### 5.3 数据读取策略

```
页面加载 → fetchIndex() → 确定可用日期范围
         → 根据用户选择的天数，并行 fetch 对应日期的 JSON
         → 聚合所有 runs → 渲染 Dashboard
```

- 使用 `fetch()` 默认缓存策略（浏览器缓存）
- 可添加 `?t=${timestamp}` 参数强制刷新

## 6. Error Handling

| 场景 | 处理方式 |
|------|----------|
| index.json 不存在 | 显示 "数据采集中，请稍后重试" |
| 某天 JSON 文件 404 | 跳过该天，继续加载其他天 |
| 所有数据加载失败 | 显示错误状态 + 重试按钮 |
| ETL 运行失败 | 前端显示上次成功的数据（通过 index.json 时间戳判断） |

## 7. Migration Plan

1. **Phase 1**: 创建 `data` 分支，搭建 ETL pipeline
2. **Phase 2**: 运行 ETL 填充历史数据（回补 90 天）
3. **Phase 3**: 前端改造，切换到 data 分支数据源
4. **Phase 4**: 验证功能，删除旧的 GitHub API 调用代码

## 8. Open Questions

- [ ] 是否需要支持多 repo 同时展示？（当前设计支持，但 UI 可能需要调整）
- [ ] 数据更新频率是否需要可配置？（当前固定 6 小时）
- [ ] 是否需要添加数据校验机制（如 JSON schema 验证）？
