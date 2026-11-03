const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { runtime, deferred, flush } = require('./helpers/miniprogram-runtime');

const plain = value => JSON.parse(JSON.stringify(value));
const failure = code => Object.assign(new Error('private provider diagnostics must not appear'), { code });
const SAFE_MESSAGES = {
  40061: '内容含有违规信息，请修改后重试',
  40062: '内容格式不正确，请修改后重试',
  50361: '暂时无法提交，请稍后重试'
};

function profileRuntime(write) {
  return runtime('pages/user/profile.js', { source: true,
    request: async (_path, options) => options?.method === 'PUT' ? write(options.data)
      : { id: 1, nickname: '原称呼', profile: { realName: '原称呼', city: '上海', photos: ['cloud://old-photo.jpg'] } }
  });
}

test('new profile images wait for server acceptance before replacing the displayed photos or saved baseline', async () => {
  const pending = deferred();
  const { page, calls } = profileRuntime(() => pending.promise);
  await page.onShow();
  const originalAvatar = page.data.preview.avatarUrl;
  const saving = page.saveImmediatePatch({ photos: ['cloud://new-photo.jpg'] }, {
    photoText: 'cloud://new-photo.jpg', photoDisplayUrls: ['wxfile://new-photo.jpg']
  }, '照片已保存');
  assert.equal(page.data.form.photoText, 'cloud://old-photo.jpg');
  assert.equal(page.data.preview.avatarUrl, originalAvatar);
  assert.equal(page._savedForm.photoText, 'cloud://old-photo.jpg');
  assert.equal(calls.toasts.includes('照片已保存'), false);
  pending.resolve({ id: 1, profile: { photos: ['cloud://new-photo.jpg'] } });
  assert.equal(await saving, true);
  assert.equal(page.data.form.photoText, 'cloud://new-photo.jpg');
  assert.equal(page._savedForm.photoText, 'cloud://new-photo.jpg');
  assert.equal(calls.toasts.at(-1), '照片已保存');
});

test('accepted server copy IDs and signed display URLs replace the upload draft without resubmitting temporary URLs', async () => {
  const accepted = 'cloud://env.bucket/hl_moderated/images/' + 'a'.repeat(64) + '.jpg';
  const signed = 'https://private.example/accepted.jpg?signature=fresh';
  const { page, calls } = profileRuntime(data => Promise.resolve({ id: 1,
    avatarUrl: signed, profile: { photos: [accepted], photoDisplayUrls: [signed], ...('realName' in data ? { realName: data.realName } : {}) }
  }));
  await page.onShow();
  assert.equal(await page.saveImmediatePatch({ photos: ['cloud://uploaded.jpg'] }, {
    photoText: 'cloud://uploaded.jpg', photoDisplayUrls: ['wxfile://draft.jpg']
  }, '照片已保存'), true);
  assert.equal(page.data.form.photoText, accepted);
  assert.equal(page._savedForm.photoText, accepted);
  assert.deepEqual(plain(page.data.form.photoDisplayUrls), [signed]);
  assert.equal(page.data.preview.avatarUrl, signed);
  assert.equal(await page.saveImmediatePatch({ photos: [accepted] }, {
    photoText: accepted, photoDisplayUrls: ['https://private.example/accepted.jpg?signature=expired']
  }, '照片已保存'), true);
  assert.equal(page.data.preview.avatarUrl, signed, 'fresh server URLs must replace cached or local URLs');
  const last = calls.requests.filter(row => row.options?.method === 'PUT').at(-1);
  assert.deepEqual(plain(last.options.data), { photos: [accepted] });
  assert.doesNotMatch(JSON.stringify(last.options.data), /https:|wxfile:/);
});

for (const code of [40061, 40062, 50361]) {
  test(`profile photo rejection ${code} retains the accepted avatar and draft with a safe retry message`, async () => {
    const pending = deferred();
    const { page, calls } = profileRuntime(() => pending.promise);
    await page.onShow();
    const originalAvatar = page.data.preview.avatarUrl;
    const saving = page.saveImmediatePatch({ photos: ['cloud://new-photo.jpg'] }, {
      photoText: 'cloud://new-photo.jpg', photoDisplayUrls: ['wxfile://new-photo.jpg']
    }, '照片已保存');
    page.updateForm('selfIntro', '保留正在编辑的介绍');
    pending.reject(failure(code));
    assert.equal(await saving, false);
    assert.equal(page.data.form.photoText, 'cloud://old-photo.jpg');
    assert.equal(page.data.preview.avatarUrl, originalAvatar);
    assert.equal(page._savedForm.photoText, 'cloud://old-photo.jpg');
    assert.equal(page.data.form.selfIntro, '保留正在编辑的介绍');
    assert.equal(page.data.saving, false);
    assert.equal(page.data.saveStatus, SAFE_MESSAGES[code]);
    assert.equal(calls.toasts.at(-1), SAFE_MESSAGES[code]);
    assert.equal(calls.toasts.includes('照片已保存'), false);
    assert.equal(JSON.stringify(calls.updates).includes('private provider'), false);
  });

  test(`profile text rejection ${code} never confirms success and can retry the edited draft`, async () => {
    let writes = 0;
    const { page, calls } = profileRuntime(data => ++writes === 1 ? Promise.reject(failure(code)) : Promise.resolve({ profile: data }));
    await page.onShow();
    page.openProfileEditor();
    page.updateForm('realName', '修改中的称呼');
    assert.equal(await page.save(), false);
    assert.equal(page.data.saveStatus, SAFE_MESSAGES[code]);
    assert.equal(page.data.form.realName, '修改中的称呼');
    assert.equal(page.data.formDirty, true);
    assert.equal(calls.toasts.includes('资料已保存'), false);
    assert.equal(await page.save(), true);
    assert.equal(page.data.formDirty, false);
    assert.equal(calls.toasts.at(-1), '资料已保存');
  });
}

function sourceModule(relative, globals = {}, requireStub) {
  const filename = path.join(__dirname, '..', 'miniprogram', relative);
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, console: { warn() {} }, require: requireStub, ...globals }, { filename });
  return module.exports;
}

function imageRuntime({ original = { width: 400, height: 600, type: 'jpeg', size: 1000 }, variants = [], infoFailure = false } = {}) {
  const calls = { uploads: [], compressed: [], deleted: [], hidden: 0 };
  const files = new Map([['wxfile://original.jpg', original]]);
  let compressedCount = 0;
  const wx = {
    chooseImage: options => options.success({ tempFilePaths: ['wxfile://original.jpg'] }),
    showLoading() {}, hideLoading: () => { calls.hidden += 1; },
    getImageInfo(options) {
      if (infoFailure) return options.fail(new Error('private image decoder detail'));
      const file = files.get(options.src);
      options.success({ ...file, path: options.src });
    },
    getFileSystemManager: () => ({ getFileInfo: options => options.success({ size: files.get(options.filePath).size }) }),
    compressImage(options) {
      calls.compressed.push({ width: options.compressedWidth, height: options.compressedHeight, quality: options.quality });
      const variant = variants[compressedCount] || variants.at(-1) || original;
      const target = `wxfile://prepared-${compressedCount++}.jpg`;
      files.set(target, variant);
      options.success({ tempFilePath: target });
    },
    cloud: {
      uploadFile: async options => { calls.uploads.push(options); return { fileID: `cloud://env/${options.cloudPath}` }; },
      deleteFile: async options => { calls.deleted.push(...options.fileList); return { fileList: [] }; }
    }
  };
  return { images: sourceModule('utils/local-image.ts', { wx }), calls };
}

test('upload preparation preserves an already bounded JPEG and keeps the private owner path', async () => {
  const { images, calls } = imageRuntime();
  const chosen = await images.chooseLocalImages(1, { cloudFolder: 'member-private', privateOwnerKey: 42 });
  assert.equal(calls.compressed.length, 0);
  assert.equal(calls.uploads[0].filePath, 'wxfile://original.jpg');
  assert.match(calls.uploads[0].cloudPath, /^hl_uploads\/member-private\/42\//);
  assert.equal(chosen[0].displayUrl, calls.uploads[0].filePath);
});

test('upload preparation scales a camera photo to bounded dimensions, verifies real bytes, and only uploads the prepared file', async () => {
  const { images, calls } = imageRuntime({ original: { width: 3000, height: 6000, type: 'jpeg', size: 6000000 },
    variants: [{ width: 667, height: 1334, type: 'jpeg', size: 1100000 }, { width: 667, height: 1334, type: 'jpeg', size: 450000 }] });
  const chosen = await images.chooseLocalImages(1);
  assert.deepEqual(calls.compressed.map(row => row.quality), [85, 65]);
  assert.ok(calls.compressed.every(row => row.width <= 750 && row.height <= 1334));
  assert.equal(calls.uploads.length, 1);
  assert.equal(calls.uploads[0].filePath, 'wxfile://prepared-1.jpg');
  assert.equal(chosen[0].tempFilePath, 'wxfile://prepared-1.jpg');
  assert.equal(chosen[0].displayUrl, chosen[0].tempFilePath);
});

test('client refuses oversized, unresized, unsupported or unreadable images before any upload', async () => {
  for (const options of [
    { original: { width: 3000, height: 6000, type: 'jpeg', size: 6000000 } },
    { original: { width: 750, height: 1000, type: 'png', size: 1000001 } },
    { original: { width: 400, height: 600, type: 'gif', size: 1000 } },
    { original: { width: 0, height: 600, type: 'jpeg', size: 1000 } },
    { infoFailure: true }
  ]) {
    const { images, calls } = imageRuntime(options);
    await assert.rejects(images.chooseLocalImages(1), /照片处理失败，请重新选择或缩小图片后重试/);
    assert.equal(calls.uploads.length, 0);
    assert.equal(calls.hidden, 1);
  }
});

for (const role of ['user', 'matchmaker']) {
  test(`${role} cannot start, finish or upload new voice through legacy page handlers`, async () => {
    const calls = { recorder: 0, uploads: 0, sends: 0, toasts: [] };
    const definition = sourceModule('utils/chat-page.ts', {
      wx: { showToast: options => calls.toasts.push(options.title) }
    }, name => {
      if (name.endsWith('/services/chat')) return { chatApi: { sendVoiceMessage: () => { calls.sends += 1; } } };
      if (name.endsWith('/page-session')) return { pageSessionScope: () => 'test-session' };
      if (name.endsWith('/chat-voice')) return {
        cancelChatVoiceRecording() {}, resolveChatVoiceUrls: async rows => rows, voiceDurationText: () => '2秒',
        startChatVoiceRecording: () => { calls.recorder += 1; },
        stopChatVoiceRecording: () => { calls.recorder += 1; },
        uploadChatVoice: () => { calls.uploads += 1; }
      };
      throw new Error(`unexpected import ${name}`);
    }).createChatPageDefinition();
    const page = { ...definition, data: structuredClone(definition.data), setData(update) { Object.assign(this.data, update); } };
    page.data.recording = true;
    page.toggleVoiceMode();
    await page.startVoice();
    page.data.recording = true;
    await page.finishVoice();
    assert.equal(calls.recorder, 0);
    assert.equal(calls.uploads, 0);
    assert.equal(calls.sends, 0);
    assert.equal(page.data.voiceMode, false);
    assert.equal(page.data.recording, false);
    assert.ok(calls.toasts.every(text => text === '语音发送暂不可用，请发送文字消息'));
    const markup = fs.readFileSync(path.join(__dirname, '..', 'miniprogram', 'pages', role, 'chat.wxml'), 'utf8');
    assert.doesNotMatch(markup, /bind(?:tap="toggleVoiceMode"|touchstart="startVoice"|touchend="finishVoice")/);
    assert.match(markup, /bindtap="playVoice"/);
    assert.match(markup, /bindtap="send"/);
  });

  test(`${role} text content rejection retains its draft and never appends an outgoing success`, async () => {
    const instance = runtime(`pages/${role}/chat.js`, { source: true, chatApi: {
      listMessages: async () => ({ conversation: { id: 7, title: '会话' }, messages: [], hasMore: false }),
      sendMessage: async () => { throw failure(40061); }
    } });
    await instance.page.onLoad({ id: '7' });
    instance.page.setData({ inputValue: '尚未发送的草稿' });
    await instance.page.send();
    await flush();
    assert.equal(instance.page.data.inputValue, '尚未发送的草稿');
    assert.deepEqual(plain(instance.page.data.messages), []);
    assert.equal(instance.page.data.sending, false);
  });
}
