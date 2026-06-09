import { copyFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';

const root = join(process.cwd(), 'miniprogram');

function sync(dir) {
  for (const entry of readdirSync(dir)) {
    const source = join(dir, entry);
    const stat = statSync(source);
    if (stat.isDirectory()) {
      sync(source);
      continue;
    }
    if (extname(source) === '.less') {
      copyFileSync(source, source.slice(0, -5) + '.wxss');
    }
  }
}

sync(root);
