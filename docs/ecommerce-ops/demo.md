# 电商运营可复现演示

本演示使用虚构 US / DE 商品、合成规则、合成广告数据与合成工单。规则中的权威身份只用于隔离测试，不是 Amazon 官方政策认证。模型响应由本地测试 provider 生成，业务 API、冻结输入、质检、SQLite 持久化、审核与导出执行真实代码。

## 自动演示入口

可运行的纯业务演示入口为 `scripts/ecommerce-demo.mjs`；不启动 HTTP、Agent 平台或后台，不读取生产账号。它复用实际 `createEcommerceWorkflow`、事实/知识/报表函数、SQLite 表、质检、审核与导出，使用明确的 `synthetic.fixture.v1` adapter 和 `synthetic.operator` 模拟人工确认。

```powershell
node scripts/ecommerce-demo.mjs --workspace demo-launch-us-de --reset --scenario launch-us-de
node scripts/ecommerce-demo.mjs --workspace demo-conflicting-evidence --reset --scenario conflicting-evidence
node scripts/ecommerce-demo.mjs --workspace demo-operations-boundaries --reset --scenario operations-boundaries
```

三条命令均实际执行成功，报告位于 `artifacts/ecommerce-ops/demos/<workspace>/report.json`，原始 fixtures、`demo.sqlite` 和真实导出文件保留在同目录。每个演示还保存 153000 字节原文 BLOB，关闭重开 SQLite 后核验完整字节/hash 与任务/产物/导出引用。缺少输入或断言失败时命令返回非零并写 failed 报告，不能只输出成功文字。

重复执行同一 workspace/scenario、去掉 `--reset`，会核验既有持久化引用和导出 hash，返回 `replayed: true`，不再次生成。`--reset` 只接受 `demo-` 前缀、限定目录内且有匹配 `.ecommerce-demo.json` marker 的演示，拒绝生产名称、路径穿越和 junction/symlink；只清理该演示数据库及 exports，不删除生产数据。不存在的演示目录可首次创建 marker。需要保留不同场景历史时使用不同 workspace。

另有真实浏览器演示：`web/tests/e2e/ecommerce-ops.spec.ts`，配置为 `web/playwright.ecommerce.config.ts`。配置不复用或停止用户正在运行的服务。每条测试使用现有 `botHandoffHttpFixture` 创建随机端口、独立临时数据目录和本地 provider；结束后只清理自己的 fixture。

推荐直接运行已交付的检查入口，让 E2E 自动编译真正的隔离 backend/web 产物：

```powershell
node scripts/ecommerce-check.mjs unit
node scripts/ecommerce-check.mjs integration
node scripts/ecommerce-check.mjs e2e
# types → unit → integration → root/web/runner build → 隔离 E2E → docs
node scripts/ecommerce-check.mjs all
```

检查入口复用 `vitest.ecommerce.config.ts` 与现有 Playwright，不新建测试框架。unit 跑纯函数/仓库和前端 DOM；integration 跑 API、workflow、review、domain/security、benchmark/model-budget 和 demo。各步记录命令、退出码和日志，任何失败都会让整体非零。`types`、`build` 和 `docs` 也可单独运行。普通 build 更新生成的 dist；E2E 则把 backend/web 都编译到 `artifacts/ecommerce-ops/checks/<run>/isolated/`，传入受目录限制的 backend entry 和 web dist，不能用旧 dist 伪造通过。shell 环境可通过同名无后缀 wrapper 调到 Node 入口。

也可在开发副本准备标准产物后，直接运行 Playwright：

```powershell
# 仓库根目录；正常构建会更新生成目录与前端图标。
npm run build
npm run build:web

Set-Location web
node ../scripts/run-node-cli.mjs playwright test --config playwright.ecommerce.config.ts
```

本地 Windows 默认使用已安装的 Microsoft Edge；可通过 `OPENDOT_TEST_BROWSER_CHANNEL` 指定 Playwright 可用的浏览器通道。其他平台需要已安装 Chromium。

如需保护已有 `web/dist`，可把已经生成的隔离前端构建目录通过 `OPENDOT_ECOMMERCE_WEB_DIST` 传给测试。测试只替换自己临时目录中的 web junction，不修改源目录或现有产物。本次最终验证使用 `artifacts/ecommerce-ops/t9/web-dist-r4`，不使用真实用户的数据目录。

每次浏览器执行都是新环境；纯业务演示的 reset 仅针对带 marker 的私有演示目录。不要把测试 provider、测试账号或 `synthetic.operator` 当作实际业务审核人。

## 演示一：US / DE 上新草稿、审核和下载

测试创建独立 US / DE SKU，分别导入 1500 W 与 2000 W 合成规格，人工确认候选事实，再导入带版本与适用范围的合成规则。桌面执行 US，390 × 844 手机视口执行 DE。

在中文工作台选择正确产品和站点，创建 Listing 任务。测试 provider 必须读取生产 prompt 的 FROZEN_DATA 并复制绑定标识、冻结证据与该 SKU 的功率，不能返回脱离上下文的固定“成功”。

任务进入等待审核后，操作者填写理由，通过审核并下载 JSON。测试读取下载文件，比较内容 Hash 与界面所展示的精确版本，检查站点和有效审核；刷新页面后确认审核仍由持久层返回。

核对点：不串规格；当前 revision/Hash 可见；未审不可正式下载；手机抽屉可操作；刷新保留审核。该流程不向 Amazon 提交任何内容。

## 演示二：冲突、过期规则与补料后恢复

同一个 US SKU 同时确认两份冲突功率，导入一份已经过期的测试规则。创建 Listing 后应进入 needs_input，产物列出 FACT_CONFLICT，并禁用通过审核。

在产品页选择冲突候选，填写理由并拒绝错误值；导入新的适用规则，回到原任务点击“补料后恢复”。服务端使用新 input_revision 形成独立产物，并保留旧产物的预览导出。

核对点：第一次失败真实保留；模型不自行选规格；新资料能被新时刻看到；同任务恢复不覆盖历史产物；不能把旧审核复制到新输入版本。

## 演示三：广告零分母与退款草稿的操作边界

导入 SP 活动 CSV，报告含花费但曝光、点击和归因销售额均为零，使用 USD、明确账户、时区、粒度和归因窗口。通过真实报表导入与服务端计算，ACoS、CPC、CTR 应保留 null；界面显示未知/不可计算，不能显示为 0%。

随后创建一个请求退款并含有注入指令与虚构邮箱的客服工单。上下文进入 provider 前需要脱敏。结果只允许 needs_info 或 escalate 等草稿动作，不得声称退款已完成。测试同时记录浏览器写请求，确认没有退款、竞价、预算或消息发送请求。

核对点：原始金额与 ratio 语义保留；没有前端重算；缺少订单/执行回执时不编造执行状态；原始 PII 不进入模型请求；无平台外部写入。

## 本次实际证据与保留的红结果

| 检查                         | 实际结果                                                                    | 证据                                                                                                       |
| ---------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 前端 DOM / 交互              | 8 / 8 通过                                                                  | `artifacts/ecommerce-ops/t9/unit.log`                                                                      |
| 三条真实后端浏览器演示       | 最终轮 3 / 3 通过，30.9 秒，exit 0                                          | `artifacts/ecommerce-ops/t9/browser-run-3.log`；此前完整通过轮为 `browser-run-2.log`                       |
| 正常加载、移动布局、审核下载 | US 桌面 / DE 手机均保存截图                                                 | `artifacts/ecommerce-ops/t9/browser/`                                                                      |
| 原始浏览器失败               | 第一次因嵌套 label 文本匹配失败，已修复为显式 htmlFor / id                  | `browser-run-1.log` 与 `browser-run1-artifacts/`                                                           |
| 可重复纯业务演示             | 三条命令均 exit 0；含同任务重冻结、零分母、退款 needs_info、BLOB 持久化核验 | `artifacts/ecommerce-ops/demos/demo-{launch-us-de,conflicting-evidence,operations-boundaries}/report.json` |
| Demo / CLI 安全与重复运行    | 8 / 8 通过，含未标记目录与 dangling junction 拒绝                           | `artifacts/ecommerce-ops/t11/demo-tests.log`                                                               |

首轮旧浏览器的第三例在已确认同一缺陷后结束了自有 headless browser；测试 finally 清理了自有 backend。该例保留为失败/中断，未计入通过。第二轮完整通过，最终显示精简后又完整通过第三轮。

本证据支持本地工程链路与合成边界验证，不支持真实模型质量、真实产品/政策合规、所有五任务族的全站点业务验收、五工作日试用或经营效果。平台 API 未接通。进一步验收需按照 [acceptance.md](acceptance.md) 逐项补充真实模型、业务人员和真实脱敏资料证据。
