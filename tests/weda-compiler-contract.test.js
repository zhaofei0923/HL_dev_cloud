const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const logicalAssignmentTokens = new Set([
  ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);
function unsupportedAssignments(code) {
  const source = ts.createSourceFile('resource.js', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX);
  const found = [];
  function visit(node) {
    if (ts.isBinaryExpression(node) && logicalAssignmentTokens.has(node.operatorToken.kind)) {
      found.push(source.getLineAndCharacterOfPosition(node.operatorToken.getStart(source)).line + 1);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return found;
}

test('Weda Babel 7.9.6 regression guard detects logical assignments without matching text or comments', () => {
  assert.deepEqual(unsupportedAssignments('let windows; (windows ||= []).push(opened);'), [1]);
  assert.deepEqual(unsupportedAssignments('a &&= b;\nc ??= d;'), [1, 2]);
  assert.deepEqual(unsupportedAssignments('const hint = "a ||= b"; // a &&= b\n/* a ??= b */\nwindows = windows || [];'), []);
});

test('every shipped Weda JavaScript resource avoids the syntax that prevented all management handlers registering', () => {
  const app = JSON.parse(fs.readFileSync(path.join(root, 'weda-admin/app.cals.json'), 'utf8'));
  const contract = JSON.parse(fs.readFileSync(path.join(root, 'weda-admin/compiler-contract.json'), 'utf8'));
  const failures = [];
  let count = 0;
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    if (value.type === 'CODE' && !contract.nonJavascriptCodeTypes.includes(value.codeType)) {
      count++;
      assert.ok(contract.javascriptCodeTypes.includes(value.codeType), `Unknown JavaScript code type: ${value.codeType}`);
      for (const line of unsupportedAssignments(value.code)) failures.push(`${value.path}:${line}`);
    }
    for (const child of Object.values(value)) visit(child);
  }
  visit(app);
  assert.ok(count >= 12, 'all six pages must supply their handler and lifecycle');
  assert.deepEqual(failures, [], 'Babel 7.9.6 rejects logical assignment before registering the module');
});

test('official compiler check fails closed when the pinned compiler is missing or replaced', async () => {
  const { validateWedaCompiler } = await import('../scripts/check-weda-compiler.mjs');
  await assert.rejects(validateWedaCompiler({}, undefined), { message: 'COMPILER_FILE_REQUIRED' });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-weda-compiler-test-'));
  try {
    await assert.rejects(validateWedaCompiler({}, path.join(directory, 'missing.js')), { message: 'COMPILER_FILE_UNAVAILABLE' });
    const replacement = path.join(directory, 'replacement.js');
    fs.writeFileSync(replacement, 'throw new Error("replacement must never execute")');
    await assert.rejects(validateWedaCompiler({}, replacement), { message: 'COMPILER_SHA256_MISMATCH' });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
