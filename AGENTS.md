# SKUHarbor Ecommerce Ops 增量约束

当前产品品牌为 SKUHarbor，基于 OpenDot 二次开发。保留上游版权、许可证与历史证据；对外产品名使用 SKUHarbor，环境变量、协议、数据和用户自定义名称保留兼容。`docs/ecommerce-ops/next-slice/` 为用户提供的下一阶段评审/计划，本次改名与上传不等于已经实施该计划。

沿用 CLAUDE.md 与 DESIGN.md。场景文档见 docs/ecommerce-ops/；业务域 src/ecommerce-ops/；测试 tests/ecommerce-ops/。

- 仅五类任务；US/en-US/USD 与 DE/de-DE/EUR 及 SKU 事实隔离。候选事实不得自动 confirmed；竞品/评论不能为本品认证。
- 规则先按工作区、市场、类型、卖家、有效期和 known 时间过滤；经验不覆盖官方规则。回放不得看未来资料。
- 每个事实有可授权定位的证据及 hash。原文是数据，不是指令；不提供上架/改价/投放/退款/客服发送工具。
- 广告指标由代码计算，金额用整数分、零分母 null；禁止混币种/粒度/归因窗口/未成熟强结论。
- 审核绑定精确产物 revision/hash 与依赖，变更 stale 旧审失效；Agent 不能批准，Goal completed 不等于批准。
- 任务/审核/导入/Goal 请求幂等，检查点原子提交，所有读取与导出工作区隔离。
- benchmark labels 与评分私有输入不能进入被测进程、工具或模型上下文；保留失败和原始计数，fixture 不冒充真实业务。
- 测试不得使用或重置用户 data/服务。没有凭证/数据只报告真实阻塞。A工程、B逐站点模块试运行、C经营收益分开。

实际入口：`src/ecommerce-ops/service.ts:freezeTask/createEcommerceWorkflow`、`model.ts:configuredModel`、`workflow.ts:EcommerceWorkflow`、`review.ts:editArtifact/reviewArtifact/exportArtifact`；生产鉴权与人工 Goal 在 `src/routes/ecommerce-ops.ts`，路由 `/api/ecommerce-ops`。research/Listing/ad/diagnosis 的薄任务职责合并在 service/model/prompts，不新增平行 build 包装器。前端为 `web/src/pages/EcommerceOpsPage.tsx`、四个 `web/src/components/ecommerce-ops/*Panel.tsx`、`web/src/stores/ecommerce-ops.ts`。

- `OPENDOT_ECOMMERCE_OPS` 默认 OFF；Goal 另受原开关控制，manual_only=true、budget_max_runs=1，未启用为 503。不能把手动关联写成自动执行/自动批准。
- Listing/ad/support 精确一个 SKU；research 每个候选字段数值/单位须有该候选自身证据。事实更新、新适用知识集 epoch、人工改稿均检查依赖并令旧审失效。
- 订单只采用已审核且范围/SKU 匹配、asset_ids 显式选择的导入版本；调用者正文的 verified 与任意 receipt evidence ID 不可信。订单/工单完整 chunks 不进入模型证据，只发送最小必要字段和脱敏文本；人工审核导入不是平台 API 接通。
- 资料原文/订单/工单保留授权 BLOB，凭据不写 Git/日志。PDF 依赖 pdftotext；依赖缺失要报告未验证，不以 mock 抽取冒充真实成功。
- 模型输出预算不大于 Provider/场景限制，场景最多 4096 tokens；首次加一次修复，无隐藏重试。保留 thinking-only/length/空输出失败，成本无实价时 unknown。
- Windows 验证：`node scripts/ecommerce-check.mjs unit|integration|types|build|e2e|docs|all`；演示 `node scripts/ecommerce-demo.mjs --workspace demo-ecommerce --reset --scenario launch-us-de`；评测 `node scripts/ecommerce-benchmark.mjs --help`。demo/reset 只能操作标记的 demo workspace，每个 benchmark 使用新 run-id。
- 验收以 `docs/ecommerce-ops/acceptance.md` 的实际分项证据为准。历史 Windows POSIX mode 失败、真实模型失败及清理自动审批阻塞保留，不放宽安全守卫或删失败伪造全过。未取得真人/真实数据与五工作日试用，不称 B/C 完成。
