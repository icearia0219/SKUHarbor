import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { ensureWindowsPrivateDataDirectory } from '../src/windows-private-data.js';

const roots: string[] = [];
const powershell = path.join(
  process.env.SystemRoot ?? 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
);
function ps(script: string, target: string) {
  script =
    "$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); " +
    script;
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => key.toLowerCase() !== 'psmodulepath',
    ),
  );
  return execFileSync(
    powershell,
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...environment,
        PSModulePath: path.join(path.dirname(powershell), 'Modules'),
        OPENDOT_PRIVATE_DATA_PATH: target,
      },
    },
  ).trim();
}
function fixture() {
  const directory = fs.mkdtempSync(
    path.join(process.cwd(), '.windows-private-data-test-'),
  );
  roots.push(directory);
  return path.join(directory, 'data');
}
afterEach(() => {
  for (const directory of roots.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

test.skipIf(process.platform !== 'win32')(
  'creates a private current-owner DACL before children inherit it and is repeatable',
  () => {
    const directory = fixture();
    ensureWindowsPrivateDataDirectory(directory);
    expect(fs.existsSync(directory)).toBe(true);
    fs.writeFileSync(path.join(directory, 'placeholder'), 'no credentials');
    expect(
      ps(
        `$a=Get-Acl -LiteralPath $env:OPENDOT_PRIVATE_DATA_PATH; $u=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; [bool]($a.AreAccessRulesProtected -and $a.GetOwner([Security.Principal.SecurityIdentifier]).Value -eq $u)`,
        directory,
      ),
    ).toBe('True');
    expect(() => ensureWindowsPrivateDataDirectory(directory)).not.toThrow();
  },
  20000,
);

test.skipIf(process.platform !== 'win32')(
  'rejects an existing publicly readable child without rewriting its permissions',
  () => {
    const directory = fixture();
    ensureWindowsPrivateDataDirectory(directory);
    const child = path.join(directory, 'legacy-secret');
    fs.writeFileSync(child, 'no credentials');
    ps(
      `$a=Get-Acl -LiteralPath $env:OPENDOT_PRIVATE_DATA_PATH; $a.SetAccessRuleProtection($true,$true); $s=[Security.Principal.SecurityIdentifier]::new('S-1-1-0'); $r=[Security.AccessControl.FileSystemAccessRule]::new($s,[Security.AccessControl.FileSystemRights]::Read,[Security.AccessControl.AccessControlType]::Allow); $a.AddAccessRule($r); Set-Acl -LiteralPath $env:OPENDOT_PRIVATE_DATA_PATH -AclObject $a`,
      child,
    );
    expect(() => ensureWindowsPrivateDataDirectory(directory)).toThrow(
      /legacy-secret/,
    );
    expect(
      ps(
        `$a=Get-Acl -LiteralPath $env:OPENDOT_PRIVATE_DATA_PATH; [bool]($a.Access | Where-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -eq 'S-1-1-0' })`,
        child,
      ),
    ).toBe('True');
  },
  20000,
);

test.skipIf(process.platform !== 'win32')(
  'rejects a root junction without changing its target',
  () => {
    const directory = fixture();
    const destination = path.join(path.dirname(directory), 'actual');
    fs.mkdirSync(destination);
    fs.symlinkSync(destination, directory, 'junction');
    expect(() => ensureWindowsPrivateDataDirectory(directory)).toThrow(
      /reparse|symbolic|link/i,
    );
    expect(fs.existsSync(destination)).toBe(true);
  },
  20000,
);

test.skipIf(process.platform !== 'win32')(
  'restarts with a workspace package junction without traversing host workspace contents',
  () => {
    const directory = fixture();
    ensureWindowsPrivateDataDirectory(directory);
    const dependency = path.join(path.dirname(directory), 'dependency');
    fs.mkdirSync(dependency);
    fs.writeFileSync(path.join(dependency, 'package.json'), '{}');
    const modules = path.join(directory, 'groups', 'workspace', 'node_modules');
    fs.mkdirSync(modules, { recursive: true });
    fs.symlinkSync(dependency, path.join(modules, 'package'), 'junction');
    expect(() => ensureWindowsPrivateDataDirectory(directory)).not.toThrow();
    expect(
      fs.readFileSync(path.join(modules, 'package', 'package.json'), 'utf8'),
    ).toBe('{}');
  },
  20000,
);

test.skipIf(process.platform !== 'win32').each(['config', 'db', 'groups'])(
  'rejects a junction at the private data %s entry',
  (name) => {
    const directory = fixture();
    ensureWindowsPrivateDataDirectory(directory);
    const destination = path.join(path.dirname(directory), 'external');
    fs.mkdirSync(destination);
    fs.symlinkSync(destination, path.join(directory, name), 'junction');
    expect(() => ensureWindowsPrivateDataDirectory(directory)).toThrow(
      /reparse/i,
    );
    expect(fs.existsSync(destination)).toBe(true);
  },
  20000,
);
