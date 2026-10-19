import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync, deflateRawSync } from 'node:zlib';
import { Script } from 'node:vm';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SDK = 'C:/Users/12157/AppData/Local/npm-cache/_npx/e15d770835b66f6b/node_modules/@cloudbase/cloudbase-mcp/dist/index.cjs';
export const TARGET = Object.freeze({ envId: 'cloud1-d2gza7q9c8d69c721', region: 'ap-shanghai', functionName: 'hlApi' });
export const OUTPUT = join(ROOT, 'output/admin-entry-20261015/rebuild-source');
const MAX_ZIP = 60 * 1024 * 1024, MAX_FILE = 30 * 1024 * 1024, MAX_TOTAL = 180 * 1024 * 1024;
function fail(code) { throw Object.assign(new Error(code), { safeCode: code }); }
const sha = value => createHash('sha256').update(value).digest('hex');
export const inventory = files => files.map(file => ({ name: file.name, bytes: file.bytes.length, sha256: sha(file.bytes),
  externalAttributes: file.externalAttributes || 0, madeBy: file.madeBy === undefined ? 20 : file.madeBy }))
  .sort((a, b) => a.name.localeCompare(b.name));
function safeName(name) {
  if (!name || /[\\\x00-\x1f\x7f:]/.test(name) || name.startsWith('/')
    || name.split('/').some(part => !part || part === '.' || part === '..')) fail('ZIP_PATH_INVALID');
  return name;
}
function safeLink(name, bytes, externalAttributes) {
  if (((externalAttributes >>> 16) & 0xf000) !== 0xa000) return;
  const target = bytes.toString('utf8');
  if (!Buffer.from(target).equals(bytes) || !target || /[\\\x00-\x1f\x7f:]/.test(target) || posix.isAbsolute(target)) fail('ZIP_LINK_INVALID');
  const resolved = posix.normalize(posix.join(posix.dirname(name), target));
  if (resolved === '..' || resolved.startsWith('../')) fail('ZIP_LINK_INVALID');
}
const table = Array.from({ length: 256 }, (_, value) => {
  for (let index = 0; index < 8; index++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
export function normalizeRoot(files) {
  const root = files.some(file => file.name === 'index.js'), prefix = files.some(file => file.name === 'hlApi/index.js');
  if (root === prefix || prefix && files.some(file => !file.name.startsWith('hlApi/'))) fail('ARCHIVE_LAYOUT_INVALID');
  const result = files.map(file => ({ ...file, name: safeName(prefix ? file.name.slice(6) : file.name), bytes: Buffer.from(file.bytes) }));
  if (new Set(result.map(file => file.name.toLowerCase())).size !== result.length
    || !result.some(file => file.name === 'package.json')) fail('ARCHIVE_LAYOUT_INVALID');
  return result;
}
export function readZip(zip) {
  if (!Buffer.isBuffer(zip) || zip.length > MAX_ZIP) fail('ZIP_INVALID');
  let end = -1;
  for (let at = zip.length - 22; at >= Math.max(0, zip.length - 65557); at--) {
    if (zip.readUInt32LE(at) === 0x06054b50) { end = at; break; }
  }
  if (end < 0 || zip.readUInt16LE(end + 4) || zip.readUInt16LE(end + 6)
    || end + 22 + zip.readUInt16LE(end + 20) !== zip.length) fail('ZIP_INVALID');
  const count = zip.readUInt16LE(end + 10), centralStart = zip.readUInt32LE(end + 16);
  if (count === 65535 || count !== zip.readUInt16LE(end + 8) || centralStart + zip.readUInt32LE(end + 12) !== end) fail('ZIP_INVALID');
  let position = centralStart, total = 0;
  const files = [], seen = new Set();
  for (let index = 0; index < count; index++) {
    if (position + 46 > end || zip.readUInt32LE(position) !== 0x02014b50) fail('ZIP_INVALID');
    const flags = zip.readUInt16LE(position + 8), method = zip.readUInt16LE(position + 10), crc = zip.readUInt32LE(position + 16);
    const compressed = zip.readUInt32LE(position + 20), size = zip.readUInt32LE(position + 24), local = zip.readUInt32LE(position + 42);
    const length = zip.readUInt16LE(position + 28), extra = zip.readUInt16LE(position + 30), comment = zip.readUInt16LE(position + 32);
    const externalAttributes = zip.readUInt32LE(position + 38), madeBy = zip.readUInt16LE(position + 4);
    if (position + 46 + length + extra + comment > end || flags & 1) fail('ZIP_INVALID');
    const name = zip.subarray(position + 46, position + 46 + length).toString('utf8');
    position += 46 + length + extra + comment;
    safeName(name.endsWith('/') ? name.slice(0, -1) : name);
    if (seen.has(name.toLowerCase())) fail('ZIP_DUPLICATE_PATH');
    seen.add(name.toLowerCase());
    if (local + 30 > centralStart || zip.readUInt32LE(local) !== 0x04034b50
      || zip.readUInt16LE(local + 6) !== flags || zip.readUInt16LE(local + 8) !== method) fail('ZIP_INVALID');
    if (!(flags & 8) && (zip.readUInt32LE(local + 14) !== crc || zip.readUInt32LE(local + 18) !== compressed
      || zip.readUInt32LE(local + 22) !== size)) fail('ZIP_INVALID');
    const localLength = zip.readUInt16LE(local + 26), start = local + 30 + localLength + zip.readUInt16LE(local + 28);
    if (start + compressed > centralStart || size > MAX_FILE
      || zip.subarray(local + 30, local + 30 + localLength).toString('utf8') !== name) fail('ZIP_INVALID');
    let bytes;
    try {
      bytes = method === 0 ? Buffer.from(zip.subarray(start, start + compressed))
        : method === 8 ? inflateRawSync(zip.subarray(start, start + compressed), { maxOutputLength: MAX_FILE }) : null;
    } catch { fail('ZIP_INVALID'); }
    if (!bytes || bytes.length !== size || crc32(bytes) !== crc || (total += size) > MAX_TOTAL) fail('ZIP_INVALID');
    if (!name.endsWith('/')) {
      safeLink(name, bytes, externalAttributes);
      files.push({ name, bytes, externalAttributes, madeBy });
    }
  }
  if (position !== end) fail('ZIP_INVALID');
  return normalizeRoot(files);
}
export function rootZip(files) {
  const locals = [], records = [], seen = new Set();
  let offset = 0, total = 0;
  if (files.length >= 65535) fail('ZIP_INVALID');
  for (const file of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
    const name = Buffer.from(safeName(file.name)), bytes = Buffer.from(file.bytes);
    if (name.length > 65535 || seen.has(file.name.toLowerCase()) || bytes.length > MAX_FILE || (total += bytes.length) > MAX_TOTAL) fail('ZIP_INVALID');
    seen.add(file.name.toLowerCase());
    safeLink(file.name, bytes, file.externalAttributes || 0);
    const packed = deflateRawSync(bytes), crc = crc32(bytes), header = Buffer.alloc(30), record = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt16LE(8, 8);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(packed.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(name.length, 26);
    record.writeUInt32LE(0x02014b50); record.writeUInt16LE(file.madeBy === undefined ? 20 : file.madeBy, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(0x800, 8); record.writeUInt16LE(8, 10);
    record.writeUInt32LE(crc, 16); record.writeUInt32LE(packed.length, 20); record.writeUInt32LE(bytes.length, 24); record.writeUInt16LE(name.length, 28); record.writeUInt32LE(offset, 42);
    record.writeUInt32LE(file.externalAttributes || 0, 38);
    locals.push(header, name, packed); records.push(record, name); offset += header.length + name.length + packed.length;
  }
  const central = Buffer.concat(records), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  const result = Buffer.concat([...locals, central, end]);
  if (result.length > MAX_ZIP) fail('ZIP_INVALID');
  return result;
}
function replaceOnce(source, original, replacement) {
  if (source.split(original).length !== 2) fail('PATCH_ANCHOR_MISMATCH');
  return source.replace(original, replacement);
}
export function patchCompatibility(input) {
  const files = normalizeRoot(input);
  const required = ['index.js', 'certification-material-policy.js'];
  if (required.some(name => !files.some(file => file.name === name))) fail('PATCH_SOURCE_MISSING');
  return files.map(file => {
    if (!required.includes(file.name)) return { ...file, bytes: Buffer.from(file.bytes) };
    const original = file.bytes.toString('utf8'), newline = original.includes('\r\n') ? '\r\n' : '\n';
    if (!Buffer.from(original).equals(file.bytes)) fail('PATCH_ENCODING_INVALID');
    let updated;
    if (file.name === 'index.js') {
      const getter = "  return { encryptionKey: process.env.MEMBER_CERTIFICATION_ENCRYPTION_KEY, jwtSecret: process.env.JWT_SECRET };";
      updated = replaceOnce(original, getter, "  return { encryptionKey: process.env.MEMBER_CERTIFICATION_ENCRYPTION_KEY, jwtSecret: process.env.JWT_SECRET," + newline
        + '    jwtDerivedKey: process.env.MEMBER_CERTIFICATION_JWT_DERIVED_KEY };');
    } else {
      const old = "  return { key: source === 'dedicated' ? dedicatedKey(secrets.encryptionKey) : derivedKey(secrets.jwtSecret), keySource: source };";
      updated = replaceOnce(original, old, "  return { key: source === 'dedicated' ? dedicatedKey(secrets.encryptionKey)" + newline
        + '    : secrets.jwtDerivedKey ? dedicatedKey(secrets.jwtDerivedKey) : derivedKey(secrets.jwtSecret), keySource: source };');
    }
    try { new Script(updated); } catch { fail('PATCH_SYNTAX_INVALID'); }
    return { ...file, bytes: Buffer.from(updated) };
  });
}
function downloadUrl(value) {
  let url;
  try { url = new URL(value); } catch { fail('DOWNLOAD_URL_INVALID'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash
    || !/\.(?:myqcloud\.com|tencentcos\.cn)$/.test(url.hostname)) fail('DOWNLOAD_URL_INVALID');
  return url;
}
export async function prepare() {
  if (existsSync(OUTPUT)) fail('OUTPUT_ALREADY_EXISTS');
  const { getCloudBaseManager } = createRequire(import.meta.url)(SDK);
  const manager = await getCloudBaseManager({ cloudBaseOptions: { envId: TARGET.envId, region: TARGET.region, site: 'domestic' }, authStrategy: 'fail_fast' });
  // Read only. Never fetch environment variables, invoke business APIs, or write cloud resources.
  const before = await manager.functions.getFunctionDownloadUrl(TARGET.functionName);
  if (typeof before.CodeSha256 !== 'string' || !before.CodeSha256) fail('CODE_DIGEST_UNCONFIRMED');
  const response = await fetch(downloadUrl(before.Url), { redirect: 'error', signal: AbortSignal.timeout(60000) });
  if (!response.ok || Number(response.headers.get('content-length')) > MAX_ZIP) fail('DOWNLOAD_FAILED');
  const backup = Buffer.from(await response.arrayBuffer()), original = readZip(backup);
  const after = await manager.functions.getFunctionDownloadUrl(TARGET.functionName);
  if (after.CodeSha256 !== before.CodeSha256) fail('CLOUD_CODE_CHANGED');
  const patched = patchCompatibility(original), candidate = rootZip(patched);
  const beforeInventory = inventory(original), afterInventory = inventory(patched);
  if (JSON.stringify(inventory(readZip(candidate))) !== JSON.stringify(afterInventory)) fail('ZIP_ROUNDTRIP_MISMATCH');
  const changed = afterInventory.filter(file => beforeInventory.find(row => row.name === file.name)?.sha256 !== file.sha256).map(file => file.name).sort();
  if (JSON.stringify(changed) !== JSON.stringify(['certification-material-policy.js', 'index.js'])) fail('PATCH_SCOPE_MISMATCH');
  mkdirSync(join(OUTPUT, 'hlApi'), { recursive: true });
  // Only root sources are materialized for VM regression; the ZIP retains every dependency byte.
  for (const file of patched.filter(file => !file.name.includes('/'))) writeFileSync(join(OUTPUT, 'hlApi', file.name), file.bytes, { flag: 'wx' });
  writeFileSync(join(OUTPUT, 'hlApi.rollback.zip'), backup, { flag: 'wx' });
  writeFileSync(join(OUTPUT, 'hlApi.candidate.zip'), candidate, { flag: 'wx' });
  const report = { preparedAt: new Date().toISOString(), target: TARGET, originalRemoteCodeSha256: before.CodeSha256,
    rollbackZipSha256: sha(backup), candidateZipSha256: sha(candidate), changedFiles: changed,
    sourceFileCount: original.length, unchangedFiles: original.length - 2, addedFiles: 0, removedFiles: 0,
    beforeInventory, candidateInventory: afterInventory, allDependenciesPreserved: true,
    candidatePackage: join(OUTPUT, 'hlApi.candidate.zip'), rootSourcesOnly: join(OUTPUT, 'hlApi'),
    cloudCodeWrites: 0, configurationWrites: 0, businessCalls: 0, signedUrlPersisted: false,
    scriptSha256: sha(readFileSync(fileURLToPath(import.meta.url))) };
  writeFileSync(join(OUTPUT, 'manifest.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  return { prepared: true, output: OUTPUT, changedFiles: changed, totalFiles: original.length,
    unchangedFiles: report.unchangedFiles, cloudWrites: 0, businessCalls: 0 };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length > 2) fail('NO_DEPLOY_MODE_SUPPORTED');
    console.log(JSON.stringify(await prepare()));
  } catch (error) { console.error(JSON.stringify({ prepared: false, diagnostic: error.safeCode || 'READ_ONLY_PREPARATION_FAILED',
    cloudWrites: 0, secretsPrinted: false })); process.exitCode = 1; }
}
