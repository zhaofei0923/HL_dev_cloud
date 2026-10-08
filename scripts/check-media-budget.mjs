import { readdirSync, statSync, readFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MEDIA_BUDGET_BYTES = 200 * 1024;
const mediaExtensions = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg', '.avif',
  '.mp3', '.wav', '.ogg', '.aac', '.m4a', '.amr', '.flac',
  '.mp4', '.mov', '.m4v', '.avi', '.wmv', '.webm', '.3gp'
]);

export function mediaBudget(root) {
  const files = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && mediaExtensions.has(extname(entry.name).toLowerCase())) {
        files.push({ path, bytes: statSync(path).size });
      }
    }
  }
  visit(root);
  const bytes = files.reduce((sum, file) => sum + file.bytes, 0);
  return { files, bytes, passed: bytes < MEDIA_BUDGET_BYTES };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = JSON.parse(readFileSync(resolve('project.config.json'), 'utf8'));
  const result = mediaBudget(resolve(config.miniprogramRoot || 'miniprogram'));
  console.log(`Media resources: ${result.files.length} files, ${(result.bytes / 1024).toFixed(2)} KiB / < 200 KiB.`);
  if (!result.passed) {
    console.error('Media resources exceed the package budget. Optimize assets before building a preview.');
    result.files.sort((a, b) => b.bytes - a.bytes).slice(0, 10)
      .forEach(file => console.error(`${file.bytes} bytes: ${file.path}`));
    process.exitCode = 1;
  }
}
