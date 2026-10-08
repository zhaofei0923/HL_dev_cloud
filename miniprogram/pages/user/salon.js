"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const salon_1 = require("../../services/salon");
const page_session_1 = require("../../utils/page-session");
const user_navigation_1 = require("../../utils/user-navigation");
const salon_availability_1 = require("../../utils/salon-availability");
const SALON_TTL_MS = 30 * 1000;
function pad(value) {
    return value < 10 ? `0${value}` : String(value);
}
function formatDate(value) {
    if (!value)
        return '时间待定';
    const date = new Date(value);
    if (isNaN(date.getTime()))
        return value;
    const weekday = ['日', '一', '二', '三', '四', '五', '六'][date.getDay()];
    return `${date.getMonth() + 1}月${date.getDate()}日 周${weekday} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function normalizeSalonRow(row) {
    const event = row.event || row;
    const maxParticipants = Number(event.maxParticipants || 0);
    const currentParticipants = Number(event.currentParticipants || 0);
    const price = Number(event.price || 0);
    const registered = row.status === 'registered' || row.registered === true;
    const availability = (0, salon_availability_1.salonAvailability)(event);
    const status = registered ? `${availability.statusText} · 已报名` : availability.statusText;
    return {
        id: event.id || row.eventId || row.id,
        title: event.title || '精选沙龙',
        description: event.description || '主理人精选线下活动，适合轻松交流和初步了解。',
        location: event.location || '地点待定',
        eventDate: formatDate(event.eventDate || ''),
        statusText: status,
        participantText: maxParticipants > 0 ? `${currentParticipants}/${maxParticipants} 人` : `${currentParticipants} 人报名`,
        seatText: availability.canRegister
            ? (maxParticipants > 0 ? `剩余 ${Math.max(maxParticipants - currentParticipants, 0)} 席` : '席位不限')
            : availability.statusText,
        priceText: price > 0 ? `¥${price}` : '免费',
        isPast: availability.expired || event.status === 'ended' || event.status === 'cancelled',
        raw: event,
        registered
    };
}
function visibleSalons(rows, active) {
    if (active === 'mine')
        return rows;
    return rows.filter(row => active === 'past' ? row.isPast : !row.isPast)
        .sort((a, b) => {
        const left = new Date(a.raw.eventDate || '').getTime() || 0;
        const right = new Date(b.raw.eventDate || '').getTime() || 0;
        return active === 'past' ? right - left : left - right;
    });
}
Page({
    _sessionScope: '',
    _salonGeneration: 0,
    _salonSnapshots: {},
    _salonPending: null,
    _refreshOnShow: false,
    data: {
        active: 'all',
        list: [],
        loading: false,
        listTitle: '即将开始',
        listNote: '点击活动卡片查看详情和报名。'
    },
    onShow() {
        if (!this.synchronizeSession())
            return;
        (0, user_navigation_1.syncUserTabBar)(this, 'salon');
        const force = this._refreshOnShow;
        this._refreshOnShow = false;
        return this.loadSalons(this.data.active, force);
    },
    synchronizeSession() {
        const scope = (0, page_session_1.pageSessionScope)();
        if (scope !== this._sessionScope) {
            this._sessionScope = scope;
            this._salonGeneration += 1;
            this._salonSnapshots = {};
            this._salonPending = null;
            this.setData({ active: 'all', list: [], loading: false, listTitle: '即将开始', listNote: '点击活动卡片查看详情和报名。' });
        }
        if (scope)
            return scope;
        wx.redirectTo({ url: '/pages/index/index' });
        return '';
    },
    loadAll() {
        return this.loadSalons('all', true);
    },
    loadMine() {
        return this.loadSalons('mine', true);
    },
    loadPast() {
        return this.loadSalons('past', true);
    },
    loadSalons(active, force = false) {
        const scope = this.synchronizeSession();
        if (!scope)
            return Promise.resolve();
        if (!force && this._salonPending && this._salonPending.key === active && this.data.active === active) {
            return this._salonPending.promise;
        }
        this._salonPending = null;
        const generation = ++this._salonGeneration;
        const cached = this._salonSnapshots[active];
        const listTitle = active === 'mine' ? '我的报名' : active === 'past' ? '往期活动' : '即将开始';
        const listNote = active === 'mine' ? '已报名活动会显示在这里。' : active === 'past' ? '查看已结束或取消的活动。' : '点击活动卡片查看详情和报名。';
        const cachedList = cached ? cached.list.map((row) => normalizeSalonRow({ event: row.raw, registered: row.registered })) : [];
        this.setData({ active, list: visibleSalons(cachedList, active), listTitle, listNote, loading: !cached });
        const isCurrent = () => this._salonGeneration === generation && (0, page_session_1.pageSessionScope)() === scope;
        if (cached && !force && Date.now() - cached.loadedAt < SALON_TTL_MS)
            return Promise.resolve();
        const promise = Promise.resolve().then(async () => {
            try {
                const result = active === 'mine'
                    ? await salon_1.salonApi.myRegistrations({ page: 1, pageSize: 30 })
                    : await salon_1.salonApi.list({ page: 1, pageSize: 30, period: active === 'past' ? 'past' : 'upcoming' });
                if (!isCurrent())
                    return;
                const list = (result.list || []).map((row) => normalizeSalonRow(row));
                this._salonSnapshots[active] = { list, loadedAt: Date.now() };
                this.setData({ list: visibleSalons(list, active), listTitle, listNote });
            }
            catch (err) {
                if (!isCurrent())
                    return;
                console.warn('load salons failed', err);
                if (cached) {
                    cached.loadedAt = 0;
                    this.setData({ listNote: '暂未更新成功，下拉可重试。' });
                }
                else {
                    this.setData({ list: [], listTitle: '云服务暂不可用', listNote: '请稍后下拉刷新重试。' });
                }
            }
            finally {
                if (isCurrent()) {
                    this._salonPending = null;
                    this.setData({ loading: false });
                }
            }
        });
        this._salonPending = { key: active, promise };
        return promise;
    },
    onPullDownRefresh() {
        return this.loadSalons(this.data.active, true).finally(() => wx.stopPullDownRefresh());
    },
    onUnload() {
        this._salonGeneration += 1;
        this._salonPending = null;
    },
    openDetail(e) {
        const id = e.currentTarget.dataset.id;
        if (id) {
            this._refreshOnShow = true;
            wx.navigateTo({ url: `/pages/user/salon-detail?id=${id}` });
        }
    }
});
