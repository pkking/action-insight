# ADR-042: 统一下钻报告范围到 repos.yaml（废除 config/drilldown-workflows.yaml）

日期：2026-11-21　状态：已接受

## 背景

`etl/repos.yaml`（23 仓 / 66 workflow）是采集与报告元数据的唯一来源；`config/drilldown-workflows.yaml`（13 仓 / 16 workflow）是 NPU 钻取报告（趋势 / 浪费账 / 平台对比）的独立 allowlist。ADR-017 当年**有意**保留后者为"刻意的窄报告白名单，不是第二份 inventory"。

分离的实际代价已经兑现：

1. **16 个 workflow 双头维护**，15 个与 inventory 重叠，改名 / 迁移必须改两处。
2. **漂移实例（2026-11-21）**：上游把 `tile-ai/tilelang-mlir-ascend` 的 `base_ci.yml` 删除并把 Ascend job 迁入 `ci.yml`。repos.yaml 在 PR #299 修为 `ci.yml`，但 drilldown-workflows.yaml 仍挂着已删除的 `base_ci.yml`——NPU 趋势报告的 allowlist 与现实脱节，采集改名后报告侧无人知晓。
3. ADR-041 批次 5 给报告范围加 verl-SpeCo 时同样需要两处同步。

## 决策

1. **删除 `config/drilldown-workflows.yaml`**。NPU 钻取报告范围 = `etl/repos.yaml` 中带 `npu_drilldown: true` 的 workflow。一个文件既是采集清单也是报告范围的唯一事实来源。
2. 加载方一律从统一 inventory 过滤该标志：
   - `ci_analyze.py`：`parse_config_entries(path, drilldown_only=True)`；`--drilldown-config` CLI 与 `DEFAULT_DRILLDOWN_CONFIG` 移除。
   - `npu_daily_trends.py` / `npu_waste_superseded.py` / `npu_efficiency.py` / `npu_vs_gpu_nov.py`（--scope allowlist）：allowlist 改为 inventory 过滤。
3. **校验**（`etl/scripts/repos-config.ts` + `validate-repos.ts`）：
   - `npu_drilldown` 必须为布尔；
   - `npu_drilldown: true` 必须有 `report_name`（报告目标必须可命名）；
   - 输出汇总 `NPU drilldown: <n>`，替代"单独小文件一眼看全"的旧便利。
4. 迁移即修漂移：tilelang-mlir-ascend 的钻取范围随 job 迁至 `ci.yml`。

## 取舍

- **推翻 ADR-017 的分离决策**：当时担心报告范围被 inventory 淹没；现在用标志 + 校验汇总视图表达同一约束，而漂移风险（双维护、改名不同步）被结构性消除。
- 报告范围从"独立小文件一眼全览"变成"散在 66 个条目中的 16 个标志"：`validate:repos` 的 `NPU drilldown: 16` 汇总补回可读性；需要清单时 `grep npu_drilldown etl/repos.yaml`。
- 历史 ADR-013/017 的相关段落保留原文（快照原则），本 ADR 为准。

## 影响与约束

- 采集行为零变化：collect.ts 只读 `file`/`ref`，标志是报告侧元数据（与 report_name 同类）。
- 新增钻取目标 = 在 repos.yaml 该 workflow 条目上加 `npu_drilldown: true`（校验器要求已有 report_name）；不再是往第二个文件加条目。
- 上游改名 / 删 workflow 时只需改 repos.yaml 一处；`validate:repos:online` 会同时守住采集与报告两侧。
- UI、ETL 脚本不读已删文件，无连带改动。

## 验证

- pytest 91+5 全绿（含改造后的 drilldown 断言：16 个标志、均带 report_name、与采集清单同源）
- vitest repos-config 10 用例（新增布尔解析 + 非布尔拒绝）
- `npm run validate:repos`（离线）与 `validate:repos:online` 均通过，输出 `NPU drilldown: 16`
