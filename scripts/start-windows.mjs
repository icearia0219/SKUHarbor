import fs from 'node:fs';
import path from 'node:path';
import {
  checkNodeVersion,
  findGitBash,
  isMainModule,
  projectRoot,
  runNode,
} from './windows-common.mjs';

export async function startWindows({
  root = projectRoot,
  env = process.env,
} = {}) {
  checkNodeVersion();
  const required = [
    ['node_modules', true],
    ['web/node_modules', true],
    ['container/agent-runner/node_modules', true],
    ['dist/index.js', false],
    ['web/dist/index.html', false],
    ['container/agent-runner/dist/pi-index.js', false],
  ];
  const missing = required
    .filter(([relative, directory]) => {
      try {
        const stat = fs.statSync(path.join(root, relative));
        return directory ? !stat.isDirectory() : !stat.isFile();
      } catch {
        return true;
      }
    })
    .map(([relative]) => relative);
  if (missing.length)
    throw new Error(
      `Missing dependencies or builds: ${missing.join(', ')}. Run npm.cmd run setup:windows first.`,
    );
  const bash = findGitBash({ env });
  if (!bash)
    throw new Error(
      'Git for Windows Bash is required for Host Agent tools. Install Git for Windows, or set MINICLAW_HOST_BASH_PATH to its bin\\bash.exe, then rerun start:windows.',
    );
  console.log(`Host Bash: ${bash}`);
  console.log(
    'Starting OpenDot at http://127.0.0.1:' + (env.WEB_PORT || '3000'),
  );
  return runNode([path.join(root, 'dist', 'index.js')], {
    cwd: root,
    env: { ...env, MINICLAW_HOST_BASH_PATH: bash },
  });
}

if (isMainModule(import.meta.url)) {
  startWindows()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
