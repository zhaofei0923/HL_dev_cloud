"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const salon_1 = require("../../services/salon");
const member_format_1 = require("../../utils/member-format");
const page_session_1 = require("../../utils/page-session");
Page({
    _generation: 0,
    _visible: false,
    data: { eventId: '', userId: '', member: null, loading: false, error: '' },
    onLoad(options) { this.setData({ eventId: options.eventId || '', userId: options.userId || '' }); },
    onShow() { this._visible = true; return this.load(); },
    onHide() { this._visible = false; this._generation += 1; this.setData({ member: null, loading: false }); },
    onUnload() { this.onHide(); },
    async load() {
        const scope = (0, page_session_1.pageSessionScope)();
        const generation = ++this._generation;
        this.setData({ member: null, loading: !!scope, error: '' });
        if (!scope) {
            wx.redirectTo({ url: `/pages/index/index?register=1&eventId=${encodeURIComponent(this.data.eventId)}` });
            return;
        }
        if (!/^\d+$/.test(this.data.eventId) || !/^[1-9]\d*$/.test(this.data.userId)) {
            this.setData({ loading: false, error: '报名人资料不存在。' });
            return;
        }
        try {
            const profile = await salon_1.salonApi.participantProfile(this.data.eventId, this.data.userId);
            if (this._visible && generation === this._generation && (0, page_session_1.pageSessionScope)() === scope)
                this.setData({ member: (0, member_format_1.normalizeMemberProfile)(profile) });
        }
        catch (error) {
            if (this._visible && generation === this._generation && (0, page_session_1.pageSessionScope)() === scope)
                this.setData({ member: null, error: '资料未开放，或你已不在本场报名名单中。' });
        }
        finally {
            if (this._visible && generation === this._generation && (0, page_session_1.pageSessionScope)() === scope)
                this.setData({ loading: false });
        }
    },
    goBack() { wx.navigateBack(); }
});
