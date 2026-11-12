import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const receiptPath = (target: string) => `${target}.opendot-projection.json`;
const digest = (target: string) =>
  createHash('sha256').update(fs.readFileSync(target)).digest('hex');

/** Directory junctions work without Windows Developer Mode. File copies are
 * tracked so disabling native context cannot leave a previous host prompt. */
export function createHostFileProjection(
  source: string,
  target: string,
): 'linked' | 'copied' {
  const absoluteSource = path.resolve(source);
  if (
    process.platform !== 'win32' ||
    fs.statSync(absoluteSource).isDirectory()
  ) {
    fs.symlinkSync(
      absoluteSource,
      target,
      process.platform === 'win32' ? 'junction' : undefined,
    );
    return 'linked';
  }
  fs.copyFileSync(absoluteSource, target, fs.constants.COPYFILE_EXCL);
  const stat = fs.lstatSync(target);
  try {
    fs.rmSync(receiptPath(target), { force: true });
    fs.writeFileSync(
      receiptPath(target),
      JSON.stringify({
        version: 1,
        dev: stat.dev,
        ino: stat.ino,
        digest: digest(target),
      }),
      { flag: 'wx', mode: 0o600 },
    );
  } catch (error) {
    fs.unlinkSync(target);
    throw error;
  }
  return 'copied';
}

/** A session-authored replacement or edit ceases to be a managed copy. */
export function isHostFileProjection(target: string): boolean {
  try {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) return true;
    if (process.platform !== 'win32' || !stat.isFile() || stat.nlink !== 1)
      return false;
    const receipt = fs.lstatSync(receiptPath(target));
    if (!receipt.isFile() || receipt.nlink !== 1 || receipt.size > 1024)
      return false;
    const record = JSON.parse(fs.readFileSync(receiptPath(target), 'utf8'));
    return (
      record.version === 1 &&
      record.dev === stat.dev &&
      record.ino === stat.ino &&
      record.digest === digest(target)
    );
  } catch {
    return false;
  }
}

export function removeHostFileProjection(target: string): boolean {
  if (!isHostFileProjection(target)) return false;
  fs.unlinkSync(target);
  fs.rmSync(receiptPath(target), { force: true });
  return true;
}
