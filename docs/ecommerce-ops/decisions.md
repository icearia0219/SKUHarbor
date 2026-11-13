# 实施决策

- 2026-11-12：执行电商 P0 交接，停止竞品情报实施。根目录原始规划保持原文；docs 内 Plan 为真实路径绑定后的执行副本，不更改 Issue 的范围和阈值。
- ZIP 源码原无 Git，以现有文件建立仅本地基线 `28c3204dce2d85830402b1ef1b6f1f90c6f40f99` 和 `work/ecommerce-ops` 分支；保留既有 Windows 改动与用户 data，无 remote/PR。
- 沿用 Hono、React、SQLite、现有 Pi Provider/工作区模型、用量账本与 Goal；无工具文本生成，不增加第二 Agent 平台或调度器。
- `tasks/research.ts/listing.ts/ad-copy.ts/ads-diagnosis.ts` 没有独立创建：其薄任务职责合并为 `service.ts:freezeTask`、`model.ts:configuredModel` 与版本化 prompts；`export.ts` 合并为 `review.ts:exportArtifact`。这是实施合并，不是未绑定占位路径。前端实际为四个 Panel + page + Zustand store，见 [repo-map.md](repo-map.md)。
- 大原文使用同一 messages.db 的不可变 BLOB，与事实/知识/任务/审核一同备份；不使用有 64KiB 限制的 private artifact 或另建数据库。CSV/DOCX/XML/归档解析有界；PDF 需要 pdftotext，本机未验证实物提取。
- 产品规格使用 typed value/unit，候选须人工理由与 CAS 确认；Listing、ad、support 精确一个 SKU，research 候选数值与单位必须属于各自证据。竞品资料不会晋升为本品认证。
- 先词法检索。workspace/market/type/seller/product/审批/effective/known 先过滤再排序；知识修订不可回填旧 known 时间。新增适用规则即使不进 topK，也更新 knowledge collection epoch，令旧审核失效。
- 生成、改稿、审核与导出共用质检，服务器冻结指标和客服分支，人工编辑也不能修改代码指标后获批。审批绑定确切 revision/hash/依赖；请求、检查点与成果持久化幂等。
- 客服订单通过已审核、同工作区/站点/SKU 且 request.asset_ids 显式选择的导入版本取得；HTTP 请求正文的 verified/任意 evidence ID 不可信。仅时间/状态等必要字段证据可进入模型，原订单/工单完整 chunks 被排除，原文保留授权 BLOB。人工核验导入记录不等于平台 API 回执；真实业务未验收。
- 广告金额为整数分，比例由代码先汇总分子分母再算，零分母 null；不混币种/窗口/时区/粒度；不成熟归因不生成直接否词/停投强结论。
- Goal 跟进使用现有 feature gate、截止和证据条件，manual_only=true、budget_max_runs=1；未启用返回 503，completed 不等于批准。默认 OPENDOT_ECOMMERCE_OPS=false。
- 模型输出上限取 Provider/场景的较小值，场景最多 4096 tokens、首次加一次修复；既有 SDK 协议验证后仅对精确官方 DeepSeek 兼容接口关闭 thinking，不抬高预算、不用隐藏重试掩盖失败。空/只有思考/长度耗尽分开留存；无可靠价目时成本 unknown。
- P0 导入优先；SP-API / Ads API 为 P1 未接入，无平台外写工具。Amazon PTD 只做明确列出的部分字段/标准 schema 检查，未实现 Amazon 扩展词汇时不称全量平台有效。
- benchmark 采用 120 案 40/20/60 与 24 边界；controlled fixture、实际模型、真人语言/真实业务分开。labels 只在评分进程，受限 worker 实读应被拒绝；保留旧失败和版本，不把补料/失败从分母删除。新版本结果不得继承旧 fixture smoke 分数。
- T11 真实旧数据库入口升级/备份/重开/恢复与 flag OFF 已有证据；相关既有回归 32 pass / 3 fail，旧 Windows POSIX mode 假设问题保留，未放宽权限。不称生产部署或全仓测试通过。
- 2026-11-13：自动审批两次拒绝清理早期三个私有验证目录的凭据副本（blocked by policy，无具体理由），停止对这些目录的读取/删除；另有 04/05/07 因 Windows EPERM 留下副本，08 已退出但三份副本仍在、状态 directory_cleanup_pending，不再声称正常退出均清理；记录于 [temporary-verification-cleanup.md](temporary-verification-cleanup.md)。不把原始凭据写入 Git/日志。
- A 工程、B 各模块 US/DE 五工作日试运行、C 经营收益分别登记；目前整体未验收，详见 [acceptance.md](acceptance.md)。

- v1.1 第一轮真实封存 A/B 使用相同模型、输入 freeze hash 与预算，原始 A22/60、B16/60。scorer 2.0 仅修正独立冻结 needs_info 时合法 needs_input 被误要求 draft 的契约冲突，原模型/数据/gold/产物 hash 不变、新模型调用 0，audit-v2 结果 A27/60、B17/60；这是评分修正，不是产品提升。
- 随后修正产品契约误报：schema 允许的 dot/bracket field_path 与 RFC pointer 等价并阻断原型遍历；未成熟广告中的明确“不要否词/停投”不当作执行建议；客服合法 ISO 日期不误作 PII，英/德/中无回执的已登记/转交语句仍阻断。这些是代码修正而非改标签，固定源码后在 v1.1-guardfix-real-A/B 重新调用相同模型/输入/预算：A25/60、B21/60，均已完成但评分未达标，各54次响应、合计108次。两组 exit1 不是基础设施失败；包含产品代码变更和随机模型重新输出，结果单独报告，不作纯方法同比提升。
- 120 合成案例来自 30 产品家族，封存 60 案来自 15 家族。case Wilson 区间未作家族相关性校正，仅描述性，不宣称统计显著或 120 个独立真实经营样本。DE 检索正例分母 0/0=NA、独立事实支持/字段完整率缺口、实际 PDF 未验证及真人 0 均保持未验收，即使第二轮 case_pass 提高也不关闭 A 总验收/Issue。

- 最终审查修复 pauseTask 的确定 P1：原先 abort 发生在工作区读取失败/事务失败之前，错误工作区可先中断 owner 请求再得到404；现在 scoped getTask/save 事务成功后才 abort。新增错区 pause/cancel 与事务回滚3回归先红，workflow+security22/22绿色、类型检查通过。最终当前 all 为 check-1794549745698-d40dcf1f（140 unit /77 integration /3 browser /154 docs、16步exit0），新代码故障 C 为 v1.1-final-security-faults-C（24/24、unverified0）。
- 真实第二轮 A25/60、B21/60 仅属于修复前 run.code_versions；没有为最后权限顺序修复再次调用模型。当前安全修复和之后排版的源码字节不能与旧模型 hash 混为同一快照，模型质量未达标与 A/B/C 验收结论不变。完整配对/门槛证据见 artifacts/ecommerce-ops/evals/v1.1-guardfix-comparison/summary.md 与 gate-audit.json。
