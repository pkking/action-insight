# ADR-039: NPU 浪费卡时统计口径（被新提交替代 / 同 SHA 重复触发）

日期：2026-11-14　状态：已接受

## 背景

趋势报告（`reports/npu-daily-trends-*.html`）只按作业结论展示卡时，无法回答"多少卡时被浪费"。管理侧关心两类已对齐的浪费：新 commit 取消旧任务时旧任务已执行的部分；同一 commit 被重复触发执行的部分。需要一份可审计、可复算的浪费账。

## 决策

两层账，互不叠加：

1. **结果账**（沿用趋势报告）：成功 / 失败 / 取消 / 其他 job 卡时。浪费账是其子集切面。
2. **原因账**（本 ADR 新增），按 attempt 归一因，优先级 被替代 > 合并清场 > 显式取消 > 重复：

| 类别 | 判定 | 计量 |
|---|---|---|
| superseded（被新提交替代） | attempt 取消，且同 PR（有链接）或同 workflow+head_branch 的**不同 sha** run 在其结束前 ≤30 分钟入队 | 该 attempt 全部已执行 NPU 卡时（含内部已成功的 job） |
| merge_cleanup（合并清场） | attempt 的 PR 已 merged 且取消时间落在 [merged_at−5min, +30min] | 硬证据，计入浪费 |
| explicit_cancel_human（显式取消-人） | attempt 取消且 `workflow_attempts.cancelled_by` 非空、非 bot：check-run annotation "The run was canceled by @X."（ADR-040 采集） | 该 attempt 全部已执行 NPU 卡时，计入浪费，按取消者列出 |
| explicit_cancel_bot（显式取消-bot） | 同上，login 以 `[bot]` 结尾或命中 bot 清单（sglang-npu-bot、vllm-ascend-ci、metamergebot，见 provenance.bot_logins） | 同上 |
| duplicate（同 SHA 重复触发） | 同 (repo, workflow, head_sha) 的 PR-event run > 1 个；保留 created 最晚者为 keeper | 非 keeper run 的全部已执行 NPU 卡时 |
| cancelled_unknown（取消-原因未知） | 取消且无替代/合并清场/显式取消者证据；**含未采集与系统自动取消** | 不计浪费，单列 |
| 自然完成 | 新 run 开始前已结束 | 不计浪费（用户确认） |

优先级：被替代 > 合并清场 > 显式取消 > 重复；每段卡时只归一个因。

关键设计点：

- **30 分钟取消窗口**是机械签名：GitHub concurrency cancel-in-progress 在新 run 入队后秒级取消旧 run。实测 14,990 个分支推断案例中 73% 在 1 分钟内取消、93.6% 在 5 分钟内取消；超过 30 分钟的取消大多另有原因，归入 unknown。
- **PR 身份判定分级**：pr_workflow_attempts / pr_workflows 链接优先，pr_resolution_cache 按 sha 解析为辅；两者都无法解析时用同 workflow+head_branch 回退（evidence='branch'），并以"双方 PR 身份已知且不同则排除"防 fork 同名分支串判。输出中 superseded 按 evidence='pr'/'branch' 分层展示，branch 层明确标注 best-effort。
- 每段卡时只归一个因；attempt 级判定（一个取消 run 中已执行成功的 job 也计入浪费，因为整个 run 的结果已作废）。

## 证据与验证

- 窗口内 41,029 个取消 attempt 中仅 ~20% 有 PR 链接、pr_resolution_cache 仅能再覆盖 8,573 个，故必须有 branch 回退，否则 80% 场景不可判。
- 取消时间差分布（v3 快照）：pr 档 2,005/2,964、branch 档 10,962/14,990 在 1 分钟内取消，两档签名一致，互相印证。
- 2026-11-14 快照（2026-08-01→11-09，allowlist 内 PR-event NPU 卡时 529,818）：superseded 161,143 h（branch 档 156,595 / pr 档 4,548）、merge_cleanup 1,098 h、duplicate 8,270 h、cancelled_unknown 99,676 h；浪费合计 170,512 h（32.2%）。（annotation 采集前基线）
- 未知归因验证：①日级覆盖审计里 3,347/3,386 个未知 attempt 当天均有 run 观察到，日粒度无法证实缺口；②对 6 个可关联样本用 PR commits API 抽查，5 例可证明取消时无新 commit 在途（PR 无更新 commit，或新 commit 的 run 在取消后才启动），1 例 sha 被 force-push 覆盖无法判断——未知大头是真实的手动/bot/基础设施取消，而非采集缺口；③跨 workflow 并发取消仅可解释 ~9 h，可忽略。
- **取消者证据机制（ADR-040）**：GitHub run 对象无取消者字段（仅 actor/triggering_actor=push 者），但 check-run annotations 对显式取消返回 `"The run was canceled by @<login>."`，系统/并发取消返回空。前置抽样 32 run：superseded 档 4/4 无 annotation（互为印证），未知档同分支 60 分钟内均无新 sha run（0/28）。
- **2026-11-15 采集后终版**：对未知档全部 3,107 个 attempt 采集取消者 annotation（3,921 次 GitHub API，未知档覆盖率 100%；命中显式取消者 1,782 个 attempt / 72,434 h，其中 bot 71,044 h、人 1,391 h；无 annotation 1,325 个 / 27,242 h）。取消者 top：`sglang-npu-bot` 38,318 h、`github-actions[bot]` 28,537 h、`vllm-ascend-ci` 4,180 h（自动化账号，已入 bot 清单）、`metamergebot` 9 h；人类 top：fzyzcjy 731 h、HaiShaw 382 h、ch-wan 106 h。终版浪费合计 242,946 h（45.9%）；剩余 unknown 27,242 h 全部为已探测无取消者（系统/基础设施/全局并发取消），非采集缺口。采集前后同名 run 分类一致性：superseded/merge_cleanup/duplicate 档未受采集影响（优先级高于 explicit_cancel）。

## 影响

- 新增只读脚本 `npu_waste_superseded.py`（复用 npu_daily_trends 的 allowlist、resource_evidence、split_hours），输出 JSON 至 `reports/`；不调 GitHub API，不动 ETL。
- 显式取消两档依赖 ADR-040 的采集进度（`etl/scripts/collect-cancel-annotations.ts`）；报告输出 `classification_coverage.cancelled_attempts.unprobed` 展示未采集残余，引用结论时必须带上该计数——未采集不冒算为系统取消。
- 结论引用时必须带上 unknown 档和 branch 档的 best-effort 标注；浪费比例是“已观测下限+推断”混合口径，不是精确值。
- 合并清场档受 PR 链接覆盖率（~20%）限制，1,098 h 是下限；提升 PR 解析覆盖率可按比例提高该档捕获量。
- 后续若把原因账并入趋势 HTML 面板，须沿用本口径与本机械签名阈值。

## 后续约束

- 修改判定规则（keeper 选择、30 分钟阈值、证据分级）需更新本 ADR 并在 provenance.cause_rules 同步。
- 窗口、allowlist、卡时规则与趋势报告保持一致，避免两份报告口径漂移。
