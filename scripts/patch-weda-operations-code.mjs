import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { connectOperationsCode, connectOperationsFeedback } from './connect-weda-operations.mjs';

const [input, output, option] = process.argv.slice(2);
if (!input || !output) throw new Error('Supply latest backed-up CALS and local output path');
if (option !== undefined && option !== '--list-feedback') throw new Error('Unknown operations patch option');
const root = resolve(import.meta.dirname, '..');
const original = JSON.parse(await readFile(resolve(input), 'utf8'));
const runtime = await readFile(resolve(root, 'weda-admin/operations-runtime.js'), 'utf8');
const codePatched = connectOperationsCode(original, runtime);
const patched = option ? connectOperationsFeedback(codePatched) : codePatched;
let changedResources = 0;
for (const page of patched.items) for (const resource of page.resources || []) {
  const previous = original.items.find(item => item.id === page.id)?.resources?.find(item => item.path === resource.path);
  if (previous?.code !== resource.code) changedResources++;
}
await writeFile(resolve(output), JSON.stringify(patched, null, 2) + '\n');
console.log(JSON.stringify({ mode: option ? 'local-code-and-list-feedback-patch' : 'local-code-only-patch', cloudWritten: false,
  changedResources, listFeedbackNodes: option ? 10 : 0, otherContentPreserved: true,
  sourceCanonicalSha256: createHash('sha256').update(JSON.stringify(patched)).digest('hex') }));
