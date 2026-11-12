# Native Windows compatibility implementation plan

> For agentic workers: use the systematic-debugging and test-driven-development workflows; run the concrete Windows checks before reporting completion.

**Goal:** Run the existing Web application and ordinary Host Pi conversations, selected Skills, shell scripts and cancellation directly on Windows with Node 24 and Git for Windows.

**Architecture:** Keep the existing Node/Web/Runner boundaries. Resolve host executables and Git Bash explicitly, preserve Windows process environment requirements, use directory junctions for selected capabilities, and protect the Windows data root using a verified DACL before writing secrets. Existing POSIX-only device and artifact paths retain their current protections and are documented separately.

**Tech stack:** TypeScript, Node 24, Vitest, React/Vite, SQLite, PowerShell/.NET ACL APIs, Git for Windows Bash.

This checkout is a ZIP snapshot without Git metadata. The original archive is the baseline; changes are made in this working directory and can be reviewed against that archive.

## 1. Establish the Windows baseline

- [x] Inspect the installed Node, npm, Git and Docker versions.
- [x] Reproduce `which` and `/bin/sh` failures on Windows.
- [x] Identify the actual Git Bash at `D:\git\Git\bin\bash.exe`, rather than the WSL launcher on PATH.
- [x] Install root dependencies with an explicit writable npm cache after the machine-wide cache fails with EPERM.
- [x] Install Web and Agent Runner dependencies and compile all three projects.

## 2. Host processes and capabilities

Files: `src/host-platform.ts`, `src/node-resolver.ts`, `src/agent-capabilities.ts`, `src/script-runner.ts`, `src/plugin-dependency-check.ts`, `src/plugin-inline-bash.ts`, and focused tests.

- [x] Add failing Windows tests for executable discovery, shell execution and process-tree cancellation.
- [x] Resolve PATH keys case-insensitively and account for Windows executable extensions.
- [x] Resolve Git Bash from an explicit `MINICLAW_HOST_BASH_PATH`, the Git installation, or supported standard locations; reject the WSL launcher.
- [x] Preserve the Windows OS variables required by child processes while retaining script credential isolation.
- [x] Cancel Windows process trees and MSYS logical descendants, preserving POSIX process-group behavior elsewhere.
- [x] Run the focused tests on this Windows host.

## 3. Filesystem projections and private data

Files: `src/host-files.ts`, `src/windows-private-data.ts`, `src/effective-skill-resolver.ts`, `src/claude-context-resolver.ts`, `src/file-manager.ts`, and focused tests.

- [x] Add failing tests for ordinary-user directory projections and cleanup after capability changes.
- [x] Use absolute directory junctions on Windows; track owned file copies so disabling a policy removes its projections.
- [x] Reject cross-volume escape, Windows alternate streams, reserved devices and ambiguous path components.
- [x] Establish and verify a private Windows data-root DACL before session secrets or model configuration are written.
- [x] Preserve fail-closed behavior for platform-specific advanced features without a Windows security implementation.

## 4. Integrate the production Runner

Files: `src/container-runner.ts`, `src/config.ts`, `container/agent-runner/src/runtime/pi/pi-runtime.ts`, and focused tests.

- [x] Exercise Windows Runner process options through the real HTTP/browser fixture and test explicit Pi shell selection.
- [x] Use the shared host helpers for projections, Bash resolution and cancellation.
- [x] Pass `MINICLAW_HOST_BASH_PATH` into Pi SettingsManager's effective shellPath setting, overriding conflicting project settings.
- [x] Register Windows Bash operations through the standard Pi tool definition, preserving tool policies and output handling.
- [x] Verify explicit background-service detachment and provide the Agent with the required redirect/disown instructions.
- [x] Avoid detached Windows consoles and hide background helper processes.
- [x] Call the verified private-data bootstrap before session-secret creation.

## 5. Native setup and documentation

Files: `scripts/setup-windows.mjs`, `scripts/start-windows.mjs`, shared Windows script helpers, `package.json`, `README.md`, `docs/windows.md`, and script tests.

- [x] Add npm setup/start commands which run JavaScript CLI entries with Node rather than trying to execute npm.cmd directly.
- [x] Use a writable per-user npm cache and retain lockfile-based installation.
- [x] Make documentation checks usable from a ZIP checkout and Prettier launching work on Windows.
- [x] Document required Node/Git tools, actual startup commands, supported features and the remaining advanced-platform limits.

## 6. Verification and delivery

- [x] Build Backend, Web and Agent Runner.
- [x] Run focused process, capability, filesystem, configuration and Runner regression tests.
- [x] Start an isolated real Windows backend and verify health, account setup, page loading and persistence.
- [x] Exercise an ordinary Host Pi conversation and shell tool through a local controlled provider; label it as a fixture rather than vendor-model validation.
- [x] Check shutdown and child-process cleanup, including the public Native Node to MSYS cancellation entry points and unrelated-session isolation.
- [x] Review the resulting diff and record actual results and remaining limitations in `docs/verification/windows-native-2026-11-12.md`.
