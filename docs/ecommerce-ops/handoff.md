# 电商运营 P0 实施交接

更新：2026-11-13。现已交付可运行的 P0 初版；**整体 A 工程验收尚未达标，总 Issue 保持未关闭，B 业务试运行和 C 经营收益均未验收**。真实封存模型 A/B 已跑并保留失败，不能描述为“尚未调用真实模型”，也不能把工程测试通过称为业务完成。

## 当前可运行的范围

现有 OpenDot 内新增中文 `/ecommerce-ops` 工作台，沿用登录、工作区权限、Provider、SQLite、用量记录与人工 Goal。五类任务为候选资料比较、Listing、三组广告内容、SP 导入报表只读诊断、客服草稿；共享已确认 SKU 事实、适用规则和证据，支持补料/重跑、改稿、精确版本审核及 JSON/Markdown/诊断 CSV 导出。

US/en-US/USD 与 DE/de-DE/EUR 分开；Listing/ad/support 每次绑定一个 SKU。原文保留授权 BLOB；客服先脱敏，订单只能显式选择唯一已审核且匹配 SKU/范围的导入版本，不能从请求正文自证已退款。模型无平台写工具，不能上架、改价/竞价/预算、退款/补发或发送消息。SP-API / Ads API 为 P1，尚未接入。功能开关默认 OFF；Goal 仅人工推进、budget_max_runs=1，completed 不等于内容获批。

## 本机启动与复现

在 PowerShell 中使用实际项目目录及既有依赖/Provider 配置：

```powershell
Set-Location 'D:\opendot\OpenDot-main-0689098\OpenDot'
$env:Path = 'C:\Users\17495\AppData\Local\nvm\v24.15.0;' + $env:Path
node --version # 本机应显示 v24.15.0，与已安装的原生依赖一致
npm run build:all
$env:OPENDOT_ECOMMERCE_OPS='true'
npm run start:windows
```

安装依赖和启动须用相同 Node 大版本；上述 Node 路径为本机已验证的 24.15.0，仅改变当前窗口 PATH。其他机器按实际安装目录调整。登录后选择自己的现有工作区，从侧栏进入“电商运营”。人工 Goal 另需既有 `MINICLAW_PERSONAL_GOALS=true`；未启用时 follow-up 返回 503。应用 health 分开显示模型配置与资料就绪，不把未配置依赖显示为任务成功。完整启动、备份/恢复与关闭开关步骤见 [deployment.md](deployment.md)。

```powershell
node scripts/ecommerce-check.mjs all
node scripts/ecommerce-demo.mjs --workspace demo-ecommerce --reset --scenario launch-us-de
node scripts/ecommerce-demo.mjs --workspace demo-ecommerce --reset --scenario conflicting-evidence
node scripts/ecommerce-demo.mjs --workspace demo-ecommerce --reset --scenario operations-boundaries
```

demo/reset 仅能操作指定且带标记的 demo workspace；测试不使用用户 data 或原运行服务。模型评测会产生真实调用，复现时沿用显式授权的私有 bridge/budget 配置，每次使用新 run-id；不把凭据写入命令记录、仓库或日志。

## 当前证据与验收

| 层次                                 | 实际状态                                                                                                                                                                                                 | 证据入口                                                                                                                                                                                                                                                                                                         |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 当前完整工程 check（最终 P1 修复后） | **passed**：unit 140/140、integration 77/77、browser 3/3（24.5s）；5 组 types、root/web/runner 构建、docs 154，全 16 步 exit0                                                                            | [当前 report.json](../../artifacts/ecommerce-ops/checks/check-1794549745698-d40dcf1f/report.json)                                                                                                                                                                                                                |
| 安全修复前的工程快照                 | passed：unit 140、integration 74、browser 3、docs 153；仅保留历史，不能替代当前快照                                                                                                                      | [前一 report.json](../../artifacts/ecommerce-ops/checks/check-1794548758841-22f86c07/report.json)                                                                                                                                                                                                                |
| UI/人工 Goal/业务门槛                | DOM 8/8、browser 3/3 使用 synthetic provider；真实 HTTP Goal 1/1；review/ad-profile/API/order 定向回归 18/18，含诊断 JSON/CSV/null round-trip                                                            | [验收映射](acceptance.md)；各次重复用例不叠加成独立样本                                                                                                                                                                                                                                                          |
| 数据恢复/开关                        | 持久化 2/2：旧入口迁移、私有备份、跨进程恢复 BLOB/hash/引用、拒降级；flag OFF 保留 auth/chat/Goal                                                                                                        | [T11 汇总](../../artifacts/ecommerce-ops/t11/result-summary.json)                                                                                                                                                                                                                                                |
| 最终故障注入 C（P1 修复后）          | 当前实现 24/24，unverified=0、exit0；为工程故障断言，不是经营收益层 C                                                                                                                                    | [faults.json](../../artifacts/ecommerce-ops/evals/v1.1-final-security-faults-C/faults.json)、[测试日志](../../artifacts/ecommerce-ops/evals/v1.1-final-security-faults-C/fault-tests.log)                                                                                                                        |
| 最终 P1 审查                         | pause/cancel 现在先校验工作区并事务保存，成功后才 abort；错误工作区和保存回滚不能中断 owner 的运行。3 个回归先红后绿，workflow+security 22/22，类型检查通过；新增 3 项归入当前 integration77，不重复累计 | [red](../../artifacts/ecommerce-ops/final-review/workflow-red.log)、[green](../../artifacts/ecommerce-ops/final-review/workflow-security-green.log)                                                                                                                                                              |
| 既有相关回归                         | 32 pass / 3 fail；旧 product-approval 的 Windows POSIX mode 假设失败保留，未放宽安全判断                                                                                                                 | [regression.log](../../artifacts/ecommerce-ops/t11/regression.log)                                                                                                                                                                                                                                               |
| v1.1 第一轮真实封存 A/B              | 原始 A22/60、B16/60；已跑且未达标                                                                                                                                                                        | [A](../../artifacts/ecommerce-ops/evals/v1.1-real-A/report.json)、[B](../../artifacts/ecommerce-ops/evals/v1.1-real-B/report.json)                                                                                                                                                                               |
| audit-v2，同产物复评分               | A27/60、B17/60；仍未达标。0 新增模型调用，原输入/gold/模型/产物不变，仅修正正确 needs_info 补料被误要求 draft 的评分冲突，不能称产品提升                                                                 | [summary.json](../../artifacts/ecommerce-ops/evals/audit-v2/summary.json)、[provenance](../../artifacts/ecommerce-ops/evals/audit-v2/audit-provenance.json)                                                                                                                                                      |
| 产品守卫修正后第二轮真实 A/B         | **A25/60、B21/60，均已完成、未达标**。同 scorer2/v1.1 输入/预算，broker-08，新模型请求；包含新产品守卫与随机重新输出，不作单纯方法同比提升                                                               | [第二轮 A](../../artifacts/ecommerce-ops/evals/v1.1-guardfix-real-A/report.json)、[第二轮 B](../../artifacts/ecommerce-ops/evals/v1.1-guardfix-real-B/report.json)、[broker-08 脱敏汇总](../../artifacts/ecommerce-ops/real-model/broker-08/summary.json)。两组 exit1 表示评分未达标，108 次实际模型响应正常完成 |
| B/C                                  | 两站五模块均无真实资料/真人验收，未连续 5 工作日；收益未验证                                                                                                                                             | [逐模块 A/B/C](acceptance.md)                                                                                                                                                                                                                                                                                    |

第二轮 [配对与分组审计](../../artifacts/ecommerce-ops/evals/v1.1-guardfix-comparison/summary.md) 核对同模型、输入、预算和已记录代码版本，108 次真实响应没有 Provider 基础设施失败；质量分数仍未达标。该轮只覆盖其 run.code_versions 记录的源码，随后工作区取消/暂停权限顺序修复已完成，但未再调用模型，不能把旧模型 hash 等同当前源码或将安全修复追加为已测模型成绩。硬指标及缺口见 [gate-audit.json](../../artifacts/ecommerce-ops/evals/v1.1-guardfix-comparison/gate-audit.json)。

模型运行记录的 13 份代码与 5 份提示词均已按原哈希保存到 [source-snapshot/manifest.json](../../artifacts/ecommerce-ops/evals/v1.1-guardfix-comparison/source-snapshot/manifest.json)。工程检查后仅统一代码/文档排版；format check 通过，248 份封存输入、金标、清单和提示词的字节哈希未变，见 [格式检查](../../artifacts/ecommerce-ops/format-final/format-check.log) 与 [冻结校验](../../artifacts/ecommerce-ops/format-final/frozen-verification.json)。`.prettierignore` 只排除这些按字节封存的资料，不排除应用源码或测试。

v1.1 共 120 个合成任务，来自 30 产品家族；封存 60 案来自 15 家族。家族内任务相关，case Wilson 区间仅描述性、未校正家族相关性，不作 120 个独立真实业务样本或统计显著结论。原始、同产物复评、产品修正后的重新调用三个结果层必须分别留存。

第一轮每变体实际模型 schema 54/54、持久结果 schema 60/60，算术/成熟度 8/8；这些不能推出语义、平台适用性或整体 A 达标。DE 检索正例分母为 0/0=NA；事实支持率和 Listing 必需字段完成率尚无独立分母；逐证据可授权解析、跨站逐规格一致性、模型已审导出也未独立全部验收。真人语言/可用性复核为 0。PDF 代码依赖 pdftotext，本机 PATH 缺失，实际 PDF 二进制未验证；DOCX/CSV/JSON 有工程证据。Token/延迟有记录，无可靠价格版本时费用 unknown，不能填零。

产品修正轮解决 schema 允许的 dot/bracket claim 路径误报、否定投放动作误报和客服 ISO 日期误报，并补上无回执“已登记/已转交”的英/德/中守卫；没有改标签或放宽事实/审核边界。即使第二轮 case_pass 改变，上述独立指标与环境/真人缺口仍使 A 未验收。

## 下一步优先级

1. 按第二轮逐案质量 issue 复核模型任务质量，区分正确补料、真实漏字段/不支持声明与剩余代码误报；独立建立事实支持和已知适用必需字段分子分母。保留失败，不用合法 schema 或整案分数替代这些硬指标。
2. 补有来源、适用且可复核的 DE 检索正例，版本化资料与金标后重新评测每站 Recall@5；当前 0/0 不能“按通过”处理。若改输入/gold，必须另建版本，不与 v1.1 原始结果混报。
3. 按 US/DE 五模块收集授权真实候选、确认产品及规则、脱敏广告报表、工单/订单与政策，安排业务人员语言/可用性复核和连续至少 5 个工作日试用；逐模块有证据才验 B，经营收益另做实际工时记录/线上对照。
4. 补齐本机 pdftotext 与实际可读/扫描 PDF 验证；如需生产切换，按部署文档在独立恢复路径核验备份、权限与版本，不修改数据库版本或删除业务数据绕过降级保护。

真实实现/接口见 [repo-map.md](repo-map.md)，执行勾选见 [PLAN_ECOMMERCE_OPS.md](PLAN_ECOMMERCE_OPS.md)，需求/边界/测试证据见 [acceptance.md](acceptance.md)，评测方法与限制见 [benchmark.md](benchmark.md)。

早期 01–03 私有临时副本清理两次被自动审批拒绝，原因未知；04/05/07 退出清理遇 Windows EPERM，副本仍在，08 已退出，仍有三份凭据副本待手动处置。未绕过拒绝，完整目录和用户手动处置入口见 [temporary-verification-cleanup.md](temporary-verification-cleanup.md)。
