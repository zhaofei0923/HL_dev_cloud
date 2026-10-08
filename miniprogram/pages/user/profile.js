"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const api_1 = require("../../services/api");
const member_1 = require("../../services/member");
const matchmaker_1 = require("../../services/matchmaker");
const local_image_1 = require("../../utils/local-image");
const member_format_1 = require("../../utils/member-format");
const invite_1 = require("../../utils/invite");
const page_session_1 = require("../../utils/page-session");
const user_navigation_1 = require("../../utils/user-navigation");
const certification_form_1 = require("../../utils/certification-form");
const profile_options_1 = require("../../utils/profile-options");
const PROFILE_TTL_MS = 30 * 1000;
const FORM_DEFAULTS = {
    realName: '',
    photoText: '',
    photoDisplayUrls: [],
    displayEnabled: false,
    assetCategoryConsent: false,
    assetRangeDisclosure: false,
    gender: '',
    age: '',
    height: '',
    city: '',
    nativePlace: '',
    education: '',
    occupation: '',
    incomeRange: '',
    maritalStatus: '',
    houseStatus: '',
    carStatus: '',
    selfIntro: '',
    partnerRequirement: ''
};
const COMPLETION_FIELDS = [
    'photoText',
    'realName',
    'gender',
    'age',
    'height',
    'city',
    'nativePlace',
    'education',
    'occupation',
    'incomeRange',
    'maritalStatus',
    'houseStatus',
    'carStatus',
    'selfIntro',
    'partnerRequirement'
];
// Photos and disclosure preferences save immediately. Text fields remain a draft
// until the member explicitly saves, and must never leak into those PATCH-like PUTs.
const DRAFT_FIELDS = COMPLETION_FIELDS.filter(field => field !== 'photoText');
function draftPayload(form) {
    return DRAFT_FIELDS.reduce((payload, field) => {
        payload[field] = form[field];
        return payload;
    }, {});
}
function hasDraftChanges(form, saved) {
    return DRAFT_FIELDS.some(field => String(form[field] || '') !== String(saved[field] || ''));
}
function profileRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function userFromProfileResult(result, payload) {
    const serverUser = { ...profileRecord(result.user || result) };
    delete serverUser.profile;
    const user = { ...profileRecord((0, api_1.currentUser)()), ...serverUser };
    if (payload.realName)
        user.nickname = payload.realName;
    if (payload.gender !== undefined)
        user.gender = Number(payload.gender || 0);
    return user;
}
function certificationSummaryFor(rows) {
    const approved = rows.filter(row => row.verified).length;
    const pending = rows.filter(row => row.state.includes('待审核')).length;
    const followUp = rows.filter(row => row.state.includes('未通过') || row.state === '已撤销').length;
    return [approved ? `${approved}项已认证` : '尚未完成认证', pending ? `${pending}项待审核` : '', followUp ? `${followUp}项需处理` : ''].filter(Boolean).join(' · ');
}
function photosToText(photos) {
    return Array.isArray(photos) ? (0, member_format_1.photosFromText)(photos.join('\n')).join('\n') : '';
}
function photoCountFor(form) {
    return (0, member_format_1.photosFromText)(String(form.photoText || '')).length;
}
function appendChosenPhotos(form, images) {
    const existingPhotos = (0, member_format_1.photosFromText)(String(form.photoText || ''));
    const existingDisplayUrls = Array.isArray(form.photoDisplayUrls) ? form.photoDisplayUrls : [];
    const displayUrlByPhoto = existingPhotos.reduce((map, photo, index) => {
        map[photo] = String(existingDisplayUrls[index] || photo);
        return map;
    }, {});
    images.forEach(image => {
        if (!displayUrlByPhoto[image.fileID])
            displayUrlByPhoto[image.fileID] = image.displayUrl;
    });
    const photos = (0, member_format_1.mergePhotoLists)(existingPhotos, images.map(item => item.fileID));
    return {
        photoText: photos.join('\n'),
        photoDisplayUrls: photos.map(photo => displayUrlByPhoto[photo] || photo)
    };
}
function removePhotoAt(form, index) {
    const existingPhotos = (0, member_format_1.photosFromText)(String(form.photoText || ''));
    const existingDisplayUrls = Array.isArray(form.photoDisplayUrls) ? form.photoDisplayUrls : [];
    const entries = existingPhotos
        .map((photo, photoIndex) => ({
        photo,
        displayUrl: String(existingDisplayUrls[photoIndex] || photo)
    }))
        .filter((_, photoIndex) => photoIndex !== index);
    return {
        photoText: entries.map(item => item.photo).join('\n'),
        photoDisplayUrls: entries.map(item => item.displayUrl)
    };
}
function normalizeForm(raw, user) {
    const form = {
        ...FORM_DEFAULTS,
        ...(raw || {})
    };
    form.realName = form.realName || (user && user.nickname) || '';
    form.displayEnabled = form.displayEnabled === true || form.displayEnabled === 1 || form.displayEnabled === '1' || form.displayEnabled === 'true';
    form.assetCategoryConsent = form.assetCategoryConsent === true;
    form.assetRangeDisclosure = form.assetRangeDisclosure === true;
    form.gender = String(form.gender || (user && user.gender) || '');
    form.photoText = form.photoText ? (0, member_format_1.photosFromText)(String(form.photoText)).join('\n') : photosToText(form.photos);
    form.photoDisplayUrls = Array.isArray(form.photoDisplayUrls) && form.photoDisplayUrls.length
        ? form.photoDisplayUrls.slice(0, member_format_1.PHOTO_WALL_LIMIT)
        : (0, member_format_1.photosFromText)(form.photoText);
    return form;
}
function payloadFromForm(form) {
    const photos = (0, member_format_1.photosFromText)(form.photoText);
    const payload = {
        ...form,
        photos
    };
    delete payload.photoText;
    delete payload.avatarUrl;
    delete payload.avatarDisplayUrl;
    delete payload.photoDisplayUrls;
    return payload;
}
function completionFor(form) {
    const payload = payloadFromForm(form);
    const filled = COMPLETION_FIELDS.filter(field => {
        if (field === 'photoText')
            return Array.isArray(payload.photos) && payload.photos.length > 0;
        return !!String(payload[field] || '').trim();
    }).length;
    const percent = Math.round((filled / COMPLETION_FIELDS.length) * 100);
    return {
        percent,
        text: `${percent}%`,
        note: percent >= 85 ? '个人档案较完整，适合进入后续推荐。' : '补齐形象、生活状态和择偶期待后，主理人判断会更准确。'
    };
}
function previewFor(form) {
    const payload = payloadFromForm(form);
    const photoDisplayUrls = Array.isArray(form.photoDisplayUrls) ? form.photoDisplayUrls.slice(0, member_format_1.PHOTO_WALL_LIMIT) : [];
    const displayPhotos = Array.isArray(form.photoDisplayUrls) && form.photoDisplayUrls.length
        ? photoDisplayUrls
        : (payload.photos.length ? payload.photos : (0, member_format_1.defaultPhotos)(form));
    const preview = (0, member_format_1.normalizeMemberProfile)({
        ...payload,
        photos: payload.photos
    });
    return {
        ...preview,
        avatarUrl: photoDisplayUrls[0] || preview.avatarUrl,
        photos: displayPhotos,
        coverUrl: photoDisplayUrls[0] || preview.coverUrl
    };
}
function hydrateImageDisplay(form) {
    const payload = payloadFromForm(form);
    return {
        ...form,
        photoDisplayUrls: Array.isArray(form.photoDisplayUrls) && form.photoDisplayUrls.length
            ? form.photoDisplayUrls.slice(0, member_format_1.PHOTO_WALL_LIMIT)
            : payload.photos.slice(0, member_format_1.PHOTO_WALL_LIMIT)
    };
}
function preserveImageDisplay(form, source) {
    if (!source)
        return form;
    const photos = (0, member_format_1.photosFromText)(String(form.photoText || ''));
    const sourcePhotos = (0, member_format_1.photosFromText)(String(source.photoText || ''));
    const sourceDisplayUrls = Array.isArray(source.photoDisplayUrls) ? source.photoDisplayUrls : [];
    const currentDisplayUrls = Array.isArray(form.photoDisplayUrls) ? form.photoDisplayUrls : [];
    const displayUrlByPhoto = sourcePhotos.reduce((map, photo, index) => {
        map[photo] = String(sourceDisplayUrls[index] || photo);
        return map;
    }, {});
    return {
        ...form,
        photoDisplayUrls: photos.map((photo, index) => displayUrlByPhoto[photo] || currentDisplayUrls[index] || photo)
    };
}
async function resolveFormDisplayUrls(form) {
    const photoDisplayUrls = Array.isArray(form.photoDisplayUrls) ? form.photoDisplayUrls : [];
    const resolved = await (0, local_image_1.resolveImageUrls)(photoDisplayUrls);
    return {
        ...form,
        photoDisplayUrls: resolved
    };
}
async function prepareProfileForm(raw, user, source) {
    const form = preserveImageDisplay(hydrateImageDisplay(normalizeForm(raw, user)), source);
    return resolveFormDisplayUrls(form);
}
function selectorTextFor(form) {
    return {
        ageText: (0, profile_options_1.agePickerText)(form.age),
        heightText: (0, profile_options_1.heightPickerText)(form.height),
        nativePlaceText: (0, profile_options_1.regionPickerText)(form.nativePlace, '请选择籍贯'),
        cityText: (0, profile_options_1.regionPickerText)(form.city, '请选择城市'),
        educationText: (0, profile_options_1.pickerText)(form.education, '请选择学历'),
        incomeText: (0, profile_options_1.pickerText)(form.incomeRange, '请选择收入'),
        occupationText: (0, profile_options_1.pickerText)(form.occupation, '请选择职业')
    };
}
function matchmakerEntryView(matchmaker) {
    const status = matchmaker ? Number(matchmaker.certificationStatus || 0) : -1;
    const remark = matchmaker && matchmaker.certificationRemark ? String(matchmaker.certificationRemark) : '';
    if (status === 2) {
        return {
            matchmakerApproved: true,
            matchmakerEntryTitle: '主理人端入口',
            matchmakerEntryNote: '主理人权限已开通，可进入主理人端使用会员经营、资源池和沙龙管理。',
            matchmakerEntryButton: '进入主理人端'
        };
    }
    if (status === 1) {
        return {
            matchmakerApproved: false,
            matchmakerEntryTitle: '主理人申请未通过',
            matchmakerEntryNote: remark || '本次申请暂未通过，可完善资料后重新提交申请。',
            matchmakerEntryButton: '重新申请 / 查看状态'
        };
    }
    if (status === 0) {
        return {
            matchmakerApproved: false,
            matchmakerEntryTitle: '主理人申请待审批',
            matchmakerEntryNote: '申请已提交，后台审批通过后将开放会员经营、资源池和沙龙管理。',
            matchmakerEntryButton: '查看申请状态'
        };
    }
    return {
        matchmakerApproved: false,
        matchmakerEntryTitle: '申请成为主理人',
        matchmakerEntryNote: '提交申请后需等待后台审批；通过后才会开放会员经营、资源池和沙龙管理。',
        matchmakerEntryButton: '申请 / 查看状态'
    };
}
Page({
    _profileScope: '',
    _profileGeneration: 0,
    _profileLoadedAt: 0,
    _profileInitialized: false,
    _profileLoadPromise: null,
    _formRevision: 0,
    _formDirty: false,
    _savedForm: { ...FORM_DEFAULTS },
    _leaveGuardActive: false,
    _profileVisible: false,
    _choosingPhotos: false,
    _refreshOnShow: false,
    _panelLoadedAt: 0,
    _panelLoadPromise: null,
    _panelGeneration: -1,
    _certificationGeneration: 0,
    _certificationLoadPromise: null,
    _certificationRefreshOnShow: false,
    data: {
        user: null,
        loading: false,
        profileReady: false,
        saving: false,
        uploadingPhotos: false,
        completionText: '0%',
        completionNote: '补齐形象、生活状态和择偶期待后，主理人判断会更准确。',
        genderOptions: ['男', '女'],
        maritalOptions: ['未婚', '离异', '丧偶'],
        houseOptions: ['已购房', '计划购房', '与父母同住', '租住'],
        carOptions: ['有车', '无车', '计划购车'],
        ageOptions: profile_options_1.AGE_OPTIONS,
        heightOptions: profile_options_1.HEIGHT_OPTIONS,
        educationOptions: profile_options_1.EDUCATION_OPTIONS,
        incomeOptions: profile_options_1.INCOME_OPTIONS,
        occupationOptions: profile_options_1.OCCUPATION_OPTIONS,
        matchmakerApproved: false,
        matchmakerEntryTitle: '申请成为主理人',
        matchmakerEntryNote: '提交申请后需等待后台审批；通过后才会开放会员经营、资源池和沙龙管理。',
        matchmakerEntryButton: '申请 / 查看状态',
        matchmakerCode: '',
        matchmakerRequesting: false,
        referralCard: { canShare: false },
        referralLoading: false,
        editingProfile: false,
        formDirty: false,
        saveState: 'idle',
        saveStatus: '资料已同步',
        previewOpen: false,
        matchmakerPanelOpen: false,
        accountPanelOpen: false,
        ...selectorTextFor(FORM_DEFAULTS),
        form: { ...FORM_DEFAULTS },
        preview: previewFor(FORM_DEFAULTS),
        photoCount: 0,
        certificationRows: (0, certification_form_1.certificationMenuRows)(),
        certificationSummary: '读取认证状态中',
        certificationsExpanded: false,
        certificationsLoading: false,
        certificationsError: ''
    },
    onShow() {
        if (!this.synchronizeSession())
            return;
        this._profileVisible = true;
        this.syncLeaveGuard();
        wx.setNavigationBarTitle({ title: this.data.editingProfile ? '编辑资料' : '我的资料' });
        (0, user_navigation_1.syncUserTabBar)(this, 'mine');
        const force = this._refreshOnShow;
        this._refreshOnShow = false;
        const refreshCertifications = this._certificationRefreshOnShow;
        this._certificationRefreshOnShow = false;
        return Promise.all([this.loadProfile(force), this.loadCertifications(refreshCertifications)]).then(() => undefined);
    },
    synchronizeSession() {
        const scope = (0, page_session_1.pageSessionScope)();
        if (scope !== this._profileScope) {
            this._profileScope = scope;
            this._profileGeneration += 1;
            this._profileLoadPromise = null;
            this._profileLoadedAt = 0;
            this._profileInitialized = false;
            this._formDirty = false;
            this._choosingPhotos = false;
            this.clearLeaveGuard();
            this._formRevision += 1;
            this._panelLoadedAt = 0;
            this._panelLoadPromise = null;
            this._panelGeneration = -1;
            this._certificationGeneration += 1;
            this._certificationLoadPromise = null;
            this._certificationRefreshOnShow = false;
            const user = (0, api_1.currentUser)() || {};
            const form = hydrateImageDisplay(normalizeForm({}, user));
            this._savedForm = form;
            const completion = completionFor(form);
            this.setData({
                user, form, preview: previewFor(form), photoCount: 0,
                ...selectorTextFor(form),
                ...matchmakerEntryView(null),
                completionText: completion.text,
                completionNote: completion.note,
                loading: false, profileReady: false, saving: false, uploadingPhotos: false, referralLoading: false,
                referralCard: { canShare: false }, matchmakerCode: '',
                editingProfile: false, previewOpen: false,
                formDirty: false, saveState: 'idle', saveStatus: '资料已同步',
                matchmakerPanelOpen: false, accountPanelOpen: false,
                certificationRows: (0, certification_form_1.certificationMenuRows)(),
                certificationSummary: '读取认证状态中', certificationsExpanded: false,
                certificationsLoading: false, certificationsError: ''
            });
        }
        if (scope)
            return scope;
        wx.redirectTo({ url: '/pages/index/index' });
        return '';
    },
    loadProfile(force = false) {
        const scope = this.synchronizeSession();
        if (!scope)
            return Promise.resolve();
        if (this.data.saving)
            return Promise.resolve();
        if (!force && this._profileLoadPromise)
            return this._profileLoadPromise;
        this._profileLoadPromise = null;
        if (!force && this._profileInitialized && Date.now() - this._profileLoadedAt < PROFILE_TTL_MS) {
            return Promise.resolve();
        }
        const generation = ++this._profileGeneration;
        const formRevision = this._formRevision;
        const isCurrent = () => generation === this._profileGeneration && (0, page_session_1.pageSessionScope)() === scope;
        this.setData({ loading: !this._profileInitialized });
        if (force)
            this._panelLoadedAt = 0;
        if (this.data.matchmakerPanelOpen)
            void this.loadMatchmakerPanel(force);
        const promise = Promise.resolve().then(async () => {
            try {
                const result = await (0, api_1.request)('/user/profile');
                if (!isCurrent())
                    return;
                const user = (0, api_1.currentUser)() || result;
                const form = await prepareProfileForm(result.profile || {}, user);
                if (!isCurrent())
                    return;
                // A tab return/background refresh must not overwrite unsaved edits.
                if (!this._formDirty && this._formRevision === formRevision && !this.data.saving) {
                    this._savedForm = form;
                    const completion = completionFor(form);
                    this.setData({
                        user, form, preview: previewFor(form), photoCount: photoCountFor(form),
                        ...selectorTextFor(form),
                        completionText: completion.text, completionNote: completion.note,
                        saveState: 'saved', saveStatus: '资料已同步'
                    });
                }
                else {
                    this.setData({ user });
                }
                this._profileLoadedAt = Date.now();
                this._profileInitialized = true;
                this.setData({ profileReady: true });
            }
            catch (err) {
                if (!isCurrent())
                    return;
                console.warn('load user profile failed', err);
                this._profileLoadedAt = 0;
            }
            finally {
                if (isCurrent()) {
                    this._profileLoadPromise = null;
                    this.setData({ loading: false });
                }
            }
        });
        this._profileLoadPromise = promise;
        return promise;
    },
    onPullDownRefresh() {
        return Promise.all([this.loadProfile(true), this.loadCertifications(true)]).then(() => undefined).finally(() => wx.stopPullDownRefresh());
    },
    onUnload() {
        this._profileVisible = false;
        this.clearLeaveGuard();
        this._profileGeneration += 1;
        this._profileLoadPromise = null;
        this._panelLoadPromise = null;
        this._certificationGeneration += 1;
        this._certificationLoadPromise = null;
    },
    onHide() {
        this._profileVisible = false;
        // Tab pages keep their form in memory; the next shown page owns its guard.
        this.clearLeaveGuard();
    },
    syncLeaveGuard() {
        if (!this._profileVisible)
            return;
        if (this._formDirty && !this._leaveGuardActive && typeof wx.enableAlertBeforeUnload === 'function') {
            wx.enableAlertBeforeUnload({ message: '资料修改尚未保存，离开后可能丢失。' });
            this._leaveGuardActive = true;
        }
        else if (!this._formDirty)
            this.clearLeaveGuard();
    },
    clearLeaveGuard() {
        if (this._leaveGuardActive && typeof wx.disableAlertBeforeUnload === 'function')
            wx.disableAlertBeforeUnload();
        this._leaveGuardActive = false;
    },
    loadCertifications(force = false) {
        const scope = this.synchronizeSession();
        if (!scope)
            return Promise.resolve();
        if (!force && this._certificationLoadPromise)
            return this._certificationLoadPromise;
        const generation = ++this._certificationGeneration;
        const isCurrent = () => generation === this._certificationGeneration && (0, page_session_1.pageSessionScope)() === scope;
        this.setData({ certificationsLoading: true, certificationsError: '' });
        const promise = Promise.resolve().then(async () => {
            try {
                const overview = await member_1.memberApi.certifications();
                if (!isCurrent())
                    return;
                if (!(0, certification_form_1.validCertificationOverview)(overview))
                    throw new Error('认证状态不完整');
                const certificationRows = (0, certification_form_1.certificationMenuRows)(overview.entries);
                this.setData({ certificationRows, certificationSummary: certificationSummaryFor(certificationRows) });
            }
            catch (error) {
                if (!isCurrent())
                    return;
                console.warn('load certifications failed', error);
                this.setData({ certificationsError: '认证状态读取失败，请重试' });
            }
            finally {
                if (isCurrent()) {
                    this._certificationLoadPromise = null;
                    this.setData({ certificationsLoading: false });
                }
            }
        });
        this._certificationLoadPromise = promise;
        return promise;
    },
    retryCertifications() {
        return this.loadCertifications(true);
    },
    toggleCertifications() {
        this.setData({ certificationsExpanded: !this.data.certificationsExpanded });
    },
    openCertification(e) {
        const kind = String(e.currentTarget.dataset.kind || '');
        if (!(0, certification_form_1.certificationDefinition)(kind) || this.data.saving)
            return;
        if (this._formDirty) {
            wx.showToast({ title: '请先保存资料，再申请认证', icon: 'none' });
            this.openProfileEditor();
            return;
        }
        this._certificationRefreshOnShow = true;
        wx.navigateTo({ url: `/pages/user/certification?kind=${kind}` });
    },
    loadMatchmakerPanel(force = false) {
        const scope = this.synchronizeSession();
        if (!scope || !this.data.matchmakerPanelOpen)
            return Promise.resolve();
        if (!force && this._panelLoadPromise && this._panelGeneration === this._profileGeneration)
            return this._panelLoadPromise;
        if (!force && this._panelLoadedAt > 0 && Date.now() - this._panelLoadedAt < PROFILE_TTL_MS)
            return Promise.resolve();
        const generation = this._profileGeneration;
        this._panelGeneration = generation;
        const promise = Promise.all([
            this.refreshMatchmakerEntry(scope, generation),
            this.loadReferralCard(scope, generation)
        ]).then(results => {
            if (generation === this._profileGeneration && (0, page_session_1.pageSessionScope)() === scope) {
                this._panelLoadedAt = results.every(Boolean) ? Date.now() : 0;
            }
        }).finally(() => {
            if (this._panelLoadPromise === promise)
                this._panelLoadPromise = null;
        });
        this._panelLoadPromise = promise;
        return promise;
    },
    async refreshMatchmakerEntry(scope, generation) {
        const requestScope = scope === undefined ? this._profileScope : scope;
        const requestGeneration = generation === undefined ? this._profileGeneration : generation;
        const isCurrent = () => requestScope === (0, page_session_1.pageSessionScope)() && requestGeneration === this._profileGeneration;
        try {
            const result = await matchmaker_1.matchmakerApi.status(false);
            if (!isCurrent())
                return false;
            this.setData(matchmakerEntryView(result.matchmaker));
            return true;
        }
        catch (err) {
            if (!isCurrent())
                return false;
            this.setData(matchmakerEntryView(null));
            return false;
        }
    },
    async loadReferralCard(scope, generation) {
        const requestScope = scope === undefined ? this._profileScope : scope;
        const requestGeneration = generation === undefined ? this._profileGeneration : generation;
        const isCurrent = () => requestScope === (0, page_session_1.pageSessionScope)() && requestGeneration === this._profileGeneration;
        this.setData({ referralLoading: !this._profileInitialized });
        try {
            const referralCard = await member_1.memberApi.referralCard(false);
            if (!isCurrent())
                return false;
            this.setData({ referralCard });
            return true;
        }
        catch (err) {
            if (!isCurrent())
                return false;
            console.warn('load member referral card failed', err);
            this.setData({ referralCard: { canShare: false } });
            return false;
        }
        finally {
            if (isCurrent())
                this.setData({ referralLoading: false });
        }
    },
    renderForm(form, saveStatus, saveState) {
        this._formDirty = hasDraftChanges(form, this._savedForm);
        const completion = completionFor(form);
        this.setData({
            form,
            formDirty: this._formDirty,
            saveStatus: saveStatus || (this._formDirty ? '资料有修改，尚未保存' : '资料已保存'),
            saveState: saveState || (this._formDirty ? 'dirty' : 'saved'),
            preview: previewFor(form),
            photoCount: photoCountFor(form),
            ...selectorTextFor(form),
            completionText: completion.text,
            completionNote: completion.note
        });
        this.syncLeaveGuard();
    },
    setForm(form) {
        this._formRevision += 1;
        this.renderForm(form);
    },
    updateForm(field, value) {
        this.setForm({ ...this.data.form, [field]: value });
    },
    openProfileEditor() {
        wx.setNavigationBarTitle({ title: '编辑资料' });
        this.setData({ editingProfile: true, previewOpen: false }, () => {
            wx.pageScrollTo({ scrollTop: 0, duration: 0 });
        });
    },
    closeProfileEditor() {
        wx.setNavigationBarTitle({ title: '我的资料' });
        this.setData({ editingProfile: false }, () => wx.pageScrollTo({ scrollTop: 0, duration: 0 }));
    },
    toggleProfileEditor() {
        if (!this.data.editingProfile)
            return this.openProfileEditor();
        if (this.data.saving || this._choosingPhotos)
            return;
        if (!this._formDirty)
            return this.closeProfileEditor();
        const scope = this._profileScope;
        wx.showModal({
            title: '资料尚未保存',
            content: '返回后可继续本次编辑。关闭小程序或退出登录前，请先保存资料。',
            confirmText: '返回我的', cancelText: '继续编辑',
            success: result => {
                if (result.confirm && (0, page_session_1.pageSessionScope)() === scope)
                    this.closeProfileEditor();
            }
        });
    },
    togglePreview() {
        this.setData({ previewOpen: !this.data.previewOpen });
    },
    toggleMatchmakerPanel() {
        this.setData({ matchmakerPanelOpen: !this.data.matchmakerPanelOpen });
        if (this.data.matchmakerPanelOpen)
            return this.loadMatchmakerPanel();
        return Promise.resolve();
    },
    toggleAccountPanel() {
        this.setData({ accountPanelOpen: !this.data.accountPanelOpen });
    },
    onInput(e) {
        const field = String(e.currentTarget.dataset.field || '');
        if (!field)
            return;
        this.updateForm(field, e.detail.value);
    },
    async onDisplayEnabledChange(e) {
        const displayEnabled = e.detail.value === true;
        await this.saveImmediatePatch({ displayEnabled }, { displayEnabled }, displayEnabled ? '已开启展示' : '已关闭展示');
    },
    async onAssetPreferenceChange(e) {
        const field = e.currentTarget.dataset.field;
        if (field !== 'assetCategoryConsent' && field !== 'assetRangeDisclosure')
            return;
        await this.saveImmediatePatch({ [field]: e.detail.value === true }, { [field]: e.detail.value === true }, '资产展示设置已保存');
    },
    onMatchmakerCodeInput(e) {
        this.setData({ matchmakerCode: e.detail.value });
    },
    async submitMatchmakerRequest() {
        const code = String(this.data.matchmakerCode || '').trim();
        if (!code) {
            wx.showToast({ title: '请输入主理人编号', icon: 'none' });
            return;
        }
        this._refreshOnShow = true;
        wx.navigateTo({ url: (0, invite_1.invitePath)(code, 'inviteCode') });
    },
    scanMatchmakerInvite() {
        wx.scanCode({
            scanType: ['qrCode'],
            success: res => {
                const code = (0, invite_1.extractInviteCode)(res.result || res.path);
                if (!code) {
                    wx.showToast({ title: '未识别到主理人邀请码', icon: 'none' });
                    return;
                }
                this._refreshOnShow = true;
                wx.navigateTo({ url: (0, invite_1.invitePath)(code, 'scan') });
            },
            fail: err => {
                if (!/cancel/i.test(String(err && err.errMsg))) {
                    wx.showToast({ title: '扫码失败，请重试', icon: 'none' });
                }
            }
        });
    },
    showInviteLinkTip() {
        wx.showModal({
            title: '微信链接添加',
            content: '打开主理人或会员发来的微信分享卡片后，系统会自动注册为对应主理人名下免费会员；扫码和手动邀请码仍需提交申请。',
            showCancel: false,
            confirmText: '知道了'
        });
    },
    async choosePhotos() {
        if (this.data.saving || this.data.loading || this._choosingPhotos)
            return;
        const scope = this._profileScope;
        this._choosingPhotos = true;
        this.setData({ uploadingPhotos: true });
        try {
            const existingPhotos = (0, member_format_1.photosFromText)(String(this.data.form.photoText || ''));
            const remaining = member_format_1.PHOTO_WALL_LIMIT - existingPhotos.length;
            if (remaining <= 0) {
                wx.showToast({ title: '照片墙最多3张', icon: 'none' });
                return;
            }
            const images = await (0, local_image_1.chooseLocalImages)(remaining, { crop: true });
            if (scope !== (0, page_session_1.pageSessionScope)())
                return;
            if (images.length) {
                const photoPatch = appendChosenPhotos(this.data.form, images);
                await this.saveImmediatePatch({ photos: (0, member_format_1.photosFromText)(photoPatch.photoText) }, photoPatch, '照片已保存');
            }
        }
        catch (err) {
            if (scope === (0, page_session_1.pageSessionScope)() && !(0, local_image_1.isImageChooseCancel)(err)) {
                console.warn('upload photos failed', err);
                wx.showToast({ title: '图片上传失败，请重试', icon: 'none' });
            }
        }
        finally {
            if (scope === (0, page_session_1.pageSessionScope)()) {
                this._choosingPhotos = false;
                this.setData({ uploadingPhotos: false });
            }
        }
    },
    deletePhoto(e) {
        if (this.data.saving || this.data.loading || this._choosingPhotos)
            return;
        const index = Number(e.currentTarget.dataset.index);
        const photos = (0, member_format_1.photosFromText)(String(this.data.form.photoText || ''));
        if (!Number.isInteger(index) || index < 0 || index >= photos.length)
            return;
        const photo = photos[index];
        const scope = this._profileScope;
        wx.showModal({
            title: '删除照片',
            content: '确定从照片墙删除这张照片吗？',
            confirmText: '删除',
            confirmColor: '#8b332c',
            success: res => {
                if (!res.confirm || scope !== (0, page_session_1.pageSessionScope)())
                    return;
                const currentIndex = (0, member_format_1.photosFromText)(String(this.data.form.photoText || '')).indexOf(photo);
                if (currentIndex < 0)
                    return;
                const photoPatch = removePhotoAt(this.data.form, currentIndex);
                void this.saveImmediatePatch({ photos: (0, member_format_1.photosFromText)(photoPatch.photoText) }, photoPatch, '照片已删除');
            }
        });
    },
    onGenderChange(e) {
        this.updateForm('gender', String(Number(e.detail.value) + 1));
    },
    onAgeChange(e) {
        this.updateForm('age', this.data.ageOptions[Number(e.detail.value)]);
    },
    onHeightChange(e) {
        this.updateForm('height', this.data.heightOptions[Number(e.detail.value)]);
    },
    onNativePlaceChange(e) {
        this.updateForm('nativePlace', (0, profile_options_1.regionValueText)(e.detail.value));
    },
    onCityChange(e) {
        this.updateForm('city', (0, profile_options_1.regionValueText)(e.detail.value));
    },
    onEducationChange(e) {
        this.updateForm('education', this.data.educationOptions[Number(e.detail.value)]);
    },
    onIncomeChange(e) {
        this.updateForm('incomeRange', this.data.incomeOptions[Number(e.detail.value)]);
    },
    onOccupationChange(e) {
        this.updateForm('occupation', this.data.occupationOptions[Number(e.detail.value)]);
    },
    onMaritalChange(e) {
        this.updateForm('maritalStatus', this.data.maritalOptions[Number(e.detail.value)]);
    },
    onHouseChange(e) {
        this.updateForm('houseStatus', this.data.houseOptions[Number(e.detail.value)]);
    },
    onCarChange(e) {
        this.updateForm('carStatus', this.data.carOptions[Number(e.detail.value)]);
    },
    async saveImmediatePatch(payload, formPatch, toastTitle) {
        if (this.data.saving || this.data.loading || !this._profileInitialized)
            return false;
        const scope = (0, page_session_1.pageSessionScope)();
        if (!scope || scope !== this._profileScope)
            return false;
        const previous = this.data.form;
        const generation = ++this._profileGeneration;
        const isCurrent = () => (0, page_session_1.pageSessionScope)() === scope && this._profileGeneration === generation;
        this._profileLoadPromise = null;
        this.setData({ saving: true, loading: false, referralLoading: false });
        this.renderForm({ ...previous, ...formPatch }, '正在保存…', 'saving');
        try {
            const result = await (0, api_1.request)('/user/profile', { method: 'PUT', data: payload });
            if (!isCurrent())
                return false;
            const user = userFromProfileResult(result, payload);
            const savedForm = await prepareProfileForm({
                ...payloadFromForm(this._savedForm), ...payload, ...profileRecord(result.profile)
            }, user, { ...previous, ...formPatch });
            if (!isCurrent())
                return false;
            this._savedForm = savedForm;
            // Update only the immediate fields; text typed before/during the request stays a draft.
            const applied = Object.keys(formPatch).reduce((patch, field) => {
                patch[field] = savedForm[field];
                return patch;
            }, {});
            const next = { ...this.data.form, ...applied };
            wx.setStorageSync('user', user);
            getApp().globalData.user = user;
            this.setData({ user });
            this.renderForm(next, hasDraftChanges(next, savedForm) ? `${toastTitle}；资料修改尚未保存` : toastTitle);
            this._profileLoadedAt = Date.now();
            wx.showToast({ title: toastTitle });
            return true;
        }
        catch (err) {
            if (!isCurrent())
                return false;
            console.warn('save profile preference or photos failed', err);
            const rollback = Object.keys(formPatch).reduce((patch, field) => {
                patch[field] = previous[field];
                return patch;
            }, {});
            const message = Object.prototype.hasOwnProperty.call(payload, 'photos')
                ? '照片未保存，已恢复原照片，请重试' : '设置未保存，已恢复原设置，请重试';
            this.renderForm({ ...this.data.form, ...rollback }, message, 'error');
            wx.showToast({ title: Object.prototype.hasOwnProperty.call(payload, 'photos') ? '照片未保存，请重试' : '设置未保存，请重试', icon: 'none' });
            return false;
        }
        finally {
            if (isCurrent())
                this.setData({ saving: false });
        }
    },
    async save() {
        if (this.data.saving || this.data.loading || this._choosingPhotos)
            return false;
        const scope = (0, page_session_1.pageSessionScope)();
        if (!scope || scope !== this._profileScope)
            return false;
        const submitted = { ...this.data.form };
        const payload = draftPayload(submitted);
        const generation = ++this._profileGeneration;
        const isCurrent = () => (0, page_session_1.pageSessionScope)() === scope && this._profileGeneration === generation;
        this._profileLoadPromise = null;
        this.setData({ saving: true, loading: false, referralLoading: false, saveStatus: '正在保存资料…', saveState: 'saving' });
        try {
            const result = await (0, api_1.request)('/user/profile', { method: 'PUT', data: payload });
            if (!isCurrent())
                return false;
            const user = userFromProfileResult(result, payload);
            const savedForm = await prepareProfileForm({
                ...payloadFromForm(this._savedForm), ...payload, ...profileRecord(result.profile)
            }, user, this.data.form);
            if (!isCurrent())
                return false;
            const next = { ...savedForm };
            // A slow response must not erase text entered after the Save tap.
            DRAFT_FIELDS.forEach(field => {
                if (this.data.form[field] !== submitted[field])
                    next[field] = this.data.form[field];
            });
            this._savedForm = savedForm;
            wx.setStorageSync('user', user);
            getApp().globalData.user = user;
            this.setData({ user });
            this.renderForm(next);
            this._profileLoadedAt = Date.now();
            this._profileInitialized = true;
            wx.showToast({ title: this._formDirty ? '已保存，新修改待保存' : '资料已保存', icon: this._formDirty ? 'none' : 'success' });
            return true;
        }
        catch (err) {
            if (!isCurrent())
                return false;
            console.warn('save user profile failed', err);
            this.setData({ saveState: 'error', saveStatus: '保存失败，修改仍保留，请重试' });
            return false;
        }
        finally {
            if (isCurrent())
                this.setData({ saving: false });
        }
    },
    goMatchmaker() {
        if (this._formDirty) {
            wx.showToast({ title: '请先保存资料，再进入主理人端', icon: 'none' });
            this.openProfileEditor();
            return;
        }
        this._refreshOnShow = true;
        wx.redirectTo({ url: '/pages/matchmaker/workspace' });
    },
    goMembership() {
        this._refreshOnShow = true;
        wx.navigateTo({ url: '/pages/user/membership' });
    },
    logout() {
        if (this.data.saving || this._choosingPhotos)
            return;
        if (this._formDirty) {
            const scope = this._profileScope;
            wx.showModal({
                title: '资料尚未保存', content: '退出登录将丢失本次资料修改，是否仍要退出？',
                confirmText: '退出登录', cancelText: '继续编辑',
                success: result => {
                    if ((0, page_session_1.pageSessionScope)() !== scope)
                        return;
                    if (result.confirm)
                        this.completeLogout();
                    else
                        this.openProfileEditor();
                }
            });
            return;
        }
        this.completeLogout();
    },
    completeLogout() {
        this.clearLeaveGuard();
        wx.removeStorageSync('token');
        wx.removeStorageSync('user');
        const app = getApp();
        app.globalData.token = '';
        app.globalData.user = null;
        this.synchronizeSession();
    },
    onShareAppMessage() {
        const card = this.data.referralCard || {};
        return {
            title: '邀请你注册成为 HL 会员',
            path: card.sharePath || '/pages/user/members'
        };
    }
});
