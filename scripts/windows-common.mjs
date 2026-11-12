import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { killWindowsProcessTree } from '../shared/windows-process.cjs';

export const projectRoot = path.resolve(import.meta.dirname, '..');

export function isMainModule(url) {
  return (
    Boolean(process.argv[1]) &&
    url === pathToFileURL(path.resolve(process.argv[1])).href
  );
}

function isFile(filename) {
  try {
    return fs.statSync(filename).isFile();
  } catch {
    return false;
  }
}

export function resolveNpmCli(env = process.env) {
  const candidates = [
    env.npm_execpath,
    path.join(
      path.dirname(process.execPath),
      'node_modules',
      'npm',
      'bin',
      'npm-cli.js',
    ),
    path.resolve(
      path.dirname(process.execPath),
      '..',
      'lib',
      'node_modules',
      'npm',
      'bin',
      'npm-cli.js',
    ),
  ];
  const cli = candidates.find(
    (candidate) =>
      candidate && /\.[cm]?js$/i.test(candidate) && isFile(candidate),
  );
  if (!cli)
    throw new Error(
      'Cannot locate npm-cli.js. Install Node.js with npm, then run npm.cmd run setup:windows.',
    );
  return cli;
}

export function writableNpmCache(root, env = process.env) {
  const candidates = [
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'OpenDot', 'npm-cache'),
    path.join(root, '.npm-cache'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      fs.mkdirSync(candidate, { recursive: true });
      const probe = path.join(
        candidate,
        `.write-check-${process.pid}-${Date.now()}`,
      );
      const descriptor = fs.openSync(probe, 'wx');
      fs.closeSync(descriptor);
      fs.rmSync(probe);
      return candidate;
    } catch {
      // A protected global cache must not prevent use of the project cache.
    }
  }
  throw new Error(
    'No writable npm cache. Check LOCALAPPDATA or the project directory permissions.',
  );
}

export function runNode(args, { cwd, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env,
      stdio: 'inherit',
      windowsHide: true,
    });
    let cancellationSignal;
    const cancel = (signal) => {
      if (process.platform !== 'win32') {
        child.kill(signal);
        return;
      }
      if (
        cancellationSignal ||
        child.exitCode !== null ||
        child.signalCode !== null
      )
        return;
      cancellationSignal = signal;
      // Include MSYS logical descendants before stopping the native Node tree.
      const bash = Object.entries(env).find(
        ([key]) => key.toLowerCase() === 'miniclaw_host_bash_path',
      )?.[1];
      const stopped = killWindowsProcessTree(child.pid, bash);
      // A console Ctrl+C may already have stopped the child independently.
      if (!stopped && child.exitCode === null && child.signalCode === null)
        child.kill(signal);
    };
    const interrupt = () => cancel('SIGINT');
    const terminate = () => cancel('SIGTERM');
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
    const cleanup = () => {
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', terminate);
    };
    child.once('error', (error) => {
      cleanup();
      reject(error);
    });
    child.once('close', (code, signal) => {
      cleanup();
      resolve(
        cancellationSignal
          ? cancellationSignal === 'SIGINT'
            ? 130
            : 143
          : (code ??
              (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1)),
      );
    });
  });
}

export function findGitBash({ env = process.env } = {}) {
  const usable = (filename) =>
    filename &&
    !/[\\/](?:system32|sysnative)[\\/]bash(?:\.exe)?$/i.test(filename) &&
    isFile(filename);
  const override = env.MINICLAW_HOST_BASH_PATH?.trim();
  if (override) {
    if (!usable(override))
      throw new Error(
        'MINICLAW_HOST_BASH_PATH must point to an existing Git for Windows bash.exe, for example D:\\git\\Git\\bin\\bash.exe.',
      );
    return path.resolve(override);
  }

  const pathValue =
    Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] ??
    '';
  const gitPaths = pathValue
    .split(path.delimiter)
    .filter(Boolean)
    .map((directory) => path.join(directory.replace(/^"|"$/g, ''), 'git.exe'))
    .filter(isFile);
  if (process.platform === 'win32') {
    try {
      gitPaths.push(
        ...execFileSync('where.exe', ['git.exe'], {
          env,
          encoding: 'utf8',
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
        })
          .trim()
          .split(/\r?\n/),
      );
    } catch {
      /* Git may not be on PATH yet. */
    }
  }
  const roots = gitPaths.flatMap((git) => [
    path.resolve(path.dirname(git), '..'),
    path.resolve(path.dirname(git), '../..'),
  ]);
  roots.push(
    ...[env.ProgramFiles, env['ProgramFiles(x86)']]
      .filter(Boolean)
      .map((directory) => path.join(directory, 'Git')),
  );
  if (env.LOCALAPPDATA)
    roots.push(path.join(env.LOCALAPPDATA, 'Programs', 'Git'));
  const candidates = roots.flatMap((root) => [
    path.join(root, 'bin', 'bash.exe'),
    path.join(root, 'usr', 'bin', 'bash.exe'),
  ]);
  return candidates.find(usable) ?? null;
}

export function checkNodeVersion() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 19))
    throw new Error(
      'OpenDot requires Node.js 22.19 or newer; Node.js 24 is recommended.',
    );
}
