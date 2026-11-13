# ECOM-OPS-v1 工程评测与隔离

这是 controlled_fixture / synthetic 数据集，不是真实卖家数据，也没有业务人员双盲复核。120个案例按30个互斥家电家族划分，每个家族包含事实/规则、Listing、广告、客服四种关联案例：开发40、验证20、测试60。测试集为15事实/研究、15Listing、7广告内容、8广告诊断、15客服，每个task_type均有US与DE。

产品家族不同，功率/电压/功能关注点、规则适用故障、广告行/订单与件数/零分母、客服状态/安全/归属等组合不同。案例仍来自模板化合成，家族内及共享规则行为相关，不能当作120次独立真实经营试验。`manifest.json`记录家族、场景、输入与标签hash；`family_review.human_review`和每标签复核状态均为not_reviewed，待业务专家检查语义与覆盖。

数据集位于 `benchmarks/ecommerce-ops/`：`inputs/`是可见资料，`private/labels/`是独立评分金标，`private/gold.canary`是隔离哨兵。`generate.mjs`仅用于维护合成数据，会更新输入、标签和freeze hash；正式运行不调用生成器，任何改动需新数据版本及重新审核。runner核验manifest和每输入字节hash，scorer核验标签hash及观察到的input hash，单输出目录只允许一个run-id。

数据修订为`dataset_revision=v1.1`。v1.0存在harness/data defect：部分Listing负例只有scenario名称，没有对应缺失/过期规则或字段限制；客服工程分支直接读取fixture对象，模型分支却没有适用商家规则与可消费的已审核订单；广告报表缺少行级证据。旧manifest、120份原输入、generator和worker保存在`artifacts/ecommerce-ops/benchmark-baselines/v1.0-pre-materialization-fix/`，`baseline.json`记录前后hash和原因。全部120个原gold期望及label hash保持不变，没有删难例，也没有为此前DE咖啡机正例补造brew capacity事实。原真实dev失败记录保留，旧结果不能与新冻结输入混作同一A/B。

`materialize.mjs`只消费显式可见业务记录，不读取scenario或gold：

| 任务          | 实际业务输入与冻结路径                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 候选/事实研究 | `product.fact_records`导入后按明确decision确认；`documents`的站点、SKU、类型、卖家、审核、有效期和known_at通过生产知识摄取与检索过滤。feature只是研究主题，不自动成为已确认功能事实。                                                                                                                                                                                                                                           |
| Listing       | missing_power/voltage真实缺行，power_conflict真实两条冲突确认值，pending_fact保留candidate；unknown_policy真实空规则，expired_rule真实过去effective_to，future_rule真实未来known_at；title_limit加载JSON RuleProfile的20字符限制。竞品认证有独立competitor资料，wrong_sku_claim与voltage_isolation有独立SKU/市场产品和受限资料；unsupported_speed/missing_accessory是明确请求但未提供证据的字段。valid_unicode包含Unicode请求。 |
| 广告内容      | 原数据均明确`internal_draft`且没有官方placement profile，保留该真实局限，不把placement编号解释成不同平台位置或已审核投放素材。三组文案必须走同一生成与质量入口。                                                                                                                                                                                                                                                                |
| 广告诊断      | CSV先导入为report源，再走生产解析、报表存储、行级证据与冻结计算；保留订单/件数差异、零分母、未知窗口和未成熟快照。                                                                                                                                                                                                                                                                                                              |
| 客服          | 工单导入ticket源，商家政策按真实期限/市场进入knowledge；订单JSON以SKU/revision绑定的已审核order源导入并由asset_ids显式选择。请求只保留工单，不能自证订单或回执；生产代码派生脱敏上下文与support_guard。危险、归属、缺订单/政策、过期、未来和注入均来自实际字段；工程与模型共用该冻结结果。                                                                                                                                      |

每条observation记录实际materialization（产品事实状态、文档适用元数据、冻结issues/rules、检索过滤、报表证据和脱敏客服gate），供复核输入是否真实到达业务域。dev/validation的60份输入逐案导入/冻结测试另验证字段限制确实由quality函数拒绝、显式过期/未来日期确实过滤，且冻结模型资料不含scenario/expected/label。该工程证据不能代替模型质量或人工复核。

## 运行

```powershell
node scripts/ecommerce-benchmark.mjs --manifest benchmarks/ecommerce-ops/manifest.json --suite test --model configured --variant A --dry-run --output artifacts/ecommerce-ops/evals/dry-A
node scripts/ecommerce-benchmark.mjs --suite test --model none --output artifacts/ecommerce-ops/evals/engineering
node scripts/ecommerce-benchmark.mjs --suite test --model fixture --variant B --output artifacts/ecommerce-ops/evals/contract-smoke
node scripts/ecommerce-benchmark.mjs --suite test --case test-travel-kettle-listing --model configured --variant B --bridge http://127.0.0.1:PORT --bridge-token-file PRIVATE_TOKEN_FILE --output artifacts/ecommerce-ops/evals/configured-bounded
node scripts/ecommerce-benchmark.mjs --suite faults --variant C --output artifacts/ecommerce-ops/evals/faults
```

`--suite`允许dev、validation、test、all、faults；`--variant`允许A、B、C。dry-run仅列任务、预算上限、凭证需求和未知成本，模型调用数为0。失败和未满足边界返回非零退出码，保留failure.json及日志。

三种模式独立报告：

- `--model none`运行真实业务函数的词法检索/适用政策解析、广告确定性计算、客服上下文/执行回执/分支防线。Listing和广告内容等语言任务明确blocked，不用静态文案代替生成成绩。测试60中38可执行、22需要语言生成。
- `--model fixture`通过实际`createEcommerceWorkflow`、`freezeTask`、契约验证及持久阶段，注入synthetic deterministic adapter。adapter只返回带明确解释的needs_input契约对象，不生成假Listing/广告/客服文本。`fixture_contract_schema`是工程smoke，不计入真实首模型/最终schema率、文案质量、证据语义或真实AB完成。
- `--model configured`通过显式配置的loopback bearer bridge调用现有生产模型；未提供bridge时保持not_configured并返回2，不读取用户data或隐式调用provider。父runner从`--bridge-token-file`读取token，仅传给受限worker环境，worker捕获后删除该环境变量；token文件不复制、不授权worker读取、不写入轨迹。URL只接受带明确端口的127.0.0.1或[::1] HTTP地址，不接受用户信息、非根路径、query/hash和重定向。请先授权provider及费用预算，用`--case id1,id2`限定所需案例，不擅自运行120例真实费用调用。

A/B始终使用同一manifest、同一输入、同一冻结事实与规则、同一输出契约和预算。variant由worker显式传入bridge ModelAdapter：A为single plain prompt，B增加任务SOP；两者均保留生产workflow的最终schema、guardedModel与quality检查，报告不能把A描述成没有任何质量检查。synthetic adapter 不能证明提示词方法差异；v1.1 第一轮真实配对 A/B 已执行并单独复核输入/配置/预算，结果见下文。C是实际故障/边界代码测试，不与语言生成质量混算。单个 configured 报告不自动认定配对 A/B 完成；单次运行中的 real_model_ab_completed/ab_completed 标记不是本次配对审计结论。第一轮两个运行已按相同 freeze hash/模型/预算配对，已跑且未达标；真人语言/业务验收仍为 0。

bridge接口固定为`POST /v1/generate`、`Authorization: Bearer TOKEN`，请求JSON为`{task,snapshot,repair?,variant}`，响应`{text,usage}`。task删除原support工单与重复snapshot，只有冻结脱敏资料跨模型边界。bridge服务负责把worker任务映射为已授权server-owned workspace/provider配置，复用生产`configuredModel`；不得请求或加载gold。worker只保存经过契约校验的结构化业务结果与输出hash，不记录provider原始文本/endpoint/token；model_ref统一为sha256标识。非2xx响应只保留白名单code及校验后的数值usage，错误model_ref仅接受已有sha256，message、原始正文及diagnostics不会透传；safe usage随错误保存，失败调用也不丢失已花Token。桥接请求、响应大小和时间有界，单case仍服从冻结执行预算。

## 被测与评分边界

runner将可见输入复制到系统临时目录，子进程以Node `--permission`执行，只允许读取业务源码、依赖、契约、当前输入和scratch，以及只写scratch；无私有标签和原用户data权限。不继承provider凭据、不授予子进程派生权限、无发送/退款工具。每case重建SQLite内存数据库，走实际`importAssets/createProduct/confirmFacts/ingestKnowledge/retrieveEvidence/resolvePolicy/computeAdMetrics/prepareSupportContext`；fixture模式另走生产workflow和freeze。服务端代码的fixture确认身份明确标合成，不冒称真人审核。

worker启动时实际读取private canary，必须得到`ERR_ACCESS_DENIED`才继续；B24测试还独立启动Node进程验证拒读。gold只由结束后的独立`score.mjs`进程读取，模型/worker不加载生成器或评分器。Node权限模型用于受信任业务代码的数据访问隔离；允许的SQLite原生addon和tsx worker不是针对恶意原生代码的操作系统安全沙箱，不宣称容器级隔离。

## 统计与专项

report.json保留逐案失败原因、原始分子/分母、NA、Wilson 95%区间、每task/market计数、P50/P95、重试和Token。工程耗时包含seed与业务执行，不冒充真实模型延迟；有真实usage时另列model_latency_ms。首/最终模型schema率只计算真正调用过模型的case，最终失败回退为合法failed对象不计模型schema成功，持久结果schema独立记录persisted_schema。无真实usage/价格版本时Token与成本为null/unknown，不能填0；成功任务费用只在全部成功任务可定价时计算。检索每case一个query，Recall@5按相关文档锚点计数；零相关金标为NA，错误适用文档仍使case失败。没有真实业务复核时，语言质量、业务试运行和经营收益保持未评价。

configured评分也独立核对检索文档/政策状态、诊断输出指标/成熟度、客服输出分支与实际冻结订单回执；scorer 2.0 区分正确补料与缺产物：客服独立冻结 gate=needs_info 时，合法 needs_input/null 是正确补料；不能把其他本应生成诊断/回复的空对象自动算通过。Listing原有status/功率/电压期望保持不变。fixture仍只记独立契约smoke，不应用这些规则冒充真实业务通过。

`faults.json`把B01–B24绑定实际测试断言，并记录每个匹配测试、状态与文件。缺断言或partial覆盖保持unverified，不凭“全suite通过”自动认定所有专项完整。B19注入真实generation checkpoint故障，再创建workflow恢复，验证模型不重调和唯一成果；B24验证真实拒读及未来知识过滤。B21分别执行格式修复上限、模型不响应signal时仍被执行预算截停、quota拒绝不重试，以及取消后late response不能写入成果。它们是代码故障证据，不能代替真实provider故障/费用的试运行验收。

ESCI未下载/未评测，不报告ESCI官方成绩。真人复核、真实账户 API 和经营收益验证仍未完成。v1.1 第一轮真实模型 A/B 已执行，未达标；产品守卫修正后的第二轮单独运行，不能与第一轮或同产物复评混报。

## v1.1 真实封存 A/B 与复评记录

120 个任务案例归属 30 个互斥产品家族；封存 60 案来自 15 家族。家族内四类任务共用事实/资料，case 之间存在相关性。报告的 case Wilson 95% 区间仅为描述性结果，未作家族相关性校正，不能当作 120 个独立真实经营样本或统计显著证据。

冻结版本为 v1.1，freeze SHA-256：`d4f6a2f209449dd1610faaef03dc1414343610913b44835a27eecee9218cc3a1`。原始输入/gold 与失败不删除、不为提高成绩改期望。第一轮使用同模型、同输入/规则片段/输出契约/预算，A 为单次提示，B 增加任务 SOP；两者都经过生产 workflow 与最终质检。

| 结果层                       |                   A |                   B | 解释与证据                                                                                                                                                                                                                                |
| ---------------------------- | ------------------: | ------------------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 第一轮原始 case_pass         |               22/60 |               16/60 | `artifacts/ecommerce-ops/evals/v1.1-real-A/report.json`、`v1.1-real-B/report.json`，保留原始结果                                                                                                                                          |
| 相同产物的 audit-v2 复评     |               27/60 |               17/60 | `evals/audit-v2/summary.json`、`audit-provenance.json`；scorer 2.0 纠正 needs_info→needs_input 的评分契约冲突，0 新增模型调用，原数据/gold/模型/产物 hash 不变。仅指标口径修正，不是产品提升                                              |
| 产品守卫修正后第二轮真实 A/B | 25/60，完成、未达标 | 21/60，完成、未达标 | `evals/v1.1-guardfix-real-A/`、`v1.1-guardfix-real-B/`；同一 v1.1 输入/预算及 scorer2，各54次实际模型响应、合计108次，broker-08 脱敏汇总。两组 exit1 是评分未达而非基础设施失败。包含产品代码修正和随机模型重新输出，不作单纯方法同比提升 |

第一轮每变体实际调用模型 54 个 task，首/最终 schema 均 54/54，持久 schema 60/60；六个预冻结阻断案例不计入真实模型 schema 分母。确定性广告算术/成熟度为 8/8。A Token 为 input 325954 / output 65169，B 为 input 330486 / output 79260；价格与 price_version 未知，成本 unknown。模型延迟 P50/P95：A 3916/9470ms，B 5257/9071ms。这些是该轮数据，不承诺生产性能/费用。

检索有 15 个研究 query。US 相关且适用锚点为 6/6；DE 的 7 个 query 没有适用 gold 正例，Recall@5 为 0/0=NA，不能通过“DE >=90%”必测门槛。不得用跨站合并 6/6 或研究简报整案通过率替代 DE 检索验收。

尚未独立测量/验收的硬指标包括：事实支持率及应有未输出事实分母、Listing 已知适用必需字段完成率、逐规格跨站数字单位一致性、逐证据授权解析/定位率、已审导出 schema 率、全部模型文本虚构执行次数及真人自然度。case_pass、词法守卫与 persisted_schema 不能替代这些门槛。当前真人复核 0，实际 PDF 环境未验证，B/C 未验收；即使第二轮 case_pass 改变，也不认定整体 A 或关闭总 Issue。

产品守卫修正只改代码契约误报与安全边界：schema 允许的 dot/bracket field_path 归一为 RFC pointer 并阻止原型遍历；明确“不要否词/停投”不误作动作建议；客服合法 ISO 日期不误报 PII，英/德/中无回执已登记/转交语句仍阻断。对应定向回归和当前完整 check 见 [acceptance.md](acceptance.md)，不将代码修正轮与评分修正混称改进。第二轮结果已完成：A25/60、B21/60，两组均未达标，结果分别保存在 [A report](../../artifacts/ecommerce-ops/evals/v1.1-guardfix-real-A/report.json) 与 [B report](../../artifacts/ecommerce-ops/evals/v1.1-guardfix-real-B/report.json)。不把该轮与第一轮的差值归为单纯方法提升。

最终第二轮的 [配对/分组汇总](../../artifacts/ecommerce-ops/evals/v1.1-guardfix-comparison/summary.md) 与 [硬指标审计](../../artifacts/ecommerce-ops/evals/v1.1-guardfix-comparison/gate-audit.json) 已完成；强制补料/转人工分支诊断为 A6/10、B9/10，均未达到95%。剩余 claim/location/PII 等诊断是规则标记，未由真人逐案判为泄露或真实执行事件，也不能当作独立语义事实支持率。

版本边界：真实模型配对仅验证各 run.json 的 code_versions。模型运行结束后，pauseTask 又修复了一个权限/副作用顺序 P1：先按工作区取任务并事务保存，再 abort；错误工作区暂停/取消和事务回滚不会中断 owner 的模型请求。3项回归 red 3 failed → workflow+security22/22 green，日志在 artifacts/ecommerce-ops/final-review/；未为该修复再调用模型，不将旧模型 hash 或质量分数等同当前源码。后续排版变化也不回填成原模型已测。

当前 P1 修复后工程证据为 [all report](../../artifacts/ecommerce-ops/checks/check-1794549745698-d40dcf1f/report.json)：unit140、integration77、browser3、docs154，16步exit0、类型及三端构建通过；[故障 C](../../artifacts/ecommerce-ops/evals/v1.1-final-security-faults-C/faults.json) 为24/24、unverified0、exit0。旧140/74工程快照及 v1.1-final-faults-C 仅保留为历史；这些工程证据不替代模型全部硬指标或经营收益 C。
