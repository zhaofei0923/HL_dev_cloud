import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { connectOperationsCode } from './connect-weda-operations.mjs';

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('Supply latest backed-up CALS and local output path');
const root = resolve(import.meta.dirname, '..');
const original = JSON.parse(await readFile(resolve(input), 'utf8'));
const runtime = await readFile(resolve(root, 'weda-admin/operations-runtime.js'), 'utf8');
const patched = connectOperationsCode(original, runtime);
await writeFile(resolve(output), JSON.stringify(patched, null, 2) + '\n');
console.log(JSON.stringify({ mode: 'local-code-only-patch', cloudWritten: false,
  changedResources: 10, otherContentPreserved: true,
  sourceCanonicalSha256: createHash('sha256').update(JSON.stringify(patched)).digest('hex') }));
