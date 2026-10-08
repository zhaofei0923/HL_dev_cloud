"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const api_1 = require("../../services/api");
const member_1 = require("../../services/member");
const page_session_1 = require("../../utils/page-session");
const member_certification_1 = require("../../utils/member-certification");
const certification_form_1 = require("../../utils/certification-form");
function safeEducationSource(value) {
    return value === 'chsi' || value === 'cscse' ? value : '';
}
function safeEducationLevel(value) {
    if (value === 'bachelors')
        return '本科';
    if (value === 'master')
        return '硕士';
    if (value === 'doctor')
        return '博士';
    return value === '本科' || value === '硕士' || value === '博士' ? value : '';
}
function sourceText(value) {
    return value === 'chsi' ? certification_form_1.EDUCATION_SOURCE_OPTIONS[0] : value === 'cscse' ? certification_form_1.EDUCATION_SOURCE_OPTIONS[1] : '请选择学历来源';
}
function fileSize(filePath) {
    return new Promise((resolve, reject) => wx.getFileSystemManager().getFileInfo({ filePath,
        success: result => resolve(result.size), fail: reject
    }));
}
function fileBase64(filePath) {
    return new Promise((resolve, reject) => wx.getFileSystemManager().readFile({ filePath, encoding: 'base64',
        success: result => typeof result.data === 'string' ? resolve(result.data) : reject(new Error('无法读取材料文件')), fail: reject
    }));
}
async function prepareMaterial(file) {
    let path = file.path;
    let size = file.size || await fileSize(path);
    if (file.isPdf && size > certification_form_1.CERTIFICATION_MATERIAL_MAX_BYTES)
        throw new Error('PDF 文件须小于或等于500 KB，请压缩后重试');
    if (!file.isPdf && size > certification_form_1.CERTIFICATION_MATERIAL_MAX_BYTES) {
        for (const quality of [80, 60, 40, 20]) {
            path = await new Promise((resolve, reject) => wx.compressImage({ src: file.path, quality,
                success: result => resolve(result.tempFilePath), fail: reject
            }));
            size = await fileSize(path);
            if (size <= certification_form_1.CERTIFICATION_MATERIAL_MAX_BYTES)
                break;
        }
    }
    if (size > certification_form_1.CERTIFICATION_MATERIAL_MAX_BYTES)
        throw new Error('图片压缩后仍超过500 KB，请裁剪或缩小图片后重试');
    const contentBase64 = await fileBase64(path);
    const mimeType = (0, certification_form_1.certificationMaterialMime)(contentBase64);
    if (!mimeType || (file.isPdf ? mimeType !== 'application/pdf' : mimeType === 'application/pdf')) {
        throw new Error('仅支持 JPG、PNG 图片或 PDF，请将其他格式转换后重试');
    }
    return { mimeType, contentBase64, path, size };
}
function entryView(entry) {
    const verified = (0, certification_form_1.isApprovedCertification)(entry);
    const pending = (0, certification_form_1.hasPendingCertification)(entry);
    const education = entry.kind === 'education' && verified ? safeEducationLevel(entry.verifiedEducation) : '';
    const assets = entry.kind === 'assets' && verified ? (0, member_certification_1.financialAssetRangeText)(entry.verifiedFinancialAssetRange) : '';
    return {
        entry, statusText: (0, certification_form_1.certificationStateText)(entry), verified, pending,
        verifiedDetail: education ? `已核验学历：${education}` : assets ? `已核验金融资产：${assets}` : '',
        submittedAtText: (0, certification_form_1.certificationTimeText)(entry.application && entry.application.submittedAt || entry.submittedAt),
        reviewedAtText: (0, certification_form_1.certificationTimeText)(entry.reviewedAt),
        expiresAtText: (0, certification_form_1.certificationTimeText)(entry.expiresAt),
        receivedMaterialCount: entry.application && Array.isArray(entry.application.materialIds) ? entry.application.materialIds.length : 0,
        feedback: typeof entry.feedback === 'string' ? entry.feedback : '',
        actionText: pending ? '申请待审核' : verified ? '提交更新申请' : ['rejected', 'revoked', 'expired'].includes(entry.status) ? '重新提交申请' : '提交认证申请'
    };
}
Page({
    _scope: '', _generation: 0, _uploadGeneration: 0,
    _loadPromise: null,
    _disposed: false, _draftEdited: false, _loaded: false,
    _materialSequence: 0, _leaveGuardEnabled: false,
    _previewPaths: [],
    data: {
        kind: '', title: '资料认证', materials: '',
        loading: false, loadError: '', unsupportedKind: false, submitting: false, submissionError: '',
        entry: null, statusText: '读取中', verified: false, pending: false,
        verifiedDetail: '', submittedAtText: '', reviewedAtText: '', expiresAtText: '', feedback: '', actionText: '提交认证申请',
        educationSourceOptions: certification_form_1.EDUCATION_SOURCE_OPTIONS, educationOptions: certification_form_1.CERTIFICATION_EDUCATION_OPTIONS,
        educationSource: '', educationSourceText: '请选择学历来源', educationLevel: '',
        institutionName: '', consentConfirmed: false,
        methodOptions: certification_form_1.EDUCATION_CERTIFICATION_METHODS, methodPickerOpen: false,
        method: '', methodText: '请选择认证方式',
        verificationCode: '', certificateNumber: '', requiresMaterials: false,
        uploadedMaterials: [], uploading: false, previewing: false, uploadError: '', receivedMaterialCount: 0,
        declaredAssetRangeOptions: certification_form_1.DECLARED_FINANCIAL_ASSET_RANGE_OPTIONS,
        declaredFinancialAssetRange: '', declaredAssetRangeText: '请选择金融资产区间'
    },
    onLoad(options) {
        this._disposed = false;
        const definition = (0, certification_form_1.certificationDefinition)(options.kind);
        if (!definition) {
            this.setData({ unsupportedKind: true, loadError: '认证项目不存在，请返回我的资料重新选择' });
            return;
        }
        this.setData({ kind: definition.kind, title: definition.title, materials: definition.materials,
            requiresMaterials: (0, certification_form_1.methodRequiresMaterials)(definition.kind, '') });
        wx.setNavigationBarTitle({ title: definition.title });
    },
    onShow() {
        this.clearMaterialPreviews();
        if (!this.synchronizeSession() || this.data.unsupportedKind || !this.data.kind)
            return Promise.resolve();
        return this.loadCertification(true);
    },
    synchronizeSession() {
        const scope = (0, page_session_1.pageSessionScope)();
        if (scope !== this._scope) {
            this._scope = scope;
            this._generation += 1;
            this._uploadGeneration += 1;
            this._loadPromise = null;
            this._draftEdited = false;
            this._loaded = false;
            this.clearMaterialPreviews();
            this.setData({
                loading: false, loadError: this.data.unsupportedKind ? '认证项目不存在，请返回我的资料重新选择' : '',
                submitting: false, submissionError: '', entry: null, statusText: '读取中', verified: false, pending: false,
                verifiedDetail: '', submittedAtText: '', reviewedAtText: '', expiresAtText: '', feedback: '', actionText: '提交认证申请',
                educationSource: '', educationSourceText: '请选择学历来源', educationLevel: '', institutionName: '', consentConfirmed: false,
                method: '', methodText: '请选择认证方式', methodPickerOpen: false, verificationCode: '', certificateNumber: '',
                requiresMaterials: !!this.data.kind && (0, certification_form_1.methodRequiresMaterials)(this.data.kind, ''),
                uploadedMaterials: [], uploading: false, previewing: false, uploadError: '', receivedMaterialCount: 0,
                declaredFinancialAssetRange: '', declaredAssetRangeText: '请选择金融资产区间'
            });
            this.updateLeaveGuard();
        }
        if (scope)
            return scope;
        wx.redirectTo({ url: '/pages/index/index' });
        return '';
    },
    loadCertification(force = false) {
        const scope = this.synchronizeSession();
        if (!scope || this._disposed || !this.data.kind || this.data.submitting || this.data.uploading)
            return Promise.resolve();
        const kind = this.data.kind;
        if (!force && this._loadPromise)
            return this._loadPromise;
        const generation = ++this._generation;
        const isCurrent = () => !this._disposed && generation === this._generation && (0, page_session_1.pageSessionScope)() === scope;
        this.setData({ loading: true, loadError: '', submissionError: '' });
        const promise = Promise.resolve().then(async () => {
            try {
                const [overview, staged] = await Promise.all([member_1.memberApi.certifications(), member_1.memberApi.stagingCertificationMaterials(kind)]);
                if (!isCurrent())
                    return;
                if (!(0, certification_form_1.validCertificationOverview)(overview))
                    throw new Error('认证状态不完整');
                const entry = overview.entries.find(item => item.kind === this.data.kind);
                if (!entry)
                    throw new Error('认证状态缺失');
                if (!staged || !Array.isArray(staged.materials) || staged.materials.some(item => !item || !item.id || item.kind !== this.data.kind))
                    throw new Error('暂存材料状态缺失');
                this.restoreStagingMaterials(staged.materials);
                this.applyEntry(entry);
                this._loaded = true;
            }
            catch {
                if (!isCurrent())
                    return;
                this._loaded = false;
                this.setData({ loadError: '认证状态或暂存材料读取失败，请重试后再继续' });
            }
            finally {
                if (isCurrent()) {
                    this._loadPromise = null;
                    this.setData({ loading: false });
                }
            }
        });
        this._loadPromise = promise;
        return promise;
    },
    applyEntry(entry) {
        this.setData(entryView(entry));
        const attachedIds = entry.application && entry.application.materialIds || [];
        if (attachedIds.length)
            this.setData({ uploadedMaterials: this.data.uploadedMaterials.filter(item => !attachedIds.includes(item.id)) });
        if ((0, certification_form_1.hasPendingCertification)(entry)) {
            this._draftEdited = false;
            this.setData({ verificationCode: '', certificateNumber: '', consentConfirmed: false });
        }
        if (!this._draftEdited && entry.kind === 'education') {
            const application = entry.application;
            const source = safeEducationSource(application && application.source || entry.source);
            const method = (0, certification_form_1.safeEducationMethod)(application && application.method);
            const methodOption = certification_form_1.EDUCATION_CERTIFICATION_METHODS.find(item => item.value === method);
            this.setData({ educationSource: source, educationSourceText: sourceText(source),
                educationLevel: safeEducationLevel(application && application.educationLevel || entry.verifiedEducation),
                institutionName: application && typeof application.institutionName === 'string' ? application.institutionName : '',
                method, methodText: methodOption ? methodOption.title : '请选择认证方式',
                requiresMaterials: (0, certification_form_1.methodRequiresMaterials)(entry.kind, method) });
        }
        this.updateLeaveGuard();
    },
    retryLoad() { return this.loadCertification(true); },
    restoreStagingMaterials(materials) {
        const previous = this.data.uploadedMaterials;
        const restored = materials.map(material => {
            const local = previous.find(item => item.id === material.id || !!material.clientRequestId && item.clientRequestId === material.clientRequestId);
            return { id: material.id, localId: local ? local.localId : `restored-${material.id}`,
                clientRequestId: material.clientRequestId || '', mimeType: material.mimeType, size: material.size,
                previewPath: local ? local.previewPath : '', sizeText: `${Math.ceil(material.size / 1024)} KB`,
                isPdf: material.mimeType === 'application/pdf', status: 'uploaded', error: '',
                source: local ? local.source : { path: '', size: material.size, isPdf: material.mimeType === 'application/pdf' } };
        });
        const merged = previous.flatMap(item => {
            const remote = restored.find(material => material.localId === item.localId);
            return remote ? [remote] : !item.id ? [item] : [];
        });
        this.setData({ uploadedMaterials: [...merged, ...restored.filter(item => !merged.some(local => local.localId === item.localId))] });
        this.updateLeaveGuard();
    },
    clearMaterialPreviews() {
        const paths = this._previewPaths.splice(0);
        paths.forEach(filePath => wx.getFileSystemManager().unlink({ filePath, fail: () => undefined }));
        // Recover cleanup after the OS terminates a preview before onUnload runs.
        if (typeof wx.getFileSystemManager === 'function' && wx.env && wx.env.USER_DATA_PATH) {
            const manager = wx.getFileSystemManager();
            if (typeof manager.readdir === 'function')
                manager.readdir({ dirPath: wx.env.USER_DATA_PATH,
                    success: result => result.files.filter(name => /^certification-preview-\d+-\d+\.(pdf|png|jpg)$/.test(name)
                        && !this._previewPaths.includes(`${wx.env.USER_DATA_PATH}/${name}`))
                        .forEach(name => manager.unlink({ filePath: `${wx.env.USER_DATA_PATH}/${name}`, fail: () => undefined })),
                    fail: () => undefined });
        }
    },
    async previewMaterial(e) {
        if (this.data.previewing || this.data.uploading || this.data.submitting)
            return;
        const id = String(e.currentTarget.dataset.id || '');
        const material = this.data.uploadedMaterials.find(item => item.id === id);
        const scope = this._scope;
        if (!material || !id || !scope)
            return;
        const isCurrent = () => !this._disposed && (0, page_session_1.pageSessionScope)() === scope;
        this.setData({ previewing: true, uploadError: '' });
        try {
            const result = await member_1.memberApi.certificationMaterial(id);
            if (!isCurrent())
                return;
            if (!result || result.material.id !== id || result.material.kind !== this.data.kind
                || (0, certification_form_1.certificationMaterialMime)(result.contentBase64) !== result.material.mimeType)
                throw new Error('材料读取结果异常');
            const extension = result.material.mimeType === 'application/pdf' ? 'pdf' : result.material.mimeType === 'image/png' ? 'png' : 'jpg';
            const filePath = `${wx.env.USER_DATA_PATH}/certification-preview-${Date.now()}-${++this._materialSequence}.${extension}`;
            this._previewPaths.push(filePath);
            await new Promise((resolve, reject) => wx.getFileSystemManager().writeFile({ filePath, data: result.contentBase64,
                encoding: 'base64', success: () => resolve(), fail: reject }));
            if (!isCurrent()) {
                this.clearMaterialPreviews();
                return;
            }
            if (extension === 'pdf')
                await new Promise((resolve, reject) => wx.openDocument({ filePath, fileType: 'pdf', showMenu: false, success: () => resolve(), fail: reject }));
            else
                await new Promise((resolve, reject) => wx.previewImage({ urls: [filePath], current: filePath, success: () => resolve(), fail: reject }));
        }
        catch {
            if (isCurrent())
                this.setData({ uploadError: '材料预览失败，请重试' });
            this.clearMaterialPreviews();
        }
        finally {
            if (isCurrent())
                this.setData({ previewing: false });
        }
    },
    onPullDownRefresh() { return this.loadCertification(true).finally(() => wx.stopPullDownRefresh()); },
    onUnload() {
        this.clearMaterialPreviews();
        this._disposed = true;
        this._generation += 1;
        this._uploadGeneration += 1;
        this._loadPromise = null;
        this.setData({ verificationCode: '', certificateNumber: '', uploadedMaterials: [] });
    },
    hasUnsubmittedChanges() { return this._draftEdited || this.data.uploadedMaterials.length > 0; },
    updateLeaveGuard() {
        const enabled = !this._disposed && this.hasUnsubmittedChanges();
        if (enabled === this._leaveGuardEnabled)
            return;
        this._leaveGuardEnabled = enabled;
        if (enabled && typeof wx.enableAlertBeforeUnload === 'function') {
            wx.enableAlertBeforeUnload({ message: '填写的信息不会保存，已上传材料将加密暂存24小时，可返回继续申请。', fail: () => undefined });
        }
        else if (!enabled && typeof wx.disableAlertBeforeUnload === 'function') {
            wx.disableAlertBeforeUnload({ fail: () => undefined });
        }
    },
    markDraftEdited() { this._draftEdited = true; this.updateLeaveGuard(); },
    editingBlocked() { return this.data.pending || this.data.submitting || this.data.uploading || this.data.loading || !!this.data.loadError || !this._loaded; },
    openMethodPicker() {
        if (!this.editingBlocked())
            this.setData({ methodPickerOpen: true });
    },
    closeMethodPicker() { this.setData({ methodPickerOpen: false }); },
    stopSheetTap() { },
    chooseMethod(e) {
        if (this.editingBlocked())
            return;
        const method = (0, certification_form_1.safeEducationMethod)(e.currentTarget.dataset.method);
        if (!method || !this.data.kind)
            return;
        const option = certification_form_1.EDUCATION_CERTIFICATION_METHODS.find(item => item.value === method);
        const source = method === 'chsi_code' ? 'chsi' : method === 'cscse_number' ? 'cscse' : this.data.educationSource;
        this.markDraftEdited();
        this.setData({ method, methodText: option ? option.title : '', methodPickerOpen: false,
            verificationCode: '', certificateNumber: '', educationSource: source, educationSourceText: sourceText(source),
            requiresMaterials: (0, certification_form_1.methodRequiresMaterials)(this.data.kind, method), submissionError: '' });
    },
    onEducationSourceChange(e) {
        if (this.editingBlocked() || this.data.method === 'chsi_code' || this.data.method === 'cscse_number')
            return;
        const source = certification_form_1.EDUCATION_SOURCES[Number(e.detail.value)];
        if (!source)
            return;
        this.markDraftEdited();
        this.setData({ educationSource: source, educationSourceText: sourceText(source), submissionError: '' });
    },
    onEducationLevelChange(e) {
        if (this.editingBlocked())
            return;
        const level = certification_form_1.CERTIFICATION_EDUCATION_OPTIONS[Number(e.detail.value)];
        if (!level)
            return;
        this.markDraftEdited();
        this.setData({ educationLevel: level, submissionError: '' });
    },
    onInstitutionInput(e) {
        if (this.editingBlocked())
            return;
        this.markDraftEdited();
        this.setData({ institutionName: e.detail.value.slice(0, 120), submissionError: '' });
    },
    onVerificationInput(e) {
        if (this.editingBlocked())
            return;
        this.markDraftEdited();
        if (this.data.method === 'chsi_code')
            this.setData({ verificationCode: e.detail.value.slice(0, 100), submissionError: '' });
        if (this.data.method === 'cscse_number')
            this.setData({ certificateNumber: e.detail.value.slice(0, 100), submissionError: '' });
    },
    onAssetRangeChange(e) {
        if (this.editingBlocked())
            return;
        const range = certification_form_1.DECLARED_FINANCIAL_ASSET_RANGES[Number(e.detail.value)];
        if (!range)
            return;
        this.markDraftEdited();
        this.setData({ declaredFinancialAssetRange: range, declaredAssetRangeText: (0, member_certification_1.financialAssetRangeText)(range), submissionError: '' });
    },
    onConsentChange(e) {
        if (this.editingBlocked())
            return;
        this.markDraftEdited();
        this.setData({ consentConfirmed: e.detail.value.includes('confirmed'), submissionError: '' });
    },
    chooseMaterials() {
        if (this.editingBlocked() || !this.data.requiresMaterials)
            return;
        const remaining = certification_form_1.CERTIFICATION_MATERIAL_LIMIT - this.data.uploadedMaterials.length;
        if (remaining <= 0) {
            wx.showToast({ title: '每次申请最多3份材料', icon: 'none' });
            return;
        }
        const scope = this._scope;
        const generation = this._uploadGeneration;
        const isCurrent = () => !this._disposed && (0, page_session_1.pageSessionScope)() === scope && generation === this._uploadGeneration;
        wx.showActionSheet({ itemList: ['选择图片', '选择 PDF 文件'], success: selection => {
                if (!isCurrent())
                    return;
                if (selection.tapIndex === 0) {
                    wx.chooseMedia({ count: remaining, mediaType: ['image'], sizeType: ['original'], sourceType: ['album', 'camera'],
                        success: result => { if (isCurrent())
                            void this.uploadMaterials(result.tempFiles.map(file => ({ path: file.tempFilePath, size: file.size, isPdf: false }))); },
                        fail: error => { if (isCurrent() && !/cancel/i.test(error.errMsg))
                            this.setData({ uploadError: '选择图片失败，请重试' }); }
                    });
                }
                else {
                    wx.chooseMessageFile({ count: remaining, type: 'file', extension: ['pdf'],
                        success: result => { if (isCurrent())
                            void this.uploadMaterials(result.tempFiles.map(file => ({ path: file.path, size: file.size, isPdf: true }))); },
                        fail: error => { if (isCurrent() && !/cancel/i.test(error.errMsg))
                            this.setData({ uploadError: '选择 PDF 失败，请重试' }); }
                    });
                }
            } });
    },
    async uploadMaterials(files) {
        const scope = this.synchronizeSession();
        if (!scope || this._disposed || !this.data.kind || this.editingBlocked() || !this.data.requiresMaterials)
            return;
        const remaining = certification_form_1.CERTIFICATION_MATERIAL_LIMIT - this.data.uploadedMaterials.length;
        if (files.length > remaining) {
            this.setData({ uploadError: '每次申请最多3份材料' });
            return;
        }
        if (!files.length)
            return;
        const queued = files.map(source => ({
            id: '', localId: `local-${++this._materialSequence}`, source,
            clientRequestId: `material_${Date.now().toString(36)}_${this._materialSequence}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}`,
            mimeType: '', size: source.size, sizeText: source.size ? `${Math.ceil(source.size / 1024)} KB` : '',
            previewPath: source.path, isPdf: source.isPdf, status: 'pending', error: ''
        }));
        this.setData({ uploadedMaterials: [...this.data.uploadedMaterials, ...queued], uploadError: '', submissionError: '' });
        this.updateLeaveGuard();
        return this.uploadQueuedMaterials(queued.map(item => item.localId));
    },
    async retryMaterial(e) {
        if (this.editingBlocked())
            return;
        const localId = String(e.currentTarget.dataset.localId || '');
        const item = this.data.uploadedMaterials.find(material => material.localId === localId);
        if (!item || item.status !== 'failed')
            return;
        return this.uploadQueuedMaterials([localId]);
    },
    async uploadQueuedMaterials(localIds) {
        const scope = this.synchronizeSession();
        if (!scope || this._disposed || !this.data.kind || this.editingBlocked() || !this.data.requiresMaterials)
            return;
        const kind = this.data.kind;
        const generation = ++this._uploadGeneration;
        const isCurrent = () => !this._disposed && generation === this._uploadGeneration && (0, page_session_1.pageSessionScope)() === scope;
        const updateMaterial = (localId, patch) => {
            this.setData({ uploadedMaterials: this.data.uploadedMaterials.map(item => item.localId === localId ? { ...item, ...patch } : item) });
        };
        this.setData({ uploading: true, uploadError: '', submissionError: '' });
        let reconcile = false;
        try {
            for (const localId of localIds) {
                const file = this.data.uploadedMaterials.find(item => item.localId === localId);
                if (!file || file.id)
                    continue;
                updateMaterial(localId, { status: 'uploading', error: '' });
                let attemptedUpload = false;
                try {
                    const prepared = await prepareMaterial(file.source);
                    if (!isCurrent())
                        return;
                    // Keep the prepared bytes stable across retries without persisting them
                    // in local storage. The server rejects a changed file under the same ID.
                    updateMaterial(localId, { source: { path: prepared.path, size: prepared.size, isPdf: file.source.isPdf } });
                    attemptedUpload = true;
                    const result = await member_1.memberApi.uploadCertificationMaterial({ kind, mimeType: prepared.mimeType, contentBase64: prepared.contentBase64, clientRequestId: file.clientRequestId });
                    const material = result && result.material;
                    if (!isCurrent()) {
                        return;
                    }
                    if (!material || !material.id || material.kind !== kind || material.size > certification_form_1.CERTIFICATION_MATERIAL_MAX_BYTES) {
                        if (material && material.id)
                            void member_1.memberApi.removeCertificationMaterial(material.id).catch(() => undefined);
                        throw new Error('材料上传结果异常，请重试');
                    }
                    updateMaterial(localId, { id: material.id, mimeType: material.mimeType, size: material.size, previewPath: prepared.path,
                        isPdf: material.mimeType === 'application/pdf', sizeText: `${Math.ceil(material.size / 1024)} KB`, status: 'uploaded', error: '' });
                }
                catch (error) {
                    if (!isCurrent())
                        return;
                    const message = (0, api_1.apiErrorMessage)(error) || '材料上传失败，请重试';
                    updateMaterial(localId, { status: 'failed', error: message });
                    this.setData({ uploadError: message });
                    if (attemptedUpload)
                        reconcile = true;
                }
            }
        }
        finally {
            if (isCurrent())
                this.setData({ uploading: false });
        }
        if (reconcile && isCurrent())
            await this.loadCertification(true);
    },
    async removeMaterial(e) {
        if (this.editingBlocked())
            return;
        const id = String(e.currentTarget.dataset.id || '');
        const localId = String(e.currentTarget.dataset.localId || '');
        const material = this.data.uploadedMaterials.find(item => localId ? item.localId === localId : !!id && item.id === id);
        if (!material)
            return;
        const remainingMaterials = this.data.uploadedMaterials.filter(item => item !== material);
        if (!material.id) {
            this.setData({ uploadedMaterials: remainingMaterials, uploadError: '', submissionError: '' });
            this.updateLeaveGuard();
            return;
        }
        const scope = this._scope;
        this.setData({ uploading: true, uploadError: '' });
        try {
            await member_1.memberApi.removeCertificationMaterial(material.id);
            if (this._disposed || (0, page_session_1.pageSessionScope)() !== scope)
                return;
            this.setData({ uploadedMaterials: remainingMaterials, submissionError: '' });
            this.updateLeaveGuard();
        }
        catch (error) {
            if (this._disposed || (0, page_session_1.pageSessionScope)() !== scope)
                return;
            const code = error && typeof error === 'object' && 'code' in error ? Number(error.code) : 0;
            if (code === 40400) {
                // The first deletion may have succeeded before its response was lost.
                this.setData({ uploadedMaterials: remainingMaterials, uploadError: '', submissionError: '' });
                this.updateLeaveGuard();
            }
            else
                this.setData({ uploadError: '材料删除失败，请重试' });
        }
        finally {
            if (!this._disposed && (0, page_session_1.pageSessionScope)() === scope)
                this.setData({ uploading: false });
        }
    },
    async submitApplication() {
        const scope = this.synchronizeSession();
        if (!scope || this._disposed || !this.data.kind || this.data.submitting || this.data.uploading || this.data.loading
            || this.data.loadError || !this._loaded || !this.data.entry)
            return;
        if ((0, certification_form_1.hasPendingCertification)(this.data.entry)) {
            wx.showToast({ title: '已有待审核申请，请耐心等待', icon: 'none' });
            return;
        }
        if (!this.data.consentConfirmed) {
            this.setData({ submissionError: '请先阅读并同意认证申请说明' });
            return;
        }
        if (this.data.requiresMaterials && this.data.uploadedMaterials.some(item => !item.id)) {
            this.setData({ submissionError: '仍有材料未上传成功，请重试或移除失败材料后再提交' });
            return;
        }
        const data = { kind: this.data.kind, consentConfirmed: true,
            materialIds: this.data.requiresMaterials ? this.data.uploadedMaterials.map(item => item.id).filter(Boolean) : [] };
        if (this.data.kind === 'education') {
            if (!this.data.method) {
                this.setData({ submissionError: '请选择学历认证方式' });
                return;
            }
            if (!this.data.educationSource || !this.data.educationLevel || !this.data.institutionName.trim()) {
                this.setData({ submissionError: '请填写学校全称，并选择学历来源和最高已取得学历' });
                return;
            }
            data.source = this.data.educationSource;
            data.educationLevel = certification_form_1.CERTIFICATION_EDUCATION_VALUES[certification_form_1.CERTIFICATION_EDUCATION_OPTIONS.indexOf(this.data.educationLevel)];
            data.institutionName = this.data.institutionName.trim();
            data.method = this.data.method;
            if (this.data.method === 'chsi_code') {
                if (!this.data.verificationCode.trim()) {
                    this.setData({ submissionError: '请输入学信网在线验证码' });
                    return;
                }
                data.verificationCode = this.data.verificationCode.trim();
            }
            if (this.data.method === 'cscse_number') {
                if (!this.data.certificateNumber.trim()) {
                    this.setData({ submissionError: '请输入教育部留服认证书编号' });
                    return;
                }
                data.certificateNumber = this.data.certificateNumber.trim();
            }
        }
        if (this.data.requiresMaterials && !data.materialIds.length) {
            this.setData({ submissionError: '请至少上传1份核验材料' });
            return;
        }
        if (this.data.kind === 'assets') {
            if (!this.data.declaredFinancialAssetRange) {
                this.setData({ submissionError: '请选择申报的金融资产区间' });
                return;
            }
            data.declaredFinancialAssetRange = this.data.declaredFinancialAssetRange;
        }
        const generation = ++this._generation;
        const isCurrent = () => !this._disposed && generation === this._generation && (0, page_session_1.pageSessionScope)() === scope;
        this._loadPromise = null;
        this.setData({ submitting: true, submissionError: '' });
        try {
            const overview = await member_1.memberApi.applyCertification(data);
            if (!isCurrent())
                return;
            if (!(0, certification_form_1.validCertificationOverview)(overview))
                throw new Error('认证申请状态不完整');
            const entry = overview.entries.find(item => item.kind === this.data.kind);
            if (!entry)
                throw new Error('认证申请状态缺失');
            this.applyEntry(entry);
            if (!this.data.requiresMaterials) {
                this.data.uploadedMaterials.filter(material => material.id).forEach(material => { void member_1.memberApi.removeCertificationMaterial(material.id).catch(() => undefined); });
            }
            this._draftEdited = false;
            this.setData({ consentConfirmed: false, verificationCode: '', certificateNumber: '', uploadedMaterials: [] });
            this.updateLeaveGuard();
            wx.showToast({ title: (0, certification_form_1.hasPendingCertification)(entry) ? '申请已提交，等待审核' : '申请状态已更新', icon: 'none' });
        }
        catch (error) {
            if (!isCurrent())
                return;
            const code = error && typeof error === 'object' && 'code' in error ? Number(error.code) : 0;
            if (code >= 40000 && code < 50000) {
                this.setData({ submissionError: (0, api_1.apiErrorMessage)(error) || '申请信息不完整，请检查后重试' });
            }
            else {
                this._loaded = false;
                this.setData({ submissionError: '申请结果暂未确认，请刷新状态后再继续', loadError: '请重新读取认证状态，确认申请是否已提交' });
            }
        }
        finally {
            if (isCurrent())
                this.setData({ submitting: false });
        }
    },
    goProfile() {
        const leave = () => {
            if (typeof wx.disableAlertBeforeUnload === 'function')
                wx.disableAlertBeforeUnload({ fail: () => undefined });
            this._leaveGuardEnabled = false;
            wx.switchTab({ url: '/pages/user/profile', fail: () => this.updateLeaveGuard() });
        };
        if (!this.hasUnsubmittedChanges()) {
            leave();
            return;
        }
        const scope = this._scope;
        wx.showModal({ title: '申请尚未提交', content: '填写的信息不会保存；已上传材料将加密暂存24小时，返回后可继续使用或移除。确定离开吗？',
            confirmText: '确认离开', cancelText: '继续填写',
            success: result => { if (result.confirm && !this._disposed && (0, page_session_1.pageSessionScope)() === scope)
                leave(); } });
    }
});
