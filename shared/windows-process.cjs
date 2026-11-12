'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// The actual usr/bin Bash does not receive the bin launcher's PATH additions.
const windowsBashCommandPrefix =
  'export PATH="/usr/bin:$PATH"\ntrap \'wait\' EXIT';

function prepareWindowsBashCommand(command) {
  return `${windowsBashCommandPrefix}\n${command}`;
}

function isFile(filename) {
  try {
    return fs.statSync(filename).isFile();
  } catch {
    return false;
  }
}

function nativeDescendants(childPid) {
  const owned = new Set([childPid]);
  const systemRoot =
    Object.entries(process.env).find(
      ([key]) => key.toLowerCase() === 'systemroot',
    )?.[1] || 'C:\\Windows';
  const powershell = path.win32.join(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => key.toLowerCase() !== 'psmodulepath',
    ),
  );
  const command =
    "$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$ErrorActionPreference='Stop';Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress";
  const snapshot = spawnSync(
    powershell,
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(command, 'utf16le').toString('base64'),
    ],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5_000,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        ...environment,
        PSModulePath: path.win32.join(
          path.win32.dirname(powershell),
          'Modules',
        ),
      },
      stdio: ['ignore', 'pipe', 'ignore'],
    },
  );
  if (snapshot.error || snapshot.status !== 0) return owned;
  try {
    const result = JSON.parse(snapshot.stdout.trim());
    const rows = Array.isArray(result) ? result : [result];
    let found;
    do {
      found = false;
      for (const row of rows) {
        if (owned.has(row.ParentProcessId) && !owned.has(row.ProcessId)) {
          owned.add(row.ProcessId);
          found = true;
        }
      }
    } while (found);
  } catch {
    /* A failed ownership snapshot is not permission to widen cleanup. */
  }
  return owned;
}

function killMsysDescendants(childPid, bashPath) {
  if (!bashPath || !/[/\\]bash\.exe$/i.test(bashPath)) return false;
  const directory = path.win32.dirname(bashPath);
  // Accept the Git bin launcher selected by setup as well as the actual shell.
  const tools = [
    directory,
    path.win32.resolve(directory, '..', 'usr', 'bin'),
  ].find(
    (candidate) =>
      isFile(path.win32.join(candidate, 'ps.exe')) &&
      isFile(path.win32.join(candidate, 'kill.exe')),
  );
  if (!tools) return false;
  const ps = path.win32.join(tools, 'ps.exe');
  const kill = path.win32.join(tools, 'kill.exe');
  // MSYS exec can replace a logical child with a new Windows process whose
  // original Windows parent has exited. taskkill /T cannot find that child.
  // Keep the snapshot private and select only this live shell's logical tree.
  const snapshot = spawnSync(ps, ['-W'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 3_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (snapshot.error || snapshot.status !== 0) return false;
  const rows = snapshot.stdout.split(/\r?\n/).flatMap((line) => {
    const columns = line.match(
      /^\s*(?:[A-Z]\s+)?(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+/,
    );
    return columns
      ? [
          {
            pid: Number(columns[1]),
            ppid: Number(columns[2]),
            pgid: Number(columns[3]),
            winpid: Number(columns[4]),
          },
        ]
      : [];
  });
  // A direct MSYS shell already provides an unambiguous logical root. For a
  // native Node backend, first find only its native descendants, then map any
  // registered MSYS processes in that tree to their corresponding logical roots.
  const directRoot = rows.find(
    (row) => row.winpid === childPid && row.pgid > 0,
  );
  const nativeOwned = directRoot
    ? new Set([childPid])
    : nativeDescendants(childPid);
  const roots = rows.filter(
    (row) => nativeOwned.has(row.winpid) && row.pgid > 0 && row.pid > 1,
  );
  if (roots.length === 0) return false;
  const rootPids = new Set(roots.map((row) => row.pid));
  const owned = new Set(rootPids);
  let found;
  do {
    found = false;
    for (const row of rows) {
      if (owned.has(row.ppid) && !owned.has(row.pid)) {
        owned.add(row.pid);
        found = true;
      }
    }
  } while (found);
  const descendants = [...owned].filter((pid) => !rootPids.has(pid)).reverse();
  if (descendants.length === 0) return false;
  const result = spawnSync(kill, ['-KILL', ...descendants.map(String)], {
    stdio: 'ignore',
    windowsHide: true,
    timeout: 3_000,
  });
  return !result.error && result.status === 0;
}

function killWindowsProcessTree(childPid, bashPath) {
  if (
    process.platform !== 'win32' ||
    !Number.isSafeInteger(childPid) ||
    childPid <= 0
  )
    return false;
  const logicalKilled = killMsysDescendants(childPid, bashPath);
  const systemRoot =
    Object.entries(process.env).find(
      ([key]) => key.toLowerCase() === 'systemroot',
    )?.[1] || 'C:\\Windows';
  const result = spawnSync(
    path.win32.join(systemRoot, 'System32', 'taskkill.exe'),
    ['/PID', String(childPid), '/T', '/F'],
    {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 5_000,
    },
  );
  // Killing the last background job can let Bash exit before taskkill runs.
  return logicalKilled || (!result.error && result.status === 0);
}

module.exports = {
  killWindowsProcessTree,
  prepareWindowsBashCommand,
  windowsBashCommandPrefix,
};
