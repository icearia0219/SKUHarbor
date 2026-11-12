# Windows 安装与运行

此说明面向原生 Windows 上的基础 Web 服务、Host Agent 和脚本任务。Agent 的 Bash 工具使用 Git for Windows 提供的 Bash。Node.js、数据库、Backend 和 Runner 作为 Windows 进程运行。

## 安装条件

- Node.js 22.19 或更高版本，推荐 Node.js 24，并安装随附的 npm。
- [Git for Windows](https://gitforwindows.org/)，安装时保留 Bash 组件，并让 Git 可从命令行使用。
- 可以写入的项目目录，建议使用 `C:\src\OpenDot` 这样的较短路径。

`node -v`、`npm.cmd -v` 和 `git --version` 应能在新打开的 PowerShell 中运行。使用 `npm.cmd` 可以避免 PowerShell 对 `npm.ps1` 的执行策略限制。Make 不是 Windows 安装路径的依赖。

## 安装和启动

克隆仓库或解压源码，然后在包含 `package.json` 的目录打开 PowerShell：

```powershell
npm.cmd run setup:windows
npm.cmd run start:windows
```

`setup:windows` 依次对根项目、`web`、`container/agent-runner` 执行 `npm ci`，然后运行 `build:all`。依赖版本以三个 lockfile 为准。默认 npm 缓存为 `%LOCALAPPDATA%\OpenDot\npm-cache`；该目录不可写时使用项目根目录的 `.npm-cache`，避免提前创建运行时私有数据目录。任何安装或构建失败都会停止后续步骤，可修复错误后重新运行同一命令。

`start:windows` 检查三个依赖目录及 Backend、Web、Agent Runner 的构建入口，然后以前台进程启动服务。默认访问 <http://127.0.0.1:3000>，停止时在启动终端按 Ctrl+C。首次进入页面完成管理员和 Provider 配置；也可以先跳过 Provider 配置进入工作台，之后再补齐。

启动脚本会从 PATH 中的 Git 安装位置，以及 Program Files 和用户本地安装目录寻找 Bash；支持 Git 安装在其他磁盘。需要覆盖自动选择时：

```powershell
$env:MINICLAW_HOST_BASH_PATH = 'D:\git\Git\bin\bash.exe'
npm.cmd run start:windows
```

该变量也适用于 `npm.cmd start` 和开发命令。`C:\Windows\System32\bash.exe` 是 WSL 启动入口，不能作为 Git Bash 使用。运行时使用同一个 Bash 设置执行 Host Agent 和脚本任务。

修改端口时：

```powershell
$env:WEB_PORT = '3001'
npm.cmd run start:windows
```

更新源码后重新执行 `npm.cmd run build:all`。依赖或 lockfile 更新时重新执行 `setup:windows`。

## 后台服务与取消

Windows 的 Bash 工具会等待普通后台任务结束，使取消和超时可以终止该命令启动的任务。因此，仅使用 `&` 或 `nohup` 启动后台进程仍可能让工具保持运行。

需要持续运行的服务时，请显式重定向 stdin、stdout 和 stderr，再使用 `disown` 将服务交给调用者管理。例如，在 Agent 的 Bash 工具中运行：

```bash
nohup npm run dev </dev/null >./dev-server.log 2>&1 &
pid=$!
disown "$pid"
printf 'Started PID %s\n' "$pid"
```

保存输出的 PID 和日志位置。显式脱离后的服务不会随本次工具调用的取消自动结束；请在使用完毕后自行关闭服务及其启动的子进程。

## 开发与验证

安装完成后，可以使用 Backend 和 Vite 开发模式：

```powershell
$env:MINICLAW_HOST_BASH_PATH = 'D:\git\Git\bin\bash.exe'
npm.cmd run dev:all
```

Git 安装路径不同时调整上面的变量。基础检查命令：

```powershell
npm.cmd run test:windows-tooling
npm.cmd run typecheck
node web/node_modules/typescript/bin/tsc -p web/tsconfig.json --noEmit
node container/agent-runner/node_modules/typescript/bin/tsc -p container/agent-runner/tsconfig.json --noEmit
npm.cmd run build:all
npm.cmd run docs:check
```

开发工具测试会运行临时 npm CLI 和 Backend fixture，验证安装顺序、错误中断、Bash 发现及进程环境；不会重复安装真实依赖或调用模型。完整 Vitest 测试中仍有依赖 POSIX 工具、权限或特定平台的用例，基础检查通过不代表全部高级能力在 Windows 上完成验收。

`docs:check` 支持没有 `.git` 的 ZIP 源码目录。`format:changed` 依赖 Git 变更信息；ZIP 源码可直接按修改文件运行 Prettier，例如 `node node_modules/prettier/bin/prettier.cjs --check scripts/start-windows.mjs`。

## 原生模块安装失败

Backend 使用 `better-sqlite3` 和 `node-pty`。预构建模块无法使用时，安装过程可能回退到本机 C++ 编译。根据 npm 错误安装 Python、Visual Studio 的“使用 C++ 的桌面开发”工作负载和 Windows SDK；`node-pty` 报 `MSB8040` 时还需要对应架构的 Spectre 库。参考 [better-sqlite3 安装排查](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/troubleshooting.md) 和 [node-pty Windows 依赖说明](https://github.com/microsoft/node-pty#windows)。

原生依赖和 Electron 下载可能需要访问 npm、GitHub 等下载源；下载错误应先按安装日志排查网络。安装目录建议避免空格和特殊字符，尤其在需要从源码编译原生模块时。

仅运行 Web 服务且希望跳过 Electron 二进制下载，可以在安装前设置：

```powershell
$env:ELECTRON_SKIP_BINARY_DOWNLOAD = '1'
npm.cmd run setup:windows
```

此时无法直接启动 Electron。之后需要桌面外壳时，清除此变量并完成 Electron 二进制安装：

```powershell
Remove-Item Env:ELECTRON_SKIP_BINARY_DOWNLOAD -ErrorAction SilentlyContinue
node node_modules/electron/install.js
npm.cmd run desktop:dev
```

桌面外壳连接单独运行的 Backend。需要 Vite 页面时，在另一个终端设置 `$env:MINICLAW_RENDERER_URL = 'http://127.0.0.1:5173'` 后运行 `npm.cmd run desktop:dev`。连接远程 Backend 时使用 `$env:MINICLAW_SERVER_URL = 'https://your-miniclaw.example.com'`。

## 可选能力与当前边界

启动会在读取或生成持久密钥之前验证 `data` 根目录的 Windows ACL。目录必须属于当前用户，并且只能向当前用户、SYSTEM 和 Administrators 授予访问权限；工作区内容不作为凭据目录递归检查。正常的工作区 package junction 不会阻止重启。项目目录及其父目录仍须可信，Host 模式不提供对抗其他可替换这些目录的本地用户的隔离沙箱。

已有安装的配置或数据库若保留了公开 ACL，启动会报告具体路径并拒绝继续，不会递归改写历史权限。请先备份，再由目录所有者核对并修复该路径的安全属性；不要直接删除已有数据库以绕过检查。

`npm.cmd run test:windows-core` 验证原生命令、取消、文件投影和 ACL；`npm.cmd run test:windows-browser` 使用本机 Edge 验证页面到真实 Pi Runner/Git Bash 的执行与重启续接，模型回复由本地受控接口提供。这些检查不代表外部模型服务验收。

- `setup:windows` 不安装 `feishu-cli`、`uv` 等宿主工具，也不自动下载内置 Skills catalog。这些能力需要另外按各工具的 Windows 安装说明配置。缺少内置 Skills 不影响基础 Web 服务，但相应 Skills 不可用。`scripts/install-host-tools.sh` 的完整工具安装路径目前仅支持 macOS/Linux。
- Container 模式另外需要 Docker Desktop、可用镜像和目录挂载；应针对实际 Docker 环境单独验证。
- Device 私有状态使用 POSIX 所有权与权限校验，Windows 当前不可用；macOS 专用的 KimiCU 等桌面能力也有各自的平台要求。
- Durable 私有产物路径仍依赖 POSIX 文件权限与目录 fsync，本次没有绕过这些检查；Windows 基础 Host 支持不代表 Goal/Durable 全部高级路径已完成适配。
- Make 中的备份、恢复、端口管理以及部分 POSIX shell 检查不属于原生 PowerShell 启动路径。修改源码时按实际涉及的模块运行对应检查。
- Electron 已包含 Windows NSIS 打包目标，但外壳安装包没有内置 Backend；Windows 签名和发行包仍需单独验收。
