---
date: 2026-04-19
topic: ci-experience-report-modes
---

# CI Experience Report Modes

## Problem Frame

当前 `.agents/skills/ci-efficiency-report` 已经可以产出仓库级 CI 效率数据，但输出模式仍过于单一。用户希望它同时服务两类场景：

- **月度汇报版**：从“开发者提交 PR 的体验”角度，对某个仓库一个月内的 CI 提交体验做管理汇报
- **每日技术分析版**：从“当前问题和改进跟踪”角度，对某个仓库最近一天或指定短时间窗的 CI 问题做技术分析

这项工作必须通过增强 `.agents/skills/ci-efficiency-report` 的输出能力来实现，而不是新增独立的页面或单独的分析脚本入口。

## Audience

- 月度汇报版主要受众：管理层 / 负责人
- 每日技术分析版主要受众：CI 平台团队、仓库维护者

两类受众不同，因此 skill 不能再只生成一种固定输出。月报必须优先回答“整体是否达标、问题是否严重、治理抓手是什么”；日报必须优先回答“今天/当前有哪些具体问题值得处理、怎么跟踪”。

## Goals

- 让管理者能在一页到两页内容内判断该仓库本月 CI 提交体验是否达标
- 让技术团队能快速看到当前周期内最需要跟踪和修复的 CI 问题
- 明确说明偏离 `60 分钟` 目标的程度和分布
- 给出可以继续治理或跟踪的具体方向，而不是停留在泛化指标
- 保留 workflow / job / step 级下钻明细

## Non-Goals

- 不在这次工作中新增 Web UI 页面
- 不修改仓库现有前端功能行为
- 不修改仓库现有 ETL 功能行为
- 不把报告扩展成完整的“PR review 体验”报告
- 不把 flaky、重跑次数、首次通过率等当前未稳定采集的数据包装成正式月报结论
- 不要求本次工作自动生成 PPT 或视觉设计稿

## Requirements

**Report Modes**
- R1. `ci-efficiency-report` 必须支持至少两种报告模式：
  - `monthly_summary`
  - `daily_diagnostic`
- R2. `monthly_summary` 与 `daily_diagnostic` 必须共用同一套底层数据采集和聚合能力，但输出组织不同。
- R3. `monthly_summary` 不能退化为技术排障日志，`daily_diagnostic` 也不能退化为只看仓库级总览的静态摘要。

**Monthly Summary**
- R4. 月度汇报首页必须包含以下核心指标：
  - `统计 PR 数`
  - `CI E2E P50`
  - `CI E2E P90`
  - `排队耗时 P90`
  - `CI执行时长 P90`
  - `CI E2E达标率(%)`
- R5. 月度汇报首页必须直接对照 `CI E2E <= 60 分钟` 目标，并明确判断“达标 / 不达标 / 长尾严重”。
- R6. 月度汇报首页必须包含标准分桶分布表，分桶固定为：
  - `<60m`
  - `60-120m`
  - `120-240m`
  - `>240m`
- R7. 月度汇报中的每个分桶必须展示：
  - PR 数
  - 占比
  - 必要时的代表性长尾样本
- R8. 月度汇报首页必须给出一句话结论，说明本月开发者提交体验的整体判断，以及主要矛盾在排队、执行，还是少数重型 workflow。
- R9. 月度汇报首页必须给出少量治理建议，优先对应高频拖慢项、长尾拖慢项或资源排队问题。

**Daily Diagnostic**
- R10. 每日技术分析版必须优先展示当前时间窗内最值得处理的问题，而不是先展示完整月度总览。
- R11. 每日技术分析版必须输出可跟踪的问题清单，至少覆盖：
  - 当前最慢 workflow
  - 当前最慢 job
  - 当前最慢 step
  - 高频拖慢项
  - 新出现的问题与持续问题
- R12. 每个问题项至少要能附带：
  - 影响范围或运行次数
  - 最大耗时 / 平均耗时 / 累计耗时中的至少两个
  - 所属 workflow / job / step
  - 是否属于偶发长尾或持续拖慢
- R13. 每日技术分析版必须适合技术团队继续做问题跟踪，而不是只做展示。

**Abnormality Detection**
- R14. skill 必须能够从统计指标中识别异常，至少包括：
  - `CI E2E达标率` 明显偏低
  - `>240m` 长尾桶占比偏高
  - `排队耗时 P90` 明显偏高
  - `CI执行时长 P90` 明显偏高
- R15. 异常分析必须优先回答：
  - 超标是普遍偏慢，还是长尾严重
  - 瓶颈主要在排队还是执行

**Diagnostic Appendix**
- R16. skill 必须生成一个据详下钻表格，从 PR 体验视角逐层下钻：
  - 先看最耗时 workflow
  - 再看这些 workflow 中最耗时的 job
  - 再看这些 job 中最耗时的 step
- R17. workflow / job / step 三层都必须同时展示耗时和运行次数，避免只看单次异常值。
- R18. `Diagnostic Appendix` 中必须单独给出“本周期内最慢 job”的排行，至少包含：
  - 最大耗时
  - 平均耗时
  - 累计耗时
  - 运行次数
  - 对该 job 属于“偶发长尾”还是“高频拖慢项”的说明
- R19. 下钻分析必须能够支撑治理建议或问题跟踪，至少能回答“具体是哪几个 workflow / job 值得优先治理或持续跟踪”。

**Data Truthfulness**
- R20. 当某项数据当前口径不稳定或无有效样本时，报告必须显式标记为“当前不具备可靠结论”，不能输出误导性结论。
- R21. 当前版本必须将 `PR review 体验` 视为非主结论项；若无稳定样本，不得在 `monthly_summary` 中强行纳入。
- R22. 若 step 级耗时数据存在缺失或 API 覆盖不足，报告必须将 step 分析降级为补充排障信息，而不是首页正式结论。

**Output Structure**
- R23. skill 必须能够清晰区分：
  - 面向管理层的月度摘要输出
  - 面向技术团队的每日诊断输出
- R24. 即使最终仍落地为 Excel 或文本报告，也必须在内容组织上保留这两类模式，而不是混成一种固定模板。

## Success Criteria

- 用户能够直接用 skill 输出组织一版月度管理汇报或每日技术分析，无需手工重新拼装核心结论
- 管理层读完月报后，能回答：
  - 本月是否达标
  - 问题是否严重
  - 主要拖慢因素是什么
- 技术团队读完日报后，能回答：
  - 当前最需要处理的问题是什么
  - 这些问题集中在哪些 workflow / job / step
  - 应该优先修复还是继续跟踪
- 报告不会把当前不稳定或缺失的数据伪装成确定性结论

## Scope Boundaries

- 第一版不引入新的前端展示页面
- 第一版不把 `PR review`、`flake`、`首次通过率`、`重跑次数` 纳入月报首页强制项
- 第一版不要求自动给出复杂的根因诊断，只要求把问题定位到足够明确的 workflow / job / step 层级
- 第一版不要求做跨仓库月报对比，先服务单仓库月报和单仓库日报
- 第一版不要求自动生成 ticket 或 issue，只要求输出适合继续跟踪的问题清单

## Key Decisions

- skill 必须显式支持“月度管理汇报版”和“每日技术分析版”两种模式
- `60 分钟` 是月报异常识别和内容组织的主轴
- 月报采用“摘要 + 附录”的双层结构，日报采用“问题清单 + 归因 + 跟踪”的结构
- 所有增强都必须通过扩展 `.agents/skills/ci-efficiency-report` 来实现
- 本次方案不得引入对 `src/` 前端代码或 `etl/` 采集逻辑的功能性改动

## Current Data Assessment

### Sufficient Today

- PR 数、CI E2E、排队耗时、执行耗时、SLA 达标率
- PR 维度的 CI 分桶分布
- workflow / job 维度的主要拖慢项
- 若 jobs API step 数据齐全，则可做 step 级补充分析
- 基于运行次数和耗时组合输出问题清单

### Not Yet Reliable Enough As Headline Metrics

- PR review 体验
- flaky 重跑体验
- 首次通过率
- 任何当前没有稳定样本或存在明显口径缺口的数据

## Outstanding Questions

### Resolve Before Planning

- None.

### Deferred to Planning

- `monthly_summary` 与 `daily_diagnostic` 的具体输出格式是扩展现有 Excel、生成多 sheet Excel，还是文本 + Excel 混合物。
- workflow / job / step 的排序规则是按最大耗时、累计耗时、平均耗时，还是综合评分。
- “偶发长尾”与“高频拖慢项”的阈值如何定义，是否需要 repo 可配置。
- 日报里“新问题”和“持续问题”的判定是否只基于当前窗口，还是需要与前一周期对比。

## Next Steps

- Proceed to planning for how `.agents/skills/ci-efficiency-report` should gather, structure, and present both monthly and daily CI experience reports.
