import path from 'node:path';
import {
  checkNodeVersion,
  isMainModule,
  projectRoot,
  resolveNpmCli,
  runNode,
  writableNpmCache,
} from './windows-common.mjs';

export async function setupWindows({
  root = projectRoot,
  env = process.env,
} = {}) {
  checkNodeVersion();
  const npmCli = resolveNpmCli(env);
  const cache = writableNpmCache(root, env);
  for (const directory of ['', 'web', path.join('container', 'agent-runner')]) {
    console.log(`Installing locked dependencies: ${directory || 'backend'}`);
    const code = await runNode([npmCli, 'ci', '--cache', cache], {
      cwd: path.join(root, directory),
      env,
    });
    if (code !== 0)
      throw new Error(
        `npm ci failed in ${directory || 'backend'} (exit ${code}). Fix the installation error above, then rerun setup:windows.`,
      );
  }
  console.log('Building Backend, Web Client and Agent Runner...');
  const code = await runNode([npmCli, 'run', 'build:all'], { cwd: root, env });
  if (code !== 0) throw new Error(`build:all failed (exit ${code}).`);
  console.log('Setup complete. Start OpenDot with npm.cmd run start:windows.');
}

if (isMainModule(import.meta.url)) {
  setupWindows().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
