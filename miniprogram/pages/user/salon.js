"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const salon_1 = require("../../services/salon");
function pad(value) {
    return value < 10 ? `0${value}` : String(value);
}
function formatDate(value) {
    if (!value)
        return '时间待定';
    const date = new Date(value);
    if (isNaN(date.getTime()))
        return value;
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function normalizeSalonRow(row) {
    const event = row.event || row;
    const maxParticipants = Number(event.maxParticipants || 0);
    const currentParticipants = Number(event.currentParticipants || 0);
    const price = Number(event.price || 0);
    const registered = row.status === 'registered';
    const status = registered ? '已报名' : (event.status === 'upcoming' ? '报名中' : (event.status || '待定'));
    return {
        id: event.id || row.eventId || row.id,
        title: event.title || '精选沙龙',
        description: event.description || '红娘精选线下活动，适合轻松交流和初步了解。',
        location: event.location || '地点待定',
        eventDate: formatDate(event.eventDate || ''),
        statusText: status,
        participantText: maxParticipants > 0 ? `${currentParticipants}/${maxParticipants} 人` : `${currentParticipants} 人报名`,
        seatText: maxParticipants > 0 ? `剩余 ${Math.max(maxParticipants - currentParticipants, 0)} 席` : '席位不限',
        priceText: price > 0 ? `¥${price}` : '免费',
        raw: event
    };
}
Page({
    data: {
        active: 'all',
        list: [],
        loading: false,
        listTitle: '近期精选',
        listNote: '点击活动卡片查看详情和报名。'
    },
    onShow() {
        this.loadAll();
    },
    async loadAll() {
        this.setData({ active: 'all', loading: true });
        try {
            const result = await salon_1.salonApi.list({ page: 1, pageSize: 30 });
            const list = (result.list || []).map((row) => normalizeSalonRow(row));
            this.setData({ list, listTitle: '近期精选', listNote: '点击活动卡片查看详情和报名。' });
        }
        catch (err) {
            console.warn('load salon list failed', err);
            this.setData({
                list: [],
                listTitle: '云服务暂不可用',
                listNote: '请确认 hlApi 云函数已部署后重试。'
            });
        }
        finally {
            this.setData({ loading: false });
        }
    },
    async loadMine() {
        this.setData({ active: 'mine', loading: true });
        try {
            const result = await salon_1.salonApi.myRegistrations({ page: 1, pageSize: 30 });
            const list = (result.list || []).map((row) => normalizeSalonRow(row));
            this.setData({ list, listTitle: '我的报名', listNote: '已报名活动会显示在这里。' });
        }
        catch (err) {
            console.warn('load my salon registrations failed', err);
            this.setData({
                list: [],
                listTitle: '云服务暂不可用',
                listNote: '请确认 hlApi 云函数已部署后重试。'
            });
        }
        finally {
            this.setData({ loading: false });
        }
    },
    openDetail(e) {
        const id = e.currentTarget.dataset.id;
        if (id)
            wx.navigateTo({ url: `/pages/user/salon-detail?id=${id}` });
    }
});
