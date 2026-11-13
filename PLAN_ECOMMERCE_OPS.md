# Amazon 跨境电商上新与运营 Copilot Implementation Plan

> **For agentic workers:** 逐任务实施；环境有相应扩展时可使用 subagent-driven-development 或 executing-plans，缺扩展不阻塞。所有步骤用复选框记录，任务结束附实际证据。
> 本交付是计划，不代表仓库代码、运行命令、API接入或benchmark已经完成。

**Goal:** 在现有 OpenDot 中实现基于共享产品事实和适用知识的跨境电商内容/诊断工作台。

**Architecture:** 产品事实、规则快照、证据、任务结果契约为共享基础；research_brief、listing_pack、ad_pack、ads_diagnosis、support_draft为薄任务模块。沿用既有模型、Goal、审批、调度、数据库、文件存储及UI，不另建Agent平台。

**Tech Stack:** 以T0仓库核验为准；当前仅有产品PDF，无源码。下述逻辑路径必须绑定真实路径后实施，不伪造已有文件或行号。

**Spec:** [ISSUE_ECOMMERCE_OPS.md](ISSUE_ECOMMERCE_OPS.md)。设计依据：[ARCHITECTURE_ECOMMERCE_OPS.md](ARCHITECTURE_ECOMMERCE_OPS.md)。统一输出：[contracts/task-result.schema.json](docs/ecommerce-ops/contracts/task-result.schema.json)。

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

### 1.1 T0必须定位的现有入口

| 别名                | 实际绑定目标                             | 修改原则                             |
| ------------------- | ---------------------------------------- | ------------------------------------ |
| `@BE`               | 现有后端业务域下的ecommerce-ops目录      | 新增场景模块或扩展已有同职责模块     |
| `@FE`               | 现有前端feature目录下的ecommerce-ops     | 复用组件/请求/状态管理               |
| `@DB`               | 现有schema与migration目录                | 沿用数据库、事务和迁移机制           |
| `@TEST`             | 项目测试根下的ecommerce-ops              | 沿用实际runner，不能新建平行测试体系 |
| `@EXEC`             | 既有模型、工具、审批、持久运行与预算入口 | 新增场景注册，最小改动               |
| `@GOAL`             | 既有Goal创建/状态/证据接口               | 只做关联与结果回流                   |
| `@AUTH`             | 工作区、角色和artifact访问校验           | 复用，不建新账号系统                 |
| `@STORE`            | 上传、文件提取、快照与授权读取           | 支持大原文，不依赖64KiB私有文本接口  |
| `@SEARCH`           | 已有检索/全文/embedding实现              | 能复用则复用，缺省先词法方案         |
| `@API`/`@NAV`       | 后端路由及前端导航注册                   | 开关控制，既有行为回归               |
| `@CONFIG`/`@DEPLOY` | 实际配置、启动、健康与部署               | 沿用，不强制某云厂商/队列            |

### 1.2 拟新增代码单元（不是已存在的文件）

T0将以下路径的`@...`及`<ext>`改成真实路径/语言后缀，并记录Create或Modify；已有等价职责时不得重复创建。小型模块可合并，避免无意义文件数量。

| 拟定路径                                                                               | 责任                                  | 任务  |
| -------------------------------------------------------------------------------------- | ------------------------------------- | ----- |
| `@BE/domain.<ext>`、`repository.<ext>`                                                 | 产品/规则/任务/产物模型及隔离存储     | T1/T8 |
| `@BE/ingest.<ext>`、`facts.<ext>`                                                      | 文件/报表导入、事实候选确认、来源版本 | T1    |
| `@BE/knowledge.<ext>`                                                                  | metadata过滤、检索、证据、规则快照    | T2    |
| `@BE/contracts.<ext>`、`quality.<ext>`                                                 | JSONschema绑定、语义/证据/状态校验    | T3    |
| `@BE/tasks/research.<ext>`、`listing.<ext>`                                            | 候选比较与多语言Listing               | T4    |
| `@BE/tasks/ad-copy.<ext>`                                                              | 广告文案和候选词                      | T5    |
| `@BE/reports.<ext>`、`metrics.<ext>`、`tasks/ads-diagnosis.<ext>`                      | 导入、口径核对、代码计算和解释        | T6    |
| `@BE/tasks/support.<ext>`                                                              | 脱敏工单/政策/订单上下文与客服草稿    | T7    |
| `@BE/workflow.<ext>`、`review.<ext>`、`export.<ext>`                                   | 依赖/恢复/stale/审核/导出/Goal        | T8    |
| `@BE/routes.<ext>`                                                                     | 场景API，调用既有鉴权                 | T8/T9 |
| `@FE/{products,knowledge,tasks,review}.<ext>`                                          | 产品/知识/任务/审核四个视图           | T9    |
| `@FE/client.<ext>`                                                                     | 共享类型与接口封装                    | T9    |
| `@DB/<仓库序号>_ecommerce_ops.<格式>`                                                  | 模型、索引、唯一键与兼容迁移          | T1/T8 |
| `@TEST/{ingest,facts,knowledge,contracts,listing,ads,support,workflow,api}.test.<ext>` | 领域回归及集成                        | T1–T8 |
| `@TEST/ecommerce.e2e.<ext>`                                                            | 三条UI闭环                            | T9    |

### 1.3 固定交接路径

- `docs/ecommerce-ops/repo-map.md`：逻辑组件→真实文件→修改符号→复用接口→测试路径/命令。
- `docs/ecommerce-ops/{decisions,data-sources,sop,benchmark,deployment,training,demo,acceptance}.md`。
- `docs/ecommerce-ops/prompts/{research,listing,ad-copy,ads-diagnosis,support}.md`：版本化任务提示。
- `docs/ecommerce-ops/contracts/task-result.schema.json`：本交接schema的实施基线；需要变更时同修示例、测试和版本。
- `docs/ecommerce-ops/templates/`：产品事实、政策元数据、SP报表映射、客服导入样例。
- `tests/fixtures/ecommerce-ops/`：少量自建/授权fixture，明确合成标识。
- `benchmarks/ecommerce-ops/{manifest.json,inputs/,labels/,faults/,runner.<ext>,scorer.<ext>}`：隔离回放与评分。
- `scripts/ecommerce-check`、`scripts/ecommerce-benchmark`、`scripts/ecommerce-demo`：新增薄运行入口，转调实际技术栈。
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

- [ ] 检查git工作状态，保留用户改动；按仓库协作方式隔离后续修改。
- [ ] 先用rg定位并阅读真实模块，记录commit/语言/包管理器/数据库/测试runner。
- [ ] 追踪一个模型任务从API到持久化、审批和Goal的链路；验证PDF描述与代码是否一致。
- [ ] 确认是否已有文件解析、全文搜索、embedding、导出、角色授权和费用统计；复用点逐项落表。
- [ ] 运行项目最小基线测试/构建，记录历史失败和实际退出码。
- [ ] 将本文逻辑路径全部替换为真实Create/Modify/Test路径和接口符号；现有代码确无能力才提出最小兼容补丁。
- [ ] 把FR-01–FR-12和B01–B24写入acceptance；未运行/阻塞不得预填通过。
- [ ] 记录API接入是P1、选品仅候选比较、无平台写入、US/DE隔离；更新AGENTS新增模块规则。

**验收:** 无未解析路径；有最小可运行基线、真实技术栈和能力矩阵；常规命名选择自行推进。不得因未见源码而新建另一个完整应用。

## T1：资料导入、产品事实及版本

**Files:** `@BE/{domain,repository,ingest,facts}.<ext>`、`@DB/...`、`@STORE`最小接入；Test `@TEST/{ingest,facts}.test.<ext>`；Create templates与fixture。

**Interfaces:**

- `importAssets(workspaceId, fileRefs, mapping, requestKey) -> ImportBatchResult`
- `extractFactCandidates(assetRevision, productScope) -> FactCandidates`
- `confirmFacts(workspaceId, productId, expectedRevision, decisions) -> ProductRevision`
- `freezeInputs(taskRequest) -> InputManifest`（源hash、产品revision、market、locale、as_of）。

- [ ] 为B01/B02/B03/B07/B09/B23建立断言：站点隔离、冲突待确认、竞品不赋予认证、扫描件失败明确、权限与PII受控。
- [ ] 支持规格CSV/JSON与可读PDF/DOCX/文本，复用解析器；空文本不是成功抽取；导入坏行与不支持格式明确显示。
- [ ] 保存不可变原文/定位/hash/来源权属和provenance；文件大小/类型/安全解析沿用已有上传限制。
- [ ] 用typed value/unit表达事实；抽取候选不自动变confirmed；允许人工确认并保留版本与理由。
- [ ] US与DE两个虚构SKU分开fixture；同产品家族不共享未经确认的功率/电压等字段。
- [ ] 导入批次requestKey幂等；重复提交不重复事实版本；人工确认使用expectedRevision防覆盖。
- [ ] 完成迁移、索引及授权读取；重新启动后原文/事实/引用仍在。

**验收:** 关键事实可追溯；冲突被阻断；原始文件与事实表不混；无凭证可完整导入与确认。

## T2：政策知识库与RAG

**Files:** `@BE/knowledge.<ext>`、`@SEARCH`最小扩展、政策元数据模板；Test `@TEST/knowledge.test.<ext>`；Update data-sources。

**Interfaces:**

- `ingestKnowledge(assetRef, metadata) -> KnowledgeRevision`
- `retrieveEvidence(query, {workspaceId,market,productType,sellerScope,asOf,knownAsOf}, topK=5) -> EvidenceBundle`
- `resolvePolicy(bundle, scope) -> PolicySnapshot | PolicyConflict`。

- [ ] 编写B04/B05/B06/B24：过期/错站点/经验冲突/未来材料，预期过滤或blocked。
- [ ] 按内容kind切分产品依据、平台规则、品牌语气与历史经验；chunk保留可定位父文档/段落/字段。
- [ ] 元数据先过滤再排序；为effective时间与系统known时间保存独立字段，回放不见未来文档。
- [ ] 采用既有全文/词法检索，已有embedding可复用；没有则先词法，不新建独立向量集群。
- [ ] 保存query、过滤原因、topK、retrievedDocRefs与最终使用证据；policy冲突/未知适用性返回明确状态。
- [ ] 导入PTD schema时保存market/productType/sellerScope/version及校验覆盖声明，区分标准JSONschema与Amazon扩展词汇未检查项。
- [ ] 为过期/被撤回政策更新依赖版本通知接口，交给T8处理下游stale。

**验收:** 检索可解释；错误站点/过期规则不会被引用为适用规则；无检索结果不编造来源。

## T3：统一输出契约与质检

**Files:** 交接schema拷入docs/ecommerce-ops/contracts；`@BE/{contracts,quality}.<ext>`；Test `@TEST/contracts.test.<ext>`。

**Interfaces:**

- `validateTaskResult(candidate, boundTaskContext) -> ValidatedResult | ContractErrors`
- `validateClaims(claims, evidenceBundle, productRevision) -> ClaimCheck[]`
- `generateTask(taskType, frozenInputs, budget) -> TaskResult`（通过现有模型入口）。

- [ ] 用包内示例验证schema；测试多余字段、错误task payload、draft无payload、模型自带approved被拒。
- [ ] 将schema绑定本仓库校验器；ID/workspace/输入版本由服务端上下文绑定，不采信模型任意字段。
- [ ] 分别检查引用可定位、授权、hash与事实支持；schema通过不能替代语义校验。
- [ ] 对无效JSON/schema错误最多进行1次修复重试，且取既有预算允许范围；修复不能编造缺失事实。
- [ ] 超时/取消/超预算输出真实失败状态并保存用量；精确记录首次输出和修复后的有效率。
- [ ] 定义可阻断issue码：FACT_CONFLICT、POLICY_UNKNOWN、WRONG_MARKET、UNSUPPORTED_CLAIM、REPORT_INCOMPARABLE、STALE_INPUT等。

**验收:** 五种task都受同一契约约束；有效结果持久化100%通过校验；模型不能提升审核权限。

## T4：候选比较与多语言Listing

**Files:** `@BE/tasks/{research,listing}.<ext>`、提示词research/listing；Test `@TEST/listing.test.<ext>`。

**Interfaces:**

- `buildResearchBrief(candidateRefs, evidenceBundle) -> TaskResult<research_brief>`
- `buildListingPack(productRevision, market, locale, policySnapshot, brandProfile) -> TaskResult<listing_pack>`。

- [ ] 测试B01/B02/B03/B04/B05，以及已知字段完整、关键值未知时needs_input；US/DE数据分别断言。
- [ ] 候选比较只消费输入范围，明确证据差异与缺口；不输出利润/销量预测。
- [ ] Listing按版本化站点/品类profile生成title/bullets/description/search_terms；字段数量/字符字节限制来自规则，不写死全局数值。
- [ ] Claim映射覆盖规格、功能、配件、使用范围；不支持的认证/功效被阻断或移除，保留缺料说明。
- [ ] US和DE独立校验数值/单位，再由业务人员检查自然表达；禁止跨SKU直接翻译继承。
- [ ] 把结果标成内部草稿/部分规则检查；商品属性不全或未实现PTD扩展词汇时不称平台全量有效。

**验收:** 无API也能在真实模型下生成两站草稿；关键事实不变；research和listing分别可调用。模型不可用只报告未完成模型端到端。

## T5：广告内容包

**Files:** `@BE/tasks/ad-copy.<ext>`、ad-copy提示词；Test `@TEST/ads.test.<ext>`文案部分。

**Interfaces:** `buildAdPack(productRevision, approvedListingRef?, placementProfile, market, locale) -> TaskResult<ad_pack>`。

- [ ] 测试同一产品不同placement规则、缺规则、旧Listing/不同SKU被误引用等场景。
- [ ] 每次生成3组可编辑文案，候选词带来源；可从已审且未stale Listing复用证据，也可直接引用事实层。
- [ ] 文案的claim重新检查，不能因Listing已审就跳过新增广告断言。
- [ ] placement未知或缺规则时标internal_draft，不能称平台可上传；字符/字节校验沿用profile。
- [ ] 无自动创建广告/关键词/否词工具；建议类型与执行类型分开。

**验收:** 3组文案结构有效、事实有据，格式适配与未检查项清楚，不依赖广告API。

## T6：SP报表导入、计算与诊断

**Files:** `@BE/{reports,metrics}.<ext>`、`@BE/tasks/ads-diagnosis.<ext>`、报表映射模板；Test `@TEST/ads.test.<ext>`计算部分。

**Interfaces:**

- `parseAdReport(assetRef, verifiedMapping, metadata) -> NormalizedAdReport | MappingErrors`
- `validateReportScope(reportRefs) -> ComparableScope | IncomparableReasons`
- `computeAdMetrics(rows, scope) -> ComputedMetrics`
- `diagnoseAds(metricsRef, productContext?, policySnapshot) -> TaskResult<ads_diagnosis>`。

- [ ] 固定B10–B14算例，包含零分母、不同币种/窗口、叠加粒度、未成熟归因、订单与件数。
- [ ] 只支持两种明确模板：SP search-term、SP campaign；识别失败要人工映射，不让LLM猜字段。
- [ ] 报告metadata缺窗口/账户/日期/币种/时区等必要项可保留原件，但阻断不可比结论；标明import不是live。
- [ ] 金额用USD/EUR分和decimal运算；ACoS/ROAS/CTR/CPC/CVR按Issue公式实现；汇总先加分子分母。
- [ ] 记录report row定位、去重键、模板/映射版本；行级可拆分数据去重后按日期聚合，不把campaign和search-term直接叠加；只有重叠期间汇总且无法拆分则阻断。
- [ ] 区分同期间汇总与环比：后者允许等长且已成熟的不同窗口，要求账户/币种/时区/粒度/广告产品/广告主类型/归因口径可比并披露活动季节影响；不据此下因果结论。
- [ ] 成熟度由as_of、report日期、归因窗口及可见延迟信息判定；未知时不推断近期词无效。保留观察统计而不输出硬因果。
- [ ] LLM只读取代码计算结果与必要上下文，生成有据的发现/待补信息/待审动作，不重算公式。
- [ ] JSON与CSV导出共享同一个metrics快照；单位为ratio或minor_unit明确标记，显示百分号只在视图格式化。

**验收:** 确定性指标100%正确，金额精确到分、比例误差≤1e-6；所有不可比状态可解释；没有平台修改动作。

## T7：多语言客服草稿

**Files:** `@BE/tasks/support.<ext>`、support提示词、工单模板；Test `@TEST/support.test.<ext>`。

**Interfaces:** `buildSupportDraft(ticketRef, orderSnapshotRef?, productRevision, policySnapshot, locale) -> TaskResult<support_draft>`。

- [ ] 固定B15/B16/B23：退款请求无回执、订单过期/归属不明、PII最小化；预期补问/转人工/草稿。
- [ ] 工单输入脱敏、按workspace隔离；仅将本任务必需事实送模型，默认不传姓名/邮箱/住址。
- [ ] 区分requested/pending/accepted/completed状态，无执行凭证不能宣称已退款/已补发。
- [ ] 使用适用站点政策与订单as_of；过期或缺失不自动接受用户自述作为系统真值。
- [ ] 生成US/DE自然语言回复、intent、action(reply_draft/needs_info/escalate)、缺料与内部中文说明。
- [ ] 不配置发送/退款工具；导出包与UI注明草稿及人工处理事项。

**验收:** 不虚构业务执行结果；应补问/转人工的分支正确；没有消息外发。

## T8：持久工作流、版本失效、审核、API和导出

**Files:** `@BE/{workflow,review,export,routes}.<ext>`、repository扩展；Modify `@EXEC/@GOAL/@AUTH/@API`必要注册点；Test `@TEST/{workflow,api}.test.<ext>`。

**Interfaces:**

- `startTask(request, requestKey) -> ExistingRunRef`
- `commitArtifact(runRef, expectedInputRevision, result) -> ArtifactRevision | StaleInput`
- `reviewArtifact(workspaceId, artifactId, expectedRevision, contentHash, decision) -> ReviewDecision`
- `invalidateDependents(changedRef, revision) -> StaleArtifactRefs`
- `exportArtifact(workspaceId, artifactId, revision, format, mode) -> ExportRef`
- `createFollowUp(artifactRef, completionCriteria, requestKey) -> GoalRef` / `refreshFollowUp(goalId, observedVersion) -> FollowUpRevision`。

- [ ] 使用既有run推进freeze→retrieve→generate/compute→quality→review→export，等待人工时暂停且不循环消耗模型。
- [ ] 把task写入、artifact提交、阶段检查点更新做成原子提交或既有可恢复步骤；B19任意间隙重启不漏不重。
- [ ] 请求幂等与版本CAS处理并发；B20双击/重投只创建一个产物/Goal。
- [ ] 事实、规则、人工改稿变化传播stale；B17/B18证明旧hash审批失效且不能作为已审导出。
- [ ] 审核与导出权限复用既有角色；预览模式有未审/失效标记，approved模式需当前有效审核。LLM不能构造ReviewDecision。
- [ ] 直接调用审核API时，同样检查当前revision、非stale、draft且无严重质检阻塞；对blocked/failed/needs_input/错误站点/事实冲突/无依据关键断言的approve请求写拒绝测试，不能只靠UI禁用按钮。
- [ ] 输出JSON+Markdown，ads诊断另有CSV；附件大文件走授权存储，原文和导出不公开裸链。
- [ ] 跟进复用Goal，补料/审稿/效果验证有截止与证据条件；回调幂等更新关联卡片，不凭Goal completed自动批准内容。
- [ ] 注册产品/知识/任务/审核/导出API，记录真实端点；API拒绝错误market/locale以及其他workspace ID。

**验收:** B09/B17–B22通过；审核精确到版本；输入变化后不能复用旧审；导出与UI数据一致。

## T9：中文工作台UI

**Files:** `@FE/{products,knowledge,tasks,review,client}.<ext>`、`@NAV`；Test `@TEST/ecommerce.e2e.<ext>`；Create demo/training初稿。

**Interfaces:** 使用T8真实API与共享schema派生类型，前端不复制金额/政策判定。

- [ ] 功能开关控制入口，产品页显示SKU/站点/事实来源/冲突确认，知识页显示适用性/版本。
- [ ] 任务表单选择5种task_type、market/locale、产品与附件，显示依赖及缺料；不把API未接显示为成功。
- [ ] 内容编辑区按title/bullets/copies/reply等结构展示，支持claim定位到证据和未检查项。
- [ ] 广告诊断显示分子分母、币种、窗口、成熟度与源行定位，比例空值不显示0%。
- [ ] 审核抽屉展示精确revision/hash与stale差异；编辑后自动撤销当前审核有效性并重新质检。
- [ ] 展示模型、Token、重试/等待/失败及成本unknown状态；业务界面不堆无意义内部实现参数。
- [ ] 三条E2E：US/DE生成审核导出；冲突/过期规则补料后重跑；广告边界诊断+退款客服草稿不越权。
- [ ] 复用桌面/手机布局；关闭功能开关后原导航/聊天/Goal正常。

**验收:** UI操作真实持久层，不能用写死成功结果；三条演示可重置复现，未审/失效与可交付清楚。

## T10：Benchmark与模型质量/成本比较

**Files:** benchmarks/ecommerce-ops目录、ecommerce-benchmark脚本、benchmark/acceptance；可选ESCI下载脚本及NOTICE（不捆绑大数据）。

**Interfaces:** `runCase(visibleInputs, variant, modelConfig, budget) -> Trajectory`；`scoreCase(trajectory, privateGold) -> CaseScore`；`aggregate(scores, manifest) -> Report`。

- [ ] 构建120个独立case（40/20/60）与B01–B24；封存分配为RAG/事实15（至少5research）、Listing15、广告15（7文案+8诊断）、客服15；每种task_type均有两站及负例，provenance/业务复核状态逐案记录。
- [ ] 每案固定输入hash、product/policy版本、market/locale、as_of与允许/禁止断言。产品家族/同报表变体/政策事件不跨分区。
- [ ] 被测运行只挂载inputs及必要知识快照；labels与评分器私有输入不可读，B24实测读取被拒。每案重置状态/记忆。
- [ ] 先实现代码评分：schema、字段/规格、数值、引用定位、正确阻断。证据语义与语言质量用业务复核，模型评分仅辅助。
- [ ] 检索另记录query数量、每query相关/适用证据集合与Recall@5；同案多query披露共享关系，不用研究简报成功率替代检索指标。
- [ ] A/B同模型、同输入/规则片段/输出schema/预算，B增加SOP+质检；RAG检索策略另做同文档全集测试；C恢复单独注入故障。
- [ ] 业务待审状态不按文案缺字段惩罚正确补料；对“已知且适用字段”计算完整率，未输出应有事实仍算错误。
- [ ] 记录首次/最终schema有效率、重试、Token、模型/提示词/规则/价格版本，P50/P95及每成功任务成本；人工等待另列。
- [ ] ESCI可选固定小子集按官方split/归属评测相关性，报告subset/custom，不称官方全榜，不用于DE语言质量或实时经营数据。
- [ ] 输出summary.json、report.md、failures.jsonl、配置/轨迹到独立run-id目录；真实/合成、任务族、站点分别报分，所有比例给计数与区间。
- [ ] 门槛未达标修开发输入/规则/实现，保留失败；更改测试标签需复核/版本化，不能删除困难样例伪造进步。

**验收:** Issue第10节逐项达标；B01–B24全过。没有真人复核只报告工程/合成成绩；无模型凭证不能声称真实模型AB对照已跑。

## T11：部署、培训、演示与交接

**Files:** `@DEPLOY/@CONFIG`、AGENTS、README；deployment/training/demo/acceptance文档与ecommerce-demo脚本。

- [ ] 给配置示例添加场景开关、模型路由、上传/证据存储、workspace及预算，全部使用占位值；不写入真实密钥或PII。
- [ ] 使用实际项目启动/部署方式，持久化DB/原文/产物/索引版本；若需Compose仅作既有方式最小扩展。
- [ ] health区分应用就绪、模型未配置、资料未导入；无凭证不是业务任务成功。
- [ ] 重启、备份恢复、索引重建、功能关闭和代码回滚实际验证；不能删除业务数据解决回滚。
- [ ] 演示脚本仅可操作指定demo workspace，reset需显式标识，拒绝生产workspace；3条路径可重复执行。
- [ ] 培训文档讲任务选择、补料、证据检查、审核/导出、错误处理及数据流向；明确样例为虚构而非用户实际产品。
- [ ] 运行既有聊天/Goal/审批/工作区/上传/导出相关回归，记录未执行项和历史问题。
- [ ] 有已授权部署目标才上线；否则交付本地/测试部署与生产步骤，不购买资源。
- [ ] 更新AGENTS实际路径/命令、事实与规则优先级、广告口径、审核失效、无外写、标签隔离及数据处理规则。
- [ ] 汇报逐模块、逐站点A/B/C矩阵；真实候选、产品/规则、广告报表和客服工单分别有核对证据才通过对应B。5工作日试运行与业务复核未结束保持未验收，不能用一份报表替代所有模块真实验证，不预填经营收益。

**验收:** 可从文档复现部署/演示；数据可恢复，开关关闭无关业务正常；模型/真人/真实数据/API接入状态如实记录。

## 3. 新增执行入口的命令契约

以下是实施后应交付的命令，当前尚未存在；T0按项目实际脚本方式替换。普通check无需真实店铺API。

```bash
./scripts/ecommerce-check unit
./scripts/ecommerce-check integration
./scripts/ecommerce-check e2e
./scripts/ecommerce-check build
./scripts/ecommerce-check all

./scripts/ecommerce-benchmark --manifest benchmarks/ecommerce-ops/manifest.json --split test --variant B --dry-run
./scripts/ecommerce-benchmark --manifest benchmarks/ecommerce-ops/manifest.json --split test --variant B --output artifacts/ecommerce-ops/evals/local-B
./scripts/ecommerce-benchmark --manifest benchmarks/ecommerce-ops/manifest.json --suite faults --variant C --output artifacts/ecommerce-ops/evals/local-faults

./scripts/ecommerce-demo --workspace demo-ecommerce --reset --scenario launch-us-de
./scripts/ecommerce-demo --workspace demo-ecommerce --reset --scenario conflicting-evidence
./scripts/ecommerce-demo --workspace demo-ecommerce --reset --scenario operations-boundaries
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
