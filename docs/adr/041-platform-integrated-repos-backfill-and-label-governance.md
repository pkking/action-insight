# ADR-041: 平台集成仓库补采与标签治理扩展（9 仓库采集 + allowlist + 标签家族 + 对账）

日期：2026-11-20　状态：方案已接受（待实施 PR）

## 背景

Ascend GHA Runners 平台集成清单（https://ascend-gha-runners.github.io/docs/Repo/，2026-11-20 核对，共 22 个仓库）与本地库（docker `action-insight-postgres-1:5433`，采集持续入库）的对照发现三块缺口：

1. **采集缺口**：本地只采了 13 个，9 个未采集（sgl-project/sgl-kernel-npu、vllm-ascend/vllm-ascend-recipes、XPU-Forces/mojo_opset、verl-project/uni-agent、verl-project/verl-omni、vllm-project/vllm-omni、Ascend/sglang、fla-org/flash-linear-attention、Ascend/cann-container-image）。
2. **报告范围缺口**：`verl-project/verl-SpeCo` 本地已有数据（2026-11 月 PR-event NPU 卡时 1,313，全部事件 1,504），但不在 `config/drilldown-workflows.yaml` allowlist，从未进过趋势报告（npu_daily_trends / npu_waste_superseded / npu_efficiency 均以 allowlist 为范围）。
3. **标签治理缺口**：若干带 NPU/GPU 证据的 runner 标签家族无法折算卡数。平台对比报告（`reports/ascend-platform-npu-gpu-nov-2026.html`，快照 2026-11-20T13:37Z）中 11 月"未知卡数"规模：sglang 16,021 jobs、vllm-ascend 11,173、Ascend/pytorch 1,432（NPU）；tilelang 934、AReaL 20（GPU）。

现有治理资产：`.agents/skills/ci-effective-report/scripts/runner_resource_evidence.py`（scoped 约定层 + 通用层 `LABEL_RE`/`AMD64_A5_LABEL_RE` + `MODEL` 清单 + `NPU_HINT`/`CPU`/`GPU` 正则）、`scripts/card_quantity.py`（A3 die→卡换算：A3 族 N/2，A2/A5/310P 族 N=卡；`RULE_VERSION='governed-runner-v5-user-confirmed-card-units'`）。ETL 入口：`etl/repos.yaml`（分析目标唯一来源，AGENTS.md/ADR-017）+ `etl/scripts/collect.ts`。本地常驻采集：`/home/lcr/collect-cron/hourly.sh` systemd timer 每小时对 repos.yaml 全部仓库跑 `collect.ts --days 3`（双 token lane）+ `rebuild-pr-artifacts`。

### 规划期新增实证（2026-11-20，只读探针 + 本地库，可直接引用）

以下事实在本 ADR 规划时实测确认，实施时只需复核不必重做：

**A. `npu_vs_gpu_nov.py` 漏传 workflow，scoped 约定全部失效（重大）**：该脚本的 SQL 未 select `workflow_file`，`resource_evidence(r)` 收到的 `workflow=None` → 所有 scoped 约定（sglang pr-test-npu、vllm-ascend pr_test、triton-ascend/tilelang 的 amd64-a5）从不触发。其余报告脚本（npu_daily_trends / npu_efficiency / npu_waste_superseded）均正确传递 workflow，**只有此脚本有此缺陷**。用本地库复算（11-01→11-20，同证据规则、传 vs 不传 workflow）：

| repo | NPU卡时(PR) 修复前 | 修复后 | NPU jobs 修复前 | 修复后 | 未知卡数 修复前 | 修复后 |
|---|---|---|---|---|---|---|
| sgl-project/sglang | 5,739 | **18,388** | 9,148 | 24,863 | 16,036 | **321** |
| vllm-project/vllm-ascend | 16,557 | **22,734** | 21,095 | 30,427 | 11,173 | **1,841** |
| ascend/pytorch | 0 | 0（需新规则，见决策 3） | 28 | 28 | 1,432 | 1,432 |
| verl-project/verl | 1,368 | 1,368 | 689 | 689 | 21 | 21 |
| 其余 8 仓 | 不变 | 不变 | | | | |

即：13 仓合计 NPU PR 卡时将从 27,075 重定基线到 ≈**45,900**（+70%），NPU 未知卡数 jobs 从 28,647 降到 **3,615**。这是分类修复（口径修正），不是数据变化，必须先于任何新采集结论完成并单独说明。

**B. 9 仓库的 workflow 清单与 11 月 run 数（workflows API + total_count 探针，排除 `dynamic/*` 伪条目）**：

| repo | 加速器相关 workflow（11 月 run 数，2026-11-20） | 已核验标签 |
|---|---|---|
| sgl-project/sgl-kernel-npu | pr-test-kernels.yml(847)、pr-test-deepep-npu.yml(255)、daily-test-kernels.yml(146)、daily-build-test.yml(22)、pr-test-mega-moe.yml(4)、kernel-coverage.yml(5)、kernel-coverage-pr-smoke.yml(6)；pr-test-kernels-small/internode/multi_node/test-a3-runner-labels 均 0 | pr-test-kernels 抽样：`linux-aarch64-a3-800t-2`、`linux-amd64-a5-1`（真 NPU） |
| vllm-ascend/vllm-ascend-recipes | pr-recipe-verify.yml(171)、recipe-e2e.yml(43)、nightly-recipe-verify.yml(44)、verify_multi_node.yaml(19)；recipe_verify_multi_node 0 | 平台探针：`a2b4-8`、`a3-800i-recipes-fed-16`、`a5-8` |
| XPU-Forces/mojo_opset | npu-910b.yml(76)、ascend-a2-smoke.yml(4)、ascend-a3-smoke.yml(4)、fa-b3-debug.yml(1)；**npu-910b 8-10 月为 0（11 月才启动）** | 平台探针：`a2-mojo-fed-1/2/4/8` |
| verl-project/uni-agent | ci-npu.yml(230)、ci-gpu.yml(230)；ci-cpu.yml(230) 纯 CPU 不采 | 平台探针：`a2-8`（NPU）+ `uv_cu130_dev5`（GPU 8×L20） |
| verl-project/verl-omni | npu_smoke.yml(204)、gpu_smoke.yml(204)、l3_nightly.yml(180)；cpu_unit_tests(205) 纯 CPU 不采 | 平台探针：`uv_cu130`（GPU） |
| vllm-project/vllm-omni | build_wheel.yml(2,500)、recipes.yml(86)；comfyui/hunyuan/python_cpu_smoke 均 0。**抽样实测两者均 `ubuntu-latest`：11 月全量 CPU-only** | `ubuntu-latest`（实证） |
| Ascend/sglang | full-test-npu.yml(131)、pr-test-npu.yml(4)；pr-test.yml(293) 与 pr-test-extra.yml(293) 抽样 `ubuntu-latest`（CPU）；cp-test/multi-node-test/nightly-test-npu-* 11 月均 0 | full-test-npu 抽样：`a3-16/-2/-4/-8`、`a3-800i-4`、`a3-800t-2/-4/-8/-16`（真 NPU） |
| fla-org/flash-linear-attention | **双栈**：ascend-a2-ci.yml(607)、ascend-a2-benchmark-ci.yml(537)、agent-ascend-a2-tests.yml(95)、agent-ascend-a5-tests.yml(8) + nvidia-h100.yml(461)、nvidia-h100-smoke.yml(356)、agent-h100-tests.yml(113) | 平台探针：`nvidia-h100-1`；Ascend 侧工作流名实证 |
| Ascend/cann-container-image | build_cann.yml(2)、batch_build_and_push_cann.yml(1)；tools-tests 等 0。容器镜像构建，11 月共 18 runs | 未见加速器标签 |

**C. fla-org 不是纯 GPU**：上一轮平台探针只抽到 `nvidia-h100-1`，但 workflows API 实证存在 4 个 Ascend A2/A5 CI（11 月合计 1,247 runs），必须双栈采集；**vllm-omni 反向确认纯 CPU**（2,500+86 runs 全 `ubuntu-latest`）；**Ascend/sglang 的 NPU 工作流体量很小**（11 月 ~135 runs，仓库总量 ≥2,500 大头是 CPU/docker 工作流）。

**D. 本地库 11 月标签家族分布（completed 非 skipped，只读复算）**——未知卡数的真实构成：

| 家族 | 样例标签 | 规模（repo / jobs） | 现状 |
|---|---|---|---|
| `<model>-<N>-<host>` 主机后缀 | `linux-aarch64-a3-800i-8-cn12-001`、`-2-cn12-001` | ascend/pytorch 997+448=1,445；vllm-ascend `a2b1b3-1-hk-001` pr_test.yaml 9,754（scoped 已治，仅平台脚本漏传未生效） | 不匹配 LABEL_RE → quantity_unknown |
| `-fed-<N>`（含仓名中缀） | `a3-800i-fed-2/4/16`、`a2-fed-1/2`、`a2b1/a2b3/a2b1b3/a2b4-fed-2`、`a3-sglang-fed-*`、`a3-800i-verl-fed-16` | vllm-ascend ~434、verl ~30、sglang ~42 | quantity_unknown / unsupported_scoped_label |
| `-mojo-fed-<N>` | `a2-mojo-fed-1/2/4/8` | mojo_opset（未采集，平台探针） | 采集后同样落入未知 |
| `a2b4` 型号缺失 | `a2b4-8`（recipes）、`a2b4-fed-2`（vllm-ascend 8 jobs） | recipes 未采集 | **MODEL 正则无 a2b4 → hardware_unknown（连 NPU 类都不进）** |
| `N=0` 零卡标签 | `a3-800t-0`(1,092)、`a2b3-0`(315) | vllm-ascend nightly | `[1-9]\d*` 不含 0 → quantity_unknown |
| GPU 带卡数 | `nvidia-h100-1` | fla-org（未采集） | NVIDIA_HINT 只判 kind，不折卡 |
| GPU 机型即卡数 | `gcp-a2-highgpu-2g-run-...` | AReaL 20 | 无卡数规则（**实证后缀 `2g` = 2×A100，GCP 机型命名即卡数**） |
| GPU 无卡数 | `self-hosted, nvidia` | tilelang 883 | 只能靠 static_resources（ADR-017） |

**E. a2b4 / recipes-fed 的卡数语义证据（矛盾，必须实证）**：vllm-ascend-recipes 仓库 `.github/verification-targets.yaml`（2026-11-20 读取）显示 `a2b4-2` ↔ "Single Node **Single Card**"（3 个 recipe）、`a2b4-8` ↔ "Multi Card"、`a2b4-1` ↔ "1P1D (1 Prefill + 1 Decode)"、`a3-800i-recipes-fed-16` ↔ "Multi Card"（A3）。这强烈暗示 **a2b4 家族后缀 N 计的是 die（2 die = 1 张 300I Duo 卡）**——与 ADR-024 用户确认的"A2 变体后缀 = 物理卡"（a2b1-1-hk-001 = 1 卡）**相矛盾**。在 job 日志实证前，两族一律不折卡（保守原则）。

**F. collect.ts 与常驻采集的机制事实（读代码确认）**：
- CLI 只有 `--repo`、`--days N`（最近 N 天）、`--force-full-backfill/--full`、`--reverse/--forward`、`--skip-jobs`、`--help`；**没有 `--from/--to`**。jobs+steps 随 jobs 端点一次抓取（steps 内联在 job payload 里，自适应分页 per_page=100→30→10→1）。
- 窗口机制：7 天一窗；`--days N` 时 `oldest = now - N`；runs 列表 per_page=100，单查询 1000 条封顶后自动裂窗；jobs 每个 run attempt 1 次调用（>100 jobs 的 run 翻页）。
- 幂等与事务：每窗一个事务（`BEGIN → runs upsert(ON CONFLICT id) → attempts upsert → collection_state upsert → COMMIT`，异常 ROLLBACK）；重跑靠 ETag validator（recent 窗 304 跳过）与 cached-attempt 新鲜度（stepPolicyHash 一致且 updatedAt 更新则跳过 jobs 重抓）；**collect.ts 无任何 DELETE**，retention 只裁剪 state 索引不删行。
- token：collect.ts 用 `resolveGitHubTokens()`（gh-token.txt + `gh auth` + GITHUB_TOKEN），**没有 per-repo token 机制**（那是 rebuild-pr-artifacts.ts 专属）；多 token 去重身份后形成多 lane，每 lane 独立预算（`RATE_LIMIT_RESERVE` 默认 10）。本地 hourly cron 双 lane：lcrpkking + pkking，合计 ~10k/h。
- **3 天游标陷阱（新仓首次补采必读）**：hourly cron 先对新仓跑 `--days 3` 会把 `backfill_cursor` 锚定在最近 3 天；之后再跑 `--days 20` 只会从 cursor 补到 latest，**11-01～cursor-1 永远不会采**。新仓补采必须带 `--force-full-backfill`（从 `now-N` 重建全窗，幂等、无删除），或先手动补采再让 hourly 接管增量。
- **RETENTION_DAYS 陷阱（Aug 补采必读）**：retentionStart(90d)=今天-90 天 ≈ 08-22，覆盖不到趋势窗口起点 08-01；且 state 索引按 RETENTION_DAYS 裁剪后 `historyComplete` 重算为 false、cursor 回退，会让后续常规运行反复重列最老窗口。Aug-Nov 补采须一次性 `RETENTION_DAYS=120 npx tsx etl/scripts/collect.ts --repo X --days 112 --force-full-backfill`；rows 落库后不会被常规 90d 运行删除（无 DELETE），报告直读 runs/jobs 表。

## 目标与非目标

**目标**：
1. 把 9 个平台集成仓库纳入本地采集（含验证过的 workflow 选择），使平台对比（npu_vs_gpu_nov.py --scope integrated）从"—"变实测数字。
2. verl-SpeCo 进入趋势报告 allowlist；为其余新仓给出"是否进 allowlist"的可复核判据，控制范围膨胀。
3. 治理 4 个 NPU + 2 个 GPU 标签家族（含规划中新发现的 `N=0`、跨仓 `-fed-` 家族），每条规则有核验命令与证据链，未核验不折卡。
4. 修复 npu_vs_gpu_nov.py 的 workflow 漏传缺陷，先重定基线再谈增量。
5. 全程预算可控、幂等可续，符合 AGENTS.md 成本意识。

**非目标**：
- 不改 collect.ts 主流程与 pg/schema.sql（本方案纯配置 + 报告脚本治理 + 一次性运维采集）。
- 不消除"未知"档：无卡数证据的标签保持 quantity_unknown，绝不冒算（ADR-024 Known/Estimated/Unknown 三态约束）。
- 不把 9 仓默认塞进效率/月报（不加 report_name，见决策 2.3）。
- 不在本 PR 内做 pr_metrics 的 Aug-Nov 全量重建（rebuild 由 hourly 3 天窗口自然跟进，平台对比与趋势报告均直读 runs/jobs，不依赖 pr_metrics）。

## 决策

### 1. 采集扩展

#### 1.1 repos.yaml schema 语义（现状）

`etl/repos.yaml` 是仓库/workflow 唯一清单（ADR-017）：`repo` + `workflows[{file, ref?, steps_min_workflow_duration_seconds?}]`（file 必须是 basename，`WORKFLOW_FILE_PATTERN` 校验）+ repo 级/defaults 级 `steps_min_workflow_duration_seconds`（现有默认 600s）。报告侧字段 `report_name`/`comparison_name`/`comparison_group`/`static_resources`/`resource_pools` 由 ci_analyze.py 等消费，**采集只看 repo + workflows[].file**；列出 workflows 即"只采这些 workflow"（`trackedWorkflowIds`），jobs 只为 tracked runs 抓取。`validate-repos.ts` 要求每仓至少 1 个 workflow（`requireWorkflows: true`），CI（etl-validate.yml）以 `npm run validate:repos:online` 对 GitHub 实时校验 file 存在性——**所以新增条目的 file 名必须先核实再落盘，CI 会兜底**。

#### 1.2 新仓库 workflow 入选判据与核实命令

判据（按序）：
1. `state=active` 且非 `dynamic/*`（伪 workflow）。
2. **加速器证据**：名称含 ascend/npu/a2/a3/a5/910/nvidia/h100/gpu 等关键词是候选信号，但**必须抽样 runs→jobs 的 labels 实证**（名称不是硬件证据，ADR-024 第 4 条）；CPU 工作流（`ubuntu-latest`/`linux-*-cpu-*`）排除——包括名为 NPU 实为 CPU 的（Ascend/sglang 的 pr-test.yml、pr-test-extra.yml 实证 `ubuntu-latest`）。
3. 优先收录 PR-event 驱动 + nightly/schedule 的主 CI；debug/一次性工作流只在有加速器证据且成本低时收（每条 ≈1 次列表 + runs 数次调用）。

核实命令（实施时逐仓执行，2026-11-20 已执行过一轮，结果见背景 B）：

```bash
# ① workflow 清单（排除 dynamic/*）
gh api "repos/<owner>/<repo>/actions/workflows?per_page=100" --paginate \
  --jq '.workflows[] | select(.state=="active") | [.path, .name] | @tsv'

# ② 候选 workflow 的 11 月 run 数（total_count 元数据，1 调用/工作流）
gh api "repos/<owner>/<repo>/actions/workflows/<file>/runs?per_page=1&created=2026-11-01..2026-11-30" --jq '.total_count'

# ③ 标签实证：抽 2-3 个 run 的 jobs labels
gh api "repos/<owner>/<repo>/actions/workflows/<file>/runs?per_page=3&created=2026-11-10..2026-11-20" \
  --jq '.workflow_runs[].id' | while read id; do
  gh api "repos/<owner>/<repo>/actions/runs/$id/jobs?per_page=30" --jq '[.jobs[].labels] | flatten | unique'
done

# ④ 落盘后 CI 前自检
npm run validate:repos            # 本地 schema
npm run validate:repos:online     # 对 GitHub 实时校验 file 存在（= CI etl-validate.yml 行为）
```

#### 1.3 推荐新增条目（file 名已按上法核实，实施时复核一次）

```yaml
# --- ADR-041: 平台集成仓库采集扩展（labels 已抽样核实，2026-11-20）---
- repo: sgl-project/sgl-kernel-npu
  workflows:
  - file: pr-test-kernels.yml
  - file: pr-test-deepep-npu.yml
  - file: daily-test-kernels.yml
  - file: daily-build-test.yml
  - file: pr-test-mega-moe.yml            # 4 runs/11月，mega-moe 专用
  - file: kernel-coverage.yml             # 5 runs/11月
  - file: kernel-coverage-pr-smoke.yml    # 6 runs/11月
  # 不采：lint.yml(957, CPU)、slash-cmd-gate(121)、push_build_cache(83)、
  #        agentic*(53)、build_and_release(56)、kernel_coverage(0)、release_test(0)
- repo: vllm-ascend/vllm-ascend-recipes
  workflows:
  - file: pr-recipe-verify.yml
  - file: recipe-e2e.yml
  - file: nightly-recipe-verify.yml
  - file: verify_multi_node.yaml
- repo: XPU-Forces/mojo_opset
  workflows:
  - file: npu-910b.yml
  - file: ascend-a2-smoke.yml
  - file: ascend-a3-smoke.yml
  # fa-b3-debug.yml(1 run)/triton-version-debug.yml 可选，暂不采
- repo: verl-project/uni-agent
  workflows:
  - file: ci-npu.yml
  - file: ci-gpu.yml
  # ci-cpu.yml(230, CPU)、check-pr-title(433)、secrets-scan(252)、pre-commit(256) 等不采
- repo: verl-project/verl-omni
  workflows:
  - file: npu_smoke.yml
  - file: gpu_smoke.yml
  - file: l3_nightly.yml
  # cpu_unit_tests(205, CPU)、sanity/pre-commit/check-pr-title 等不采
- repo: Ascend/sglang
  workflows:
  - file: full-test-npu.yml
  - file: pr-test-npu.yml                # 4 runs/11月，保留以便后续激活
  # pr-test.yml / pr-test-extra.yml 实证 ubuntu-latest(CPU)；cp-test/nightly-test-npu-* 11月 0 runs，
  # 激活后按 1.2 判据补
- repo: fla-org/flash-linear-attention
  workflows:
  - file: ascend-a2-ci.yml
  - file: ascend-a2-benchmark-ci.yml
  - file: agent-ascend-a2-tests.yml
  - file: agent-ascend-a5-tests.yml       # 8 runs/11月
  - file: nvidia-h100.yml
  - file: nvidia-h100-smoke.yml
  - file: agent-h100-tests.yml
  # ascend-a5-ci.yml(0 runs/11月) 可选暂缓
- repo: Ascend/cann-container-image
  workflows:
  - file: build_cann.yml
  - file: batch_build_and_push_cann.yml
  # build_and_push_cann.yml / tools-tests.yml 0 runs，暂缓
# vllm-project/vllm-omni：缓采，见 1.4
```

以上条目**均不设 report_name / comparison_group**（理由见 2.3）。verl-SpeCo 现有条目已含 `npu_vllm_unit_tests.yml`，无需改（11 月 112 runs 与本地 563 runs 吻合）；可选加 `sglang_npu_unit_tests.yml`（11 月 0 runs，零成本占位，其 NPU 工作流身份由名称+后续抽样确认后再加，**默认不加**）。

#### 1.4 vllm-omni 缓采决策

实证（2026-11-20）：11 月 2,586 runs（build_wheel 2,500 + recipes 86）**全部 `ubuntu-latest`**，无任何加速器标签；其余工作流 11 月 0 runs。结论：**暂不加入 repos.yaml**（省 ~2,600 次调用，约半小时双 lane），平台报告保留 `local_data=false` 并把 `INTEGRATED_PROBE_20261120` 的该条目补注 `cpu_only_verified: true`（build_wheel/recipes 抽样标签留档）。若平台侧后续给 vllm-omni 接入 NPU runner（关注 `runs_on` 状态变化），按 1.2 判据重评。此为预算取舍而非范围裁剪——平台清单覆盖率以"有加速器证据的仓 100% 采集"为准。

#### 1.5 采集顺序与预算（11 月窗口）

调用量模型：`runs 列表页数（≈ runs/100，按 7 天窗分摊，每 workflow×窗 ≥1 页） + jobs 1 次/run（>100 jobs 的 run 翻页，+10% 余量）`。11-20 执行时用 `--days 20`（覆盖 11-01→当天），11-21～30 的新 runs 由 hourly cron `--days 3` 自然补齐，月末 11-30 再跑一次 `--days 30` 收口全月。

| 批次 | 仓库 | 11 月 runs（tracked） | 预计调用 | 单 lane 墙钟(5k/h) |
|---|---|---|---|---|
| 1a | sgl-kernel-npu | 1,285 | ~1,300 | ~16 min |
| 1b | vllm-ascend-recipes | 277 | ~290 | ~4 min |
| 1c | verl-omni | 588 | ~600 | ~7 min |
| 1d | uni-agent | 460 | ~470 | ~6 min |
| 1e | mojo_opset | 85 | ~95 | ~1 min |
| 1f | Ascend/sglang | 135 | ~150 | ~2 min |
| 2 | fla-org（双栈） | 2,177 | ~2,190 | ~26 min |
| 3 | cann-container-image | 3 | ~10 | <1 min |
| 合计 | 8 仓 | 4,735 | **~5,100** | ~61 min（双 lane ~31 min） |

对照：若不缓采 vllm-omni 则 +~2,600 调用（≈7,700 总量，背景中"9 仓 ≈17k runs"的全量口径是按 repo 级 ≥2,500 封顶估计的未筛选上限；tracked 筛掉 CPU 工作流后大幅缩小）。

**顺序理由**：批次 1 全部是"活跃 NPU 优先"（sgl-kernel-npu 最大、recipes/verl-omni/uni-agent 是清单里 runs/标签密度最高的 NPU 消耗方）+ 两个小仓顺手；批次 2 fla-org 量大且 GPU 侧对 NPU 治理无信息增量，放后单独跑；批次 3 收尾。

#### 1.6 只采 11 月 vs 补 Aug-Nov（趋势口径）

- **平台对比报告**（npu_vs_gpu_nov.py）窗口就是 11 月 → 8 仓只需 11 月窗口（`--days 20/30`）。
- **趋势报告**（npu_daily_trends.py）固定窗口 **2026-08-01 → 2026-11-09**，且以 allowlist 为范围。只有**决定进 allowlist 的仓库**（见 2.2 判据）才需要 Aug-Nov 补采，用 `RETENTION_DAYS=120 ... --days 112 --force-full-backfill`（背景 F 的 RETENTION 陷阱）。8-10 月已探 run 数（同 1.2 命令换 created 窗口）：sgl-kernel-npu 1,676、verl-omni 2,024、Ascend/sglang full-test-npu 966、uni-agent 369、recipes 489、mojo_opset 0（11 月才启动，无需 Aug）、fla-org 单工作流即触顶 2,500（全仓 Aug-Nov 估 ≥10k runs，**最贵，须先看 11 月 NPU 数字再决定**）。
- 预算：除 fla-org 外 6 仓 Aug-Nov ≈ 5,700 runs ≈ **~5,800 调用**（≈70 min 单 lane）；fla-org 视判据单独评估（估 ~10,000 调用，双 lane ~1h）。

（补 collection_state 注记：`/home/lcr/collect-cron/hourly.sh` 直接 `grep` **工作树**里的 `etl/repos.yaml`，因此改动一落盘（即使未 commit）下个整点 hourly 就会开始采集新仓——首次全量补采要么抢在整点前，要么临时用 hourly.sh 既有的 `EXCLUDE_REPOS` 屏蔽，要么接受 hourly 先采 3 天、再用 `--force-full-backfill` 重建全窗（幂等，无副作用）。）

#### 1.7 token 取舍

collect.ts 无 per-repo token（背景 F）；本地双 lane（gh-token.txt=lcrpkking、collect-cron/token-b.txt=pkking）合计 ~10k/h。单仓补采命令（带双 lane + 直连 fallback 常识，代理异常时 unset 代理变量，ADR-038 实测直连快 4-8 倍）：

```bash
export PG_DATABASE_URL='postgresql://action_insight:action_insight@localhost:5433/action_insight'
# 单 lane：
GITHUB_TOKEN_FILE=gh-token.txt GH_CONFIG_DIR=/nonexistent \
  npx tsx etl/scripts/collect.ts --repo sgl-project/sgl-kernel-npu --days 20 --force-full-backfill
# 双 lane（GITHUB_TOKEN_FILE 与 GITHUB_TOKEN 两个来源会合并成两个身份 lane）：
GITHUB_TOKEN_FILE=gh-token.txt GITHUB_TOKEN="$(cat /home/lcr/collect-cron/token-b.txt)" GH_CONFIG_DIR=/nonexistent \
  npx tsx etl/scripts/collect.ts --repo verl-project/verl-omni --days 20 --force-full-backfill
```

与 hourly 共存：补采与 hourly 同用 token-a 时可设 `GITHUB_RATE_LIMIT_RESERVE=600`（ADR-038 的共存模式：预算剩 600 即停，剩余下一轮续）；hourly 每仓 `timeout 25min`、双 attempt，新仓 11 月单窗量级都在时限内。

**重要**：新仓加入 repos.yaml 后 hourly 立即自动接管（`grep repos.yaml`），其 `--days 3` 会先跑——这正好说明为什么**首次全量补采要抢在下一个整点前执行，且必须带 `--force-full-backfill`**（背景 F 游标陷阱）；若想让某仓暂不进 hourly，用 hourly.sh 既有的 `EXCLUDE_REPOS` 环境变量。

### 2. allowlist 扩展（config/drilldown-workflows.yaml）

#### 2.1 verl-SpeCo（必加）

workflow file 已核实（本地库 563 runs 全部为 `npu_vllm_unit_tests.yml`，上游该工作流 11 月 112 runs、active；`sglang_npu_unit_tests.yml` 11 月 0 runs 不加）：

```yaml
  - repo: verl-project/verl-SpeCo
    workflows:
      - name: npu_vllm_unit_tests
        file: npu_vllm_unit_tests.yml
```

verl-SpeCo 首个 run 2026-07-30，趋势窗口（08-01→11-09）全程有数据，加入后趋势报告立即多一个 11 月 PR NPU 卡时 ~1,300 的成员（与 verl 主仓 1,368 同量级），无需任何补采。

#### 2.2 新仓库是否进 allowlist 的判据

**范围区分**：`npu_vs_gpu_nov.py --scope integrated` 独立读取平台清单，**不依赖 allowlist** → 平台对比不需要动 allowlist。allowlist 影响的是**趋势报告 + 浪费账（npu_waste_superseded）+ 下钻 HTML（ci_analyze --drilldown-config）**，这三个都以 allowlist 为边界，范围膨胀会直接推高每期报告的生成成本与解读负担。

判据（按 11 月采集后的实测数字决定，二选一即入）：
1. **NPU PR 卡时 ≥ 500**（趋势报告的量级门槛，与现有成员 verl 1,368 / triton-ascend 1,204 / verl-SpeCo 1,313 对齐，过滤纯 GPU 仓与噪声仓）；
2. **NPU PR jobs ≥ 500 且 label 治理后可折卡率 ≥ 80%**（规模意义明确但卡时偏低的长尾仓，需治理后复核）。

预估（11 月探针外推）：sgl-kernel-npu、vllm-ascend-recipes、verl-omni、uni-agent、Ascend/sglang 大概率过线；mojo_opset（95 runs）不过线不进；fla-org 看 Ascend 侧折卡后数字（a2-ci 607 runs，若过线进，其 Aug-Nov 补采 ~10k 调用的成本要在验收时单独核准）；cann-container-image 不过线不进。

#### 2.3 范围膨胀控制（三条硬约束）

1. **新仓条目不设 report_name**：ADR-017 明确"无 report_name 不进标准效率报告"，采集清单加宽不等于报告范围加宽。
2. **allowlist 只加过 2.2 判据的仓**，且逐仓在 PR 描述中给出实测数字；禁止"清单对齐"式批量加入。
3. **平台对比走 --scope integrated**，永不靠改 allowlist 来对齐平台清单。

### 3. 标签治理

#### 3.0 前置修复：npu_vs_gpu_nov.py 补 workflow（批次 0）

SQL 加一列并传入证据函数（与其余三个报告脚本对齐）：

```python
# 查询里增加：
SELECT %s AS repo, r.event, ...,
  COALESCE(r.workflow_file, regexp_replace(r.workflow_path, '^.*/', '')) AS workflow, ...
```

`resource_evidence(r)` 即自动收到 `r['workflow']`。不新增测试文件之外的用例（该脚本无独立 pytest；修复语义由 3.5 的家族用例与重跑对账覆盖），但要在脚本 provenance.definitions 里注明"scoped conventions now applied (same as trend report)"。**修复后先重跑平台报告并留档新旧对照**（背景 A 表），这是后续一切"未知卡数下降"声明的基线。

#### 3.1 NPU 家族规则设计

| # | 家族 | 提议层级 | 规则形态 | 卡数语义与核验 | 未核验时的落点 |
|---|---|---|---|---|---|
| 1 | `<model>-<N>-<host>`（cn12-001 / hk-001） | **通用层**（跨仓：ascend/pytorch、vllm-ascend、未来仓） | LABEL_RE 增加可选 host 尾组：`^(linux-aarch64-MODEL)-([1-9]\d*)(?:-(cards?\|dies?))?-(?:[a-z0-9]+-[0-9]{3})?$`；host 段仅匹配 `[a-z0-9]+-ddd` 形态（cn12-001/hk-001），不吞 fed/memclean 等词尾 | a2b1b3-1-hk-001=1 卡已被 scoped+用户确认；**a3-800i-8-cn12-001 的 8 未知是 die 还是卡**，须 job 日志核验（命令见下） | a3 族保持 quantity_unknown（a2b1/a2b1b3 等 CARD 家族可先行，因 1 卡结论已有 ADR-024 依据） |
| 2 | `-fed-<N>`（含仓名中缀 `-<x>-fed-`） | **通用层**（实证跨 5 仓：vllm-ascend/sglang/verl/recipes/mojo_opset） | 新正则 `FED_RE = ^linux-aarch64-(MODEL)-[a-z0-9-]*fed-([1-9]\d*)$`，命中后 N 的单位**继承模型族既有语义**（a3 族 die→÷2，a2/a2b/310p/a5 族卡） | 每**模型族**各抽 1-2 个 job 日志核验（a3-800i-fed-16 若 npu-smi 显示 8 卡 → die 语义确认；a2-fed-1 若显示 1 卡 → 卡语义确认） | 整族 quantity_unknown；只把 `hardware_unknown` 升级为 `npu+未知卡数`（先让 KIND 正确认 NPU） |
| 3 | `-mojo-fed-<N>` | 并入 #2（`[a-z0-9-]*fed-` 覆盖 mojo-fed） | 同上 | mojo_opset 采集后抽 ascend-a2-smoke.yml 的 job 日志数卡 | 同上 |
| 4 | `a2b4` 型号 | **通用层 MODEL 清单**（加 `a2b4` 到 MODEL 与 CARD/A3 判定的族清单候选） | MODEL 正则加 `a2b4`；**card_quantity.py 是否把它放 CARD_MODELS 还是新 A2B4_DIE_MODELS 待实证**（背景 E：a2b4-2 ↔ Single Card，疑似 die 语义，与 ADR-024 A2=卡矛盾） | verification-targets.yaml 映射已留档；再抽 recipes 的 a2b4-2 / a2b4-8 job 日志（npu-smi / ASCEND_RT_VISIBLE_DEVICES 计数）终判 | NPU kind 认定 + quantity_unknown（从 hardware_unknown 升级，进步但冒零风险） |
| 5 | `N=0`（a3-800t-0 / a2b3-0） | **通用层**（若核验成立） | LABEL_RE 的 N 组放宽到 `[0-9]+`，0 值单独分支 | 假设是“NPU 宿主机无卡槽位（构建/打包 job）”；核验：抽 nightly_a3 的 a3-800t-0 job 日志找 npu-smi 空输出 / workflow 源码 runs-on 上下文 | 保持 quantity_unknown；**绝不把 0 当作“免费”折算进卡时** |
| 5b | `a3-(N)-` 尾横线（sglang nightly-test-npu.yml，259 jobs） | **scoped 层扩展**（同仓同标签，语义已被用户确认过） | 把现有 `(sgl-project/sglang, pr-test-npu.yml)` scoped 约定的作用域**并列扩展**到 `(sgl-project/sglang, nightly-test-npu.yml)`，模式不变 `linux-aarch64-a3-(2\|4\|8\|16)-` | 与 pr-test-npu.yml 完全同形同义（ADR-024 已确认 a3 尾横线 N=die），无需新核验，扩条 scoped case 即可 | 未扩展前保持 quantity_unknown |
| 6 | GPU：`nvidia-h100-1` | 通用层 GPU 规则（平台脚本侧） | `GPU_COUNT_LABEL_RE = ^nvidia-[a-z0-9]+-([1-9]\d*)$`（亦覆盖未来 nvidia-<model>-N） | fla-org nvidia-h100.yml 源码 runs-on + job 日志 nvidia-smi 计数 | 不折卡，维持 gpu jobs-only |
| 7 | GPU：`gcp-a2-highgpu-2g-...` | 通用层 GPU 规则 | `GCP_GPU_RE = ^gcp-a2-highgpu-([1-9][0-9]*)g(?:-run-[0-9]+-[0-9]+)?$` → N×A100 | GCP 机型命名即卡数（a2-highgpu-2g=2×A100 80G）；用 AReaL test-areal.yml 源码 + job 日志 nvidia-smi 复核 | 不折卡 |
| 8 | GPU：`nvidia` 裸标签（tilelang 883 jobs） | **不走通用层** | 按 ADR-017 用 repos.yaml `static_resources` 显式声明（如 `{ "A100": N }`），前提是核验出该 runner 的实际拓扑 | tilelang ci.yml 源码 + 日志 | gpu jobs-only（不折卡） |

卡数核验命令模板（每家族 2-3 个样本，写入 PR 描述留档）：

```bash
# 找一个目标标签的 job，拉日志数设备
run_id=$(gh api "repos/vllm-ascend/vllm-ascend-recipes/actions/workflows/pr-recipe-verify.yml/runs?per_page=5&created=2026-11-01..2026-11-30" \
  --jq '[.workflow_runs[] | select(.conclusion=="completed")][0].id')
job_id=$(gh api "repos/vllm-ascend/vllm-ascend-recipes/actions/runs/$run_id/jobs?per_page=100" \
  --jq '[.jobs[] | select((.labels//[]) | index("linux-aarch64-a3-800i-recipes-fed-16"))][0].id')
gh api "repos/vllm-ascend/vllm-ascend-recipes/actions/jobs/$job_id/logs" 2>/dev/null \
  | grep -iE "npu-smi|ASCEND_RT_VISIBLE_DEVICES|device_count|Found [0-9]+ npu|NPUs available"

# 工作流源码侧证
gh api repos/vllm-ascend/vllm-ascend-recipes/contents/.github/workflows/pr-recipe-verify.yml --jq .content | base64 -d | grep -nE "runs-on|fed-"
gh api repos/Ascend/pytorch/contents/.github/workflows/nightly-a3.yml    --jq .content | base64 -d | grep -nE "runs-on|cn12"
gh api repos/fla-org/flash-linear-attention/contents/.github/workflows/nvidia-h100.yml --jq .content | base64 -d | grep -nE "runs-on|h100"
gh api repos/areal-project/AReaL/contents/.github/workflows/test-areal.yml --jq .content | base64 -d | grep -nE "highgpu"
gh api repos/XPU-Forces/mojo_opset/contents/.github/workflows/ascend-a2-smoke.yml --jq .content | base64 -d | grep -nE "runs-on|mojo"
```

**保守原则（硬约束）**：任何家族在 job 日志实证前只做"kind 认定"不做"卡数折算"；核验结论（截图/日志摘录 + 样本 job_id）写进实施 PR，`RULE_VERSION` 升版（governed-runner-v6-*）并在 provenance 记录每条规则的证据样本。凡与 ADR-024 已确认语义冲突的新证据（a2b4 疑似 die），必须**升级为用户决策**而不是擅自改 CARD_MODELS 语义（见遗留问题 1）。

#### 3.2 card_quantity.py 变更边界

- 家族 1/2/3 复用现有模型→单位语义，`physical_cards()` 不需要新函数；
- 家族 4（a2b4）：若实证为卡 → 加入 `CARD_MODELS`；若实证为 die → 新增 `A2B4`（或泛化 A3_MODELS 为 DIE_MODELS）并同步 ADR-024 的"用户确认"注记；**未实证前不改**；
- 家族 5（0 卡）：若实证成立，在 evidence 层返回 `('npu', model, 0, 'zero_card_host')` 并保证卡时贡献为 0、不计入未知计数——需要新增测试断言"0 卡 job 不产生卡时也不冒算"。

#### 3.3 治理规则落点与测试

- 代码落点：`runner_resource_evidence.py`（LABEL_RE/FED_RE/GPU 规则 + scoped 层仅扩 sglang nightly case（5b））、`card_quantity.py`（如需）、`npu_vs_gpu_nov.py`（GPU_COUNT_LABEL_RE / GCP_GPU_RE + workflow 传递 + probe 注记）。GPU 规则不进 trend 报告（趋势报告只做 NPU）。
- 测试：`tests/test_card_quantity_shared.py` 增补家族用例（host 尾、fed、mojo-fed、a2b4 kind、0 卡、nvidia-h100-1、gcp-highgpu-2g），沿用现有"构造 job dict → 断言 evidence 四元组"风格；`uv run pytest tests/test_card_quantity_shared.py tests/test_npu_daily_trends.py`（回归趋势口径不受新规则影响——**新通用规则会改变趋势报告的已知卡时**，见 4.3 口径注记）。

### 4. 重跑与对账

#### 4.1 批次 0（修复 workflow 传递后，无新采集）

| 指标 | 修复前（2026-11-20 报告） | 修复后预期 |
|---|---|---|
| sglang NPU PR 卡时 | 5,739 | **18,388**（+12,649） |
| vllm-ascend NPU PR 卡时 | 16,557 | **22,734**（+6,177） |
| 13 仓 NPU PR 合计 | 27,075 | **≈45,900** |
| NPU 未知卡数 jobs | 28,647 | **3,615** |
| GPU 侧 | 不变 | 不变 |

对账：重跑 `uv run scripts/npu_vs_gpu_nov.py --scope integrated`，新旧 JSON 并排留档；差值只允许来自 scoped 生效的 sglang pr-test-npu（a3-N- 尾横线标签，有效区间 15,715 jobs）与 vllm-ascend pr_test（hk-001 9,332 jobs + scoped a3），其他仓数字漂移 ≤ 采集增量。

#### 4.2 批次 1-3 采集后

从"—"变数字的仓（平台报告 scope=integrated）：sgl-kernel-npu（NPU 主导）、vllm-ascend-recipes（NPU，若 a2b4/fed 未治理则先 jobs+未知卡数）、uni-agent（NPU+GPU 双栈）、verl-omni（GPU 8×L20 为主 + npu_smoke 待标签）、mojo_opset（NPU 小量）、Ascend/sglang（NPU ~135 runs）、fla-org（双栈）、cann-container-image（大概率 0 卡时、少量 jobs）。vllm-omni 保持"—"但注记 cpu_only_verified。

#### 4.3 治理规则落地后（批次 4）

未知卡数再降：ascend/pytorch 1,432 → 0（若 cn12-001 核验通过并折卡）或保持 1,432（未过）；vllm-ascend 1,841 → ~1,407-0（0 卡家族 1,407 视核验）；verl 21 → 0-21；sglang 321 → **62-0**（scoped 扩展消掉 nightly 259；fed 家族 62 视核验）；新增仓（recipes/uni-agent 等）的 fed/a2b4/mojo-fed jobs 从未知转已折或保持。**趋势报告口径**：新通用规则对历史标签同样生效 → npu_daily_trends 的已知卡时会上修（sglang nightly a3-N- 259 jobs 与 ascend/pytorch 1,432 jobs 是最大两块），这是治理的预期效果，报告 provenance 的 rule_version/rule_sha256 会体现；**趋势报告必须等 allowlist 决策（批次 5）后一次性重生成**，避免中间态版本满天飞。

### 5. 执行序（批次 0→5，每步含验证）

> 全程禁止在 main 上 commit；每批一个 Conventional Commit，feature 分支 + PR。采集命令在本地跑（非 commit 内容），日志留档 `/home/lcr/collect-cron/logs/`。

**批次 0 — 治理前置修复（零采集）**
```bash
git branch --show-current                 # 非 main
git checkout -b fix/npu-vs-gpu-workflow-scope   # 从最新 main
# 1) npu_vs_gpu_nov.py 补 workflow 传递（3.0）
# 2) 单测回归：
(cd .agents/skills/ci-effective-report && uv run pytest tests/ -q)
# 3) 重跑平台对比并留档新旧对照（脚本会覆盖 JSON，先备份旧版）：
cp reports/npu-vs-gpu-nov-2026-integrated.json /tmp/npu-vs-gpu-nov-2026-integrated.before.json
(cd .agents/skills/ci-effective-report && uv run scripts/npu_vs_gpu_nov.py --scope integrated)
# 验证 4.1 表：sglang 18,388 / vllm-ascend 22,734 / 未知 3,615
npm run lint && npm test
git commit -m "fix(report): pass workflow scope into resource evidence in npu_vs_gpu_nov" && git push -u origin HEAD
gh pr create --base main --title "fix(report): pass workflow scope into resource evidence in npu_vs_gpu_nov"
```

**批次 1 — repos.yaml 新增 + 活跃 NPU 仓 11 月补采**
```bash
git checkout -b feat/platform-integrated-repos-collection   # 基于最新 main
# 1) 按 1.3 编辑 etl/repos.yaml（8 仓，vllm-omni 不加）
# 2) 复核 + CI 预检：
npm run validate:repos && npm run validate:repos:online
npx tsx etl/scripts/collect.ts --help        # dry-run 帮助可用
# 3) 合并前先本地补采（抢在下一个整点 hourly 之前，或临时 EXCLUDE_REPOS）：
export PG_DATABASE_URL='postgresql://action_insight:action_insight@localhost:5433/action_insight'
for r in sgl-project/sgl-kernel-npu vllm-ascend/vllm-ascend-recipes verl-project/verl-omni \
         verl-project/uni-agent XPU-Forces/mojo_opset Ascend/sglang; do
  GITHUB_TOKEN_FILE=gh-token.txt GITHUB_TOKEN="$(cat /home/lcr/collect-cron/token-b.txt)" \
  GH_CONFIG_DIR=/nonexistent npx tsx etl/scripts/collect.ts --repo "$r" --days 20 --force-full-backfill \
    2>&1 | tee "/home/lcr/collect-cron/logs/adr041-collect-$(date -u +%Y%m%d)-${r//\//_}.log"
done
# 4) 逐仓验收（runs/jobs 已入库、标签可见）：
docker exec action-insight-postgres-1 psql -U action_insight -d action_insight -c \
 "SELECT r.repo, count(DISTINCT a.run_id) runs, count(j.job_id) jobs FROM ..."
# 5) commit/PR：
npm run lint && npm test        # etl/** 改动对应 etl-validate.yml：validate:repos:online 已跑
git commit -m "feat(etl): track 8 ascend-gha-runners platform integrated repos" && git push -u origin HEAD
gh pr create --base main
```

**批次 2 — fla-org 双栈 11 月补采**（同上命令，repo 换 fla-org/flash-linear-attention；单独跑，观察 2,177 runs / ~2,190 调用 / ~26 min）

**批次 3 — cann-container-image + 标签核验抽样**
```bash
# 收尾仓（~10 调用）
npx tsx etl/scripts/collect.ts --repo Ascend/cann-container-image --days 20 --force-full-backfill
# 家族核验：按 3.1 命令逐家族抽 2-3 个 job 日志（~20-40 调用），结论写入 PR/ADR 附录
```

**批次 4 — 治理规则落地**
```bash
git checkout -b feat/runner-label-family-governance
# 1) runner_resource_evidence.py / card_quantity.py / npu_vs_gpu_nov.py 按 3.1/3.2 改
#    （仅落地已有核验结论的家族；核验不过的只做 kind 认定）
# 2) 测试：
(cd .agents/skills/ci-effective-report && uv run pytest tests/test_card_quantity_shared.py tests/test_npu_daily_trends.py -q)
# 3) 重跑平台对比（对账 4.2/4.3）+ 重跑浪费账口径检查（allowlist 未变时 waste 数字只应因规则上修）
(cd .agents/skills/ci-effective-report && uv run scripts/npu_vs_gpu_nov.py --scope integrated)
npm run lint && npm test
git commit -m "feat(report): govern host-suffix/fed/a2b4/zero-card runner label families" ...
```

**批次 5 — allowlist 决策 + 趋势窗口补采 + 报告重生成**
```bash
# 1) 用 11 月实测数字过 2.2 判据，逐仓决定；verl-SpeCo 必加（2.1）
# 2) 过线仓做 Aug-Nov 补采（仅这些仓）：
RETENTION_DAYS=120 GITHUB_TOKEN_FILE=gh-token.txt GITHUB_TOKEN="$(cat /home/lcr/collect-cron/token-b.txt)" \
  npx tsx etl/scripts/collect.ts --repo <过线仓> --days 112 --force-full-backfill
# 3) 趋势报告 + 浪费账 + 月报一次性重生成（PR 内改 config/drilldown-workflows.yaml + 重跑）：
(cd .agents/skills/ci-effective-report && uv run scripts/npu_daily_trends.py)
(cd .agents/skills/ci-effective-report && uv run scripts/npu_waste_superseded.py)
npm run lint && npm test
```

**CI 映射**（AGENTS.md 规范）：`etl/**` → `npm run lint` + `npm test` + `npm run validate:repos:online`（etl-validate.yml）；`config/`+Python → `npm run lint` + pytest 子集；本方案不触 `.github/workflows/**`（actionlint 不适用）、不触 schema（migrate 不适用）。

### 6. 风控

1. **共享 token 预算上限**：批次 1+2+3 合计 ~5,100 调用；单次运行软顶 `GITHUB_RATE_LIMIT_RESERVE`（默认 10，与 hourly 共存时用 ADR-038 的 600），限流即 `RateLimitAbortError` 优雅停机、窗口保留 pending 下一轮续跑（collect.ts 语义，无部分写入损坏）。**硬性上限建议：任何单仓单日补采 ≤4,000 调用**（双 lane 一小时配额的 40%），fla-org Aug-Nov（估 ~10k）必须拆 2 天或配 per-repo 独立 token 后再批。
2. **幂等与活库安全**：collect.ts 每窗事务（BEGIN→upsert→state→COMMIT，异常 ROLLBACK）；runs `ON CONFLICT(id) DO UPDATE`、attempts `ON CONFLICT DO UPDATE`、无 DELETE；重跑同窗靠 ETag 304 与 cached-attempt 新鲜度跳过；rate-limit 中断只丢进度不丢一致性。本地库采集持续写入，补采与其并发安全（行级幂等 upsert）。**一个已知预存缺陷**（ADR-038 记录）：重持久化 attempt 会清空 queue 值——`--force-full-backfill` 会重写最近 20 天全部 attempt 行，**若担心 queue_duration_seconds 历史值受损，先按 ADR-038 phase-0 快照**（`CREATE TABLE ... AS SELECT run_id, run_attempt, queue_duration_seconds FROM workflow_attempts WHERE queue_duration_seconds IS NOT NULL`）。本方案 force-full 范围是**新仓首次入库**（无历史 queue 值），风险仅存在于对老仓操作时——对 13 个老仓不做任何 force-full。
3. **9 仓总量与分批**：本方案 tracked 筛选后 11 月合计 ~5,100 调用（vllm-omni 缓采省 2,600）；对照未筛选全量口径（repo 级 ≥2,500×5 封顶 ≈17k runs ≈170 页 + jobs）说明 workflow 级筛选的必要性——**新仓永远先按 1.2 判据筛掉 CPU 工作流再采**。
4. **fla-org 取舍**（已由实证替代原假设）：非纯 GPU，双栈必采（批次 2，~2,190 调用）；其 Aug-Nov 趋势补采（~10k 调用）列为**有条件项**，仅当 11 月实测 NPU PR 卡时过 2.2 判据且预算/窗口可容纳时执行，否则该仓只进平台对比不进趋势报告。
5. **范围失控防护**：allowlist 判据量化（2.2）、report_name 不默认加（2.3）、`--scope integrated` 与 allowlist 解耦；每期平台报告 provenance 保留 probe 证据与"cpu_only_verified"标注，防止"清单对齐"式冲动。
6. **0 卡/未知语义**：家族 5（N=0）在核验前保持未知；核验后 0 卡 job 不得产生卡时也不得计入浪费账（浪费账以"已执行 NPU 卡时"为口径，0 卡无从浪费）。
7. **趋势口径漂移**：批次 4 的通用规则会上修趋势报告已知卡时（sglang nightly、ascend/pytorch 两大块）；批次 5 重生成时在报告 provenance 引用 ADR-041 与 rule_version 升版，旧报告文件不回溯改写（快照制品原则）。

## 验收标准

1. **批次 0 对账**：平台对比修复后 sglang NPU PR ≈18,388、vllm-ascend ≈22,734、NPU 未知卡数 ≈3,615（允许采集增量漂移 ≤5%）；新旧 JSON 留档于 PR 描述。
2. **采集完整**：8 仓 11-01→当天 runs/jobs 入库，抽查 3 仓各 1 天：本地 runs 数 vs `gh api .../runs?created=该日` total_count 一致（±进行中 runs）；`npm run validate:repos:online` 通过（CI 同款）。
3. **标签治理**：每个落地规则在 PR 中附 ≥2 个样本 job_id 的日志/源码证据；未核验家族仍为 quantity_unknown；pytest 全绿；`RULE_VERSION` 升版。
4. **allowlist**：verl-SpeCo 出现在新趋势报告（11 月 PR NPU 卡时 ~1,300 量级）；每个新进仓在 PR 描述给出判据数字；未过线仓不进。
5. **报告重跑**：平台对比 8 仓有数字（vllm-omni 注 cpu_only_verified）；未知卡数相对 4.1 基线只降不升（新仓新增未知除外，需逐仓列出）。
6. **CI**：`npm run lint`、`npm test`、`npm run validate:repos:online`、pytest 子集全绿；全程无 main 直接 commit。

## 核验结果（2026-11-20 实施，job 日志 npu-smi 实证）

| 家族 | 样本 | npu-smi 实证 | 结论 |
|---|---|---|---|
| -fed-（A3 族） | a3-800i-recipes-fed-4（recipes job 136204483184） | 2 NPU × 2 die，ASCEND_RT_VISIBLE_DEVICES=0,1,2,3 | **N=die，÷2 折卡**，与 A3 治理语义一致 |
| host 尾组 | a3-800i-8-cn12-001（Ascend/pytorch job 136337062994） | 4 NPU × 2 die = 8 die | **N=die，÷2 折卡** |
| a2b4 | a2b4-2（recipes job 136040735330） | 2 台 910B4 NPU 设备（各 1 chip） | **N=物理卡**（与 ADR-024 A2 族语义一致；verification-targets.yaml 的 "Single Card" 为 recipe 配置标签，非硬件描述）。已按卡折算，如有反证一行可回退 |
| mojo-fed / a2-fed | a2-mojo-fed-4（模式同 a2b4） | A2 族 | **N=卡** |

遗留问题 1（a2b4 / recipes-fed 语义）据此关闭；实施落地见批次 4。0 卡家族（a3-800t-0 / a2b3-0）保持 quantity_unknown 不折卡。

## 遗留问题（需人工确认）

1. **a2b4 / recipes-fed 的 N 语义终裁（最高优先级）**：verification-targets.yaml 映射（a2b4-2↔"Single Card"）与 ADR-024 用户确认的"A2 后缀=卡"矛盾。需按 3.1 命令抽 job 日志（npu-smi / ASCEND_RT_VISIBLE_DEVICES）实证后**由用户拍板**：a2b4 归 CARD_MODELS 还是 die 族；`a3-800i-*-fed-16` 是否按 A3 die 惯例 ÷2。核验前相关标签一律不折卡。
2. **fla-org 的 Aug-Nov 趋势补采是否执行**：估 ~10,000 调用（单 lane ~2h / 双 lane ~1h），建议以其 11 月实测 NPU PR 卡时是否过 500 判据 + 当日剩余配额决定；不执行则只进平台对比。
3. **批次预算上限确认**：单仓单日 ≤4,000 调用的软上限、与 hourly 共存时 `GITHUB_RATE_LIMIT_RESERVE=600`、是否为 fla-org 配 per-repo token（需 GitHub Settings → Secrets，且 collect.ts 不支持 per-repo token——只能靠双 lane 或等 ADR 另立机制）。
4. **趋势 allowlist 阈值**：NPU PR 卡时 ≥500 / jobs≥500 且折卡率 ≥80% 的二选一判据是否认可；mojo_opset（95 runs）与 cann-container-image（18 runs）确认不进。
5. **vllm-omni 缓采确认**：11 月实证全 CPU；若平台侧后续为其接入 NPU runner（runs_on 状态变化），再按 1.2 重评。是否现在就给该仓留 repos.yaml 占位条目（采 recipes.yml 86 runs 作为哨兵）请拍板——本方案默认**不留**（省预算，靠人工关注平台清单变更）。
6. **0 卡标签（a3-800t-0 / a2b3-0）语义**：若实证为"无卡宿主机"，其在浪费账/趋势报告中的归类（NPU-kind 0 卡 vs CPU-kind）需用户确认口径。
7. **npu_vs_gpu_nov.py 是否升格为常规模板**：本轮它暴露了"独立脚本漏传 scope"的类bug 风险，是否把 platform 对比并入 skill 的标准 pytest（加最小 DB-free 用例）请确认。
