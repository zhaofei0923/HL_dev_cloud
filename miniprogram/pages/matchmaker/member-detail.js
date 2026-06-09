"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const member_1 = require("../../services/member");
const member_format_1 = require("../../utils/member-format");
Page({
    data: {
        id: '',
        scope: 'own',
        isOwn: true,
        member: null,
        loading: false
    },
    onLoad(options) {
        const scope = options.scope === 'resource' ? 'resource' : 'own';
        this.setData({
            id: String(options.id || ''),
            scope,
            isOwn: scope === 'own'
        });
        this.load();
    },
    async load() {
        if (!this.data.id)
            return;
        this.setData({ loading: true });
        try {
            const cached = wx.getStorageSync('selectedMatchmakerMember');
            if (cached && String(cached.id) === this.data.id) {
                this.setData({ member: (0, member_format_1.normalizeMemberProfile)(cached, this.data.isOwn) });
                return;
            }
            const result = this.data.isOwn
                ? await member_1.memberApi.list({ page: 1, pageSize: 100 })
                : await member_1.memberApi.resources({ page: 1, pageSize: 100 });
            const row = (result.list || []).find((item) => String(item.id) === this.data.id);
            this.setData({ member: row ? (0, member_format_1.normalizeMemberProfile)(row, this.data.isOwn) : null });
        }
        catch (err) {
            console.warn('load matchmaker member detail failed', err);
            this.setData({ member: null });
        }
        finally {
            this.setData({ loading: false });
        }
    },
    goBack() {
        wx.navigateBack();
    }
});
