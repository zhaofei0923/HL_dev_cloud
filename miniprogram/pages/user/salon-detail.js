"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const salon_1 = require("../../services/salon");
const page_session_1 = require("../../utils/page-session");
const salon_availability_1 = require("../../utils/salon-availability");
const CONSENT_NOTE = '报名后称呼和照片显示在名单，资料仅本场已报名者及活动组织者可查看，手机号不会公开。';
function formatDate(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime()))
        return '时间待确认';
    const pad = (part) => String(part).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function normalizeEvent(event) {
    const availability = (0, salon_availability_1.salonAvailability)(event);
    const registered = event.isRegistered === true || event.registrationStatus === 'registered';
    const max = Number(event.maxParticipants || 0), count = Number(event.currentParticipants || 0), price = Number(event.price || 0);
    let primaryAction = { type: 'register', text: '立即报名', className: 'gold', disabled: false, note: CONSENT_NOTE };
    if (availability.blockedReason && availability.blockedReason !== 'full') {
        primaryAction = { type: 'disabled', text: availability.statusText, className: 'secondary', disabled: true, note: '该活动无法报名，请选择其他活动。' };
    }
    else if (registered) {
        primaryAction = { type: 'cancel', text: '取消报名', className: 'danger', disabled: false, note: '取消报名后，将不能继续查看本场报名人的资料。' };
    }
    else if (availability.full) {
        primaryAction = { type: 'disabled', text: '席位已满', className: 'secondary', disabled: true, note: '该活动名额已满，请选择其他活动。' };
    }
    else if (event.registrationRequirements?.complete === false) {
        primaryAction = { type: 'complete', text: '完善资料后报名', className: 'gold', disabled: false, note: `先填写手机号、称呼并上传照片。${CONSENT_NOTE}` };
    }
    return {
        id: event.id, title: event.title || '精选沙龙', description: event.description,
        location: event.location, eventDate: event.eventDate, status: event.status,
        maxParticipants: max, currentParticipants: count, price,
        isRegistered: registered, isOrganizer: event.isOrganizer === true,
        registrationRequirements: event.registrationRequirements,
        isExpired: availability.expired, isFull: availability.full, canRegister: availability.canRegister,
        registrationBlockedReason: availability.blockedReason,
        eventDateText: formatDate(event.eventDate || ''), locationText: event.location || '地点待定',
        descriptionText: event.description || '主理人精选线下活动，适合轻松交流和初步了解。',
        statusText: availability.statusText,
        participantText: max > 0 ? `${count}/${max} 人` : `${count} 人报名`,
        seatHint: availability.canRegister ? (max > 0 ? `剩余 ${Math.max(max - count, 0)} 个席位` : '席位不限') : availability.statusText,
        priceText: price > 0 ? `¥${price}` : '免费', primaryAction
    };
}
Page({
    _generation: 0, _actionGeneration: 0, _session: '', _visible: false,
    _expiryTimer: null,
    data: {
        id: '', event: null,
        shareCard: { canShare: false, title: '', sharePath: '' },
        participants: [], participantPage: 0, participantTotal: 0,
        participantsLoading: false, participantsError: '',
        participantNote: '登录后可查看报名名单；资料仅本场已报名者及活动组织者可查看。',
        loading: false, shareLoading: false, actionLoading: false, error: ''
    },
    onLoad(options) { this.setData({ id: String(options.id || options.eventId || '') }); },
    onShow() { this._visible = true; return this.load(); },
    onHide() { this._visible = false; this._generation += 1; this._actionGeneration += 1; this.clearExpiryTimer(); this.setData({ actionLoading: false, shareLoading: false, participantsLoading: false }); },
    onUnload() { this.onHide(); },
    clearExpiryTimer() { if (this._expiryTimer !== null)
        clearTimeout(this._expiryTimer); this._expiryTimer = null; },
    ensureSession() {
        const scope = (0, page_session_1.pageSessionScope)();
        if (scope !== this._session) {
            this._session = scope;
            this._generation += 1;
            this._actionGeneration += 1;
            this.setData({ event: null, participants: [], participantPage: 0, participantTotal: 0, participantsError: '', shareCard: { canShare: false, title: '', sharePath: '' }, actionLoading: false });
        }
        if (!scope)
            this.completeRegistration();
        return scope;
    },
    isCurrent(generation, scope) { return this._visible && generation === this._generation && (0, page_session_1.pageSessionScope)() === scope; },
    async load() {
        const scope = this.ensureSession();
        if (!scope || !this.data.id)
            return;
        const generation = ++this._generation;
        this.clearExpiryTimer();
        this.setData({ loading: true, error: '', event: null, participants: [], participantPage: 0 });
        const participants = this.loadParticipants(1, generation, scope);
        try {
            const event = await salon_1.salonApi.detail(this.data.id);
            if (!this.isCurrent(generation, scope))
                return;
            this.setData({ event: normalizeEvent(event), loading: false });
            this.scheduleExpiry(generation, scope);
            if ((event.isRegistered || event.isOrganizer) && (0, salon_availability_1.salonAvailability)(event).canRegister)
                void this.loadShareCard(generation, scope);
            else
                this.setData({ shareCard: { canShare: false, title: '', sharePath: '' } });
        }
        catch (error) {
            if (this.isCurrent(generation, scope))
                this.setData({ event: null, error: '活动暂时无法读取，请重试。' });
        }
        finally {
            if (this.isCurrent(generation, scope))
                this.setData({ loading: false });
            await participants;
        }
    },
    scheduleExpiry(generation, scope) {
        const event = this.data.event;
        if (!event || event.isExpired)
            return;
        const delay = new Date(event.eventDate || '').getTime() - Date.now();
        if (!Number.isFinite(delay) || delay <= 0)
            return;
        this._expiryTimer = setTimeout(() => {
            if (!this.isCurrent(generation, scope) || !this.data.event)
                return;
            this.setData({ event: normalizeEvent(this.data.event), shareCard: { canShare: false, title: '', sharePath: '' } });
            this.scheduleExpiry(generation, scope);
        }, Math.min(delay + 10, 2147483647));
    },
    async loadParticipants(page = 1, generation, scope) {
        const requestGeneration = generation ?? this._generation;
        const requestScope = scope ?? this._session;
        if (!requestScope || !this.data.id)
            return;
        this.setData({ participantsLoading: true, participantsError: '' });
        try {
            const result = await salon_1.salonApi.participants(this.data.id, page);
            if (!this.isCurrent(requestGeneration, requestScope))
                return;
            const previous = page === 1 ? [] : this.data.participants;
            const seen = new Set(previous.map((row) => row.userId));
            const list = previous.concat(result.list.filter(row => !seen.has(row.userId)));
            this.setData({ participants: list, participantPage: page, participantTotal: result.total,
                participantNote: result.visibilityNote || '登录后可查看报名名单；资料仅本场已报名者及活动组织者可查看。' });
        }
        catch (error) {
            if (this.isCurrent(requestGeneration, requestScope))
                this.setData({ participantsError: '报名名单暂时无法读取，请重试。' });
        }
        finally {
            if (this.isCurrent(requestGeneration, requestScope))
                this.setData({ participantsLoading: false });
        }
    },
    loadMoreParticipants() { if (!this.data.participantsLoading)
        return this.loadParticipants(this.data.participantPage + 1); },
    retryParticipants() { return this.loadParticipants(1); },
    openParticipant(e) {
        const userId = Number(e.currentTarget.dataset.userId);
        const row = this.data.participants.find((person) => person.userId === userId);
        if (!row || !this.ensureSession())
            return;
        if (!row.canViewProfile) {
            wx.showToast({ title: '本场报名后，可查看已开放的资料', icon: 'none' });
            return;
        }
        wx.navigateTo({ url: `/pages/user/salon-participant?eventId=${encodeURIComponent(this.data.id)}&userId=${userId}` });
    },
    completeRegistration() { wx.redirectTo({ url: `/pages/index/index?register=1&eventId=${encodeURIComponent(this.data.id)}` }); },
    async loadShareCard(generation, scope) {
        const requestGeneration = generation ?? this._generation;
        const requestScope = scope ?? this._session;
        this.setData({ shareLoading: true });
        try {
            const card = await salon_1.salonApi.shareCard(this.data.id, false);
            if (this.isCurrent(requestGeneration, requestScope) && this.data.event
                && (0, salon_availability_1.salonAvailability)(this.data.event).canRegister)
                this.setData({ shareCard: card });
        }
        catch (error) {
            if (this.isCurrent(requestGeneration, requestScope))
                this.setData({ shareCard: { canShare: false, title: '', sharePath: '' } });
        }
        finally {
            if (this.isCurrent(requestGeneration, requestScope))
                this.setData({ shareLoading: false });
        }
    },
    async register() {
        const event = this.data.event;
        if (!event || this.data.actionLoading || !(0, salon_availability_1.salonAvailability)(event).canRegister || !this.ensureSession())
            return;
        const scope = this._session;
        const actionGeneration = ++this._actionGeneration;
        this.setData({ actionLoading: true });
        try {
            await salon_1.salonApi.register(this.data.id);
            if ((0, page_session_1.pageSessionScope)() !== scope || !this._visible || actionGeneration !== this._actionGeneration)
                return;
            wx.showToast({ title: '报名成功' });
            await this.load();
        }
        catch (error) {
            if ((0, page_session_1.pageSessionScope)() === scope && this._visible && actionGeneration === this._actionGeneration)
                await this.load();
        }
        finally {
            if ((0, page_session_1.pageSessionScope)() === scope && this._visible && actionGeneration === this._actionGeneration)
                this.setData({ actionLoading: false });
        }
    },
    async cancel() {
        if (this.data.actionLoading || !this.ensureSession())
            return;
        const scope = this._session;
        const actionGeneration = ++this._actionGeneration;
        this.setData({ actionLoading: true });
        try {
            await salon_1.salonApi.cancelRegistration(this.data.id);
            if ((0, page_session_1.pageSessionScope)() !== scope || !this._visible || actionGeneration !== this._actionGeneration)
                return;
            wx.showToast({ title: '已取消' });
            await this.load();
        }
        catch (error) {
            if ((0, page_session_1.pageSessionScope)() === scope && this._visible && actionGeneration === this._actionGeneration)
                await this.load();
        }
        finally {
            if ((0, page_session_1.pageSessionScope)() === scope && this._visible && actionGeneration === this._actionGeneration)
                this.setData({ actionLoading: false });
        }
    },
    primaryAction() {
        if (!this.data.event || this.data.actionLoading)
            return;
        const event = normalizeEvent(this.data.event);
        this.setData({ event });
        if (event.primaryAction.disabled)
            return;
        if (event.primaryAction.type === 'complete')
            return this.completeRegistration();
        return event.primaryAction.type === 'cancel' ? this.cancel() : this.register();
    },
    onPullDownRefresh() { return this.load().finally(() => wx.stopPullDownRefresh()); },
    onShareAppMessage() { return { title: `邀请你参加沙龙《${this.data.event?.title || '精选沙龙'}》`, path: `/pages/user/salon-detail?id=${encodeURIComponent(this.data.id)}&source=salonShare` }; }
});
