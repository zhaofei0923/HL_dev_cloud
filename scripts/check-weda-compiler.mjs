import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const CONTRACT_PATH = new URL('../weda-admin/compiler-contract.json', import.meta.url);
const fail = code => { throw new Error(code); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeText = (value, max = 240) => typeof value === 'string'
  ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';

function failureReason(error) {
  const message = String(error?.message || '');
  const syntax = message.match(/experimental syntax '([A-Za-z][A-Za-z0-9]*)'/);
  if (syntax) return 'UNSUPPORTED_SYNTAX: ' + syntax[1];
  if (/Script execution timed out/.test(message)) return 'COMPILATION_TIMEOUT';
  if (/Unexpected token/.test(message)) return 'UNEXPECTED_TOKEN';
  if (/has already been declared/.test(message)) return 'DUPLICATE_IDENTIFIER';
  return 'COMPILATION_FAILED';
}

function resourcesIn(app) {
  const seen = new WeakSet(), resources = [];
  function walk(value) {
    if (value === null || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (object(value) && value.type === 'CODE') resources.push(value);
    for (const item of Object.values(value)) walk(item);
  }
  walk(app);
  return resources;
}

// The compiler file is downloaded separately from the official URL and must
// match the reviewed digest. Resource code is parsed/transformed, never run.
export async function validateWedaCompiler(app, babelFile) {
  if (!object(app)) fail('INVALID_CALS_APPLICATION');
  if (typeof babelFile !== 'string' || !babelFile.trim()) fail('COMPILER_FILE_REQUIRED');
  const contract = JSON.parse(await readFile(CONTRACT_PATH, 'utf8'));
  if (contract.schemaVersion !== 1 || contract.compiler?.version !== '7.9.6'
    || !/^[a-f0-9]{64}$/.test(contract.compiler?.sha256 || '')
    || JSON.stringify(contract.options) !== JSON.stringify({ presets: ['env', 'react'] })
    || !Array.isArray(contract.javascriptCodeTypes) || !Array.isArray(contract.nonJavascriptCodeTypes)) fail('INVALID_COMPILER_CONTRACT');
  let source;
  try { source = await readFile(resolve(babelFile)); } catch { fail('COMPILER_FILE_UNAVAILABLE'); }
  if (source.length > 4 * 1024 * 1024) fail('COMPILER_FILE_TOO_LARGE');
  const digest = createHash('sha256').update(source).digest('hex');
  if (digest !== contract.compiler.sha256) fail('COMPILER_SHA256_MISMATCH');
  const scope = vm.createContext({ console: Object.freeze({ log() {}, info() {}, warn() {}, error() {} }) });
  try { vm.runInContext(source.toString('utf8'), scope, { filename: 'official-weda-babel.js', timeout: 10000 }); }
  catch { fail('COMPILER_LOAD_FAILED'); }
  if (scope.Babel?.version !== contract.compiler.version) fail('COMPILER_VERSION_MISMATCH');
  const report = {
    passed: true,
    compiler: { ...contract.compiler, sha256: digest },
    options: contract.options,
    resourceCount: 0,
    compiledCount: 0,
    failures: [],
  };
  for (const resource of resourcesIn(app)) {
    if (contract.nonJavascriptCodeTypes.includes(resource.codeType)) continue;
    report.resourceCount++;
    const entry = { path: safeText(resource.path, 300) || '(missing path)', codeType: safeText(resource.codeType, 60), line: null, column: null };
    if (!contract.javascriptCodeTypes.includes(resource.codeType)) {
      report.failures.push({ ...entry, reason: 'UNSUPPORTED_CALS_CODE_TYPE' });
      continue;
    }
    if (typeof resource.code !== 'string') {
      report.failures.push({ ...entry, reason: 'INVALID_RESOURCE_CODE' });
      continue;
    }
    try {
      scope.__wedaSource = resource.code;
      vm.runInContext('Babel.transform(__wedaSource, { presets: ["env", "react"] }).code', scope, { filename: 'weda-compiler-check.js', timeout: 10000 });
      report.compiledCount++;
    } catch (error) {
      report.failures.push({ ...entry, line: Number.isSafeInteger(error?.loc?.line) ? error.loc.line : null,
        column: Number.isSafeInteger(error?.loc?.column) ? error.loc.column + 1 : null, reason: failureReason(error) });
    } finally { delete scope.__wedaSource; }
  }
  report.passed = report.resourceCount > 0 && report.failures.length === 0;
  if (!report.resourceCount) report.failures.push({ path: '(application)', codeType: '', line: null, column: null, reason: 'NO_JAVASCRIPT_RESOURCES' });
  return report;
}

async function main(argv) {
  let calsFile = resolve(ROOT, 'weda-admin/app.cals.json'), babelFile, stdout = false;
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (value === '--stdout') stdout = true;
    else if ((value === '--cals' || value === '--babel') && argv[i + 1] && !argv[i + 1].startsWith('--')) {
      if (value === '--cals') calsFile = resolve(argv[++i]); else babelFile = resolve(argv[++i]);
    } else if (value === '--help') {
      process.stdout.write('Usage: node scripts/check-weda-compiler.mjs --babel <official-babel-file> [--cals <app.cals.json>] [--stdout]\n');
      return;
    } else if (!value.startsWith('--') && i === 0) calsFile = resolve(value);
    else fail('INVALID_COMPILER_ARGUMENTS');
  }
  let app;
  try { app = JSON.parse(await readFile(calsFile, 'utf8')); } catch { fail('CALS_FILE_UNAVAILABLE_OR_INVALID'); }
  const report = await validateWedaCompiler(app, babelFile);
  if (stdout) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  else {
    process.stdout.write(`Weda compiler ${report.compiler.version}: ${report.compiledCount}/${report.resourceCount} JavaScript resources compiled.\n`);
    for (const failure of report.failures) process.stderr.write(`${failure.path}:${failure.line ?? '?'}:${failure.column ?? '?'} ${failure.reason}\n`);
  }
  if (!report.passed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {
    // Fixed codes only: file contents, code frames and arbitrary errors stay local.
    const code = /^(?:INVALID_CALS_APPLICATION|COMPILER_FILE_REQUIRED|INVALID_COMPILER_CONTRACT|COMPILER_FILE_UNAVAILABLE|COMPILER_FILE_TOO_LARGE|COMPILER_SHA256_MISMATCH|COMPILER_LOAD_FAILED|COMPILER_VERSION_MISMATCH|INVALID_COMPILER_ARGUMENTS|CALS_FILE_UNAVAILABLE_OR_INVALID)$/.test(error?.message) ? error.message : 'WEDA_COMPILER_CHECK_FAILED';
    process.stderr.write(code + '\n');
    process.exitCode = 1;
  });
}
