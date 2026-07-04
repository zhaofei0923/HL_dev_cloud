"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const member_1 = require("../../services/member");
const chat_1 = require("../../services/chat");
const member_format_1 = require("../../utils/member-format");
Page({
    data: {
        id: '',
        member: null,
        loading: false,
        chatStarting: false
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
    },
    async startChat() {
        const member = this.data.member;
        const memberId = String(member && member.id ? member.id : '');
        if (!/^\d+$/.test(memberId)) {
            wx.showToast({ title: '配对后才能聊天', icon: 'none' });
            return;
        }
        if (this.data.chatStarting)
            return;
        this.setData({ chatStarting: true });
        try {
            const conversation = await chat_1.chatApi.getOrCreateConversation({ targetMemberId: memberId });
            wx.navigateTo({ url: `/pages/user/chat?id=${conversation.id}` });
        }
        catch (err) {
            console.warn('start user chat failed', err);
        }
        finally {
            this.setData({ chatStarting: false });
        }
    }
});
