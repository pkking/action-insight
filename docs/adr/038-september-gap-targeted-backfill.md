# ADR-038: 9 月采集缺口的两阶段定向补采（gap-aware targeted backfill）

**Status**: Accepted（一次性运维 campaign 已执行完毕并通过终验；预存缺陷转为后续约束）

## 背景

2026-09-17 至 2026-10-02 期间本地 CI 采集出现缺口：`sgl-project/sglang` 在整个窗口内 runs 全零，其余监控仓存在部分 UTC 日缺失。缺口根因是三个机制叠加：

1. **采集器坏时段**：9/17–10/2 期间 hourly 采集因宿主/代理问题多次停摆，缺口在窗口内持续累积；
2. **hourly 视野无法自愈**：hourly 以 `--days 3` 运行，窗口外的历史日在 `historyComplete=true` 后永不复查，缺口一旦形成便不会自我修复；
3. **`collection_state.backfill_cursor` 陈旧**：游标停在 `2026-08-10`，backfill 路径认为此前的日子均已完成，不会回补。

缺口比 handoff 最初认定的大得多。对照 GitHub API：vllm-ascend 9/17 本地仅 18 条而 GitHub 有 2,127 条；VeOmni 多日缺失（9/21=40/165、9/25=20/231、9/30=48/193）；triton-ascend 10/1=3/64。手工逐日补不可行，需要一次定向补采 campaign。

campaign 于 2026-11-09 08:28Z 启动（runner `/home/lcr/collect-cron/sept-gap-backfill-20261109.sh` v2.3），2026-11-12 05:51Z 终态 COMPLETE。期间遭遇多起环境事故，处置决策一并记录：

- 首次启动 10 分钟后主动 kill 调参（phase-1 per-attempt timeout 6h→12h；实测 listing 延迟 ~10-30s/page），08:40Z 重启；
- 代理 25 分钟断连与持续劣化：phase-1 首日 sglang 三次尝试失败（vllm-ascend 亦重试一次），11-11 段 phase-2 多轮 quota probe 连续失败、连续两轮无进展停机；
- 宿主机重启（2026-11-10 03:19Z）后 PG 容器（`restart: unless-stopped`）未随 WSL 恢复，数据库停摆约 29h，campaign 随之挂起；
- 代理彻底死亡后切直连（unset 代理变量），实测快 4-8 倍，sglang phase-1 首次成功。

## 决策

### a. 两阶段补采（runs 层 / jobs 层分离）

- **Phase 1（runs 层）**：`collect.ts --days 56 --force-full-backfill --skip-jobs`，对 5 个监控仓（sgl-project/sglang、vllm-project/vllm-ascend、ByteDance-Seed/VeOmni、triton-lang/triton-ascend、modelscope/ms-swift）顺序执行。`--force-full-backfill` 是必需的：缺口多为"部分日缺失"，恰好落在游标逻辑眼中"已完成"的日子边界内，只有强制全窗口重列才能覆盖；`--skip-jobs` 是必需的：collect.ts 的 jobs 抓取以 7 天窗口为单元，单单元耗时超出 hourly lane 的 65 分钟恢复上限，会触发无限重试并烧穿配额，jobs 推迟到 Phase 2 用更细粒度的断点处理。
- **Phase 2（jobs 层）**：`backfill-missing-jobs-gap.ts`（stock `backfill-missing-jobs.ts` 的未入库变体：+4 行 `jobs_fetched_at IS NULL` 查询过滤、空 jobs 也标记、`--max`/`--list-only`），按 day/attempt 级断点由 supervisor 轮次驱动，`eligible_missing` 单调递减至 0。

### b. fetch-once 幂等

空 jobs 的 attempt（GitHub 返回空 jobs 列表）也写入 `workflow_attempts.jobs_fetched_at`，配合查询过滤 `jobs_fetched_at IS NULL`，每轮只处理真正未抓取的 attempt，消除"每轮重烧同一批永久空 jobs"的配额浪费。`action_required`/`startup_failure` 属语义性永久空（设计排除）；后续被 GitHub 批准产生 jobs 的 run 由 hourly freshness 正常自愈。

### c. queue 指标保护（快照 → 还原 → 重建 → 双门）

1. **Phase 0**：启动前快照全部 `workflow_attempts.queue_duration_seconds` 至 `sept_gap_queue_snapshot_20261109`（147,654 行）——collect.ts 重持久化 attempt 行时会清空 queue 值（见后续约束 1 的预存缺陷）；
2. **Phase 1.5**：collect 结束后先从快照还原，再对仍缺值的行做 from-jobs 重建，仅限 `run_attempt=1`（遵 ADR-023：rerun 的 queue 语义为 NULL，不可从 jobs 重建）；
3. **双门校验**：`valued_drift=0`（快照已有值不允许漂移）且 `inconsistent_null=0`（不允许不一致 NULL），任一非零即视为失败。

### d. 配额共存（与 hourly 并行）

campaign 与 hourly 共享单 lane token-a（token-b 不受影响）：phase-1 设 `GITHUB_RATE_LIMIT_RESERVE=600`（collect.ts 在 remaining≤600 时停止派发，给 hourly 留余量）；phase-2 由 supervisor 轮询 `/rate_limit`，配额跌破外部地板 700 即 kill worker。worker 以 `setsid` 独立进程组启动，kill 面向整个进程组避免孤儿进程；`pinned_days` 在启动时钉死日历日边界，防止跨 UTC 午夜的轮次产生日历漂移。共存在 11-09 08:49Z 的 hourly 周期全绿验证（含 token-a sglang collect）。

### e. 直连 failover 与 sol 审查

代理（Windows 侧）死亡后 unset 代理环境变量直连 GitHub API，实测比代理快 4-8 倍。runner 脚本经 sol 审查四轮（1-3 轮阻断、第 4 轮有条件放行，条件 = 无 spring-DST 穿越——对 11 月一次性任务满足），累计修正 10+ 项，包括 F1 queue 清空路径、测量口径误判、进程组竞态、日历漂移等。

## 结果与验证

- **Runs 层**：11-09 段 4/5 仓 OK（sglang 失败），11-10 补采段因宿主机重启中断，直连后 11-11 段 sglang 一次通过。缺口 runs 全量补齐：终验对 14 组 workflow 做本地 vs GitHub 对照，11 组 0% 偏差，3 组差异为 GitHub `total_count=2500` 列表截断假象（列表 API 上限，非采集缺失），单日探针核对精确一致。本地 9/16–10/5 落库 runs 46,246 条（事后只读复查确认）。
- **Jobs 层**：phase-2 三段调度收敛——11-09 段 12 轮 13,328→0（终态 PARTIAL_RUNS，仅 sglang runs 缺失）；11-11 代理劣化段 sglang 五次尝试均失败（每次崩溃前已部分落库 runs，新增 ~10.6k 缺 jobs attempt），12 轮 10,623→5,892 后连续两轮无进展停机（PARTIAL_JOBS）；11-11 直连段 6 轮 10,069→0，终态 COMPLETE。
- **Queue 修复**：Phase 1.5 最终累计快照还原 42,913 行、from-jobs 重建 54,273 行（其中 39,323 行为**预存**衰减修复，见后续约束 1），双门校验 valued_drift=0 / inconsistent_null=0。修复窗口内 `run_attempt=1` 且 queue 值非空的 attempt 达 31,095 行（事后只读复查），ADR-024 报表口径的数据基础恢复。
- **共存量**：campaign 全程 hourly 周期未中断；11-09 08:49Z 周期全绿验证。
- **墙钟**：预估 20-24h，实际跨 69h（11-09 08:28Z → 11-12 05:51Z），差额来自 29h PG 停摆与代理事故；campaign 自身有效工作约 44h。

## 取舍

- **不复用 bulk campaign 基础设施（ADR-029–037）**：其 scope 锁定在 8/2–9/7 全量历史区间（sealed manifest + 生产绑定 + backup receipt pin），走 refresh→re-pin→sol 流程成本高。本次是窄窗口定向修复，复用重机制的固定开销远超收益。
- **不改仓码**：仓库工作树处于未提交状态，且本次为单次运维任务；变体脚本（`backfill-missing-jobs-gap.ts`）与 runner 均放在 collect-cron 侧（未入库），避免为一次性任务引入 PR 复杂度。代价是 delta 未进仓，必须作为后续约束回收（约束 3）。
- **`--force-full-backfill` 的代价**：全 56 天窗口重列（而非只补缺口日）换取对部分日缺失的覆盖；listing 为延迟瓶颈（~5-8 req/min）而非配额瓶颈，代价可接受。
- **接受中间态 PARTIAL**：runner 幂等可重启（flock 单实例锁），PARTIAL_RUNS/PARTIAL_JOBS 状态由后续轮次收敛，不为单轮失败扩大重试爆炸半径。

## 影响范围

- **数据库**：5 仓 runs/workflow_attempts/workflow_jobs 在 ~9/14–10/5 窗口内补齐与修复；`collection_state.backfill_cursor` 刷新；快照表 `sept_gap_queue_snapshot_20261109` 保留至终验通过，可安全 DROP。
- **hourly 采集器**：零改动，仅共享 token-a lane；配额护栏（reserve 600 / floor 700）保证共存。
- **报表**：9 月统计总量上修约 +20%（原 4,548 → ~5,500 h/天）；sglang 10/1–2 需合入十月 Merge CI；npu daily trends、October Merge CI 等 ADR-024 口径报表需基于修复后数据重新生成。
- **仓库代码**：本次零变更（所有 delta 在 collect-cron 侧，见约束 3）。

## 后续约束与遗留缺陷（已发现、未在本次修复）

1. **hourly queue 衰减 bug（仓码缺陷，优先修）**：hourly 对 changed-window 中 cached-fresh runs 重持久化时，jobs 未在内存中重新 hydrate，`queue_duration_seconds` 被清 NULL。实测近期仅 5-15% 的有 jobs attempt 带 queue 值，10/21–25 ≈ 0%。campaign Phase 1.5 只修复了 5 个监控仓（39,323 行），其余 10 仓仍受影响。正解是仓码修复（persist 路径保留 queue，或 hydrate 时合并回填）+ 测试 + PR；在此之前，任何重跑 collect 的窗口都需要同类快照保护。
2. **PG 容器重启策略**：`restart: unless-stopped` 未能扛住 WSL 重启（11-10 宿主机重启后停摆 29h），需改为 `restart: always`。
3. **`backfill-missing-jobs-gap.ts` delta 合入 stock**：fetch-once 标记、`jobs_fetched_at IS NULL` 过滤、`--max`/`--list-only` 应以 flag 形式合入 `backfill-missing-jobs.ts`，消除未入库变体。
4. **hourly 单点代理依赖**：需直连回退或代理健康监控，避免代理死亡导致采集静默停摆。

## 参考

- ADR-023：rerun attempt 的 queue=NULL 语义（from-jobs 重建仅限 `run_attempt=1` 的依据）。
- ADR-024：报表证据与覆盖口径（修复后数据的消费方；9 月总量上修后报表重生成的依据）。
- ADR-029–037：全量历史 bulk ingestion 基础设施（本次不复用的对象与原因）。
- 运行审计（campaign 全程事实源）：`/home/lcr/collect-cron/logs/sept-gap/STATUS.md`、`master.log`（含各段 preflight 基线、phase-1.5 校验门值与终态 status）。
