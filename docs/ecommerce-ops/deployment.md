# 安装、运行、备份和回退

运行在现有 OpenDot Node/npm/Hono/SQLite 服务中，不增加数据库服务、队列、向量平台或独立 Agent 服务。Windows 不需要 Ubuntu；沿用已配置的原生启动脚本。三个 Node 项目分别 `npm ci`，锁文件未升级。首次启动前先备份现有 data。

## Windows 本地启动

安装依赖和启动必须使用相同的 Node 大版本。当前这台机器的 `better-sqlite3` 已为 Node 24.15.0（ABI 137）安装；Node 22（ABI 127）会报 `ERR_DLOPEN_FAILED`。已在 Windows PowerShell 5.1 中验证 Node 24 可打开内存 SQLite，没有访问用户业务数据库。以下 PATH 调整仅作用于当前终端窗口，其他机器应改成自己的 Node 安装目录。

在项目根目录 PowerShell：

```powershell
$env:Path = 'C:\Users\17495\AppData\Local\nvm\v24.15.0;' + $env:Path
node --version # 本机应显示 v24.15.0
npm run build:all
$env:OPENDOT_ECOMMERCE_OPS='true'
npm run start:windows
```

现有端口仍有服务时，先用原来的停止方式停止那一个服务；不要重复启动，不用宽泛的 node/Docker kill。浏览器登录后从侧栏进入“电商运营”，使用已有自己的工作区。手机访问同一服务的现有 Web/PWA；没有新增客户端。

默认 `OPENDOT_ECOMMERCE_OPS=false`。开关由服务端 `/api/ecommerce-ops/availability` 返回，关闭时入口隐藏且业务接口拒绝访问。Goal 跟进另需既有 `MINICLAW_PERSONAL_GOALS=true`；跟进是有截止与证据条件的**人工 Goal**，`budget_max_runs=1`，需手动推进，不自动调度、退款、发客服消息或批准草稿。

数据路径以启动工作目录为准：`data/db/messages.db`。产品、来源 BLOB、证据、知识版本、运行检查点、成果、审核与导出记录在同一数据库；原文不经聊天 20KiB 或私有成果 64KiB 接口。文件上限取项目 MAX_FILE_SIZE 与场景 50MiB 的较小值；文本提取上限 8MiB，超限明确失败，不冒充全量。PDF 需要可用 pdftotext；本机 PATH 未发现它，实际 PDF 二进制提取未验证，扫描件需另给可读文本。DOCX 使用有界安全 XML 解析，CSV/JSON/DOCX 已做工程验证，未引入 OCR。

## 模型和平台依赖

沿用已配置 Provider、工作区所属 Dot 模型与既有费用/Token 账本；每次生成请求重验 owner、配置指纹和额度，最多首次加一次格式修复。单请求 60秒，场景执行不超过10分钟及既有执行上限的较小值，人工等待不消耗循环。无价格表时成本 unknown。API密钥、Cookie、真实 Provider Endpoint 不进入资料/导出/评测日志。

API“应用可用”和“业务依赖就绪”分开；未配置模型、未导入资料、SP-API/Ads API未接入不能算任务成功。P0依靠授权导入；没有平台写工具。必要的事实和规则片段会发送给用户配置的模型提供方，自托管不等于本地推理；客服进入模型前脱敏。字段词法与数值检查不能替代语义、德语自然度或全部 Amazon 审核规则，业务人员必须复核。

## 备份与恢复

沿用原有备份机制，数据库使用 SQLite backup / VACUUM INTO 一致性快照，不直接复制处于写入中的单个 `.db` 并忽略 WAL。完整灾备还需现有 `data/config` 加密凭据与密钥、其他工作区原有文件。备份包含敏感信息，应使用原部署的私有权限及保管方式，不上传到 Git。

恢复时先停止确切服务，恢复到**独立路径**验证 SQLite quick_check、SourceAsset 原文 SHA-256、产品/知识修订、任务与成果/审核/Goal 引用，再切换数据路径。知识索引为可从完整版本数据重建的确定性词法检索，无外部向量服务需要同步。

数据库由原 `src/db.ts` 迁移机制升级，迁移前备份失败即中止；未修改历史 Goal/聊天表语义。首选回退方式是关闭场景开关并重启，**保留数据及 schema**。旧入口拒绝升级后的数据库是降级保护（本次版本见验收日志；当前版本以 src/db.ts 为准）；不要修改数据库版本号、删表或删除 data 强行启动旧程序。若必须回退全部二进制，使用已确认支持同一 schema 的包，或在保留当前完整数据库的前提下恢复升级前备份至独立目录，并明确新场景数据不会出现在旧版界面。未执行真实生产切换，不宣称生产回滚已完成。

## 验证及产物

```powershell
node scripts/ecommerce-check.mjs all
node scripts/ecommerce-demo.mjs --workspace demo-ecommerce --reset --scenario launch-us-de
node scripts/ecommerce-benchmark.mjs --suite faults --variant C --output artifacts/ecommerce-ops/evals/my-faults-run
```

每个 benchmark 使用新目录，保留失败、配置和轨迹。真实模型验证与合成契约 smoke 分开；验收实际状态见 [acceptance.md](acceptance.md)。没有用户授权服务器/域名，交付本地和隔离测试部署，不购买云资源。

## 本次隔离验证结果

2026-11-13 的 `tests/ecommerce-ops/persistence.integration.test.ts` 两项通过：从本地基线原样旧数据库入口建立旧版数据，再执行当前迁移与私有备份，跨进程重开和独立路径恢复后检查 160000-byte 原文 BLOB、hash 及事实/知识/任务/审核/Goal 引用；旧入口尝试读取升级库被拒，库版本和数据未被改写。flag OFF 使用真实签名会话与已注册 Hono auth/chat/Goal 路由确认历史数据仍可读，电商写入 404。见 `artifacts/ecommerce-ops/t11/persistence-green.log`、`result-summary.json`。

这是隔离数据库与路由验证；旧入口不是完整历史应用包，未在生产切换二进制。相关既有回归 35 项中 32 通过、3 个旧 product-approval Windows POSIX mode/backup mode 假设失败，日志 `artifacts/ecommerce-ops/t11/regression.log`，没有放宽私有文件权限守卫。前一完整 check 通过 unit84/integration73/browser3/docs153；产品守卫更新后的 check-1794548758841-22f86c07 为140/74/3/153；最终 P1 修复后的当前 check-1794549745698-d40dcf1f 全16步 exit0：unit140/integration77/browser3/docs154、5组 types 和 root/web/runner build，独立构建证据见验收记录；不能称全仓测试全过。

本机真实 Provider 已完成 US/DE Listing 开发样本 A/B 四次请求，费用仍 unknown；DE 过度补料失败保留，随后 v1.1 第一轮真实封存 A/B 已跑：原 A22/60、B16/60，同产物 audit-v2 为 A27/60、B17/60，属于评分契约修正且未达标。产品守卫修正第二轮 A25/60、B21/60 均已完成未达标，108次实际模型响应正常，两组 exit1 为评分未达标，真人语言评分仍为 0。订单只消费已审核且范围匹配的导入记录，人工导入审核不等于平台 API 接通。真实产品/规则/报表/工单与五工作日试用均未完成，不将测试部署或 synthetic provider 的浏览器流程称作生产业务验收。

早期 01–03 私有副本的清理被自动审批拒绝（原因未知），04/05/07 的 Windows EPERM 也留下副本，08 已退出但仍有三份凭据副本、状态 directory_cleanup_pending。目录列表与手动处置的独立阻塞记录见 [temporary-verification-cleanup.md](temporary-verification-cleanup.md)；不得通过读出、复制到仓库或关闭权限守卫绕过。

人工 Goal 回调另以真实 HTTP 测试验证 1/1：重复创建仅一个 Goal，重复 refresh 不改版本；变参冲突 409、其他 workspace 404；manual_only、budget_max_runs=1、无任务/执行自动注册，completed 后草稿仍未获批。证据为 `artifacts/ecommerce-ops/t11/goal-http-green.log`；变异 red 日志保留。
