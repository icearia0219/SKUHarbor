# 一个真实SKU Listing闭环 Implementation Plan

> 日期：2026-11-13。逐任务执行并记录复选状态。当前交付仅是下一轮计划，未改用户D盘源码。
> Spec：[ISSUE_NEXT_LISTING_SLICE.md](ISSUE_NEXT_LISTING_SLICE.md)。审阅：[REVIEW_ECOMMERCE_2026-11-13.md](REVIEW_ECOMMERCE_2026-11-13.md)。

**Goal:** 让普通入口可发现电商功能，一个SKU/一个站点用真实资料产生有据、可审、可导出的Listing。

**Architecture:** 复用现有Hono/SQLite、React、EcommerceWorkflow、模型SDK、AJV、审核与stale依赖，不新建系统。先修输入requiredness与claim语义，再接首个任务向导；原五模块保留但本轮只验收Listing闭环。

**Tech Stack:** 汇报记录React/TypeScript/Vite、Node/Hono/SQLite、AJV/Zod、Vitest/Playwright。当前审阅只有证据包，未得到源码；实施时核实commit与配置。Node版本按本仓库已验证说明匹配原生依赖，不假定D盘外环境一致。

## Global Constraints

- 本轮一个SKU/一个站点，工程优先US；业务必须DE则先补正例与规则并记录，不同时扩大两站。
- 原60例作为已见回归，不作未见泛化证据；旧结果/输入/gold/产物不可覆写。
- 不通过减少守卫、删失败、修改旧gold刷分；修复误报同时保留对应危险正例回归。
- 无平台写操作；审核绑定当前revision/hash；stale、无证据、错工作区继续阻断。
- 文本claim定位与事实支持是不同指标；数值计算由代码负责。
- 自动审批曾拒绝的凭据删除不得绕过；不把凭据内容加入日志、测试或交接。

## Review Focus

- 准确规格但claim指错标题/数组：只修契约和定位，不免除事实核验（P1）。
- 已确认必需事实被模型遗漏、可选信息导致整案补料：结构化requiredness（P2）。
- UI入口可见但真实provider仍零产出：主流程必须真实模型+人工审核跑通（P3/P5）。
- 同一产物复评分与重新生成、新增资料与方法变化：分别记录（P4）。
- 版本修改、并发和权限回归：不能因局部改动破坏原守卫（P5）。

## 文件改动范围

下列核心路径出现在证据包source-manifest中，说明它们属于运行记录的文件名；本审阅没有读到这些源码，符号与修改内容仍须P0定位。

| 路径                                                             | 计划变更                                                  | 任务  |
| ---------------------------------------------------------------- | --------------------------------------------------------- | ----- |
| `src/ecommerce-ops/contracts.ts`                                 | 统一claim定位语义和运行时契约说明                         | P1    |
| `src/ecommerce-ops/quality.ts`                                   | 定位/事实/必需字段分项校验，错误原因可定位                | P1/P2 |
| `src/ecommerce-ops/model.ts`                                     | 输入requiredness/模板与claim生成一致，不扩大工具          | P1/P2 |
| `src/ecommerce-ops/knowledge.ts`                                 | 适用规则与必需性来源，必要时补target站点正例              | P2    |
| `src/ecommerce-ops/service.ts`                                   | 就绪检查、任务向导所需范围数据、指标拆分                  | P2/P3 |
| `src/ecommerce-ops/workflow.ts`                                  | 仅在确有需要时接新检查点/状态；保持CAS/stale/审批         | P2/P5 |
| `docs/ecommerce-ops/prompts/listing.md`                          | claim精确片段、必需/可选/冲突规则与例子                   | P1/P2 |
| `benchmarks/ecommerce-ops/{materialize,worker,bridge,score}.mjs` | 审输入/gold对应、新版本计分和独立指标；不篡改旧结果       | P0/P4 |
| `docs/ecommerce-ops/contracts/task-result.schema.json`           | 若实际契约需改，同步说明/版本/兼容性，不先猜实现          | P1    |
| UI导航、手机入口、现有四业务页与真实测试文件                     | 包内未列路径；P0从repo-map和源码定位再写明，不臆造web路径 | P3/P5 |

新增固定交付路径：

- `docs/ecommerce-ops/next-slice/{repo-binding,error-taxonomy,readiness-rules,acceptance}.md`。
- `benchmarks/ecommerce-ops/v2-slice/`：新manifest、隔离inputs/gold、评分配置；具体与既有loader绑定，禁止复制另一套生产逻辑。
- `artifacts/ecommerce-ops/next-slice/<run-id>/`：检查结果、模型轨迹、人工核验、导出及界面证据，敏感资料不入Git。
- 根/适用范围`AGENTS.md`增量规则。

## P0：核实实际版本、定位前端、建立可审开发样例

**Files:** 上表核心源码只读、现有repo-map/启动文档；Create next-slice/repo-binding、error-taxonomy、acceptance。

- [ ] 检查当前分支、commit及用户未提交修改；保存证据对应版本，不能把安全修复前模型结果当当前版本结果。
- [ ] 阅读真实契约/selector/quality/scorer和Listing prompt，定位路径语法、字符串匹配、单位支持及必需字段判断的实际函数。
- [ ] 从repo-map定位桌面/手机导航、空工作区和任务创建页的确切文件、组件、测试命令，写入repo-binding后再编辑。
- [ ] 检查开发集是否包含与报告类似的问题；用开发集或单独工程fixture构建12个正负对照。原封存案例仅作审计/回归，明确已见，不加入未见测试。
- [ ] 对每个对照记录：可见输入、源证据、应该输出/禁止输出、预期状态、实际claim/path、quality与scorer结论。未决项由业务复核，不能凭tag猜幻觉。
- [ ] 运行定向基线检查并保存；核对旧140/77/3范围，不宣称已重跑全仓。

**验收:** 有真实路径/函数/命令；12对照标签有据；知道失败属于哪一层。源码与prompt未提供完整时不得跳过这一步直接改regex。

## P1：收敛claim契约与精确引用

**Files:** contracts.ts、quality.ts、model.ts、listing.md；现有contract/quality测试路径在P0绑定；必要时同步schema。

**接口目标:** 定位校验返回 `{path, target_type, text_match, evidence_resolution, factual_check}` 的分项结果或项目等价类型，不用一个UNSUPPORTED_CLAIM承载全部语义。

- [ ] 先固定测试：正确的1650W/230V原文片段能引用对应标题/要点；指向整数组/对象/数值的文字claim被明确拒绝；错误SKU/单位/数值仍拒绝。
- [ ] 在现有selector支持范围中选定规范语法，明确文本叶子与精确片段要求；如果改语法/字段，增加版本和历史结果只读兼容，不默默重写旧产物。
- [ ] prompt给出真实任务schema匹配的少量开发例子：title里的claim取title原文片段，不把解释性改述冒充原文。
- [ ] 事实层使用typed value/unit及来源范围核对；文字定位正确不等于事实正确。数值指标由metrics_ref与源行提供依据，不能要求解释文字在数字值里出现。
- [ ] 修复后对12对照复测；保存同产物旧/新质检的差异。若重新调用模型，结果另列，不能混成同一种提升。

**验收:** 6正例按预期有效、6反例阻断；失败错误码能解释原因；没有“全放行”或虚假认证漏报。

## P2：输入就绪与字段完整性

**Files:** model.ts、quality.ts、knowledge.ts、service.ts，必要时workflow.ts；Create readiness-rules；现有Listing/输入测试。

**接口目标:** `requiredFacts / optionalClaims / userFocus / conflicts / ruleCoverage` 分开传入既有生成上下文；名称按项目风格定，但含义不得混合。

- [ ] 建测试：用户关注容量但未要求写容量→可省略；有明确必需容量规则→needs_input；新开发fixture中已确认850W不能列未核实或遗漏；本案无功率且必需时必须补料，禁止跨案例继承功率；冲突参数→阻断。
- [ ] 规则必需性绑定来源/作用字段；对没有明确机器规则的简短文本标unknown，不把query中出现词当required。
- [ ] 服务端产出就绪检查：已确认字段、必补项、可省略项、冲突、未检查规则；前端与生成使用同一个结果。
- [ ] 生成提交后检查已知必需字段和数值/单位是否出现；不可用省略来提高事实支持率，完整性另计。
- [ ] 输入缺必需事实走needs_input；模型漏写已有事实走生成质量错误和有界修正/blocked；原始冲突走人工确认。三条分支分别断言，不能把模型缺陷伪装成用户资料不足。
- [ ] 阶段分开：缺可选信息不强制全部payload=null；缺关键事实或适用性不足仍不能宣称完整可提交。

**验收:** 定向positive可生成受限有据稿，negative仍正确补料；不因profile覆盖不全虚称Amazon审核通过。

## P3：入口与一个Listing向导

**Files:** P0绑定的真实桌面/手机导航、现有产品/任务/审核视图；必要的service/API最小修改；现有Playwright路径。

- [ ] 从普通聊天/主导航提供可见“电商工作台”入口，手机也能访问；关闭场景开关仍保持原导航行为。
- [ ] 空态引导“创建首个Listing”，按产品/站点→导入→事实确认→就绪检查→生成→证据/审核/导出推进。
- [ ] 当前模型/规则/文件解析依赖未就绪时展示可操作原因。PDF缺pdftotext时预检明确提示；不得以空抽取继续。
- [ ] 明确区分补料、质检拦截、模型失败、待审、已批准、失效；用户可从缺料处返回修复，而不是重填所有表单。
- [ ] 用一个真实SKU资料完成真实模型调用；人工改稿后重新校验和审核，正式导出仍走现有精确版本规则。
- [ ] 在正常首页开始做桌面/手机操作记录；请1名非实现者验证入口与前5分钟任务启动过程。缺真人则该项未验收。

**验收:** 用户不用输入隐藏URL就能开始；实际SKU出现一份可送审稿，并能审后导出；不能用synthetic provider替代。

## P4：新局部评测与可用性指标

**Files:** 新v2-slice数据与manifest、必要的worker/materialize/score扩展，acceptance；旧v1.1全部保留。

- [ ] 旧60案例改为已见回归标签，不再称新的独立封存；错误分析与gold改动留版本理由。
- [ ] 在不同家族的开发/验证样例调试后，另冻结20个未见case（10完整正例、10补料/阻断反例，至少10新家族）；同家族不跨开发与封存。
- [ ] gold记录requiredness依据、允许状态、已知必需字段、禁止断言和source锚点；业务复核未完成显示unreviewed，不能把期望状态自动当真值。
- [ ] 只给Agent可见输入，不挂gold/评分器；记录实际输入hash、代码/prompt/规则/模型/质检版本。
- [ ] 同材料同预算比较；分别报告正确补料、draft、waiting_review、人工通过、导出、字段完整性/事实支持，不拿case_pass代替有用产物。
- [ ] 正例≥8/10待审、应有字段全覆盖；反例10/10正确，严重错误0，证据可定位100%。小样本报告计数，不宣称总体质量已达到某置信水平。
- [ ] 记录真实Token/重试/延迟；价格不可知继续unknown。用一个真实SKU记录人工修改与耗时，但不和不同输入的历史成绩作因果比较。

**验收:** 新旧数据/同产物复评分/重新生成分表；不篡改历史；不借放宽检测刷分；仅声明局部里程碑结果。

## P5：回归、环境与最终交接

**Files:** 既有检查脚本/测试、AGENTS、启动/依赖说明、next-slice/acceptance；不改无关底座。

- [ ] 跑现有场景相关单元、集成、浏览器及B01–B24回归；旧Windows权限相关3个失败在目标部署平台复现并判断真实行为，不能直接关守卫或删断言。
- [ ] 人工改稿/事实变化/规则变化使旧审失效；并发请求/重启不重复产物，跨工作区操作不影响其他运行。
- [ ] 如真实流程使用PDF，验证pdftotext可用及可读/扫描件实物；不使用PDF则如实保留该缺口，不能宣布整体导入已完整验收。
- [ ] 记录临时凭据清理状态，由本机持有人按允许流程处置；不在本任务绕过历史blocked by policy，不把内容打进证据包。
- [ ] 更新AGENTS：定位与事实分项检查、requiredness来源、已见数据标识、成功指标定义、旧审失效及实际命令。
- [ ] 输出小范围diff、实际文件、复测命令/退出码、模型结果、真人核对、UI证据、已知阻塞。当前源码和本轮运行版本必须一致，或明确分界。

**验收:** 真实SKU路径有可复核产物、局部门槛满足、原守卫无退化；整体A/B/C仍保留未完成项。

## 直接交给Codex

> 基于实际源码和上传阶段证据执行本Issue/Plan。先P0，不扩大范围。下一轮唯一目标是一个真实SKU、一个站点，从正常入口完成导入、事实确认、真实模型生成、证据质检、人工审核、导出与旧审失效。优先修claim定位/事实校验边界及requiredness；不要直接以更长SOP、更多模型、接API或放松守卫代替定位根因。保留旧60案原结果，使用新冻结数据验证，并分别报告正确补料、待审产物与人工通过。落实真实文件路径、AGENTS更新、测试/界面/模型证据与未验证项。
