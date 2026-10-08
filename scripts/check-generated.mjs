import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { renderWorkspace, workspaceTabs } from './sync-matchmaker-workspace.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const normalize = text => text.replace(/\r\n/g, '\n');

function walk(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? walk(join(directory, entry.name)) : [join(directory, entry.name)]);
}

function controllerMethods(file, controllerName) {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2020, true);
  let definition;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === controllerName) {
      let value = node.initializer;
      while (value && (ts.isParenthesizedExpression(value) || ts.isAsExpression(value) || ts.isSatisfiesExpression(value))) value = value.expression;
      if (value && ts.isCallExpression(value)) value = value.arguments[0];
      if (value && ts.isObjectLiteralExpression(value)) definition = value;
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (!definition) throw new Error(`Cannot read controller methods: ${file}`);
  return new Set(definition.properties.filter(property => ts.isMethodDeclaration(property)
    || (ts.isPropertyAssignment(property) && (ts.isArrowFunction(property.initializer) || ts.isFunctionExpression(property.initializer))))
    .map(property => property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) ? property.name.text : '')
    .filter(method => method && !method.startsWith('onLoad') && !['onShow', 'onHide', 'onUnload'].includes(method)));
}

// This checker only reads files. It never repairs or rebuilds stale outputs.
export function checkGenerated(root = projectRoot) {
  const failures = [];
  const counts = { javascript: 0, styles: 0, workspace: 0, bindings: 0 };
  function compare(file, expected) {
    if (!existsSync(file)) failures.push(`Missing generated file: ${relative(root, file)}`);
    else if (normalize(readFileSync(file, 'utf8')) !== normalize(expected)) failures.push(`Stale generated file: ${relative(root, file)}`);
  }

  const configPath = join(root, 'tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  if (parsed.errors.length) throw new Error(parsed.errors.map(error => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'));
  const program = ts.createProgram(parsed.fileNames, { ...parsed.options, noEmit: false, noEmitOnError: false });
  const emitted = program.emit(undefined, (file, text) => {
    if (file.endsWith('.js')) { counts.javascript += 1; compare(resolve(file), text); }
  });
  if (emitted.emitSkipped) failures.push('TypeScript skipped JavaScript emission during consistency checking.');

  for (const source of walk(join(root, 'miniprogram')).filter(file => file.endsWith('.less'))) {
    counts.styles += 1;
    compare(source.slice(0, -5) + '.wxss', readFileSync(source, 'utf8'));
  }

  const rendered = renderWorkspace(root);
  for (const [file, expected] of Object.entries(rendered.files)) {
    counts.workspace += 1;
    compare(join(root, file), expected);
  }
  const methods = Object.fromEntries(workspaceTabs.map(tab => [tab, controllerMethods(
    join(root, 'miniprogram', 'controllers', 'matchmaker', `${tab}.ts`), `${tab}Controller`
  )]));
  for (const binding of rendered.bindings) {
    counts.bindings += 1;
    if (!methods[binding.tab].has(binding.handler)) failures.push(`Missing workspace event handler: ${binding.tab}.${binding.handler} (${binding.event})`);
  }
  return { failures, counts };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { failures, counts } = checkGenerated();
    if (failures.length) {
      console.error(failures.join('\n'));
      console.error('Run npm run build:miniprogram, then check again. No files were changed.');
      process.exitCode = 1;
    } else console.log(`Verified generated files: ${counts.javascript} JavaScript, ${counts.styles} styles, ${counts.workspace} workspace outputs and ${counts.bindings} event bindings.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
