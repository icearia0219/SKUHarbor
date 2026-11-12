# Windows 原生运行验收记录

日期：2026-11-12。源码目录：`D:\opendot\OpenDot-main-0689098\OpenDot`。

基线为用户提供的 `OpenDot-main-0689098.zip`，SHA-256 为 `6ad0c73471871885dea087bd6d3ade264475316e8a5b1f94772557d0ef74ce49`。解压目录没有 Git 元数据；本次直接修改该目录，未创建提交或远端 PR。

## 交付范围

- 新增 `setup:windows` 和 `start:windows`，按三个 lockfile 安装依赖并构建；使用可写 npm 缓存，兼容 PowerShell 和自定义 Git 安装位置。
- 原生命令发现支持大小写不同的 PATH、PATHEXT 和 `node.exe`。Host、脚本和插件使用 Git for Windows Bash，排除 System32 的 WSL 启动入口。
- Pi 保留原有工具定义、输出处理和工具权限策略，使用 Windows 执行后端；有效 shell 设置不受项目内旧 WSL 设置干扰。
- Windows 取消同时处理原生进程树和 MSYS 逻辑后代；明确脱离的持久服务使用完整 stdio 重定向与 `disown`，由调用者负责关闭。
- Skills 与上下文目录使用 junction，文件投影使用受跟踪副本，清理时保留用户修改的文件。
- 私有数据在写入密钥前建立并校验 Windows ACL；保留历史公开权限时拒绝继续，不递归改写已有数据。工作区内正常依赖 junction 不阻止重启。
- 修复 Windows 跨盘路径、备用数据流和保留设备名的文件管理边界；补充原生 Windows CI 入口、运行文档及回归测试。

## 实际验证方式

本机环境为 Windows、Node.js 24.15.0、npm 11.12.1、Git for Windows（`D:\git\Git`）和 Microsoft Edge。根项目、Web 与 Runner 的 `npm ci` 均实际执行成功。首次遇到机器级 npm 缓存 EPERM，改用可写缓存后安装完成，SQLite 与 node-pty 原生模块可加载。

Backend、Web 和 Runner 已实际构建；Web 仅报告现有的大 chunk 提示。另以不含根 `shared` 目录的隔离源码布局检查 Windows Runner 模块编译，确认 Linux 容器构建不会静态依赖容器外的 Windows helper。未执行完整 Linux/Docker 功能验收。

浏览器验收使用真实 Web 页面、HTTP Backend、SQLite、生产 Pi Runner 和 Git Bash。模型接口由本地受控服务提供，按工具调用协议驱动以下完整链路：

1. 创建账户与 Dot，选择一个真实 Skills 目录。
2. 在工作区设置故意冲突的 System32 Bash 路径。
3. 页面发送消息，Pi 调用 Bash 写入并读取证明文件，回传工具结果。
4. 刷新页面，停止并重启 Backend，确认历史仍存在。
5. 继续同一会话，确认先前消息进入下一次模型请求。

这验证了本地运行与工具链路；未使用用户 API Key，也未验证外部模型服务、计费或第三方渠道。

最终原生核心回归为 **15 个文件、100 项通过**，安装与启动工具回归 **11 项通过**。Backend、Runner、根项目及个人智能体类型检查通过，Web E2E 类型检查通过。完整浏览器链路已通过；独立审查额外复验了无根 `shared` 的容器编译布局、公共取消入口的 MSYS 清理和并发隔离。

交付时本机服务已使用修改后的构建重新启动，`/api/health` 返回 healthy，数据库与队列检查通过；初始化接口仍返回 `initialized: false`，未代用户创建管理员或填写模型凭据。

## 复查命令

在源码根目录使用 PowerShell：

```powershell
npm.cmd run test:windows-core
npm.cmd run test:windows-tooling
npm.cmd run test:windows-browser
npm.cmd run typecheck
npm.cmd --prefix web run typecheck:e2e
npm.cmd --prefix container/agent-runner run build
npm.cmd run docs:check
```

这组 Windows 回归涵盖进程发现、环境与凭据隔离、普通任务取消和超时、并发取消隔离、后台服务显式脱离、文件投影、ACL、工具白名单、页面到 Runner 的执行及重启续接。仓库完整测试集还包含 POSIX 和其他环境专用用例，本次未宣称全量测试通过。

## 使用与边界

本机依赖与构建产物已准备好，启动命令：

```powershell
cd D:\opendot\OpenDot-main-0689098\OpenDot
npm.cmd run start:windows
```

默认打开 <http://127.0.0.1:3000>，首次创建管理员并配置模型 Provider。后续新环境可先运行 `npm.cmd run setup:windows`。详细安装、后台服务和排错说明见 [Windows 安装说明](../windows.md)。

Device 私有状态、macOS 专用 KimiCU 和部分 Goal/Durable 私有产物仍有平台限制；本次保留原保护条件。Docker、第三方宿主工具、渠道和 Electron 发行包需按实际环境单独验收。本次完成的是基础 Web、普通 Host Pi、Skills 投影和脚本任务的 Windows 原生运行。
