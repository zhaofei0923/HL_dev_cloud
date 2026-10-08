const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runtime, deferred, flush, miniprogramRoot } = require('./helpers/miniprogram-runtime');

const KINDS = ['identity', 'education', 'vehicle', 'property', 'assets'];
const plain = value => JSON.parse(JSON.stringify(value));
const picker = index => ({ detail: { value: String(index) } });
const consent = accepted => ({ detail: { value: accepted ? ['confirmed'] : [] } });
const clickKind = kind => ({ currentTarget: { dataset: { kind } } });
const clickMethod = method => ({ currentTarget: { dataset: { method } } });
const clickMaterial = id => ({ currentTarget: { dataset: { id } } });

function seedMaterial(page, id = 'encrypted-material-1') {
  page.setData({ uploadedMaterials: [{ id, mimeType: 'image/jpeg', size: 100, previewPath: 'wxfile://local-preview.jpg', isPdf: false, sizeText: '1 KB' }] });
}
function fillEducation(page, method = 'cscse_number', level = 2, institution = '海外示例大学') {
  page.chooseMethod(clickMethod(method));
  page.onEducationLevelChange(picker(level));
  page.onInstitutionInput({ detail: { value: institution } });
  page.onVerificationInput({ detail: { value: 'test-certification-reference' } });
}

function overview(changes = {}) {
  return { entries: KINDS.map(kind => ({ kind, status: 'unsubmitted', verified: false, ...changes[kind] })) };
}

function certificationRuntime(kind = 'education', overrides = {}) {
  const instance = runtime('pages/user/certification.js', {
    ...overrides,
    memberApi: {
      certifications: async () => overview(),
      applyCertification: async data => overview({ [data.kind]: {
        status: 'pending', application: { status: 'pending', ...data }
      } }),
      removeCertificationMaterial: async () => ({ removed: true }),
      ...overrides.memberApi
    }
  });
  instance.page.onLoad({ kind });
  return instance;
}

test('my profile shows five trusted certification statuses without treating self-filled education as certified', async () => {
  const { page } = runtime('pages/user/profile.js', {
    request: async () => ({ profile: { education: '博士', isVerified: true } }),
    memberApi: { certifications: async () => overview({
      education: { status: 'pending', verified: false },
      vehicle: { status: 'approved', verified: true },
      property: { status: 'rejected', verified: false },
      assets: { status: 'revoked', verified: false }
    }) }
  });
  await page.onShow();
  assert.deepEqual(plain(page.data.certificationRows.map(item => item.kind)), KINDS);
  assert.deepEqual(plain(page.data.certificationRows.map(item => item.state)), ['未认证', '待审核', '已认证', '未通过', '已撤销']);
  assert.equal(page.data.certificationRows[1].verified, false);
  assert.equal(page.data.certificationRows[2].verified, true);
});

test('profile certification refresh retains unsaved edits and sees application status on returning', async () => {
  let reads = 0;
  const { page, calls } = runtime('pages/user/profile.js', { memberApi: {
    certifications: async () => overview({ education: ++reads > 1
      ? { status: 'pending', application: { status: 'pending' } } : {} })
  } });
  await page.onShow();
  page.openCertification(clickKind('education'));
  assert.equal(calls.navigation.at(-1).url, '/pages/user/certification?kind=education');
  page.updateForm('realName', '未保存姓名');
  await page.onShow();
  assert.equal(page.data.form.realName, '未保存姓名');
  assert.equal(page._formDirty, true);
  assert.equal(page.data.certificationRows[1].state, '待审核');
  page.openCertification(clickKind('assets'));
  assert.equal(calls.navigation.filter(item => item.method === 'navigateTo').length, 1);
  assert.ok(calls.toasts.includes('请先保存资料，再申请认证'));
  assert.equal(page.data.editingProfile, true);
});

test('profile certification load errors remain visible and incomplete data requires retry', async () => {
  let reads = 0;
  const { page } = runtime('pages/user/profile.js', { memberApi: {
    certifications: async () => {
      reads += 1;
      if (reads === 1) throw new Error('network failed');
      return reads === 2 ? { entries: [] } : overview();
    }
  } });
  await page.onShow();
  assert.equal(page.data.certificationsError, '认证状态读取失败，请重试');
  assert.ok(page.data.certificationRows.every(item => item.state === '读取中'));
  await page.retryCertifications();
  assert.ok(page.data.certificationsError);
  await page.retryCertifications();
  assert.equal(page.data.certificationsError, '');
  assert.ok(page.data.certificationRows.every(item => item.state === '未认证'));
});

test('profile late old-account and unloaded responses never alter certification rows', async () => {
  const old = deferred();
  const late = deferred();
  let reads = 0;
  const { page, session } = runtime('pages/user/profile.js', { memberApi: {
    certifications: () => {
      reads += 1;
      return reads === 1 ? old.promise : reads === 2 ? Promise.resolve(overview()) : late.promise;
    }
  } });
  const first = page.onShow();
  await flush();
  session.token = 'another-certification-account';
  session.user = { id: 2 };
  await page.onShow();
  old.resolve(overview({ assets: { status: 'approved', verified: true } }));
  await first;
  assert.equal(page.data.certificationRows[4].verified, false);
  const loading = page.retryCertifications();
  await flush();
  page.onUnload();
  late.resolve(overview({ assets: { status: 'approved', verified: true } }));
  await loading;
  assert.equal(page.data.certificationRows[4].verified, false);
});

test('overseas education application submits only claim fields and remains pending', async () => {
  const writes = [];
  const { page, calls } = certificationRuntime('education', { memberApi: {
    applyCertification: async data => {
      writes.push(plain(data));
      return overview({ education: { status: 'pending', verified: false, application: { status: 'pending', ...data } } });
    }
  } });
  await page.onShow();
  fillEducation(page, 'cscse_number', 2, '  海外示例大学  ');
  page.onConsentChange(consent(true));
  await page.submitApplication();
  assert.deepEqual(writes, [{ kind: 'education', consentConfirmed: true, materialIds: [], source: 'cscse', educationLevel: 'doctor', institutionName: '海外示例大学', method: 'cscse_number', certificateNumber: 'test-certification-reference' }]);
  assert.equal(page.data.statusText, '待审核');
  assert.equal(page.data.verified, false);
  assert.equal(page.data.pending, true);
  assert.equal(page.data.consentConfirmed, false);
  assert.ok(calls.toasts.includes('申请已提交，等待审核'));
  page.onConsentChange(consent(true));
  await page.submitApplication();
  assert.equal(writes.length, 1, 'pending applications cannot be submitted again');
});

test('education submission requires consent, source and level and supports domestic CHSI', async () => {
  const writes = [];
  const { page } = certificationRuntime('education', { memberApi: {
    applyCertification: async data => { writes.push(plain(data)); return overview({ education: { status: 'pending' } }); }
  } });
  await page.onShow();
  await page.submitApplication();
  assert.equal(page.data.submissionError, '请先阅读并同意认证申请说明');
  page.onConsentChange(consent(true));
  await page.submitApplication();
  assert.equal(page.data.submissionError, '请选择学历认证方式');
  page.chooseMethod(clickMethod('chsi_code'));
  await page.submitApplication();
  assert.equal(page.data.submissionError, '请填写学校全称，并选择学历来源和最高已取得学历');
  fillEducation(page, 'chsi_code', 0, '国内示例大学');
  await page.submitApplication();
  assert.deepEqual(writes, [{ kind: 'education', consentConfirmed: true, materialIds: [], source: 'chsi', educationLevel: 'bachelors', institutionName: '国内示例大学', method: 'chsi_code', verificationCode: 'test-certification-reference' }]);
});

test('identity, vehicle, property and asset requests contain only allowed material IDs and private claim fields', async () => {
  for (const kind of KINDS.filter(item => item !== 'education')) {
    const writes = [];
    const { page } = certificationRuntime(kind, { memberApi: {
      applyCertification: async data => { writes.push(plain(data)); return overview({ [kind]: { status: 'pending' } }); }
    } });
    await page.onShow();
    // Even stale educational draft fields must not leak into other certification requests.
    page.setData({ educationSource: 'cscse', educationLevel: '博士', institutionName: '示例学校', financialAssetRange: 'over_10m', verified: true });
    seedMaterial(page);
    if (kind === 'assets') page.onAssetRangeChange(picker(2));
    page.onConsentChange(consent(true));
    await page.submitApplication();
    assert.deepEqual(writes, [{ kind, consentConfirmed: true, materialIds: ['encrypted-material-1'], ...(kind === 'assets' ? { declaredFinancialAssetRange: '2m_5m' } : {}) }]);
    assert.equal(page.data.verified, false);
  }
});

test('valid old certification survives a pending update for both allowed overview encodings', async () => {
  for (const status of ['approved', 'pending']) {
    const { page } = certificationRuntime('education', { memberApi: {
      certifications: async () => overview({ education: { status: 'approved', verified: true, verifiedEducation: '硕士', source: 'cscse' } }),
      applyCertification: async () => overview({ education: {
        status, verified: true, verifiedEducation: '硕士',
        application: { status: 'pending', source: 'cscse', educationLevel: '博士' }
      } })
    } });
    await page.onShow();
    assert.equal(page.data.statusText, '已认证');
    fillEducation(page);
    page.onConsentChange(consent(true));
    await page.submitApplication();
    assert.equal(page.data.statusText, '已认证 · 更新待审核');
    assert.equal(page.data.verified, true);
    assert.equal(page.data.verifiedDetail, '已核验学历：硕士');
    assert.equal(page.data.pending, true);
  }
});

test('certification failures block submission until a successful status retry', async () => {
  let reads = 0;
  let writes = 0;
  const { page } = certificationRuntime('assets', { memberApi: {
    certifications: async () => { if (++reads === 1) throw new Error('offline'); return overview(); },
    applyCertification: async () => { writes += 1; throw new Error('response timed out'); }
  } });
  await page.onShow();
  page.onConsentChange(consent(true));
  await page.submitApplication();
  assert.equal(writes, 0);
  assert.ok(page.data.loadError);
  await page.retryLoad();
  seedMaterial(page);
  page.onAssetRangeChange(picker(2));
  await page.submitApplication();
  assert.equal(writes, 1);
  assert.equal(page.data.verified, false);
  assert.equal(page.data.submissionError, '申请结果暂未确认，请刷新状态后再继续');
  await page.submitApplication();
  assert.equal(writes, 1, 'an uncertain submission requires a read before another write');
});

test('single in-flight submit prevents repeat writes and unloaded result causes no notification', async () => {
  const pending = deferred();
  let writes = 0;
  const { page, calls } = certificationRuntime('assets', { memberApi: {
    applyCertification: () => { writes += 1; return pending.promise; }
  } });
  await page.onShow();
  seedMaterial(page);
  page.onAssetRangeChange(picker(2));
  page.onConsentChange(consent(true));
  const submitting = page.submitApplication();
  await page.submitApplication();
  assert.equal(writes, 1);
  page.onUnload();
  pending.resolve(overview({ assets: { status: 'approved', verified: true } }));
  await submitting;
  assert.equal(page.data.verified, false);
  assert.equal(calls.toasts.length, 0);
});

test('new-account transition clears draft and ignores the old submitted result', async () => {
  const pending = deferred();
  const { page, session, calls } = certificationRuntime('education', { memberApi: {
    applyCertification: () => pending.promise
  } });
  await page.onShow();
  fillEducation(page, 'cscse_number', 2, '第一账户的学校');
  page.onConsentChange(consent(true));
  const submitting = page.submitApplication();
  session.token = 'second-certification-account';
  session.user = { id: 2 };
  await page.onShow();
  pending.resolve(overview({ education: { status: 'pending', verified: false, application: { status: 'pending' } } }));
  await submitting;
  assert.equal(page.data.institutionName, '');
  assert.equal(page.data.educationSource, '');
  assert.equal(page.data.consentConfirmed, false);
  assert.equal(page.data.statusText, '未认证');
  assert.equal(page.data.submitting, false);
  assert.equal(calls.toasts.length, 0);
});

test('return refresh supersedes an older read while retaining educational draft edits', async () => {
  const older = deferred();
  let reads = 0;
  const { page } = certificationRuntime('education', { memberApi: {
    certifications: () => ++reads === 1 ? older.promise : Promise.resolve(overview({ education: {
      status: 'rejected', feedback: '请补充可查验报告', application: { status: 'rejected', educationLevel: '本科', source: 'chsi' }
    } }))
  } });
  const first = page.onShow();
  await flush();
  page.onEducationSourceChange(picker(1));
  page.onEducationLevelChange(picker(2));
  page.onInstitutionInput({ detail: { value: '尚未提交的学校' } });
  await page.onShow();
  older.resolve(overview({ education: { status: 'approved', verified: true, verifiedEducation: '本科' } }));
  await first;
  assert.equal(page.data.statusText, '未通过');
  assert.equal(page.data.feedback, '请补充可查验报告');
  assert.equal(page.data.educationSource, 'cscse');
  assert.equal(page.data.educationLevel, '博士');
  assert.equal(page.data.institutionName, '尚未提交的学校');
});

test('unknown kind and missing session never send certification reads or writes', async () => {
  let reads = 0;
  let writes = 0;
  const apis = { certifications: async () => { reads += 1; return overview(); }, applyCertification: async () => { writes += 1; return overview(); } };
  const invalid = certificationRuntime('admin', { memberApi: apis });
  await invalid.page.onShow();
  await invalid.page.submitApplication();
  assert.equal(invalid.page.data.unsupportedKind, true);
  assert.ok(invalid.page.data.loadError);
  const loggedOut = certificationRuntime('identity', { memberApi: apis });
  loggedOut.session.token = '';
  loggedOut.session.user = null;
  await loggedOut.page.onShow();
  await loggedOut.page.submitApplication();
  assert.equal(reads, 0);
  assert.equal(writes, 0);
  assert.equal(loggedOut.calls.navigation.at(-1).url, '/pages/index/index');
});

test('directly opened application can return to the native my-profile tab without a prior page', () => {
  const { page, calls } = certificationRuntime('assets');
  page.goProfile();
  assert.equal(calls.navigation.at(-1).method, 'switchTab');
  assert.equal(calls.navigation.at(-1).url, '/pages/user/profile');
});

test('certification interface explains private material handling and keeps asset controls independent', () => {
  const application = fs.readFileSync(path.join(miniprogramRoot, 'pages/user/certification.wxml'), 'utf8');
  const profile = fs.readFileSync(path.join(miniprogramRoot, 'pages/user/profile.wxml'), 'utf8');
  assert.ok(profile.includes('认证中心'));
  assert.ok(profile.includes('onAssetPreferenceChange'));
  assert.ok(application.includes('材料仅用于认证审核'));
  assert.ok(application.includes('每份不超过500 KB'));
  assert.ok(profile.includes('小程序内上传材料，认证状态以后台审核结果为准'));
  assert.ok(application.indexOf('certification-application') < application.indexOf('class="card certification-materials"'));
  assert.ok(application.includes('最高已取得学历'));
  assert.ok(application.includes('仅作为辅助材料'));
  assert.ok(application.includes('认证通过不自动开启分类参与或公开区间'));
  assert.ok(application.includes('同层级采用相同推荐规则'));
  assert.ok(!/wx\.cloud\.uploadFile|type="number"/.test(application));
});

test('large images are compressed before upload through the private material API', async () => {
  const compressed = [];
  const uploaded = [];
  const { page, calls } = certificationRuntime('identity', {
    wx: {
      compressImage(options) {
        compressed.push(options.quality);
        options.success({ tempFilePath: `wxfile://compressed-${options.quality}.jpg` });
      },
      getFileSystemManager: () => ({
        getFileInfo: options => options.success({ size: options.filePath.includes('-80') ? 650000 : 450000 }),
        readFile: options => options.success({ data: '/9j/AA-test-jpeg-content' })
      })
    },
    memberApi: { uploadCertificationMaterial: async data => {
      uploaded.push(plain(data));
      return { material: { id: 'encrypted-jpeg-1', kind: data.kind, mimeType: data.mimeType, size: 450000, createdAt: '2026-10-08T00:00:00Z' } };
    } }
  });
  await page.onShow();
  await page.uploadMaterials([{ path: 'wxfile://original.jpg', size: 900000, isPdf: false }]);
  assert.deepEqual(compressed, [80, 60]);
  assert.deepEqual(uploaded, [{ kind: 'identity', mimeType: 'image/jpeg', contentBase64: '/9j/AA-test-jpeg-content' }]);
  assert.equal(page.data.uploadedMaterials[0].id, 'encrypted-jpeg-1');
  assert.equal(page.data.uploadedMaterials[0].previewPath, 'wxfile://compressed-60.jpg');
  assert.equal(page.data.uploading, false);
  assert.equal(calls.storage.length, 0, 'material bytes and original names must never enter storage');
});

test('oversized PDFs are rejected before reading or uploading and three-file limit is enforced', async () => {
  let reads = 0;
  let uploads = 0;
  const { page } = certificationRuntime('property', {
    wx: { getFileSystemManager: () => ({ readFile: () => { reads += 1; } }) },
    memberApi: { uploadCertificationMaterial: async () => { uploads += 1; return {}; } }
  });
  await page.onShow();
  await page.uploadMaterials([{ path: 'wxfile://large.pdf', size: 512001, isPdf: true }]);
  assert.equal(page.data.uploadError, 'PDF 文件须小于或等于500 KB，请压缩后重试');
  assert.equal(reads, 0);
  assert.equal(uploads, 0);
  await page.uploadMaterials(Array.from({ length: 4 }, () => ({ path: 'wxfile://material.pdf', size: 100, isPdf: true })));
  assert.equal(page.data.uploadError, '每次申请最多3份材料');
  assert.equal(uploads, 0);
});

test('PDF and PNG signatures are submitted as allowed MIME types while unsupported image format is explained', async () => {
  for (const [base64, isPdf, mimeType] of [['JVBERi0xLjc-test-pdf', true, 'application/pdf'], ['iVBORw0KGgo-test-png', false, 'image/png'], ['UklGRfake-webp', false, '']]) {
    const uploads = [];
    const { page } = certificationRuntime('vehicle', {
      wx: { getFileSystemManager: () => ({ readFile: options => options.success({ data: base64 }) }) },
      memberApi: { uploadCertificationMaterial: async data => {
        uploads.push(plain(data));
        return { material: { id: 'encrypted-material', kind: data.kind, mimeType: data.mimeType, size: 100 } };
      } }
    });
    await page.onShow();
    await page.uploadMaterials([{ path: 'wxfile://local-material', size: 100, isPdf }]);
    if (mimeType) {
      assert.equal(uploads[0].mimeType, mimeType);
      assert.equal(page.data.uploadedMaterials[0].isPdf, isPdf);
    } else {
      assert.equal(uploads.length, 0);
      assert.ok(page.data.uploadError.includes('请将其他格式转换后重试'));
    }
  }
});

test('unsubmitted uploaded material is deleted through the private API, with failed deletion retaining the row', async () => {
  const removals = [];
  const { page } = certificationRuntime('assets', { memberApi: {
    removeCertificationMaterial: async id => { removals.push(id); if (removals.length === 1) throw new Error('network'); return { removed: true }; }
  } });
  await page.onShow();
  seedMaterial(page);
  await page.removeMaterial(clickMaterial('encrypted-material-1'));
  assert.equal(page.data.uploadedMaterials.length, 1);
  assert.equal(page.data.uploadError, '材料删除失败，请重试');
  await page.removeMaterial(clickMaterial('encrypted-material-1'));
  assert.equal(page.data.uploadedMaterials.length, 0);
  assert.deepEqual(removals, ['encrypted-material-1', 'encrypted-material-1']);
});

test('leaving an unsubmitted upload cleans staging but a successful application keeps attached materials', async () => {
  const removals = [];
  const first = certificationRuntime('property', { memberApi: { removeCertificationMaterial: async id => { removals.push(id); return { removed: true }; } } });
  await first.page.onShow();
  seedMaterial(first.page, 'unsubmitted-material');
  first.page.onUnload();
  await flush();
  assert.deepEqual(removals, ['unsubmitted-material']);
  const submitted = certificationRuntime('property', { memberApi: {
    removeCertificationMaterial: async id => { removals.push(id); return { removed: true }; },
    applyCertification: async data => overview({ property: { status: 'pending', application: { status: 'pending', materialIds: data.materialIds } } })
  } });
  await submitted.page.onShow();
  seedMaterial(submitted.page, 'submitted-material');
  submitted.page.onConsentChange(consent(true));
  await submitted.page.submitApplication();
  assert.equal(submitted.page.data.receivedMaterialCount, 1);
  submitted.page.onUnload();
  await flush();
  assert.deepEqual(removals, ['unsubmitted-material']);
});

test('a late upload after leaving cleans its staging and cannot update a disposed page', async () => {
  const upload = deferred();
  const removals = [];
  const { page } = certificationRuntime('identity', {
    wx: { getFileSystemManager: () => ({ readFile: options => options.success({ data: '/9j/fake-jpeg' }) }) },
    memberApi: {
      uploadCertificationMaterial: () => upload.promise,
      removeCertificationMaterial: async id => { removals.push(id); return { removed: true }; }
    }
  });
  await page.onShow();
  const loading = page.uploadMaterials([{ path: 'wxfile://identity.jpg', size: 100, isPdf: false }]);
  await flush();
  page.onUnload();
  upload.resolve({ material: { id: 'late-staging', kind: 'identity', mimeType: 'image/jpeg', size: 100 } });
  await loading;
  await flush();
  assert.equal(page.data.uploadedMaterials.length, 0);
  assert.deepEqual(removals, ['late-staging']);
});

test('native file selection from an old account cannot start uploads for the new account', async () => {
  let selection;
  let imageChoices = 0;
  const { page, session } = certificationRuntime('identity', { wx: {
    showActionSheet: options => { selection = options; },
    chooseMedia: () => { imageChoices += 1; }
  } });
  await page.onShow();
  page.chooseMaterials();
  session.token = 'new-material-account';
  session.user = { id: 2 };
  await page.onShow();
  selection.success({ tapIndex: 0 });
  assert.equal(imageChoices, 0);
  assert.equal(page.data.uploadedMaterials.length, 0);
});

test('photo-based education requires materials and uses highest acquired degree for study-proof claims', async () => {
  const writes = [];
  const { page } = certificationRuntime('education', { memberApi: {
    applyCertification: async data => { writes.push(plain(data)); return overview({ education: { status: 'pending', verified: false } }); }
  } });
  await page.onShow();
  fillEducation(page, 'study_proof', 0, '示例大学');
  page.onEducationSourceChange(picker(0));
  page.onConsentChange(consent(true));
  await page.submitApplication();
  assert.equal(page.data.submissionError, '请至少上传1份核验材料');
  seedMaterial(page);
  await page.submitApplication();
  assert.deepEqual(writes, [{ kind: 'education', consentConfirmed: true, materialIds: ['encrypted-material-1'], source: 'chsi', educationLevel: 'bachelors', institutionName: '示例大学', method: 'study_proof' }]);
  assert.equal(page.data.verified, false);
});

test('known server validation failures remain actionable while no sensitive identifiers enter storage', async () => {
  const { page, calls } = certificationRuntime('education', { memberApi: {
    applyCertification: async () => { const error = new Error('请先保存我的资料，再申请认证'); error.code = 42240; throw error; }
  } });
  await page.onShow();
  fillEducation(page);
  page.onConsentChange(consent(true));
  await page.submitApplication();
  assert.equal(page.data.submissionError, '请先保存我的资料，再申请认证');
  assert.equal(page.data.loadError, '');
  assert.equal(page._loaded, true);
  assert.equal(calls.storage.length, 0);
});

test('a failed file does not discard successful files or skip later files, and retry uploads only the failed file', async () => {
  const firstUpload = deferred();
  const uploads = [];
  let failedOnce = false;
  const { page, calls } = certificationRuntime('property', {
    wx: { getFileSystemManager: () => ({ readFile: options => options.success({ data: `/9j/${options.filePath}` }) }) },
    memberApi: { uploadCertificationMaterial: async data => {
      uploads.push(data.contentBase64);
      if (uploads.length === 1) await firstUpload.promise;
      if (data.contentBase64.includes('second') && !failedOnce) { failedOnce = true; throw new Error('网络中断，请重试'); }
      return { material: { id: `encrypted-${uploads.length}`, kind: data.kind, mimeType: data.mimeType, size: 100 } };
    } }
  });
  await page.onShow();
  const pending = page.uploadMaterials(['first', 'second', 'third'].map(name => ({ path: `wxfile://${name}.jpg`, size: 100, isPdf: false })));
  await flush();
  assert.deepEqual(plain(page.data.uploadedMaterials.map(item => item.status)), ['uploading', 'pending', 'pending']);
  firstUpload.resolve();
  await pending;
  assert.deepEqual(plain(page.data.uploadedMaterials.map(item => item.status)), ['uploaded', 'failed', 'uploaded']);
  assert.equal(page.data.uploadedMaterials[1].error, '网络中断，请重试');
  page.onConsentChange(consent(true));
  await page.submitApplication();
  assert.equal(page.data.submissionError, '仍有材料未上传成功，请重试或移除失败材料后再提交');
  const [first, failed, third] = page.data.uploadedMaterials;
  await page.retryMaterial({ currentTarget: { dataset: { localId: failed.localId } } });
  assert.deepEqual(plain(page.data.uploadedMaterials.map(item => item.status)), ['uploaded', 'uploaded', 'uploaded']);
  assert.equal(page.data.uploadedMaterials[0].id, first.id);
  assert.equal(page.data.uploadedMaterials[2].id, third.id);
  assert.deepEqual(uploads, ['/9j/wxfile://first.jpg', '/9j/wxfile://second.jpg', '/9j/wxfile://third.jpg', '/9j/wxfile://second.jpg']);
  assert.equal(calls.storage.length, 0);
});

test('invalid PDF is retained as an actionable failure before file reading, while valid files continue', async () => {
  const reads = [];
  const removals = [];
  const guards = [];
  const { page } = certificationRuntime('property', {
    wx: {
      enableAlertBeforeUnload: () => guards.push('enable'), disableAlertBeforeUnload: () => guards.push('disable'),
      getFileSystemManager: () => ({ readFile: options => { reads.push(options.filePath); options.success({ data: '/9j/valid-image' }); } })
    },
    memberApi: {
      uploadCertificationMaterial: async data => ({ material: { id: 'valid-material', kind: data.kind, mimeType: data.mimeType, size: 100 } }),
      removeCertificationMaterial: async id => { removals.push(id); return { removed: true }; }
    }
  });
  await page.onShow();
  await page.uploadMaterials([{ path: 'wxfile://too-large.pdf', size: 512001, isPdf: true }, { path: 'wxfile://valid.jpg', size: 100, isPdf: false }]);
  assert.deepEqual(reads, ['wxfile://valid.jpg']);
  assert.equal(page.data.uploadedMaterials[0].status, 'failed');
  await page.removeMaterial({ currentTarget: { dataset: { localId: page.data.uploadedMaterials[0].localId } } });
  assert.deepEqual(removals, []);
  assert.equal(page.data.uploadedMaterials.length, 1);
  await page.removeMaterial(clickMaterial('valid-material'));
  assert.deepEqual(removals, ['valid-material']);
  assert.equal(page.hasUnsubmittedChanges(), false);
  assert.deepEqual(guards, ['enable', 'disable']);
});

test('editing certification arms native back protection and explicit return can be cancelled without losing the draft', async () => {
  const guards = [];
  let modal;
  const { page, calls } = certificationRuntime('education', { wx: {
    enableAlertBeforeUnload: options => guards.push({ type: 'enable', message: options.message }),
    disableAlertBeforeUnload: () => guards.push({ type: 'disable' }),
    showModal: options => { modal = options; }
  } });
  await page.onShow();
  assert.equal(guards.length, 0, 'reading saved state does not create a draft');
  fillEducation(page);
  assert.equal(guards.length, 1);
  assert.equal(guards[0].type, 'enable');
  page.goProfile();
  modal.success({ confirm: false });
  assert.equal(calls.navigation.length, 0);
  assert.equal(page.data.certificateNumber, 'test-certification-reference');
  assert.equal(page.hasUnsubmittedChanges(), true);
  page.goProfile();
  modal.success({ confirm: true });
  assert.equal(guards.at(-1).type, 'disable');
  assert.equal(calls.navigation.at(-1).url, '/pages/user/profile');
  assert.equal(calls.storage.length, 0);
});

test('confirmed submission clears leave protection while a failed submission retains it', async () => {
  const guards = [];
  let failOnce = true;
  const { page, calls } = certificationRuntime('education', {
    wx: { enableAlertBeforeUnload: () => guards.push('enable'), disableAlertBeforeUnload: () => guards.push('disable') },
    memberApi: { applyCertification: async data => {
      if (failOnce) { failOnce = false; const error = new Error('请检查材料编号'); error.code = 42240; throw error; }
      return overview({ education: { status: 'pending', application: { status: 'pending', ...data } } });
    } }
  });
  await page.onShow();
  fillEducation(page);
  page.onConsentChange(consent(true));
  await page.submitApplication();
  assert.equal(page.hasUnsubmittedChanges(), true);
  assert.deepEqual(guards, ['enable']);
  await page.submitApplication();
  assert.equal(page.hasUnsubmittedChanges(), false);
  assert.equal(page.data.certificateNumber, '');
  assert.deepEqual(guards, ['enable', 'disable']);
  assert.equal(calls.storage.length, 0);
});
