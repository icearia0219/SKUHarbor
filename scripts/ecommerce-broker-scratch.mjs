import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Only the current process's freshly allocated broker directory belongs here.
// Historical verification directories require the documented manual cleanup.
export function removeBrokerScratch(scratch) {
  const real = fs.realpathSync(scratch);
  const temp = fs.realpathSync(os.tmpdir());
  if (
    !real.startsWith(temp + path.sep) ||
    !path.basename(real).startsWith('opendot-ecommerce-model-') ||
    fs.lstatSync(scratch).isSymbolicLink()
  ) {
    throw new Error('BROKER_SCRATCH_OUTSIDE_OWNED_TEMP');
  }
  const link = path.join(real, 'node_modules');
  if (fs.existsSync(link)) {
    if (!fs.lstatSync(link).isSymbolicLink())
      throw new Error('BROKER_DEPENDENCY_LINK_REQUIRED');
    // Treat a Windows directory junction as a directory entry. Nonrecursive
    // rmdir removes that entry and leaves its target untouched.
    if (process.platform === 'win32') fs.rmdirSync(link);
    else fs.unlinkSync(link);
  }
  fs.rmSync(real, { recursive: true, force: true });
}
