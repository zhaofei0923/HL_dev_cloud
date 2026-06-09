"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const member_1 = require("../../services/member");
const member_format_1 = require("../../utils/member-format");
function normalizeMember(row) {
    return (0, member_format_1.normalizeMemberProfile)(row);
}
Page({
    data: {
        keyword: '',
        city: '',
        gender: '',
        list: [],
        total: 0,
        countText: '正在整理会员资料',
        emptyTitle: '暂无匹配会员',
        emptyNote: '可以换个城市、职业或学历关键词再试。',
        loading: false
    },
    onShow() {
        this.load();
    },
    async load() {
        this.setData({ loading: true });
        try {
            const result = await member_1.memberApi.showcase({
                page: 1,
                pageSize: 50,
                keyword: this.data.keyword,
                city: this.data.city,
                gender: this.data.gender
            });
            this.setData({
                list: (result.list || []).map((row) => normalizeMember(row)),
                total: result.total || 0,
                countText: `${result.total || 0} 位会员可浏览`,
                emptyTitle: this.hasFilters() ? '暂无匹配会员' : '暂无可展示会员',
                emptyNote: this.hasFilters() ? '可以调整城市、性别或关键词后再试。' : '红娘精选会员资料后会在这里展示脱敏信息。'
            });
        }
        catch (err) {
            console.warn('load user members failed', err);
            this.setData({
                list: [],
                total: 0,
                countText: '云服务暂不可用',
                emptyTitle: '数据暂不可用',
                emptyNote: '请确认 hlApi 云函数已部署后重试。'
            });
        }
        finally {
            this.setData({ loading: false });
        }
    },
    onKeyword(e) {
        this.setData({ keyword: e.detail.value });
    },
    onCity(e) {
        this.setData({ city: e.detail.value });
    },
    setGender(e) {
        this.setData({ gender: String(e.currentTarget.dataset.gender || '') });
        this.load();
    },
    hasFilters() {
        return !!(this.data.keyword || this.data.city || this.data.gender);
    },
    search() {
        this.load();
    },
    clearKeyword() {
        this.setData({ keyword: '', city: '', gender: '' });
        this.load();
    },
    goProfile() {
        wx.navigateTo({ url: '/pages/user/profile' });
    },
    openDetail(e) {
        const id = String(e.currentTarget.dataset.id || '');
        const member = this.data.list.find((item) => String(item.id) === id);
        if (!member)
            return;
        wx.setStorageSync('selectedUserMember', member);
        wx.navigateTo({ url: `/pages/user/member-detail?id=${id}` });
    }
});
