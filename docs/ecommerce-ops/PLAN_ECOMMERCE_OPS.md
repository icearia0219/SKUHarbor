# Amazon 跨境电商上新与运营 Copilot Implementation Plan

> **For agentic workers:** 逐任务实施；环境有相应扩展时可使用 subagent-driven-development 或 executing-plans，缺扩展不阻塞。所有步骤用复选框记录，任务结束附实际证据。  
> 2026-11-13 实施回填：代码与实际路径已经绑定。复选框只标已完成步骤，未勾选项保留未验证/未完成；不代表整体 A/B/C 或 benchmark 门槛达标。实际结果见 [acceptance.md](acceptance.md)。

**Goal:** 在现有 OpenDot 中实现基于共享产品事实和适用知识的跨境电商内容/诊断工作台。

**Architecture:** 产品事实、规则快照、证据、任务结果契约为共享基础；research_brief、listing_pack、ad_pack、ads_diagnosis、support_draft为薄任务模块。沿用既有模型、Goal、审批、调度、数据库、文件存储及UI，不另建Agent平台。

**Tech Stack:** 以T0仓库核验为准；T0已核验本机源码（见repo-map.md）。实际文件与合并职责已回填；不伪造已有文件或行号。

**Spec:** [ISSUE_ECOMMERCE_OPS.md](ISSUE_ECOMMERCE_OPS.md)。设计依据：[ARCHITECTURE_ECOMMERCE_OPS.md](ARCHITECTURE_ECOMMERCE_OPS.md)。统一输出：[contracts/task-result.schema.json](contracts/task-result.schema.json)。

## Global Constraints

- 第一版 UI 为中文；业务站点为 Amazon US（en-US/USD）与 DE（de-DE/EUR），各站点的规格、政策、币种、报告时区分开。
- 任务类型固定为：`research_brief | listing_pack | ad_pack | ads_diagnosis | support_draft`。
- 不做自动提交 Listing、自动改价/改竞价/改预算/否词、退款、补发、发送客服消息或站外主动触达。
- 生成状态仅允许 `draft | needs_input | blocked | failed`；`approved` 不在模型输出schema里，审核状态由服务端另存。
- 复用实际运行时与预算，不让“等人工确认”变成持续模型循环；所有结果绑定输入revision和规则快照。
- P0导入优先，SP-API/Ads API只读连接为P1；没有API凭证可完成导入工作台，不能伪称已接通。
- 原文、敏感信息、证据读取、任务、审核和导出均受既有workspace/role隔离。
- 同一请求/重试/恢复幂等；输入或规则改变后旧产物stale、旧审核失效。
- 用户已有改动不得覆盖；适用AGENTS.md增量更新，不清理无关文件。

## Review Focus

1. US与DE同名产品、不同规格及来源冲突：始终保留站点/SKU隔离，无法确认就补料（T1/T4）。
2. 政策过期、未知有效期、经验与官方规则冲突：按适用范围与as_of筛选，不靠相似度决定权威（T2）。
3. 广告币种/窗口/粒度/订单与件数：计算代码处理，不可比则阻断相应结论（T6）。
4. 生成、人工改稿、规则更新与审核并发：审批只对确切版本有效，失效传播不漏、不重（T8）。
5. 工单注入/PII、跨工作区引用、评测标签或未来资料：被测执行不能越权访问（T1/T2/T7/T10）。

## 1. 文件变更策略与路径绑定

### 1.1 实际复用入口

| 实际路径                                                      | 当前职责/符号                                                | 修改边界                                              |
| ------------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------- |
| `src/ecommerce-ops/`                                          | Hono/SQLite 场景业务域                                       | 已新增薄业务层，无独立 Agent 平台                     |
| `src/ecommerce-ops/repository.ts`、`src/db.ts`                | createEcommerceSchema/bindEcommerceDatabase、迁移注册        | 同 messages.db 连接、事务、私有备份及拒绝降级         |
| `src/personal-agent/product-model.ts`                         | productModelConfiguration/createProductModels                | model.ts 调用现有配置/账本；无工具文本生成            |
| `src/routes/ecommerce-ops.ts`、`src/web-context.ts`           | authorizeEcommerceWorkspace、canAccessGroup/canModifyGroup   | 复用认证/owner/workspace 边界，无 admin 跨 owner 旁路 |
| `src/personal-agent/goal-store.ts`                            | createPersonalGoal/getPersonalGoal/listGoalExecutionEvidence | 生产 routes 回调关联人工 Goal，budget_max_runs=1      |
| `src/web.ts`、`web/src/App.tsx`                               | /api/ecommerce-ops 与 /ecommerce-ops 注册                    | 默认 OFF，既有聊天入口保持                            |
| `src/ecommerce-ops/config.ts`、`scripts/start-windows.mjs`    | ecommerceEnabled/ecommerceLimits、原生 Windows 启动          | 沿用当前服务，不创建第二调度器                        |
| `tests/ecommerce-ops/`、`web/tests/e2e/ecommerce-ops.spec.ts` | Vitest/Playwright 与真实隔离后端                             | 不操作用户 data/原运行服务                            |

### 1.2 已落地代码单元与合并

下列路径均对应实际文件；原规划的薄任务职责已合并，未保留不存在的 build 包装函数。函数完整映射见 [repo-map.md](repo-map.md)。

| 实际文件                                                                                            | 责任                                                                                                                          | 任务   |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------ |
| `src/ecommerce-ops/domain.ts`、`repository.ts`                                                      | 领域类型、对象/CAS、原文 BLOB 与证据                                                                                          | T1/T8  |
| `src/ecommerce-ops/ingest.ts`、`facts.ts`                                                           | importAssets/extractAssetText、候选及人工确认、freezeInputs                                                                   | T1     |
| `src/ecommerce-ops/knowledge.ts`                                                                    | ingestKnowledge/retrieveEvidence/resolvePolicy/ensureKnowledgeScope                                                           | T2     |
| `src/ecommerce-ops/contracts.ts`、`quality.ts`                                                      | validateTaskResult、validateQuality                                                                                           | T3     |
| `src/ecommerce-ops/service.ts`、`model.ts`、`model-options.ts`                                      | freezeTask/validateBusinessResult、configuredModel、协议与预算诊断；通过 task_type 分派 research/Listing/ad/diagnosis/support | T3–T8  |
| `src/ecommerce-ops/reports.ts`、`metrics.ts`                                                        | parseAdReport/validateReportScope/computeAdMetrics/attributionMaturity                                                        | T6     |
| `src/ecommerce-ops/tasks/support.ts`、`tasks/order-context.ts`                                      | prepareSupportContext/validateSupportDraft、已审核订单的最小字段上下文                                                        | T7     |
| `src/ecommerce-ops/workflow.ts`、`review.ts`                                                        | EcommerceWorkflow、editArtifact/reviewArtifact/exportArtifact；导出合并在 review                                              | T8     |
| `src/ecommerce-ops/routes.ts`、`src/routes/ecommerce-ops.ts`                                        | 场景 API 与生产 auth/model/Goal 适配                                                                                          | T8/T9  |
| `web/src/pages/EcommerceOpsPage.tsx`                                                                | 页面、工作区与四视图容器                                                                                                      | T9     |
| `web/src/components/ecommerce-ops/{ProductPanel,KnowledgePanel,TaskPanel,ReviewPanel,shared}.tsx`   | 产品/知识/任务/审核视图及共用组件                                                                                             | T9     |
| `web/src/stores/ecommerce-ops.ts`                                                                   | 复用 api 的请求、共享类型与 Zustand 状态                                                                                      | T9     |
| `tests/ecommerce-ops/`                                                                              | 领域、API、恢复、越权、模型预算与 benchmark 断言；逐项见 acceptance                                                           | T1–T11 |
| `web/src/components/ecommerce-ops/EcommerceOpsPage.test.tsx`、`web/tests/e2e/ecommerce-ops.spec.ts` | DOM 8 项与 browser 3 条闭环                                                                                                   | T9     |

原拟 tasks/research.ts、tasks/listing.ts、tasks/ad-copy.ts、tasks/ads-diagnosis.ts 均合并到 service/model 与版本化 prompts；原拟 export.ts 合并到 review。fixture 使用实际 templates、benchmark inputs 和测试内自建数据，没有 tests/fixtures/ecommerce-ops 目录。

### 1.3 固定交接路径

- `docs/ecommerce-ops/repo-map.md`：逻辑组件→真实文件→修改符号→复用接口→测试路径/命令。
- `docs/ecommerce-ops/{decisions,data-sources,sop,benchmark,deployment,training,demo,acceptance}.md`。
- `docs/ecommerce-ops/prompts/{research,listing,ad-copy,ads-diagnosis,support}.md`：版本化任务提示。
- `docs/ecommerce-ops/contracts/task-result.schema.json`：本交接schema的实施基线；需要变更时同修示例、测试和版本。
- `docs/ecommerce-ops/templates/`：产品事实、政策元数据、SP报表映射、客服导入样例。
- `docs/ecommerce-ops/templates/`、`benchmarks/ecommerce-ops/inputs/` 与测试内自建资料：明确合成标识。
- `benchmarks/ecommerce-ops/{manifest.json,inputs/,private/labels/,faults.json,generate.mjs,materialize.mjs,worker.mjs,score.mjs,bridge.mjs}`：隔离回放与私有评分。
- `scripts/ecommerce-check.mjs`、`scripts/ecommerce-benchmark.mjs`、`scripts/ecommerce-demo.mjs`：已实现的薄入口；check/demo 另有无后缀 shell 包装。
- `artifacts/ecommerce-ops/evals/<run-id>/`：JSON汇总、Markdown报告、失败/轨迹/成本配置；非fixture原文与凭证不入Git。
- 适用的`AGENTS.md`、README、现有配置示例与部署文件增量变更。

若仓库禁止独立脚本，则采用等价包脚本，T0同步更新本文所有命令。脚本不能空壳返回成功。

## 2. 里程碑与依赖

| 里程碑        | 任务   | 可验收产物                                                                |
| ------------- | ------ | ------------------------------------------------------------------------- |
| M1 事实与上新 | T0–T4  | 导入产品/规则，确认事实，检索并生成US/DE Listing/候选比较；服务接口可运行 |
| M2 运营任务   | T5–T7  | 广告文案、只读报表诊断、客服草稿，分别可触发与测试                        |
| M3 工作台交付 | T8–T11 | 版本化审核、UI、导出、benchmark、部署和培训演示                           |

T0 → T1 → T2/T3 → T4/T5/T6/T7 → T8 → T9 → T10 → T11。T10数据标注可提前，但正式计分调用同一业务代码；不能另写更强的benchmark专用Agent冒充产品。

## T0：核验仓库、锁定范围、落实文件路径

**Files:** Read AGENTS/README/依赖锁/前后端/模型与权限/存储/检索/运行时/部署；Create repo-map、decisions、data-sources、acceptance；Modify本Plan与适用AGENTS。

**Produces:** `RepoBinding`、`BaselineReport`、`CapabilityMatrix`，真实路径与命令。

- [x] ZIP源码原无Git；已建立本地基线28c3204及work/ecommerce-ops分支，保留Windows改动，未动用户data。
- [x] 先用rg定位并阅读真实模块，记录commit/语言/包管理器/数据库/测试runner。
- [x] 追踪一个模型任务从API到持久化、审批和Goal的链路；验证PDF描述与代码是否一致。
- [x] 确认是否已有文件解析、全文搜索、embedding、导出、角色授权和费用统计；复用点逐项落表。
- [x] 运行项目最小基线测试/构建，记录历史失败和实际退出码。
- [x] 将本文逻辑路径全部替换为真实Create/Modify/Test路径和接口符号；现有代码确无能力才提出最小兼容补丁。
- [x] 把FR-01–FR-12和B01–B24写入acceptance；未运行/阻塞不得预填通过。
- [x] 记录API接入是P1、选品仅候选比较、无平台写入、US/DE隔离；更新AGENTS新增模块规则。

**验收:** 无未解析路径；有最小可运行基线、真实技术栈和能力矩阵；常规命名选择自行推进。不得因未见源码而新建另一个完整应用。

## T1：资料导入、产品事实及版本

**Files:** `src/ecommerce-ops/{domain,repository,ingest,facts}.ts`、`src/db.ts`（同连接增量 schema）、`src/ecommerce-ops/ingest.ts`最小接入；Test `tests/ecommerce-ops/{ingest,facts}.test.ts`；Create templates与fixture。

**Interfaces:**

- `importAssets(workspaceId, fileRefs, mapping, requestKey) -> ImportBatchResult`
- `extractFactCandidates(workspaceId, sourceId, {sku,market}) -> ProductFact[]`
- `confirmFacts(workspaceId, productId, expectedRevision, decisions, actorId) -> Product`
- `freezeInputs(taskRequest) -> InputManifest`（源hash、产品revision、market、locale、as_of）。

- [x] 为B01/B02/B03/B07/B09/B23建立断言：站点隔离、冲突待确认、竞品不赋予认证、扫描件失败明确、权限与PII受控。
- [ ] 支持规格CSV/JSON与可读PDF/DOCX/文本，复用解析器；空文本不是成功抽取；导入坏行与不支持格式明确显示。
- [x] 保存不可变原文/定位/hash/来源权属和provenance；文件大小/类型/安全解析沿用已有上传限制。
- [x] 用typed value/unit表达事实；抽取候选不自动变confirmed；允许人工确认并保留版本与理由。
- [x] US与DE两个虚构SKU分开fixture；同产品家族不共享未经确认的功率/电压等字段。
- [x] 导入批次requestKey幂等；重复提交不重复事实版本；人工确认使用expectedRevision防覆盖。
- [x] 完成迁移、索引及授权读取；重新启动后原文/事实/引用仍在。

**实际证据：** facts/ingest/repository 分批绿灯，T11 持久化 2/2。CSV/JSON/DOCX 已测；本机缺 pdftotext，真实 PDF 二进制待验。

**验收:** 关键事实可追溯；冲突被阻断；原始文件与事实表不混；无凭证可完整导入与确认。

## T2：政策知识库与RAG

**Files:** `src/ecommerce-ops/knowledge.ts`、`src/ecommerce-ops/knowledge.ts`最小扩展、政策元数据模板；Test `tests/ecommerce-ops/knowledge.test.ts`；Update data-sources。

**Interfaces:**

- `ingestKnowledge(workspaceId, assetId, metadata, expectedRevision) -> KnowledgeDocument`
- `retrieveEvidence(query, scope:EvidenceScope, topK=5) -> RetrievedEvidenceBundle`
- `resolvePolicy(bundle, scope) -> PolicyResolution`。

- [x] 编写B04/B05/B06/B24：过期/错站点/经验冲突/未来材料，预期过滤或blocked。
- [x] 按内容kind切分产品依据、平台规则、品牌语气与历史经验；chunk保留可定位父文档/段落/字段。
- [x] 元数据先过滤再排序；为effective时间与系统known时间保存独立字段，回放不见未来文档。
- [x] 采用既有全文/词法检索，已有embedding可复用；没有则先词法，不新建独立向量集群。
- [x] 保存query、过滤原因、topK、retrievedDocRefs与最终使用证据；policy冲突/未知适用性返回明确状态。
- [ ] 导入PTD schema时保存market/productType/sellerScope/version及校验覆盖声明，区分标准JSONschema与Amazon扩展词汇未检查项。
- [x] 为过期/被撤回政策更新依赖版本通知接口，交给T8处理下游stale。

**实际证据：** knowledge/domain-review/security-review 已覆盖历史已知时间、官方/经验、SKU 绑定和新规则 epoch。通用 PTD/schema 扩展不作为全量平台有效性。

**验收:** 检索可解释；错误站点/过期规则不会被引用为适用规则；无检索结果不编造来源。

## T3：统一输出契约与质检

**Files:** 交接schema拷入docs/ecommerce-ops/contracts；`src/ecommerce-ops/{contracts,quality}.ts`；Test `tests/ecommerce-ops/contracts.test.ts`。

**Interfaces:**

- `validateTaskResult(candidate, boundTaskContext) -> ValidatedResult | ContractErrors`
- `validateQuality(result, {products,evidence,rules}) -> Issue[]`（含 claim 与实际字段、数字/单位、候选归属）
- `configuredModel({task,snapshot,signal,repair,variant}) -> {text,usage,diagnostics}`（同现有模型入口，结果再经契约/质检）。

- [x] 用包内示例验证schema；测试多余字段、错误task payload、draft无payload、模型自带approved被拒。
- [x] 将schema绑定本仓库校验器；ID/workspace/输入版本由服务端上下文绑定，不采信模型任意字段。
- [x] 分别检查引用可定位、授权、hash与事实支持；schema通过不能替代语义校验。
- [x] 对无效JSON/schema错误最多进行1次修复重试，且取既有预算允许范围；修复不能编造缺失事实。
- [x] 超时/取消/超预算输出真实失败状态并保存用量；精确记录首次输出和修复后的有效率。
- [x] 定义可阻断issue码：FACT_CONFLICT、POLICY_UNKNOWN、WRONG_MARKET、UNSUPPORTED_CLAIM、REPORT_INCOMPARABLE、STALE_INPUT等。

**验收:** 五种task都受同一契约约束；有效结果持久化100%通过校验；模型不能提升审核权限。

## T4：候选比较与多语言Listing

**Files:** `src/ecommerce-ops/{service,model,quality}.ts`、prompts/research.md 与 listing.md；Test `tests/ecommerce-ops/{quality,security-review,api}.test.ts` 及 browser 闭环。

**Interfaces:**

- `freezeTask(task)` 冻结指定 candidate sources；`configuredModel({task,snapshot,signal})` 按 research_brief 及 research prompt 生成统一 TaskResult
- 相同 `configuredModel` 按 listing_pack/listing prompt 生成；`validateQuality` 校验单 SKU/事实/规则；无独立 buildListingPack 函数。

- [x] 测试B01/B02/B03/B04/B05，以及已知字段完整、关键值未知时needs_input；US/DE数据分别断言。
- [x] 候选比较只消费输入范围，明确证据差异与缺口；不输出利润/销量预测。
- [x] Listing按版本化站点/品类profile生成title/bullets/description/search_terms；字段数量/字符字节限制来自规则，不写死全局数值。
- [x] Claim映射覆盖规格、功能、配件、使用范围；不支持的认证/功效被阻断或移除，保留缺料说明。
- [ ] US和DE独立校验数值/单位，再由业务人员检查自然表达；禁止跨SKU直接翻译继承。
- [x] 把结果标成内部草稿/部分规则检查；商品属性不全或未实现PTD扩展词汇时不称平台全量有效。

**实际证据：** US/DE Listing 开发样本真实模型 A/B 四次收到正常 JSON；A、B 各 1/2，DE 过度补料失败保留。第一轮封存 A/B 已跑且未达标；真人自然度、独立字段完整率/事实支持分母与总体阈值未验。

**验收:** 无API也能在真实模型下生成两站草稿；关键事实不变；research和listing分别可调用。模型不可用只报告未完成模型端到端。

## T5：广告内容包

**Files:** `src/ecommerce-ops/{service,model,quality}.ts`、prompts/ad-copy.md；Test contracts/security-review/benchmark；ad-profile.test.ts 覆盖 placement 守卫，ads.test.ts 实际负责报表/计算。

**Interfaces:** `freezeTask` + `configuredModel`（task_type=ad_pack）+ `validateQuality`；直接使用已确认事实与规则。没有独立 buildAdPack 或 approvedListingRef 入口；placement 守卫已有专用工程断言，真实平台适用性未验。

- [ ] 测试同一产品不同placement规则、缺规则、旧Listing/不同SKU被误引用等场景。
- [x] 每次生成3组可编辑文案，候选词带来源；可从已审且未stale Listing复用证据，也可直接引用事实层。
- [x] 文案的claim重新检查，不能因Listing已审就跳过新增广告断言。
- [x] placement未知或缺规则时标internal_draft，不能称平台可上传；字符/字节校验沿用profile。
- [x] 无自动创建广告/关键词/否词工具；建议类型与执行类型分开。

**实际证据：** 3 组结构由 schema 约束，事实/claim 共用 quality；ad-profile 3 项与 API 4 项为 7/7，证明缺 profile/错 placement/内部草稿与匹配 profile；旧 Listing 专项及真实广告文案模型质量验收仍未覆盖，不由报表 ads.test 冒充。

**验收:** 3组文案结构有效、事实有据，格式适配与未检查项清楚，不依赖广告API。

## T6：SP报表导入、计算与诊断

**Files:** `src/ecommerce-ops/{reports,metrics,service,model}.ts`、prompts/ads-diagnosis.md、报表映射模板；Test `tests/ecommerce-ops/{ads,security-review}.test.ts`。

**Interfaces:**

- `parseAdReport(input, mapping, rawMetadata, format) -> {ok,report|errors}`
- `validateReportScope(reports, {asOf}) -> {ok,rows,scope,reasons,...}`
- `computeAdMetrics(rows, scope) -> ComputedMetrics`
- `freezeTask` 将 `computeAdMetrics` 快照交给 `configuredModel`（ads_diagnosis）；`validateBusinessResult` 禁止模型/改稿改变代码指标。

- [x] 固定B10–B14算例，包含零分母、不同币种/窗口、叠加粒度、未成熟归因、订单与件数。
- [x] 只支持两种明确模板：SP search-term、SP campaign；识别失败要人工映射，不让LLM猜字段。
- [x] 报告metadata缺窗口/账户/日期/币种/时区等必要项可保留原件，但阻断不可比结论；标明import不是live。
- [x] 金额用USD/EUR分和decimal运算；ACoS/ROAS/CTR/CPC/CVR按Issue公式实现；汇总先加分子分母。
- [x] 记录report row定位、去重键、模板/映射版本；行级可拆分数据去重后按日期聚合，不把campaign和search-term直接叠加；只有重叠期间汇总且无法拆分则阻断。
- [x] 区分同期间汇总与环比：后者允许等长且已成熟的不同窗口，要求账户/币种/时区/粒度/广告产品/广告主类型/归因口径可比并披露活动季节影响；不据此下因果结论。
- [x] 成熟度由as_of、report日期、归因窗口及可见延迟信息判定；未知时不推断近期词无效。保留观察统计而不输出硬因果。
- [x] LLM只读取代码计算结果与必要上下文，生成有据的发现/待补信息/待审动作，不重算公式。
- [x] JSON与CSV导出共享同一个metrics快照；单位为ratio或minor_unit明确标记，显示百分号只在视图格式化。

**验收:** 确定性指标100%正确，金额精确到分、比例误差≤1e-6；所有不可比状态可解释；没有平台修改动作。

## T7：多语言客服草稿

**Files:** `src/ecommerce-ops/tasks/{support,order-context}.ts`、service/model、support 提示词、工单模板；Test `tests/ecommerce-ops/{support,order-context,security-review}.test.ts`；真实工单/订单未验。

**Interfaces:** `approvedOrderContext`（已审核来源）→ `prepareSupportContext` → `configuredModel`（support_draft）→ `validateSupportDraft`；冻结、人工改稿均复用守卫。没有独立 buildSupportDraft。

- [x] 固定B15/B16/B23：退款请求无回执、订单过期/归属不明、PII最小化；预期补问/转人工/草稿。
- [x] 工单输入脱敏、按workspace隔离；仅将本任务必需事实送模型，默认不传姓名/邮箱/住址。
- [x] 区分requested/pending/accepted/completed状态，无执行凭证不能宣称已退款/已补发。
- [x] 使用适用站点政策与订单as_of；过期或缺失不自动接受用户自述作为系统真值。
- [ ] 生成US/DE自然语言回复、intent、action(reply_draft/needs_info/escalate)、缺料与内部中文说明。
- [x] 不配置发送/退款工具；导出包与UI注明草稿及人工处理事项。

**实际证据：** support/order-context/API 的字段/分支和 PII 守卫已验证；订单必须显式选择唯一已审核匹配来源，ticket ID 内部 hash，不能自动采用同 SKU 另一工单。该来源是人工核验导入，不是平台 API；真实工单/语言未验。

**验收:** 不虚构业务执行结果；应补问/转人工的分支正确；没有消息外发。

## T8：持久工作流、版本失效、审核、API和导出

**Files:** `src/ecommerce-ops/{workflow,review,routes,service,repository}.ts`、`src/routes/ecommerce-ops.ts` 与 `src/web.ts`；复用既有 product-model/goal-store/web-context；Test `tests/ecommerce-ops/{workflow,review,api,security-review}.test.ts`。

**Interfaces:**

- `EcommerceWorkflow.startTask(workspaceId, ownerId, request, requestKey) -> WorkflowTask`
- `EcommerceWorkflow.resumeTask(workspaceId,id)` 内部事务提交 artifact 与 task/checkpoint；无独立 commitArtifact 公共函数
- `reviewArtifact(workspaceId, id, expectedRevision, contentHash, decision, reason, reviewer, requestKey) -> Artifact`
- `EcommerceWorkflow.invalidateDependents(workspaceId, kind, id, revision) -> string[]`
- `exportArtifact(workspaceId, id, revision, format, mode) -> {content,mime,filename}`
- `src/routes/ecommerce-ops.ts` 的 followUp/refreshFollowUp 回调：绑定 revision/hash、截止、条件与 request key，复用人工 Goal（budget_max_runs=1）；未启用 503，completed 不批准。

- [x] 使用既有run推进freeze→retrieve→generate/compute→quality→review→export，等待人工时暂停且不循环消耗模型。
- [x] 把task写入、artifact提交、阶段检查点更新做成原子提交或既有可恢复步骤；B19任意间隙重启不漏不重。
- [x] 请求幂等与版本CAS处理并发；B20双击/重投只创建一个产物/Goal。
- [x] 事实、规则、人工改稿变化传播stale；B17/B18证明旧hash审批失效且不能作为已审导出。
- [x] 审核与导出权限复用既有角色；预览模式有未审/失效标记，approved模式需当前有效审核。LLM不能构造ReviewDecision。
- [x] 直接调用审核API时，同样检查当前revision、非stale、draft且无严重质检阻塞；对blocked/failed/needs_input/错误站点/事实冲突/无依据关键断言的approve请求写拒绝测试，不能只靠UI禁用按钮。
- [x] 输出JSON+Markdown，ads诊断另有CSV；附件大文件走授权存储，原文和导出不公开裸链。
- [x] 跟进复用Goal，补料/审稿/效果验证有截止与证据条件；回调幂等更新关联卡片，不凭Goal completed自动批准内容。
- [x] 注册产品/知识/任务/审核/导出API，记录真实端点；API拒绝错误market/locale以及其他workspace ID。

**实际证据：** workflow/review/security/API 已有分批绿灯，Goal 代码为人工有界；goal-http.integration.test.ts 的真实 HTTP 创建/refresh 幂等、budget=1、completed 不审批为 1/1（变异 red 保留）；review.test.ts 新增诊断 JSON/CSV/null round-trip 已通过，t8/final-business-gates.log 共 18/18；这些分批重复用例不叠加到总测试数，不把实现存在写成全测通过。

**最终 P1 证据：** pauseTask 改为工作区校验与事务保存成功后才 abort，错误工作区 pause/cancel 和保存回滚的3个回归先红后绿；workflow+security22/22，当前完整 all 为 unit140/integration77/browser3/docs154。模型 A/B 仅覆盖修复前 run.code_versions，不追加为当前版本模型成绩。

**验收:** B09/B17–B22通过；审核精确到版本；输入变化后不能复用旧审；导出与UI数据一致。

## T9：中文工作台UI

**Files:** `web/src/pages/EcommerceOpsPage.tsx`、四个 `web/src/components/ecommerce-ops/*Panel.tsx`、shared.tsx、`web/src/stores/ecommerce-ops.ts`、App.tsx/导航；Test `web/src/components/ecommerce-ops/EcommerceOpsPage.test.tsx`、`web/tests/e2e/ecommerce-ops.spec.ts`；demo/training 已存在。

**Interfaces:** 使用T8真实API与共享schema派生类型，前端不复制金额/政策判定。

- [x] 功能开关控制入口，产品页显示SKU/站点/事实来源/冲突确认，知识页显示适用性/版本。
- [x] 任务表单选择5种task_type、market/locale、产品与附件，显示依赖及缺料；不把API未接显示为成功。
- [x] 内容编辑区按title/bullets/copies/reply等结构展示，支持claim定位到证据和未检查项。
- [x] 广告诊断显示分子分母、币种、窗口、成熟度与源行定位，比例空值不显示0%。
- [x] 审核抽屉展示精确revision/hash与stale差异；编辑后自动撤销当前审核有效性并重新质检。
- [x] 展示模型、Token、重试/等待/失败及成本unknown状态；业务界面不堆无意义内部实现参数。
- [x] 三条E2E：US/DE生成审核导出；冲突/过期规则补料后重跑；广告边界诊断+退款客服草稿不越权。
- [x] 复用桌面/手机布局；关闭功能开关后原导航/聊天/Goal正常。

**实际证据：** DOM 8/8、browser 3/3，后者为真实 Hono/SQLite + synthetic provider，覆盖 US/DE Listing 审核导出、含过期规则输入的冲突补料恢复、ads/support 边界；当前完整 check browser 3/3。广告内容包的完整浏览器生成不在这 3 条中，不把界面测试当语言质量验收。

**验收:** UI操作真实持久层，不能用写死成功结果；三条演示可重置复现，未审/失效与可交付清楚。

## T10：Benchmark与模型质量/成本比较

**Files:** benchmarks/ecommerce-ops目录、ecommerce-benchmark脚本、benchmark/acceptance；可选ESCI下载脚本及NOTICE（不捆绑大数据）。

**Interfaces:** `scripts/ecommerce-benchmark.mjs` 调用受限 `benchmarks/ecommerce-ops/worker.mjs` 的生产执行链写 observations；私有 `score.mjs:scoreObservation/scoreRun/summarize` 评分与汇总，无虚构 runCase/scoreCase/aggregate 包装。

- [x] 构建120个案例（40/20/60）与B01–B24；封存分配为RAG/事实15（至少5research）、Listing15、广告15（7文案+8诊断）、客服15；每种task_type均有两站及负例，provenance/业务复核状态逐案记录。
- [x] 每案固定输入hash、product/policy版本、market/locale、as_of与允许/禁止断言。产品家族/同报表变体/政策事件不跨分区。
- [x] 被测运行只挂载inputs及必要知识快照；labels与评分器私有输入不可读，B24实测读取被拒。每案重置状态/记忆。
- [x] 先实现代码评分：schema、字段/规格、数值、引用定位、正确阻断。证据语义与语言质量用业务复核，模型评分仅辅助。
- [x] 检索另记录query数量、每query相关/适用证据集合与Recall@5；同案多query披露共享关系，不用研究简报成功率替代检索指标。第一轮 15 个 query，US 相关锚点 6/6；DE 7 query 对应 0/0=NA。
- [ ] 具备可验收的 DE 适用规则检索正例；当前 DE 正例分母为 0，不能按 >=90% 通过，后续资料/数据版本修正另留记录。
- [ ] A/B同模型、同输入/规则片段/输出schema/预算，B增加SOP；RAG检索策略另做同文档全集测试；C恢复单独注入故障。模型第一轮配对已执行，A/B 均保留生产质检；检索策略对照与全部阈值尚未验收。
- [x] 完整第一轮真实封存 A/B 已运行；原始 A 22/60、B 16/60；scorer v2 不改数据/gold/产物、零新增模型调用，重评 A 27/60、B 17/60。复评分是评分契约修正，不称产品提升。
- [x] 产品守卫修正后的第二轮真实配对运行完成：v1.1-guardfix-real-A/B 分别 A25/60、B21/60，均未达标；各54次实际模型响应、共108次，两组 exit1 是评分未达而非基础设施失败。包含产品守卫变更与随机模型重新输出，不作纯方法同比提升；不得混入第一轮/同产物 audit-v2。
- [ ] 独立统计事实支持率（含应有未输出事实）>=95%；当前只存在整案/启发式质检，完整 claim/必需缺失字段分母和真人语义证据未建立。
- [ ] 独立统计 Listing 已知且适用必需字段完成率 >=95% 及跨站逐规格数值/单位一致性 100%；当前 case_pass/单元边界断言不能替代独立分子分母。
- [ ] 业务待审状态不按文案缺字段惩罚正确补料；对“已知且适用字段”计算完整率，未输出应有事实仍算错误。正确 needs_info→needs_input 的评分已修正并对同产物重评；独立必需字段分母尚未实现，不能将 case_pass 当完整率。
- [x] 记录首次/最终schema有效率、重试、Token、模型/提示词/规则/价格版本，P50/P95及每成功任务成本；人工等待另列。
- [x] ESCI可选固定小子集按官方split/归属评测相关性，报告subset/custom，不称官方全榜，不用于DE语言质量或实时经营数据。
- [x] 输出summary.json、report.md、failures.jsonl、配置/轨迹到独立run-id目录；真实/合成、任务族、站点分别报分，所有比例给计数与区间。
- [x] 门槛未达标修开发输入/规则/实现，保留失败；更改测试标签需复核/版本化，不能删除困难样例伪造进步。

**实际证据：** v1.1 的 120 controlled fixture 归属 30 个产品家族，封存 60 案归属 15 家族；按家族隔离但家族内相关。第一轮真实模型原始 A 22/60、B 16/60；同产物 audit-v2 为 A 27/60、B 17/60，新增调用 0；每变体实际模型 schema 54/54、持久 schema 60/60、广告算术/成熟度 8/8。case Wilson 区间仅描述性，未校正家族相关性，不当作统计显著或真实独立业务试验。第二轮产品修正后 A25/60、B21/60，均已完成未达标；最终 P1 修复后的当前完整 check 已通过 unit140/integration77/browser3/docs154及全部类型/构建步骤；前一140/74快照保留为历史。DE 检索 0/0=NA、独立事实支持/字段完整率分母、PDF 本机实际提取、真人语言/业务均未验收；整体 A 不达标。见 acceptance/audit-v2，不继承旧 v1.0 smoke 分数。

**验收:** Issue第10节逐项达标；B01–B24全过。没有真人复核只报告工程/合成成绩；无模型凭证不能声称真实模型AB对照已跑。

## T11：部署、培训、演示与交接

**Files:** `scripts/start-windows.mjs`、`src/ecommerce-ops/config.ts`、AGENTS、README；deployment/training/demo/acceptance文档与ecommerce-demo脚本。

- [x] 给配置示例添加场景开关、模型路由、上传/证据存储、workspace及预算，全部使用占位值；不写入真实密钥或PII。
- [x] 使用实际项目启动/部署方式，持久化DB/原文/产物/索引版本；若需Compose仅作既有方式最小扩展。
- [x] health区分应用就绪、模型未配置、资料未导入；无凭证不是业务任务成功。
- [ ] 重启、备份恢复、索引重建、功能关闭和代码回滚实际验证；不能删除业务数据解决回滚。
- [x] 演示脚本仅可操作指定demo workspace，reset需显式标识，拒绝生产workspace；3条路径可重复执行。
- [x] 培训文档讲任务选择、补料、证据检查、审核/导出、错误处理及数据流向；明确样例为虚构而非用户实际产品。
- [x] 运行既有聊天/Goal/审批/工作区/上传/导出相关回归，记录未执行项和历史问题。
- [x] 有已授权部署目标才上线；否则交付本地/测试部署与生产步骤，不购买资源。
- [x] 更新AGENTS实际路径/命令、事实与规则优先级、广告口径、审核失效、无外写、标签隔离及数据处理规则。
- [x] 汇报逐模块、逐站点A/B/C矩阵；真实候选、产品/规则、广告报表和客服工单分别有核对证据才通过对应B。5工作日试运行与业务复核未结束保持未验收，不能用一份报表替代所有模块真实验证，不预填经营收益。

**实际证据：** T11 旧数据库入口迁移/私有备份/跨进程恢复/拒降级与 flag OFF 为 2/2；不是完整历史应用包或生产切换。相关旧回归 32/35，3 个 Windows POSIX mode 假设失败保留。前一完整 check-1794547917403-3719824d 通过 unit84/integration73/browser3/docs153；安全修复前 check-1794548758841-22f86c07 为140/74/3/153；最终 check-1794549745698-d40dcf1f 全16步 exit0：unit140/integration77/browser3/docs154，5组 types 及 root/web/runner build 通过。新故障 C（v1.1-final-security-faults-C）24/24、unverified0、exit0。真实封存第一轮及 audit-v2 已跑未达标，第二轮 A25/60、B21/60 已完成未达标；A/B/C 总验收均未完成。

**验收:** 可从文档复现部署/演示；数据可恢复，开关关闭无关业务正常；模型/真人/真实数据/API接入状态如实记录。

## 3. 新增执行入口的命令契约

以下 .mjs 命令均已存在；普通 check 无需真实店铺 API。Windows 直接 node；每次运行保存独立结果目录。实际通过/失败与未验证项见 acceptance，不将命令存在视为执行通过。

```bash
node scripts/ecommerce-check.mjs unit
node scripts/ecommerce-check.mjs integration
node scripts/ecommerce-check.mjs e2e
node scripts/ecommerce-check.mjs build
node scripts/ecommerce-check.mjs all

node scripts/ecommerce-benchmark.mjs --manifest benchmarks/ecommerce-ops/manifest.json --split test --variant B --dry-run
node scripts/ecommerce-benchmark.mjs --manifest benchmarks/ecommerce-ops/manifest.json --split test --variant B --output artifacts/ecommerce-ops/evals/local-B
node scripts/ecommerce-benchmark.mjs --manifest benchmarks/ecommerce-ops/manifest.json --suite faults --variant C --output artifacts/ecommerce-ops/evals/local-faults

node scripts/ecommerce-demo.mjs --workspace demo-ecommerce --reset --scenario launch-us-de
node scripts/ecommerce-demo.mjs --workspace demo-ecommerce --reset --scenario conflicting-evidence
node scripts/ecommerce-demo.mjs --workspace demo-ecommerce --reset --scenario operations-boundaries
```

dry-run不调用外部模型，只输出任务数/预算/凭证需求；真正模型评测使用已授权配置。脚本必须失败返回非零、写出失败原因；一次run-id只允许一种数据与模型配置。成本unknown不填0，tokens仍需记录。

## 4. 覆盖映射与最终自审

| 需求           | 任务  | 主要验收                      |
| -------------- | ----- | ----------------------------- |
| FR-01 产品资料 | T1    | B01–B03/B07/B09/B23           |
| FR-02 RAG      | T2    | B04–B06/B24、Recall@5         |
| FR-03 候选比较 | T4    | 证据差异、无销量利润预测      |
| FR-04 Listing  | T3/T4 | 两站字段/规格、部分规则声明   |
| FR-05 广告内容 | T5    | 3组、placement、claim质检     |
| FR-06 广告诊断 | T6    | B10–B14、指标100%             |
| FR-07 客服     | T7    | B15/B16/B23、虚构执行0        |
| FR-08 流程审核 | T8    | B17–B21、Goal幂等回流         |
| FR-09 结构导出 | T3/T8 | B22、同schema/版本            |
| FR-10 UI       | T9    | 3条E2E                        |
| FR-11 评测     | T10   | 四任务族、AB/成本/失败/隔离   |
| FR-12 部署培训 | T11   | 重启、备份、开关、培训与A/B/C |

自审必须检查：每个FR有实现及证据；B01–B24都有具体断言；跨任务函数/字段一致；路径全部落地；没有用fixture/静态截图替代真实端到端；没有用schema通过替代政策或事实通过。

## 5. 直接交给Codex

> 阅读本目录的Issue、Architecture、Plan、schema和示例。先在现有OpenDot仓库完成T0，核实AGENTS和实际技术栈，将逻辑改动位置绑定到真实文件，再按里程碑实施。先完成共享事实/RAG/契约和Listing，再扩展广告与客服，最后接审核/UI/评测/部署。遵守不做范围；缺凭证仍完成可独立工作，并如实标记模型、真人、真实数据、API或部署的阻塞。不要把目标分数写成已测结果。交接包含实际文件变更、测试/benchmark、成本、失败案例和A/B/C验收等级。
