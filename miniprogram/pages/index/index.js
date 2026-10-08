"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const auth_1 = require("../../services/auth");
const api_1 = require("../../services/api");
const local_image_1 = require("../../utils/local-image");
const page_session_1 = require("../../utils/page-session");
function eventIdFrom(value) {
    const raw = String(value || '').trim();
    const id = Number(raw);
    return /^\d+$/.test(raw) && Number.isSafeInteger(id) && id > 0 ? String(id) : '';
}
function registrationName(value) {
    const name = String(value || '').trim();
    return /^(新用户|用户\d+)$/.test(name) ? '' : name;
}
Page({
    _registrationScope: '',
    _registrationGeneration: 0,
    _registrationInitialized: false,
    _registrationUnloaded: false,
    _registrationPending: null,
    data: {
        loading: false,
        registrationMode: false,
        eventId: '',
        loggedIn: false,
        checking: false,
        saving: false,
        photoUploading: false,
        phone: '',
        nickname: '',
        photoFileId: '',
        photoDisplayUrl: '',
        phoneStatus: 'filled',
        errorText: ''
    },
    onLoad(options) {
        const registrationMode = String(options.register || '') === '1';
        const eventId = eventIdFrom(options.eventId);
        this.setData({ registrationMode, eventId,
            errorText: registrationMode && !eventId ? '活动链接不完整，请重新打开活动邀请。' : '' });
    },
    onShow() {
        this._registrationUnloaded = false;
        const scope = this.synchronizeRegistrationSession();
        if (this.data.registrationMode) {
            if (scope && this.data.eventId)
                return this.loadRegistration();
            return Promise.resolve();
        }
        if (scope) {
            wx.switchTab({ url: '/pages/user/members' });
        }
        return Promise.resolve();
    },
    onUnload() {
        this._registrationUnloaded = true;
        this._registrationGeneration += 1;
        this._registrationPending = null;
    },
    synchronizeRegistrationSession() {
        const scope = (0, page_session_1.pageSessionScope)();
        if (scope !== this._registrationScope) {
            this._registrationScope = scope;
            this._registrationGeneration += 1;
            this._registrationPending = null;
            this._registrationInitialized = false;
            this.setData({ loggedIn: !!scope, checking: false, saving: false, photoUploading: false,
                phone: '', nickname: '', photoFileId: '', photoDisplayUrl: '', phoneStatus: 'filled' });
        }
        else {
            this.setData({ loggedIn: !!scope });
        }
        return scope;
    },
    isRegistrationCurrent(scope, generation) {
        return !this._registrationUnloaded && (0, page_session_1.pageSessionScope)() === scope
            && this._registrationGeneration === generation;
    },
    loadRegistration() {
        const scope = this.synchronizeRegistrationSession();
        if (!scope || !this.data.eventId)
            return Promise.resolve();
        if (this._registrationPending)
            return this._registrationPending;
        if (this._registrationInitialized)
            return Promise.resolve();
        const generation = this._registrationGeneration;
        this.setData({ checking: true, errorText: '' });
        const promise = Promise.resolve().then(async () => {
            try {
                const result = await (0, api_1.request)('/user/minimum-registration', {
                    showError: false,
                    unauthorizedRedirect: `/pages/index/index?register=1&eventId=${encodeURIComponent(this.data.eventId)}`
                });
                if (!this.isRegistrationCurrent(scope, generation))
                    return;
                if (result.completed) {
                    this.returnToEvent();
                    return;
                }
                const photos = result.profile && Array.isArray(result.profile.photos) ? result.profile.photos : [];
                const photoFileId = photos[0] || (result.user && result.user.avatarUrl) || '';
                const displayUrls = await (0, local_image_1.resolveImageUrls)(photoFileId ? [photoFileId] : []);
                if (!this.isRegistrationCurrent(scope, generation))
                    return;
                this.setData({ phone: (result.user && result.user.phone) || '',
                    nickname: registrationName((result.profile && result.profile.realName) || (result.user && result.user.nickname)),
                    photoFileId, photoDisplayUrl: displayUrls[0] || photoFileId,
                    phoneStatus: result.phoneStatus === 'verified' ? 'verified' : 'filled' });
                this._registrationInitialized = true;
            }
            catch (err) {
                if (!this.isRegistrationCurrent(scope, generation)) {
                    if (!(0, page_session_1.pageSessionScope)())
                        this.synchronizeRegistrationSession();
                    return;
                }
                this.setData({ errorText: (0, api_1.apiErrorMessage)(err) || '报名资料暂时无法读取，请重试。' });
            }
            finally {
                if (this.isRegistrationCurrent(scope, generation))
                    this.setData({ checking: false });
                if (this._registrationPending === promise)
                    this._registrationPending = null;
            }
        });
        this._registrationPending = promise;
        return promise;
    },
    async login() {
        if (this.data.loading || (this.data.registrationMode && !this.data.eventId))
            return;
        this.setData({ loading: true, errorText: '' });
        try {
            await (0, auth_1.loginByWechat)('user');
            if (this._registrationUnloaded)
                return;
            if (this.data.registrationMode) {
                await this.loadRegistration();
                return;
            }
            wx.switchTab({ url: '/pages/user/members' });
        }
        catch (err) {
            console.warn('login failed', err);
            if (!this._registrationUnloaded)
                this.setData({ errorText: (0, api_1.apiErrorMessage)(err) || '微信登录失败，请重试。' });
        }
        finally {
            if (!this._registrationUnloaded)
                this.setData({ loading: false });
        }
    },
    onRegistrationPhone(e) {
        if (this.data.saving)
            return;
        this.setData({ phone: e.detail.value, phoneStatus: 'filled' });
    },
    retryRegistration() {
        if (this.data.saving || this.data.photoUploading || this.data.checking)
            return Promise.resolve();
        this._registrationInitialized = false;
        return this.loadRegistration();
    },
    onRegistrationName(e) {
        if (this.data.saving)
            return;
        this.setData({ nickname: e.detail.value });
    },
    async chooseRegistrationPhoto() {
        const scope = this.synchronizeRegistrationSession();
        if (!scope || this.data.photoUploading || this.data.saving || this.data.checking)
            return;
        const generation = this._registrationGeneration;
        this.setData({ photoUploading: true, errorText: '' });
        try {
            const images = await (0, local_image_1.chooseLocalImages)(1, { crop: true });
            if (!this.isRegistrationCurrent(scope, generation))
                return;
            const photo = images[0];
            if (photo)
                this.setData({ photoFileId: photo.fileID, photoDisplayUrl: photo.displayUrl });
        }
        catch (err) {
            if (this.isRegistrationCurrent(scope, generation) && !(0, local_image_1.isImageChooseCancel)(err)) {
                this.setData({ errorText: (0, api_1.apiErrorMessage)(err) || '照片上传失败，请重试。' });
            }
        }
        finally {
            if (this.isRegistrationCurrent(scope, generation))
                this.setData({ photoUploading: false });
        }
    },
    async saveRegistration() {
        const scope = this.synchronizeRegistrationSession();
        if (!scope || !this.data.eventId || this.data.saving || this.data.photoUploading || this.data.checking)
            return;
        const phone = String(this.data.phone || '').trim();
        const nickname = registrationName(this.data.nickname);
        const photo = this.data.photoFileId;
        const errorText = !/^1\d{10}$/.test(phone) ? '请填写有效的 11 位手机号。'
            : !nickname || nickname.length > 40 ? '请填写 1 至 40 个字的称呼。'
                : !/^cloud:\/\/\S+\/hl_uploads\/profile\/\S+$/.test(photo) ? '请上传一张本人照片。' : '';
        if (errorText) {
            this.setData({ errorText });
            return;
        }
        const generation = this._registrationGeneration;
        this.setData({ saving: true, errorText: '' });
        try {
            const result = await (0, api_1.request)('/user/minimum-registration', {
                method: 'PUT', showError: false, data: { phone, nickname, photos: [photo] },
                unauthorizedRedirect: `/pages/index/index?register=1&eventId=${encodeURIComponent(this.data.eventId)}`
            });
            if (!this.isRegistrationCurrent(scope, generation))
                return;
            if (!result.completed) {
                this.setData({ errorText: '报名资料尚未完整，请核对手机号、称呼和照片。' });
                return;
            }
            const user = { ...((0, api_1.currentUser)() || {}), ...result.user };
            getApp().globalData.user = user;
            wx.setStorageSync('user', user);
            this.returnToEvent();
        }
        catch (err) {
            if (this.isRegistrationCurrent(scope, generation)) {
                this.setData({ errorText: (0, api_1.apiErrorMessage)(err) || '报名资料保存失败，请重试。' });
            }
            else if (!(0, page_session_1.pageSessionScope)()) {
                this.synchronizeRegistrationSession();
            }
        }
        finally {
            if (this.isRegistrationCurrent(scope, generation))
                this.setData({ saving: false });
        }
    },
    returnToEvent() {
        if (this.data.eventId)
            wx.redirectTo({
                url: `/pages/user/salon-detail?id=${encodeURIComponent(this.data.eventId)}&registrationReady=1`
            });
    }
});
