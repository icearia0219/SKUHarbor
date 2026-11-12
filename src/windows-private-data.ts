import { execFileSync } from 'node:child_process';
import path from 'node:path';

// Host execution trusts the OS user and the project directory. This protects
// stored data from other local accounts; it is not a sandbox against a hostile
// user who can replace the project or one of its parent directories.
const protectDirectory = String.raw`
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$ErrorActionPreference = 'Stop'
try {
  $root = [IO.Path]::GetFullPath($env:OPENDOT_PRIVATE_DATA_PATH)
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $trusted = @($identity.Value, 'S-1-5-18', 'S-1-5-32-544')
  function Assert-PrivateAcl([string] $target) {
    $acl = Get-Acl -LiteralPath $target
    if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $identity.Value) {
      throw "Private data must be owned by the current Windows user: $target"
    }
    foreach ($rule in $acl.Access) {
      $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
      if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and $trusted -notcontains $sid) {
        throw "Existing data has public permissions; repair this path's ACL before restarting OpenDot: $target"
      }
    }
    return $acl
  }
  if (Test-Path -LiteralPath $root) {
    $item = Get-Item -LiteralPath $root -Force
    if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw "Private data root must be a real directory, not a reparse point: $root"
    }
  } else {
    [void][IO.Directory]::CreateDirectory($root)
  }
  $rootAcl = Get-Acl -LiteralPath $root
  if ($rootAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $identity.Value) {
    throw "Private data root must be owned by the current Windows user: $root"
  }
  # Verify legacy entries before changing anything. Never recursively reset an
  # existing installation's ACLs. Intentional capability projections are links
  # to host resources and remain governed by the trusted host user's policy.
  $pending = [Collections.Generic.Stack[string]]::new()
  $pending.Push($root)
  while ($pending.Count -gt 0) {
    $parent = $pending.Pop()
    foreach ($child in Get-ChildItem -LiteralPath $parent -Force) {
      if ($child.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        $relative = $child.FullName.Substring($root.Length).TrimStart('\','/')
        if ($relative -match '^(sessions[\\/].+[\\/]\.claude[\\/](skills|rules|agents|commands|hooks|workflows|output-styles|plugins)([\\/]|$)|agent-profile-runtime[\\/].+[\\/]skills[\\/])') { continue }
        throw "Existing private data contains an unsupported reparse point: $($child.FullName)"
      }
      [void](Assert-PrivateAcl $child.FullName)
      # groups is the checked workspace entry, not credential metadata. Its
      # contents belong to the trusted Host user and can contain dependency
      # junctions, checkout permissions and arbitrary project trees. Check the
      # entry itself above, then leave workspace contents to the Host policy.
      if ($parent -eq $root -and $child.Name -eq 'groups' -and $child.PSIsContainer) { continue }
      if ($child.PSIsContainer) { $pending.Push($child.FullName) }
    }
  }
  # Modify only the DACL loaded by Get-Acl. A fresh DirectorySecurity can mark
  # audit sections as changed and incorrectly require SeSecurityPrivilege.
  $acl = $rootAcl
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($oldRule in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($oldRule) }
  foreach ($sid in $trusted | Select-Object -Unique) {
    $principal = [Security.Principal.SecurityIdentifier]::new($sid)
    $rule = [Security.AccessControl.FileSystemAccessRule]::new($principal, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit', [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
    $acl.AddAccessRule($rule)
  }
  [IO.Directory]::SetAccessControl($root, $acl)
  $verified = Assert-PrivateAcl $root
  if (-not $verified.AreAccessRulesProtected) { throw 'Private data root still inherits permissions' }
  $item = Get-Item -LiteralPath $root -Force
  if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Private data root changed during ACL setup' }
  @{ ok = $true } | ConvertTo-Json -Compress
} catch {
  @{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
}
`;

/** Call synchronously before computing or writing any persisted secret. */
export function ensureWindowsPrivateDataDirectory(directory: string): void {
  if (process.platform !== 'win32') return;
  const powershell = path.join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  let result: { ok?: boolean; error?: string };
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => key.toLowerCase() !== 'psmodulepath',
    ),
  );
  try {
    const output = execFileSync(
      powershell,
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(protectDirectory, 'utf16le').toString('base64'),
      ],
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 30000,
        // PowerShell 7 can export a PSModulePath that makes Windows PowerShell
        // load incompatible Security modules. Only load the OS-bundled ones.
        env: {
          ...environment,
          PSModulePath: path.join(path.dirname(powershell), 'Modules'),
          OPENDOT_PRIVATE_DATA_PATH: path.resolve(directory),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    result = JSON.parse(output.trim());
  } catch {
    throw new Error(
      'Windows private data ACL setup could not be verified; no secrets may be written. Check Windows PowerShell and the data directory permissions.',
    );
  }
  if (result.ok !== true) {
    throw new Error(
      result.error ?? 'Windows private data ACL validation failed',
    );
  }
}
