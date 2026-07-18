"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const member_1 = require("../../services/member");
const member_format_1 = require("../../utils/member-format");
const SWIPE_DISTANCE = 56;
let touchStartX = 0;
let touchStartY = 0;
let actionEffectTimer = null;
let actionAdvanceTimer = null;
function clearActionTimers() {
    if (actionEffectTimer !== null) {
        clearTimeout(actionEffectTimer);
        actionEffectTimer = null;
    }
    if (actionAdvanceTimer !== null) {
        clearTimeout(actionAdvanceTimer);
        actionAdvanceTimer = null;
    }
}
function compactList(values) {
    return values.map(value => String(value || '').trim()).filter(Boolean);
}
function textWithUnit(value, unit, fallback) {
    const text = String(value || '').trim();
    if (!text)
        return fallback;
    return text.indexOf(unit) >= 0 ? text : `${text}${unit}`;
}
function truncateText(value, limit) {
    const text = String(value || '').trim();
    if (!text)
        return '';
    return text.length > limit ? `${text.slice(0, limit)}...` : text;
}
function uniqueLocationParts(city, nativePlace) {
    const cityText = String(city || '').trim();
    const nativeText = String(nativePlace || '').trim();
    if (!cityText)
        return compactList([nativeText]);
    if (!nativeText || nativeText === cityText || nativeText.indexOf(cityText) >= 0 || cityText.indexOf(nativeText) >= 0) {
        return [cityText];
    }
    return [cityText, nativeText];
}
function normalizeMember(row) {
    const member = (0, member_format_1.normalizeMemberProfile)(row);
    const viewerState = row.viewerState && typeof row.viewerState === 'object' ? row.viewerState : {};
    const ageText = textWithUnit(row.age, '岁', '年龄保密');
    const heightText = textWithUnit(row.height, 'cm', '');
    const city = String(member.cityText || row.city || row.province || '').trim();
    const education = String(row.education || '').trim();
    const occupation = String(row.occupation || '').trim();
    const income = String(row.incomeRange || '').trim();
    const primaryMeta = uniqueLocationParts(city, row.nativePlace).join(' · ') || member.metaText;
    const profileLine = compactList([heightText, education, occupation]).join(' · ') || member.workText;
    const cardTags = compactList([city, education, occupation, income]).slice(0, 3);
    const partnerPreview = truncateText(row.partnerRequirement || member.partnerText, 44);
    const introPreview = truncateText(row.selfIntro || member.introText, 42);
    return {
        ...member,
        userId: row.userId,
        ageText,
        primaryMeta,
        profileLine,
        cardTags,
        partnerPreview,
        introPreview,
        isFavorite: !!viewerState.isFavorite,
        statusText: row.memberType === 'vip' ? 'VIP精选' : '真人认证'
    };
}
function normalizeGifts(result) {
    if (!Array.isArray(result))
        return [];
    return result.map(item => {
        const row = item;
        return {
            id: String(row.id || ''),
            name: String(row.name || ''),
            description: String(row.description || ''),
            symbol: String(row.symbol || row.name || '').slice(0, 1),
            tone: String(row.tone || 'rose')
        };
    }).filter(item => item.id && item.name);
}
function normalizeFavoriteQuota(value) {
    if (!value || typeof value !== 'object')
        return null;
    const row = value;
    const limit = Number(row.limit);
    const used = Number(row.used);
    const remaining = Number(row.remaining);
    if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(used) || !Number.isFinite(remaining))
        return null;
    return {
        dateKey: String(row.dateKey || ''),
        limit,
        used: Math.max(used, 0),
        remaining: Math.max(remaining, 0)
    };
}
function favoriteQuotaText(quota) {
    if (!quota)
        return '';
    return `今日免费爱心 ${quota.remaining}/${quota.limit}`;
}
function safeIndex(list, index) {
    if (!list.length)
        return 0;
    const normalized = Number(index) || 0;
    return ((normalized % list.length) + list.length) % list.length;
}
function selectionState(list, index) {
    const currentIndex = safeIndex(list, index);
    return {
        currentIndex,
        currentMember: list[currentIndex] || null,
        positionText: list.length ? `${currentIndex + 1}/${list.length}` : ''
    };
}
function memberTarget(member) {
    if (!member || !member.userId)
        return null;
    return {
        targetUserId: member.userId,
        targetMemberId: member.id
    };
}
function countText(total) {
    return total ? `${total} 位会员可浏览 · 左右滑切换 · 下滑看详情` : '暂无可浏览会员';
}
Page({
    data: {
        keyword: '',
        city: '',
        gender: '',
        filterOpen: false,
        list: [],
        currentIndex: 0,
        currentMember: null,
        positionText: '',
        total: 0,
        countText: '正在整理会员资料',
        emptyTitle: '暂无可推荐会员',
        emptyNote: '可以调整筛选条件，或稍后再查看红娘精选的公开会员。',
        gifts: [],
        giftPanelOpen: false,
        giftLoading: false,
        favoriteLoading: false,
        hideLoading: false,
        sendingGiftId: '',
        actionEffect: '',
        actionAnimating: false,
        favoriteQuota: null,
        favoriteQuotaText: '',
        loading: false
    },
    onShow() {
        const token = wx.getStorageSync('token');
        if (!token) {
            wx.redirectTo({ url: '/pages/index/index' });
            return;
        }
        this.load();
    },
    onUnload() {
        clearActionTimers();
    },
    async load() {
        this.setData({ loading: true });
        try {
            const [result] = await Promise.all([
                member_1.memberApi.showcase({
                    page: 1,
                    pageSize: 50,
                    keyword: this.data.keyword,
                    city: this.data.city,
                    gender: this.data.gender
                }),
                this.loadGifts()
            ]);
            const data = result;
            const list = (data.list || []).map(row => normalizeMember(row));
            const total = data.total || list.length;
            const favoriteQuota = normalizeFavoriteQuota(data.favoriteQuota);
            this.setData({
                list,
                ...selectionState(list, 0),
                total,
                countText: countText(total),
                favoriteQuota,
                favoriteQuotaText: favoriteQuotaText(favoriteQuota),
                emptyTitle: this.hasFilters() ? '暂无匹配会员' : '暂无可推荐会员',
                emptyNote: this.hasFilters()
                    ? '可以调整城市、性别或关键词后再试。'
                    : '红娘精选会员资料后，会在这里展示脱敏信息。'
            });
        }
        catch (err) {
            console.warn('load user members failed', err);
            this.setData({
                list: [],
                ...selectionState([], 0),
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
    async loadGifts(force = false) {
        if (this.data.gifts.length && !force)
            return this.data.gifts;
        this.setData({ giftLoading: true });
        try {
            const gifts = normalizeGifts(await member_1.memberApi.gifts());
            this.setData({ gifts });
            return gifts;
        }
        finally {
            this.setData({ giftLoading: false });
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
    },
    toggleFilter() {
        this.setData({ filterOpen: !this.data.filterOpen });
    },
    hasFilters() {
        return !!(this.data.keyword || this.data.city || this.data.gender);
    },
    search() {
        this.setData({ filterOpen: false });
        this.load();
    },
    clearKeyword() {
        this.setData({ keyword: '', city: '', gender: '', filterOpen: false });
        this.load();
    },
    nextMember() {
        if (!this.data.list.length || this.data.actionAnimating)
            return;
        this.setData(selectionState(this.data.list, this.data.currentIndex + 1));
    },
    previousMember() {
        if (!this.data.list.length || this.data.actionAnimating)
            return;
        this.setData(selectionState(this.data.list, this.data.currentIndex - 1));
    },
    onCardTouchStart(e) {
        const touch = e.touches && e.touches[0];
        if (!touch)
            return;
        touchStartX = touch.clientX;
        touchStartY = touch.clientY;
    },
    onCardTouchEnd(e) {
        const touch = e.changedTouches && e.changedTouches[0];
        if (!touch || !this.data.list.length || this.data.actionAnimating)
            return;
        const deltaX = touch.clientX - touchStartX;
        const deltaY = touch.clientY - touchStartY;
        const absX = Math.abs(deltaX);
        const absY = Math.abs(deltaY);
        const isHorizontalSwipe = absX >= SWIPE_DISTANCE && absX >= absY;
        if (!isHorizontalSwipe)
            return;
        if (deltaX < 0) {
            this.nextMember();
            return;
        }
        this.previousMember();
    },
    runActionEffect(type, finish) {
        clearActionTimers();
        this.setData({ actionEffect: type, actionAnimating: true });
        actionAdvanceTimer = setTimeout(() => {
            if (actionEffectTimer !== null) {
                clearTimeout(actionEffectTimer);
                actionEffectTimer = null;
            }
            finish();
            this.setData({ actionEffect: '', actionAnimating: false });
            actionAdvanceTimer = null;
        }, 460);
        actionEffectTimer = setTimeout(() => {
            this.setData({ actionEffect: '' });
            actionEffectTimer = null;
        }, 640);
    },
    setCurrentFavoriteAndAdvance(active, currentIndex, effect, extraState = {}) {
        const list = this.data.list.map((item, index) => (index === currentIndex ? { ...item, isFavorite: active } : item));
        if (this.data.giftPanelOpen) {
            this.setData({ giftPanelOpen: false });
        }
        this.runActionEffect(effect, () => {
            this.setData({
                list,
                ...selectionState(list, currentIndex + 1),
                ...extraState,
                giftPanelOpen: false
            });
        });
    },
    async toggleFavorite() {
        if (this.data.favoriteLoading || this.data.hideLoading || this.data.actionAnimating)
            return;
        const member = this.data.currentMember;
        const target = memberTarget(member);
        if (!member || !target) {
            wx.showToast({ title: '暂无法关注该会员', icon: 'none' });
            return;
        }
        const currentIndex = this.data.currentIndex;
        this.setData({ favoriteLoading: true });
        try {
            const result = await member_1.memberApi.interact({ ...target, actionType: 'favorite', active: true });
            const favoriteQuota = normalizeFavoriteQuota(result && result.favoriteQuota);
            this.setCurrentFavoriteAndAdvance(true, currentIndex, 'heart', favoriteQuota ? {
                favoriteQuota,
                favoriteQuotaText: favoriteQuotaText(favoriteQuota)
            } : {});
            wx.showToast({
                title: result && result.mutualFavorite
                    ? (result.canChat ? '已互相喜欢，可在消息里聊天' : '已互相喜欢，开通会员后可聊天')
                    : '已关注，对方会收到通知',
                icon: 'none'
            });
        }
        catch (err) {
            console.warn('toggle favorite failed', err);
        }
        finally {
            this.setData({ favoriteLoading: false });
        }
    },
    async hideCurrent() {
        if (this.data.hideLoading || this.data.favoriteLoading || this.data.actionAnimating)
            return;
        const member = this.data.currentMember;
        const target = memberTarget(member);
        if (!target) {
            wx.showToast({ title: '暂无法处理该会员', icon: 'none' });
            return;
        }
        const currentIndex = this.data.currentIndex;
        this.setData({ hideLoading: true });
        try {
            await member_1.memberApi.interact({ ...target, actionType: 'hide', active: true });
            const list = this.data.list.filter((_, index) => index !== currentIndex);
            const total = Math.max(Number(this.data.total || this.data.list.length) - 1, 0);
            this.runActionEffect('hide', () => {
                this.setData({
                    list,
                    ...selectionState(list, currentIndex),
                    total,
                    countText: countText(total),
                    giftPanelOpen: false
                });
            });
            wx.showToast({ title: '已减少此类推荐', icon: 'none' });
        }
        catch (err) {
            console.warn('hide member failed', err);
        }
        finally {
            this.setData({ hideLoading: false });
        }
    },
    async openGiftPanel() {
        if (this.data.giftLoading || this.data.hideLoading || this.data.actionAnimating)
            return;
        const target = memberTarget(this.data.currentMember);
        if (!target) {
            wx.showToast({ title: '暂无法赠送礼物', icon: 'none' });
            return;
        }
        this.setData({ giftPanelOpen: true });
        try {
            await this.loadGifts();
        }
        catch (err) {
            console.warn('load gifts failed', err);
            wx.showToast({ title: '礼品库暂不可用', icon: 'none' });
        }
    },
    closeGiftPanel() {
        if (this.data.sendingGiftId)
            return;
        this.setData({ giftPanelOpen: false });
    },
    async sendGift(e) {
        const giftId = String(e.currentTarget.dataset.giftId || '');
        if (!giftId || this.data.sendingGiftId || this.data.actionAnimating)
            return;
        const member = this.data.currentMember;
        const target = memberTarget(member);
        if (!target) {
            wx.showToast({ title: '暂无法赠送礼物', icon: 'none' });
            return;
        }
        const currentIndex = this.data.currentIndex;
        this.setData({ sendingGiftId: giftId });
        try {
            const result = await member_1.memberApi.sendGift({ ...target, giftId });
            const favoriteQuota = normalizeFavoriteQuota(result && result.favorite && result.favorite.favoriteQuota);
            this.setCurrentFavoriteAndAdvance(true, currentIndex, 'gift', favoriteQuota ? {
                favoriteQuota,
                favoriteQuotaText: favoriteQuotaText(favoriteQuota)
            } : {});
            const favoriteResult = result && result.favorite;
            wx.showToast({
                title: favoriteResult && favoriteResult.mutualFavorite
                    ? (favoriteResult.canChat
                        ? '赠送成功，已互相喜欢，可在消息里聊天'
                        : '赠送成功，已互相喜欢，开通会员后可聊天')
                    : '赠送成功，已关注',
                icon: favoriteResult && favoriteResult.mutualFavorite && !favoriteResult.canChat ? 'none' : 'success'
            });
        }
        catch (err) {
            console.warn('send gift failed', err);
        }
        finally {
            this.setData({ sendingGiftId: '' });
        }
    },
    noop() { },
    goProfile() {
        wx.navigateTo({ url: '/pages/user/profile' });
    }
});
