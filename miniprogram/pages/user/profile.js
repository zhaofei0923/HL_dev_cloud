"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const api_1 = require("../../services/api");
const matchmaker_1 = require("../../services/matchmaker");
const local_image_1 = require("../../utils/local-image");
const member_format_1 = require("../../utils/member-format");
const invite_1 = require("../../utils/invite");
const profile_options_1 = require("../../utils/profile-options");
const FORM_DEFAULTS = {
    realName: '',
    avatarUrl: '',
    avatarDisplayUrl: '',
    photoText: '',
    photoDisplayUrls: [],
    displayEnabled: false,
    gender: '2',
    age: '',
    height: '',
    city: '',
    nativePlace: '',
    education: '',
    occupation: '',
    incomeRange: '',
    maritalStatus: '未婚',
    houseStatus: '计划购房',
    carStatus: '无车',
    selfIntro: '',
    partnerRequirement: ''
};
const COMPLETION_FIELDS = [
    'avatarUrl',
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
function photosToText(photos) {
    return Array.isArray(photos) ? photos.slice(0, 3).join('\n') : '';
}
function normalizeForm(raw, user) {
    const form = {
        ...FORM_DEFAULTS,
        ...(raw || {})
    };
    form.realName = form.realName || (user && user.nickname) || '';
    form.avatarUrl = form.avatarUrl || (user && user.avatarUrl) || (0, member_format_1.defaultAvatar)(form);
    form.avatarDisplayUrl = form.avatarDisplayUrl || form.avatarUrl;
    form.displayEnabled = form.displayEnabled === true || form.displayEnabled === 1 || form.displayEnabled === '1' || form.displayEnabled === 'true';
    form.gender = String(form.gender || (user && user.gender) || '2');
    form.photoText = form.photoText || photosToText(form.photos) || (0, member_format_1.defaultPhotos)(form).join('\n');
    form.photoDisplayUrls = Array.isArray(form.photoDisplayUrls) && form.photoDisplayUrls.length
        ? form.photoDisplayUrls.slice(0, 3)
        : (0, member_format_1.photosFromText)(form.photoText);
    return form;
}
function payloadFromForm(form) {
    const photos = (0, member_format_1.photosFromText)(form.photoText);
    const payload = {
        ...form,
        avatarUrl: form.avatarUrl || (0, member_format_1.defaultAvatar)(form),
        photos: photos.length ? photos : (0, member_format_1.defaultPhotos)(form)
    };
    delete payload.photoText;
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
        note: percent >= 85 ? '个人档案较完整，适合进入后续推荐。' : '补齐形象、生活状态和择偶期待后，红娘判断会更准确。'
    };
}
function previewFor(form) {
    const payload = payloadFromForm(form);
    const displayPhotos = Array.isArray(form.photoDisplayUrls) && form.photoDisplayUrls.length
        ? form.photoDisplayUrls.slice(0, 3)
        : payload.photos;
    return (0, member_format_1.normalizeMemberProfile)({
        ...payload,
        avatarUrl: form.avatarDisplayUrl || payload.avatarUrl,
        photos: displayPhotos
    });
}
function hydrateImageDisplay(form) {
    const payload = payloadFromForm(form);
    return {
        ...form,
        avatarDisplayUrl: form.avatarDisplayUrl || payload.avatarUrl,
        photoDisplayUrls: Array.isArray(form.photoDisplayUrls) && form.photoDisplayUrls.length
            ? form.photoDisplayUrls.slice(0, 3)
            : payload.photos.slice(0, 3)
    };
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
            matchmakerEntryTitle: '红娘端入口',
            matchmakerEntryNote: '红娘权限已开通，可进入红娘端使用会员经营、资源池和沙龙管理。',
            matchmakerEntryButton: '进入红娘端'
        };
    }
    if (status === 1) {
        return {
            matchmakerApproved: false,
            matchmakerEntryTitle: '红娘申请未通过',
            matchmakerEntryNote: remark || '本次申请暂未通过，可完善资料后重新提交申请。',
            matchmakerEntryButton: '重新申请 / 查看状态'
        };
    }
    if (status === 0) {
        return {
            matchmakerApproved: false,
            matchmakerEntryTitle: '红娘申请待审批',
            matchmakerEntryNote: '申请已提交，后台审批通过后将开放会员经营、资源池和沙龙管理。',
            matchmakerEntryButton: '查看申请状态'
        };
    }
    return {
        matchmakerApproved: false,
        matchmakerEntryTitle: '申请成为红娘',
        matchmakerEntryNote: '提交申请后需等待后台审批；通过后才会开放会员经营、资源池和沙龙管理。',
        matchmakerEntryButton: '申请 / 查看状态'
    };
}
Page({
    data: {
        user: null,
        loading: false,
        saving: false,
        completionText: '0%',
        completionNote: '补齐形象、生活状态和择偶期待后，红娘判断会更准确。',
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
        matchmakerEntryTitle: '申请成为红娘',
        matchmakerEntryNote: '提交申请后需等待后台审批；通过后才会开放会员经营、资源池和沙龙管理。',
        matchmakerEntryButton: '申请 / 查看状态',
        matchmakerCode: '',
        matchmakerRequesting: false,
        ...selectorTextFor(FORM_DEFAULTS),
        form: { ...FORM_DEFAULTS },
        preview: previewFor(FORM_DEFAULTS)
    },
    async onShow() {
        this.setData({ loading: true });
        try {
            const result = await (0, api_1.request)('/user/profile');
            const user = (0, api_1.currentUser)() || result;
            const form = hydrateImageDisplay(normalizeForm(result.profile || {}, user));
            const completion = completionFor(form);
            this.setData({
                user,
                form,
                preview: previewFor(form),
                ...selectorTextFor(form),
                completionText: completion.text,
                completionNote: completion.note
            });
            void this.refreshMatchmakerEntry();
        }
        catch (err) {
            console.warn('load user profile failed', err);
            const form = hydrateImageDisplay(normalizeForm({}, (0, api_1.currentUser)() || {}));
            const completion = completionFor(form);
            this.setData({
                user: (0, api_1.currentUser)() || {},
                form,
                preview: previewFor(form),
                ...selectorTextFor(form),
                completionText: completion.text,
                completionNote: completion.note
            });
        }
        finally {
            this.setData({ loading: false });
        }
    },
    async refreshMatchmakerEntry() {
        try {
            const dashboard = await matchmaker_1.matchmakerApi.dashboard(false);
            this.setData(matchmakerEntryView(dashboard.matchmaker));
        }
        catch (err) {
            this.setData(matchmakerEntryView(null));
        }
    },
    setForm(form) {
        const completion = completionFor(form);
        this.setData({
            form,
            preview: previewFor(form),
            ...selectorTextFor(form),
            completionText: completion.text,
            completionNote: completion.note
        });
    },
    updateForm(field, value) {
        this.setForm({ ...this.data.form, [field]: value });
    },
    onInput(e) {
        const field = String(e.currentTarget.dataset.field || '');
        if (!field)
            return;
        this.updateForm(field, e.detail.value);
    },
    async onDisplayEnabledChange(e) {
        const next = { ...this.data.form, displayEnabled: !!e.detail.value };
        this.setForm(next);
        await this.saveProfile(next, next.displayEnabled ? '已开启展示' : '已关闭展示');
    },
    onMatchmakerCodeInput(e) {
        this.setData({ matchmakerCode: e.detail.value });
    },
    async submitMatchmakerRequest() {
        const code = String(this.data.matchmakerCode || '').trim();
        if (!code) {
            wx.showToast({ title: '请输入红娘编号', icon: 'none' });
            return;
        }
        wx.navigateTo({ url: (0, invite_1.invitePath)(code, 'inviteCode') });
    },
    scanMatchmakerInvite() {
        wx.scanCode({
            scanType: ['qrCode'],
            success: res => {
                const code = (0, invite_1.extractInviteCode)(res.result || res.path);
                if (!code) {
                    wx.showToast({ title: '未识别到红娘邀请码', icon: 'none' });
                    return;
                }
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
            content: '请打开红娘发来的微信分享卡片，系统会自动识别邀请码，并进入确认申请页面。',
            showCancel: false,
            confirmText: '知道了'
        });
    },
    async chooseAvatar() {
        try {
            wx.showLoading({ title: '上传中' });
            const images = await (0, local_image_1.chooseLocalImages)(1);
            const image = images[0];
            if (image) {
                this.setForm({
                    ...this.data.form,
                    avatarUrl: image.fileID,
                    avatarDisplayUrl: image.displayUrl
                });
            }
        }
        catch (err) {
            // 用户取消选择时无需提示。
        }
        finally {
            wx.hideLoading();
        }
    },
    async choosePhotos() {
        try {
            wx.showLoading({ title: '上传中' });
            const images = await (0, local_image_1.chooseLocalImages)(3);
            if (images.length) {
                this.setForm({
                    ...this.data.form,
                    photoText: images.map(item => item.fileID).join('\n'),
                    photoDisplayUrls: images.map(item => item.displayUrl)
                });
            }
        }
        catch (err) {
            // 用户取消选择时无需提示。
        }
        finally {
            wx.hideLoading();
        }
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
    async saveProfile(form, toastTitle = '已保存') {
        if (this.data.saving)
            return;
        this.setData({ saving: true });
        try {
            const payload = payloadFromForm(form);
            const result = await (0, api_1.request)('/user/profile', { method: 'PUT', data: payload });
            const user = {
                ...((0, api_1.currentUser)() || {}),
                ...(result.user || {}),
                nickname: payload.realName || (result.user && result.user.nickname) || (((0, api_1.currentUser)() || {}).nickname) || '',
                avatarUrl: payload.avatarUrl,
                gender: Number(payload.gender || 0)
            };
            wx.setStorageSync('user', user);
            getApp().globalData.user = user;
            const nextForm = hydrateImageDisplay(normalizeForm(result.profile || payload, user));
            const completion = completionFor(nextForm);
            this.setData({
                user,
                form: nextForm,
                preview: previewFor(nextForm),
                ...selectorTextFor(nextForm),
                completionText: completion.text,
                completionNote: completion.note
            });
            wx.showToast({ title: toastTitle });
        }
        catch (err) {
            console.warn('save user profile failed', err);
        }
        finally {
            this.setData({ saving: false });
        }
    },
    async save() {
        if (this.data.saving)
            return;
        this.setData({ saving: true });
        try {
            const payload = payloadFromForm(this.data.form);
            const result = await (0, api_1.request)('/user/profile', { method: 'PUT', data: payload });
            const user = {
                ...((0, api_1.currentUser)() || {}),
                ...(result.user || {}),
                nickname: payload.realName || (result.user && result.user.nickname) || (((0, api_1.currentUser)() || {}).nickname) || '',
                avatarUrl: payload.avatarUrl,
                gender: Number(payload.gender || 0)
            };
            wx.setStorageSync('user', user);
            getApp().globalData.user = user;
            const form = hydrateImageDisplay(normalizeForm(result.profile || payload, user));
            const completion = completionFor(form);
            this.setData({
                user,
                form,
                preview: previewFor(form),
                ...selectorTextFor(form),
                completionText: completion.text,
                completionNote: completion.note
            });
            wx.showToast({ title: '已保存' });
        }
        catch (err) {
            console.warn('save user profile failed', err);
        }
        finally {
            this.setData({ saving: false });
        }
    },
    goMatchmaker() {
        wx.redirectTo({ url: '/pages/matchmaker/dashboard' });
    },
    logout() {
        wx.removeStorageSync('token');
        wx.removeStorageSync('user');
        wx.redirectTo({ url: '/pages/index/index' });
    }
});
