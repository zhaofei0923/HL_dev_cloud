import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const check = (ok, code) => { if (!ok) throw Object.assign(new Error(code), { safeCode: code }); };
const normalize = value => Buffer.isBuffer(value) ? value.toString('utf8').replaceAll('\r\n', '\n') : value.replaceAll('\r\n', '\n');
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function parseHunks(patch) {
  const hunks = []; let current;
  for (const line of normalize(patch).split('\n')) {
    if (/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(line)) {
      current = { before: [], after: [] }; hunks.push(current);
    } else if (current && /^[ +\-]/.test(line)) {
      if (line[0] !== '+') current.before.push(line.slice(1));
      if (line[0] !== '-') current.after.push(line.slice(1));
    } else if (current && line && !line.startsWith('\\ No newline')) {
      check(false, 'DELTA_FORMAT_INVALID');
    }
  }
  check(hunks.length > 0, 'EMPTY_SOURCE_DELTA');
  return hunks.map(hunk => ({ before: hunk.before.join('\n') + '\n', after: hunk.after.join('\n') + '\n' }));
}
export function applyExactHunks(source, hunks) {
  let next = normalize(source);
  for (const hunk of hunks) {
    check(hunk.before && next.split(hunk.before).length === 2, 'SOURCE_CONTEXT_NOT_EXACTLY_UNIQUE');
    next = next.replace(hunk.before, () => hunk.after);
  }
  return Buffer.from(next);
}
export function reviewedDelta(before, after, cloud, directory, name) {
  check(/^[a-z0-9_.-]+$/i.test(name), 'DELTA_NAME_INVALID');
  mkdirSync(directory, { recursive: true });
  const oldPath = join(directory, name + '.before.txt'), newPath = join(directory, name + '.after.txt');
  writeFileSync(oldPath, normalize(before)); writeFileSync(newPath, normalize(after));
  let patch;
  try { patch = execFileSync('git', ['diff', '--no-index', '--no-ext-diff', '--text', '--unified=3', '--', oldPath, newPath], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (error) { check(error.status === 1 && typeof error.stdout === 'string', 'SOURCE_DIFF_FAILED'); patch = error.stdout; }
  const hunks = parseHunks(patch);
  check(applyExactHunks(before, hunks).equals(Buffer.from(normalize(after))), 'LOCAL_DELTA_ROUNDTRIP_FAILED');
  const bytes = applyExactHunks(cloud, hunks);
  writeFileSync(join(directory, name + '.patch'), patch);
  return { bytes, proof: { name, hunkCount: hunks.length, beforeSourceSha256: sha256(before),
    afterSourceSha256: sha256(after), cloudBeforeSha256: sha256(cloud), cloudAfterSha256: sha256(bytes),
    patchSha256: sha256(patch), exactContextOnly: true } };
}
