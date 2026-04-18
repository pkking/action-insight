---
date: 2026-04-18
topic: overview-timeseries-dashboard
---

# Overview Timeseries Dashboard

## Problem Frame

当前首页主要面向单仓库、单 PR 的生命周期查看，缺少跨仓库的聚合总览层。用户无法在一个页面里快速回答这些问题：最近一段时间哪些仓库的 PR E2E 更慢、CI E2E 是否达标、PR 检视阶段是否成为瓶颈，以及这些指标是否在改善或恶化。

Issue #16 需要把首页提升为“聚合总览 + 时序趋势”的入口，让用户先看仓库级健康度，再下钻到现有明细能力。

## Requirements

**Time Range**
- R1. 首页总览必须支持按时间范围筛选，预设选项包含过去 7 天、14 天、30 天、90 天，以及自定义时间段。
- R2. 第一版趋势图固定按天聚合，不提供周粒度或手动粒度切换。

**Overview Table**
- R3. 首页新增仓库级总览表格，每行展示一个仓库在当前时间范围内的聚合指标。
- R4. 第一版总览表默认展示且必须支持的列为：`仓库`、`PR E2E P90`、`CI E2E P90`、`PR 检视 P90`、`CI E2E 达标率`。
- R5. 所有耗时指标在首页总览与趋势图中统一使用“分钟”作为展示单位。

**Trend Visualization**
- R6. 首页新增趋势图，用于展示当前选中仓库在当前时间范围内的每日指标走势。
- R7. 第一版趋势图支持的指标至少包括：`PR E2E P90`、`CI E2E P90`、`PR 检视 P90`、`CI E2E 达标率`。
- R8. 第一版趋势图默认显示全部已支持指标，并允许用户按需取消部分指标。

**Metric Definitions**
- R9. `PR E2E` 定义为 PR 从创建到合入的总时长，并按当前筛选范围内样本计算 P90。
- R10. `CI E2E` 定义为该 PR 触发的 GitHub Actions 整体时长，并按当前筛选范围内样本计算 P90。
- R11. `PR 检视` 定义为 CI 执行完成后到 PR 合入前的时长，并按当前筛选范围内样本计算 P90。
- R12. `CI E2E 达标率` 定义为在当前筛选范围内，`CI E2E <= 60 分钟` 的 PR 占比。

**State Handling**
- R13. 当筛选结果为空、仓库缺少可计算样本或趋势图无数据点时，页面必须提供明确的空状态反馈，而不是渲染误导性图表或数值。

## Success Criteria
- 用户可以在首页单屏完成跨仓库健康度比较，而不需要逐个进入仓库或 PR 明细。
- 用户可以在选定时间范围内观察核心指标的日趋势变化。
- 首页所有时长类数值在视觉和文案上保持统一的分钟单位，不再混用秒、分秒格式。
- 第一版功能可以直接回答“哪个仓库最近 PR E2E 更慢”和“CI E2E 是否达到 60 分钟目标”这两个核心问题。

## Scope Boundaries
- 第一版不实现“所有仓库维度下、单一指标的横向趋势对比”视图。
- 第一版不把 `CI 排队时长` 或 `CI 执行时间` 的子列表类指标加入首页总览表。
- 第一版不新增趋势图粒度切换能力，只支持按天聚合。
- 第一版不改变现有 PR 明细页中 workflow/job 的展示方式，只在首页增加聚合层。

## Key Decisions
- 最小可用版优先：先交付总览表和单仓库趋势图，降低首个 PR 的范围和风险。
- 核心指标优先：总览表第一版只保留 4 个最有决策价值的聚合指标，避免把子列表类指标硬塞进表格。
- 单位统一为分钟：减少用户在首页跨仓库比较时的认知切换。
- 趋势图默认全开：第一版优先让用户一进入页面就看到完整信号，再通过勾选收窄视图。

## Dependencies / Assumptions
- 当前离线数据中已有 PR 创建、CI 开始、CI 完成、PR 合入等字段，可支撑 `PR E2E`、`CI E2E`、`PR 检视` 的计算。
- 跨仓库首页展示默认基于当前可追踪仓库列表，不要求第一版提供额外仓库配置入口。
- 若部分 PR 缺失合入时间或 CI 时间，相关指标可按已有可计算样本统计，但需要在页面上避免误导。

## Outstanding Questions

### Resolve Before Planning
- None.

### Deferred to Planning
- [Affects R3][Technical] 首页总览是否直接基于现有 `prs/index.json` 实时聚合，还是需要新增预聚合文件来控制前端成本。
- [Affects R6][Technical] 趋势图默认全开时，多条折线在同一坐标系中的可读性如何处理，尤其是百分比与分钟混合展示。
- [Affects R13][Needs research] 当某个仓库在时间窗内样本量极低时，是否需要最小样本门槛或提示文案来解释 P90 的统计意义有限。

## Next Steps
-> Proceed directly to work or `/ce:plan`, depending on whether implementation should start immediately or after a structured build plan.
