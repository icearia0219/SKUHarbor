/**
 * Resolves an absolute path to the `node` binary for spawning host-side
 * child processes (host-mode agent-runner, PTY worker, etc.).
 *
 * Host services launched by process managers / launchd / GUI launchers may inherit a
 * minimal PATH that does not include nvm / fnm / volta managed Node
 * installations. A bare `spawn('node', ...)` then fails with ENOENT even
 * though the parent process is itself running on Node. This module walks
 * a prioritised candidate list and returns the first executable path,
 * falling back to literal `'node'` if nothing matches.
 */
import os from 'os';
import path from 'path';
import {
  getHostEnvValue,
  isHostExecutable,
  resolveHostBinary,
} from './host-platform.js';

export interface NodeResolverContext {
  env: Record<string, string | undefined>;
  execPath?: string;
  argv0?: string;
  homeDir?: string;
  platform?: NodeJS.Platform;
  isExecutable: (filePath: string) => boolean;
}

export function isExecutableFile(filePath: string | undefined | null): boolean {
  return !!filePath && isHostExecutable(filePath);
}

export function resolveBinaryOnPath(
  binary: string,
  envPath: string | undefined,
  isExec: (filePath: string) => boolean = isExecutableFile,
  platform: NodeJS.Platform = process.platform,
): string | null {
  return resolveHostBinary(
    binary,
    { PATH: envPath },
    { platform, isExecutable: isExec },
  );
}

function hasNodeBasename(filePath: string | undefined): filePath is string {
  if (!filePath) return false;
  const basename = path.basename(filePath.replace(/\\/g, '/')).toLowerCase();
  return (
    basename === 'node' || basename === 'nodejs' || basename === 'node.exe'
  );
}

export function buildNodeCandidates(ctx: NodeResolverContext): string[] {
  const home = ctx.homeDir ?? '';
  const platform = ctx.platform ?? process.platform;
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const node = platform === 'win32' ? 'node.exe' : 'node';
  const env = (name: string) => getHostEnvValue(ctx.env, name);
  const raw: (string | null | undefined)[] = [
    // process.execPath / argv0 can point at non-Node runtimes such as Bun,
    // so only trust them when the executable basename is a Node binary name.
    hasNodeBasename(ctx.execPath) ? ctx.execPath : null,
    hasNodeBasename(ctx.argv0) ? ctx.argv0 : null,
    env('npm_node_execpath'),
    env('NVM_BIN') ? pathApi.join(env('NVM_BIN')!, node) : null,
    env('FNM_MULTISHELL_PATH')
      ? pathApi.join(env('FNM_MULTISHELL_PATH')!, 'bin', node)
      : null,
    env('VOLTA_HOME') ? pathApi.join(env('VOLTA_HOME')!, 'bin', node) : null,
    resolveHostBinary('node', ctx.env, {
      platform,
      isExecutable: ctx.isExecutable,
    }),
    home
      ? pathApi.join(
          home,
          '.local',
          'share',
          'fnm',
          'aliases',
          'default',
          'bin',
          node,
        )
      : null,
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    '/usr/bin/node',
  ];
  return raw.filter((c): c is string => typeof c === 'string' && c.length > 0);
}

export function resolveNodeBinary(ctx: NodeResolverContext): string {
  for (const candidate of buildNodeCandidates(ctx)) {
    if (ctx.isExecutable(candidate)) return candidate;
  }
  return 'node';
}

export function resolveHostNodeBinary(
  env: Record<string, string | undefined> = process.env,
): string {
  return resolveNodeBinary({
    env,
    execPath: process.execPath,
    argv0: process.argv[0],
    homeDir: os.homedir(),
    isExecutable: isExecutableFile,
  });
}
