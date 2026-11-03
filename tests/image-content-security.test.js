const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createContentSecurityService } = require('../cloudfunctions/hlApi/content-security');
const { MAX_IMAGE_BYTES } = require('../cloudfunctions/hlApi/image-content-security');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const photo = name => `cloud://test-env.bucket/hl_uploads/profile/20261021/${name}.jpg`;
// A small structural JPEG fixture. The real WeChat detector decides whether
// complete image content is valid; these bytes exercise server MIME selection.
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0, 0xff, 0xda, 0, 2, 0xff, 0xd9]);

function harness(options = {}) {
  const downloads = [], checks = [], uploads = [], logs = [];
  const cloud = {
    getWXContext: () => ({ ENV: 'test-env' }),
    downloadFile: async data => { downloads.push(data); return options.download ? options.download(data, downloads.length) : { fileContent: Buffer.from(png), statusCode: 200 }; },
    uploadFile: async data => { uploads.push(data); return options.upload ? options.upload(data, uploads.length) : { fileID: `cloud://test-env.bucket/${data.cloudPath}` }; },
    openapi: { security: { imgSecCheck: async data => { checks.push(data); return options.respond ? options.respond(data, checks.length) : { errCode: 0, errMsg: 'openapi.security.imgSecCheck:ok' }; } } }
  };
  const service = createContentSecurityService({ cloud, env: { TCB_ENV: 'test-env' }, logger: record => logs.push(record) });
  return { ...service, cloud, downloads, checks, uploads, logs };
}

const failureIs = (status, code) => failure => {
  assert.equal(failure.status, status); assert.equal(failure.statusCode, status); assert.equal(failure.code, code);
  assert.ok(!/PRIVATE|cloud:\/\//.test(failure.message));
  return true;
};

test('profile and salon image submissions download actual cloud bytes and synchronously check before returning', async () => {
  const instance = harness();
  const result = await instance.assertImages({ images: [photo('one'), 'cloud://test-env.bucket/hl_uploads/salon/20261021/cover.png'] });
  assert.equal(instance.downloads.length, 2);
  assert.equal(instance.checks.length, 2);
  assert.equal(instance.checks[0].media.contentType, 'image/png');
  assert.deepEqual(instance.checks[0].media.value, png);
  assert.ok(result.every(fileID => /^cloud:\/\/test-env\.bucket\/hl_moderated\/images\/[a-f0-9]{64}\.png$/.test(fileID)));
  assert.deepEqual(instance.uploads[0].fileContent, instance.checks[0].media.value);
  assert.deepEqual(instance.logs, [{ status: 'pass', code: 0 }, { status: 'pass', code: 0 }]);
});

test('image content type follows decoded bytes rather than an extension or caller claim', async () => {
  const instance = harness({ download: async () => ({ fileContent: jpeg }) });
  await instance.assertImages({ images: [photo('jpeg').replace('.jpg', '.png')], contentType: 'image/png' });
  assert.equal(instance.checks[0].media.contentType, 'image/jpeg');
  assert.deepEqual(instance.checks[0].media.value, jpeg);
});

test('only explicit zero success codes pass, including official SDK and raw response spelling', async () => {
  for (const response of [{ errCode: 0 }, { errcode: 0 }, { errCode: 0, errcode: '0' }]) {
    await harness({ respond: async () => response }).assertImages({ images: [photo('one')] });
  }
  for (const response of [undefined, null, [], 'ok', {}, { errMsg: 'ok' }, { result: { suggest: 'pass' } },
    { errCode: 'ok' }, { errCode: null }, { errCode: false }, { errCode: '' }, { errCode: 0, errcode: 40001 },
    { errCode: 0, result: { suggest: 'unknown' } }]) {
    await assert.rejects(harness({ respond: async () => response }).assertImages({ images: [photo('one')] }), failureIs(503, 50361));
  }
});

test('returned and thrown risky image code block the entire batch with the same generic text warning', async () => {
  for (const options of [{ respond: async () => ({ errCode: 87014, errMsg: 'PRIVATE diagnostic' }) },
    { respond: async () => ({ errCode: 0, result: { suggest: 'risky' } }) },
    { respond: async () => ({ errCode: 0, result: { suggest: 'review' } }) },
    { respond: async () => { throw { errcode: '87014', errMsg: 'PRIVATE image reason' }; } }]) {
    const instance = harness(options);
    await assert.rejects(instance.assertImages({ images: [photo('risky'), photo('later')] }), failure => {
      failureIs(400, 40061)(failure);
      assert.equal(failure.message, '内容含有违规信息，请修改后重试');
      return true;
    });
    assert.equal(instance.checks.length, 1);
    assert.ok(!JSON.stringify(instance.logs).includes('PRIVATE'));
  }
});

test('network, missing permission, malformed downloads and unavailable SDK never publish an image', async () => {
  for (const options of [
    { download: async () => { throw new Error('PRIVATE file diagnostic'); } },
    { download: async () => ({ fileContent: 'PRIVATE bytes' }) },
    { download: async () => ({ fileContent: png, statusCode: 403 }) },
    { respond: async () => { throw { errCode: -604101, errMsg: 'PRIVATE permission' }; } },
    { respond: async () => { throw new Error('PRIVATE network failure'); } }
  ]) await assert.rejects(harness(options).assertImages({ images: [photo('one')] }), failure => {
    failureIs(503, 50361)(failure);
    assert.equal(failure.message, '暂时无法提交，请稍后重试');
    return true;
  });
  const instance = harness(); delete instance.cloud.openapi;
  await assert.rejects(instance.assertImages({ images: [photo('one')] }), failureIs(503, 50361));
});

test('external URLs, cross-environment files, private folders and path tricks cannot reach download or detector', async () => {
  for (const fileID of ['https://PRIVATE.example/a.jpg', '/assets/custom.jpg', photo('one').replace('test-env.', 'different-env.'),
    photo('one').replace('test-env.', 'test-env-other.'), photo('one').replace('/profile/', '/profile/../profile/'),
    photo('one').replace('/profile/', '/member-private/1/'), `${photo('one')}?raw=1`, `${photo('one')}#fragment`,
    photo('one').replace('.jpg', '.svg'), photo('one').replace('.jpg', '.webp'), photo('one').replace('.jpg', '.gif'),
    photo('one').replace('.jpg', '.heic'), photo('one').replace('hl_uploads/profile', 'hl_uploads/profile-private')]) {
    const instance = harness();
    await assert.rejects(instance.assertImages({ images: [fileID] }), failureIs(400, 40062));
    assert.equal(instance.downloads.length, 0); assert.equal(instance.checks.length, 0);
  }
});

test('unknown environment fails closed and trusted WeChat context is a supported runtime fallback', async () => {
  const instance = harness();
  const fromContext = createContentSecurityService({ cloud: instance.cloud, env: {} });
  await fromContext.assertImages({ images: [photo('one')] });
  const missing = createContentSecurityService({ cloud: { getWXContext: () => ({}) }, env: {} });
  await assert.rejects(missing.assertImages({ images: [photo('one')] }), failureIs(503, 50361));
  const invalid = createContentSecurityService({ cloud: instance.cloud, env: { TCB_ENV: 'test-env/other' } });
  await assert.rejects(invalid.assertImages({ images: [photo('one')] }), failureIs(503, 50361));
});

test('only exact shipped system assets are exempt and only when explicitly requested by trusted server logic', async () => {
  const instance = harness();
  const local = '/assets/members/avatar-female-1.png';
  await assert.rejects(instance.assertImages({ images: [local] }), failureIs(400, 40062));
  assert.deepEqual(await instance.assertImages({ images: [local, '/assets/members/lifestyle-city.png'], skipSystem: true }), [local, '/assets/members/lifestyle-city.png']);
  assert.equal(instance.downloads.length, 0);
  for (const wrong of ['/assets/members/custom.png', `${local}?a=1`, '/assets/members/../private.png']) {
    await assert.rejects(instance.assertImages({ images: [wrong], skipSystem: true }), failureIs(400, 40062));
  }
  await assert.rejects(instance.assertImages({ images: [local], skipSystem: 'true' }), failureIs(400, 40062));
});

test('malformed, excessive, or unsupported image bytes are rejected before a security call', async () => {
  const huge = Buffer.alloc(MAX_IMAGE_BYTES + 1); png.copy(huge);
  const wide = Buffer.from(png); wide.writeUInt32BE(751, 16);
  const tall = Buffer.from(png); tall.writeUInt32BE(1335, 20);
  const zero = Buffer.from(png); zero.writeUInt32BE(0, 16);
  for (const bytes of [Buffer.alloc(0), Buffer.from('GIF89a PRIVATE image bytes'), Buffer.from('RIFF PRIVATE WEBP'),
    Buffer.from('<svg PRIVATE>malicious</svg>'), huge, wide, tall, zero, png.subarray(0, 24), Buffer.concat([png, Buffer.from('PRIVATE')])]) {
    const instance = harness({ download: async () => ({ fileContent: bytes }) });
    await assert.rejects(instance.assertImages({ images: [photo('one')] }), failureIs(400, 40062));
    assert.equal(instance.checks.length, 0);
  }
});

test('animated PNG frames are blocked even when wrapped in a valid PNG signature', async () => {
  const animation = Buffer.alloc(20); animation.writeUInt32BE(8); animation.write('acTL', 4);
  const bytes = Buffer.concat([png.subarray(0, 33), animation, png.subarray(33)]);
  const instance = harness({ download: async () => ({ fileContent: bytes }) });
  await assert.rejects(instance.assertImages({ images: [photo('one')] }), failureIs(400, 40062));
  assert.equal(instance.checks.length, 0);
});

test('batch size and input types are bounded, empty removals skip checks and duplicate files are checked once', async () => {
  const instance = harness();
  await instance.assertImages(); await instance.assertImages({ images: [] });
  assert.equal(instance.downloads.length, 0);
  for (const images of [null, 'file', {}, [''], [42], [photo('a'), photo('b'), photo('c'), photo('d')]]) {
    await assert.rejects(instance.assertImages({ images }), failureIs(400, 40062));
  }
  await instance.assertImages({ images: [photo('a'), ` ${photo('a')} `] });
  assert.equal(instance.checks.length, 1);
});

test('every image must pass, no persistent approval cache survives replacement or another submission', async () => {
  let mode = 'pass';
  const instance = harness({ respond: async (_data, number) => ({ errCode: mode === 'fail' || number === 2 ? 87014 : 0 }) });
  await instance.assertImages({ images: [photo('one')] });
  mode = 'fail';
  await assert.rejects(instance.assertImages({ images: [photo('one')] }), failureIs(400, 40061));
  assert.equal(instance.downloads.length, 2);
  const batch = harness({ respond: async (_data, number) => ({ errCode: number === 2 ? 87014 : 0 }) });
  await assert.rejects(batch.assertImages({ images: [photo('one'), photo('two'), photo('three')] }), failureIs(400, 40061));
  assert.equal(batch.checks.length, 2);
  assert.equal(batch.uploads.length, 0, 'no content is copied until the entire batch has passed');
});

test('only the bytes accepted by the synchronous detector are persisted into content-addressed server copies', async () => {
  let downloaded = Buffer.from(png);
  const instance = harness({ download: async () => ({ fileContent: downloaded }),
    respond: async () => { downloaded = Buffer.from('replacement'); return { errCode: 0 }; } });
  const result = await instance.assertImages({ images: [photo('original'), photo('original')] });
  const digest = crypto.createHash('sha256').update(png).digest('hex');
  assert.deepEqual(result, [`cloud://test-env.bucket/hl_moderated/images/${digest}.png`, `cloud://test-env.bucket/hl_moderated/images/${digest}.png`]);
  assert.equal(instance.uploads.length, 1);
  assert.equal(instance.uploads[0].cloudPath, `hl_moderated/images/${digest}.png`);
  assert.deepEqual(instance.uploads[0].fileContent, png);
});

test('already moderated file IDs are downloaded and checked again rather than trusted by path', async () => {
  const digest = crypto.createHash('sha256').update(png).digest('hex');
  const fileID = `cloud://test-env.bucket/hl_moderated/images/${digest}.png`;
  const instance = harness({ respond: async () => ({ errCode: 87014 }) });
  await assert.rejects(instance.assertImages({ images: [fileID] }), failureIs(400, 40061));
  assert.equal(instance.downloads.length, 1);
  assert.equal(instance.uploads.length, 0);
});

test('copy failures or malformed upload identities fail closed without returning an original writable URL', async () => {
  for (const upload of [async () => { throw new Error('PRIVATE storage error'); }, async () => ({}),
    async data => ({ fileID: `cloud://other-env.bucket/${data.cloudPath}` }),
    async data => ({ fileID: `https://PRIVATE.example/${data.cloudPath}` }),
    async data => ({ fileID: `cloud://test-env.bucket/other/${data.cloudPath}` })]) {
    await assert.rejects(harness({ upload }).assertImages({ images: [photo('one')] }), failureIs(503, 50361));
  }
});

test('image audit evidence contains only approved safe fields, with no file IDs, bytes or labels', async () => {
  const instance = harness({ respond: async () => ({ errCode: 0, traceId: 'safe-trace', detail: 'PRIVATE', filename: photo('PRIVATE') }) });
  await instance.assertImages({ images: [photo('PRIVATE')] });
  assert.deepEqual(instance.logs, [{ status: 'pass', traceId: 'safe-trace', code: 0 }]);
});
