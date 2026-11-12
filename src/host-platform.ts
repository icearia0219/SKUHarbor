import { type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
function windowsProcess(): typeof import('../shared/windows-process.cjs') {
  return require('../shared/windows-process.cjs');
}

type HostEnvironment = Record<string, string | undefined>;

export interface HostPlatformProbe {
  platform?: NodeJS.Platform;
  isExecutable?: (candidate: string) => boolean;
}

/** Windows environment keys retain their original casing in plain objects. */
export function getHostEnvValue(
  env: HostEnvironment,
  name: string,
): string | undefined {
  return (
    env[name] ??
    env[
      Object.keys(env).find(
        (key) => key.toLowerCase() === name.toLowerCase(),
      ) ?? name
    ]
  );
}

export function isHostExecutable(candidate: string): boolean {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/** Resolve binaries directly so capability checks do not require which/where. */
export function resolveHostBinary(
  binary: string,
  env: HostEnvironment = process.env,
  probe: HostPlatformProbe = {},
): string | null {
  const platform = probe.platform ?? process.platform;
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const isExecutable = probe.isExecutable ?? isHostExecutable;
  const extensions =
    platform === 'win32' && !pathApi.extname(binary)
      ? [
          '',
          ...(getHostEnvValue(env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD')
            .split(';')
            .filter(Boolean),
        ]
      : [''];
  const directories =
    pathApi.isAbsolute(binary) || /[\\/]/.test(binary)
      ? ['']
      : (getHostEnvValue(env, 'PATH') || '')
          .split(platform === 'win32' ? ';' : ':')
          .filter(Boolean);
  for (const entry of directories) {
    const directory = entry.replace(/^"(.*)"$/, '$1');
    for (const extension of extensions) {
      const candidate = directory
        ? pathApi.join(directory, binary + extension)
        : binary + extension;
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

function isWslBash(candidate: string): boolean {
  return /(?:^|\\)(?:system32|sysnative)\\bash\.exe$/i.test(
    candidate.replace(/\//g, '\\'),
  );
}

/** Resolve a native Bash, including Git for Windows installed outside Program Files. */
export function resolveHostBashPath(
  env: HostEnvironment = process.env,
  probe: HostPlatformProbe = {},
): string | null {
  const platform = probe.platform ?? process.platform;
  const isExecutable = probe.isExecutable ?? isHostExecutable;
  const usable = (candidate: string) =>
    !isWslBash(candidate) && isExecutable(candidate);
  const actualBash = (candidate: string | null): string | null => {
    if (!candidate || platform !== 'win32') return candidate;
    const directory = path.win32.dirname(candidate);
    if (
      path.win32.basename(directory).toLowerCase() === 'bin' &&
      path.win32.basename(path.win32.dirname(directory)).toLowerCase() !== 'usr'
    ) {
      const actual = path.win32.resolve(
        directory,
        '..',
        'usr',
        'bin',
        'bash.exe',
      );
      if (usable(actual)) return actual;
    }
    return candidate;
  };
  const explicit = getHostEnvValue(env, 'MINICLAW_HOST_BASH_PATH');
  if (explicit) return usable(explicit) ? actualBash(explicit) : null;
  if (platform !== 'win32') {
    return (
      resolveHostBinary('bash', env, { ...probe, isExecutable }) ||
      ['/bin/bash', '/usr/bin/bash'].find(isExecutable) ||
      null
    );
  }

  const candidates: string[] = [];
  const git = resolveHostBinary('git', env, { ...probe, isExecutable });
  if (git) {
    let directory = path.win32.dirname(git);
    // git.exe may live in cmd/, bin/, or mingw64/bin/.
    for (let level = 0; level < 3; level++) {
      candidates.push(path.win32.join(directory, 'bin', 'bash.exe'));
      candidates.push(path.win32.join(directory, 'usr', 'bin', 'bash.exe'));
      directory = path.win32.dirname(directory);
    }
  }
  for (const name of ['ProgramFiles', 'ProgramFiles(x86)']) {
    const directory = getHostEnvValue(env, name);
    if (directory)
      candidates.push(path.win32.join(directory, 'Git', 'bin', 'bash.exe'));
  }
  const localAppData = getHostEnvValue(env, 'LOCALAPPDATA');
  if (localAppData)
    candidates.push(
      path.win32.join(localAppData, 'Programs', 'Git', 'bin', 'bash.exe'),
    );
  const standard = candidates.find(usable);
  return actualBash(
    standard ||
      resolveHostBinary('bash.exe', env, { ...probe, isExecutable: usable }),
  );
}

/** Bash command strings must retain Bash semantics instead of falling back to cmd.exe. */
export const HOST_BASH_UNAVAILABLE =
  'Host Bash is unavailable. Install Git for Windows (https://git-scm.com/download/win) or set MINICLAW_HOST_BASH_PATH to a native bash executable. WSL system32 bash is not supported.';

/** Keep Bash's PID alive while ordinary background jobs hold its output pipes. */
export const windowsBashCommandPrefix =
  process.platform === 'win32' ? windowsProcess().windowsBashCommandPrefix : '';

export function prepareHostBashCommand(
  command: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === 'win32'
    ? windowsProcess().prepareWindowsBashCommand(command)
    : command;
}

/** Windows has no POSIX process groups/signals; taskkill terminates the owned tree. */
export function killHostProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals = 'SIGKILL',
): boolean {
  if (child.pid && process.platform === 'win32') {
    const bash = /[/\\]bash\.exe$/i.test(child.spawnfile)
      ? child.spawnfile
      : resolveHostBashPath();
    return windowsProcess().killWindowsProcessTree(
      child.pid,
      bash ?? undefined,
    );
  }
  try {
    if (child.pid) {
      process.kill(-child.pid, signal);
      return true;
    }
  } catch {
    // Non-detached processes do not own a process group.
  }
  try {
    return child.kill(signal);
  } catch {
    return false;
  }
}
