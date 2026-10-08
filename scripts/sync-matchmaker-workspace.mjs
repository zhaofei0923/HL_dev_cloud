import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
export const workspaceTabs = ['dashboard', 'members', 'messages', 'salon', 'mine'];

function endOfTag(source, start) {
  let quote = '';
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === quote) quote = '';
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '>') return index + 1;
  }
  throw new Error('Unterminated WXML tag');
}

export function workspaceMarkup(source, tab, onBinding = () => {}) {
  const markup = source.replace(/[\t ]*<bottom-nav\b[^>]*(?:\/>|>[\s\S]*?<\/bottom-nav\s*>)/g, '');
  let output = '';
  let cursor = 0;
  while (cursor < markup.length) {
    const start = markup.indexOf('<', cursor);
    if (start < 0) return output + markup.slice(cursor);
    output += markup.slice(cursor, start);
    if (markup.startsWith('<!--', start)) {
      const end = markup.indexOf('-->', start + 4);
      if (end < 0) throw new Error(`Unterminated WXML comment in ${tab}`);
      output += markup.slice(start, end + 3);
      cursor = end + 3;
      continue;
    }
    const end = endOfTag(markup, start);
    const tag = markup.slice(start, end).replace(
      /\b((?:bind|catch):?[A-Za-z][A-Za-z0-9]*)\s*=\s*(["'])([^"']+)\2/g,
      (attribute, event, quote, handler) => {
        if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(handler)) {
          throw new Error(`Unsupported dynamic ${event} handler in ${tab}: ${handler}`);
        }
        onBinding({ tab, event, handler });
        return `${event}=${quote}workspace_${tab}_${handler}${quote}`;
      }
    );
    output += tag;
    cursor = end;
  }
  return output;
}

function skipComment(source, start) {
  const end = source.indexOf('*/', start + 2);
  if (end < 0) throw new Error('Unterminated CSS comment');
  return end + 2;
}

function findDelimiter(source, start) {
  let quote = '';
  let parentheses = 0;
  let brackets = 0;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = '';
      continue;
    }
    if (source.startsWith('/*', index)) {
      index = skipComment(source, index) - 1;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '(') parentheses += 1;
    else if (char === ')') parentheses -= 1;
    else if (char === '[') brackets += 1;
    else if (char === ']') brackets -= 1;
    else if (!parentheses && !brackets && (char === '{' || char === ';')) return index;
  }
  return -1;
}

function endOfBlock(source, start) {
  let quote = '';
  let depth = 1;
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = '';
      continue;
    }
    if (source.startsWith('/*', index)) {
      index = skipComment(source, index) - 1;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) return index;
  }
  throw new Error('Unterminated CSS rule');
}

function scopedSelectors(prelude, scope) {
  const leading = prelude.match(/^(?:\s|\/\*[\s\S]*?\*\/)*/)[0];
  const selector = prelude.slice(leading.length).trim();
  const parts = [];
  let quote = '';
  let parentheses = 0;
  let brackets = 0;
  let start = 0;
  for (let index = 0; index < selector.length; index += 1) {
    const char = selector[index];
    if (quote) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = '';
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '(') parentheses += 1;
    else if (char === ')') parentheses -= 1;
    else if (char === '[') brackets += 1;
    else if (char === ']') brackets -= 1;
    else if (char === ',' && !parentheses && !brackets) {
      parts.push(selector.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(selector.slice(start).trim());
  if (parts.some(part => !part)) throw new Error(`Empty CSS selector for ${scope}`);
  return leading + parts.map(part => `${scope} ${part}`).join(',\n') + ' ';
}

export function scopedCss(source, scope) {
  let output = '';
  let cursor = 0;
  while (cursor < source.length) {
    const delimiter = findDelimiter(source, cursor);
    if (delimiter < 0) return output + source.slice(cursor);
    const prelude = source.slice(cursor, delimiter);
    if (source[delimiter] === ';') {
      output += prelude + ';';
      cursor = delimiter + 1;
      continue;
    }
    const end = endOfBlock(source, delimiter);
    const body = source.slice(delimiter + 1, end);
    const rule = prelude.replace(/^(?:\s|\/\*[\s\S]*?\*\/)*/, '');
    if (rule.startsWith('@')) {
      // Grouping rules contain selectors; keyframes and font-face contain declarations.
      const nested = /^@(media|supports|container|layer|document)\b/.test(rule);
      output += `${prelude}{${nested ? scopedCss(body, scope) : body}}`;
    } else {
      output += `${scopedSelectors(prelude, scope)}{${body}}`;
    }
    cursor = end + 1;
  }
  return output;
}

export function renderWorkspace(root = projectRoot, readText = file => readFileSync(file, 'utf8')) {
  const pageRoot = join(root, 'miniprogram', 'pages', 'matchmaker');
  const templates = [];
  const styles = [];
  const bindings = [];
  const components = { 'bottom-nav': '/components/bottom-nav/bottom-nav' };
  for (const tab of workspaceTabs) {
    const source = readText(join(pageRoot, `${tab}.wxml`));
    templates.push(`<template name="${tab}">\n${workspaceMarkup(source, tab, binding => bindings.push(binding)).trim()}\n</template>`);
    styles.push(`/* ${tab} */\n${scopedCss(readText(join(pageRoot, `${tab}.less`)), `.workspace-${tab}`).trim()}`);
    const pageConfig = JSON.parse(readText(join(pageRoot, `${tab}.json`)));
    for (const [name, path] of Object.entries(pageConfig.usingComponents || {})) {
      if (components[name] && components[name] !== path) throw new Error(`Conflicting component ${name} in ${tab}`);
      components[name] = path;
    }
  }
  return { files: {
    'miniprogram/pages/matchmaker/workspace.wxml': `<!-- Generated by scripts/sync-matchmaker-workspace.mjs. Edit the source page views. -->\n${templates.join('\n\n')}\n\n<view class="matchmaker-workspace-body workspace-{{activeTab}}">\n  <template is="{{activeTab}}" data="{{...view}}"></template>\n</view>\n<bottom-nav role="matchmaker" active="{{activeTab}}" embedded bind:change="onTabChange"></bottom-nav>\n`,
    'miniprogram/pages/matchmaker/workspace.less': `/* Generated by scripts/sync-matchmaker-workspace.mjs. Edit the source page styles. */\n.matchmaker-workspace-body .page {\n  padding-bottom: calc(172rpx + env(safe-area-inset-bottom));\n}\n\n${styles.join('\n\n')}\n`,
    'miniprogram/pages/matchmaker/workspace.json': JSON.stringify({
      navigationBarTitleText: '主理人工作台', enablePullDownRefresh: true, usingComponents: components
    }, null, 2) + '\n'
  }, bindings };
}

export function syncWorkspace(root = projectRoot) {
  const { files } = renderWorkspace(root);
  for (const [file, text] of Object.entries(files)) writeFileSync(join(root, file), text);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) syncWorkspace();
