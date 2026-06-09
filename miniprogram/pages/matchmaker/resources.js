"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const member_1 = require("../../services/member");
const member_format_1 = require("../../utils/member-format");
function normalizeResource(row) {
    return {
        ...(0, member_format_1.normalizeMemberProfile)(row),
        userIdText: String(row.userId || '')
    };
}
Page({
    data: {
        list: [],
        total: 0,
        myMembers: [],
        memberOptions: [],
        selectedMemberIndex: 0,
        primaryMemberName: '',
        recommendButtonText: '先录入自己的会员',
        accessNote: '已认证红娘可查看其他红娘的会员资源，并用自己的会员发起互推。',
        loading: false,
        recommendLoadingId: ''
    },
    onShow() {
        this.load();
    },
    async load() {
        this.setData({ loading: true });
        try {
            const resources = await member_1.memberApi.resources({ page: 1, pageSize: 50 });
            const own = await member_1.memberApi.list({ page: 1, pageSize: 20 });
            const list = (resources.list || []).map((row) => normalizeResource(row));
            const myMembers = own.list || [];
            const first = myMembers[0];
            const memberOptions = myMembers.map((item) => item.realName || item.nickname || '我的会员');
            this.setData({
                list,
                total: Number(resources.total || list.length || 0),
                myMembers,
                memberOptions,
                selectedMemberIndex: 0,
                primaryMemberName: first ? (first.realName || first.nickname || '我的会员') : '',
                recommendButtonText: first ? `用 ${first.realName || first.nickname || '我的会员'} 发起互推` : '先录入自己的会员',
                accessNote: '已为你整理可协作会员，可选择合适对象发起红娘协作。'
            });
        }
        catch (err) {
            console.warn('load matchmaker resources failed', err);
            this.setData({
                list: [],
                total: 0,
                myMembers: [],
                memberOptions: [],
                selectedMemberIndex: 0,
                primaryMemberName: '',
                recommendButtonText: '先录入自己的会员',
                accessNote: '暂无资源或尚未认证。认证后可查看其他红娘资源池。'
            });
        }
        finally {
            this.setData({ loading: false });
        }
    },
    onMemberChange(e) {
        const index = Number(e.detail.value || 0);
        const selected = this.data.myMembers[index];
        const name = selected ? (selected.realName || selected.nickname || '我的会员') : '';
        this.setData({
            selectedMemberIndex: index,
            primaryMemberName: name,
            recommendButtonText: selected ? `用 ${name} 发起互推` : '先录入自己的会员'
        });
    },
    async recommend(e) {
        const resourceUserId = e.currentTarget.dataset.userId;
        const myMember = this.data.myMembers[this.data.selectedMemberIndex];
        if (!myMember) {
            wx.showToast({ title: '请先录入自己的会员', icon: 'none' });
            return;
        }
        this.setData({ recommendLoadingId: String(resourceUserId) });
        try {
            await member_1.memberApi.recommend({
                myMemberId: myMember.id,
                resourceUserId,
                note: `${myMember.realName || myMember.nickname} 与对方条件较匹配`
            });
            wx.showToast({ title: '互推成功' });
        }
        catch (err) {
            console.warn('recommend member failed', err);
        }
        finally {
            this.setData({ recommendLoadingId: '' });
        }
    },
    openDetail(e) {
        const id = String(e.currentTarget.dataset.id || '');
        const member = this.data.list.find((item) => String(item.id) === id);
        if (!member)
            return;
        wx.setStorageSync('selectedMatchmakerMember', member);
        wx.navigateTo({ url: `/pages/matchmaker/member-detail?id=${id}&scope=resource` });
    }
});
