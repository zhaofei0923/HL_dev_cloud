"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const member_1 = require("../../services/member");
const member_format_1 = require("../../utils/member-format");
Page({
    data: {
        id: '',
        member: null,
        loading: false
    },
    onLoad(options) {
        this.setData({ id: String(options.id || '') });
        this.load();
    },
    async load() {
        if (!this.data.id)
            return;
        this.setData({ loading: true });
        try {
            const cached = wx.getStorageSync('selectedUserMember');
            if (cached && String(cached.id) === this.data.id) {
                this.setData({ member: (0, member_format_1.normalizeMemberProfile)(cached) });
                return;
            }
            const result = await member_1.memberApi.showcase({ page: 1, pageSize: 100 });
            const row = (result.list || []).find((item) => String(item.id) === this.data.id);
            this.setData({ member: row ? (0, member_format_1.normalizeMemberProfile)(row) : null });
        }
        catch (err) {
            console.warn('load user member detail failed', err);
            this.setData({ member: null });
        }
        finally {
            this.setData({ loading: false });
        }
    },
    goBack() {
        wx.navigateBack();
    },
    goProfile() {
        wx.navigateTo({ url: '/pages/user/profile' });
    }
});
