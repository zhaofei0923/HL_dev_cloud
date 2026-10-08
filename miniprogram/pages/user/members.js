"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const member_1 = require("../../services/member");
const api_1 = require("../../services/api");
const member_format_1 = require("../../utils/member-format");
const member_certification_1 = require("../../utils/member-certification");
const user_navigation_1 = require("../../utils/user-navigation");
const showcase_cache_1 = require("../../utils/showcase-cache");
const SHOWCASE_CATEGORIES = [
    { id: 'recommend', label: '推荐', description: '' },
    { id: 'popularity', label: '颜值', description: '收到超过100人爱心的会员' },
    { id: 'education', label: '学历', description: '学历核验通过的本科及以上会员，含海外及港澳台学历' },
    { id: 'assets', label: '资产', description: '金融资产核验200万元及以上，并同意进入此分类的会员' }
];
function categoryEmptyState(category, filtered) {
    if (category === 'recommend')
        return {
            emptyTitle: filtered ? '暂无匹配会员' : '暂无可推荐会员',
            emptyNote: filtered ? '可以调整城市、性别或关键词后再试。' : '主理人精选会员资料后，会在这里展示脱敏信息。'
        };
    const label = SHOWCASE_CATEGORIES.find(item => item.id === category)?.label || '';
    return {
        emptyTitle: `暂无符合条件的${label}会员`,
        emptyNote: filtered ? '当前筛选下暂无符合本栏目条件的会员，可调整筛选后再试；入选门槛保持不变。'
            : '暂时没有符合本栏目条件的公开会员，请稍后再来；入选门槛保持不变。'
    };
}
function record(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value : {};
}
const SWIPE_DISTANCE = 56;
const SHOWCASE_PAGE_SIZE = 50;
let touchStartX = 0;
let touchStartY = 0;
let cardTapBlocked = false;
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
    const viewerState = record(row.viewerState);
    const ageText = textWithUnit(String(row.age || ''), '岁', '年龄保密');
    const heightText = textWithUnit(String(row.height || ''), 'cm', '');
    const city = String(member.cityText || row.city || row.province || '').trim();
    const educationVerified = row.educationVerified === true;
    const assetVerified = row.assetVerified === true;
    const education = String(educationVerified && row.verifiedEducation || row.education || '').trim();
    const occupation = String(row.occupation || '').trim();
    const primaryMeta = uniqueLocationParts(city, String(row.nativePlace || '')).join(' · ') || member.metaText;
    const profileLine = compactList([heightText, education, occupation]).join(' · ') || member.workText;
    const cardTags = [];
    const partnerPreview = truncateText(String(row.partnerRequirement || member.partnerText), 44);
    const introPreview = truncateText(String(row.selfIntro || member.introText), 42);
    return {
        ...member,
        id: row.id,
        userId: row.userId,
        ageText,
        primaryMeta,
        profileLine,
        cardTags,
        partnerPreview,
        introPreview,
        educationVerified,
        assetVerified,
        financialAssetText: assetVerified ? (0, member_certification_1.financialAssetRangeText)(row.financialAssetRange) : '',
        isFavorite: !!viewerState.isFavorite,
        // Only separately reviewed credentials can display an approved badge.
        certificationBadges: ['实名认证', '学历认证', '资产认证', '车辆认证', '房产认证'].map(label => {
            const verified = label === '实名认证' && row.identityVerified === true
                || label === '学历认证' && educationVerified
                || label === '车辆认证' && row.vehicleVerified === true
                || label === '房产认证' && row.propertyVerified === true
                || label === '资产认证' && assetVerified;
            return { label, verified, statusText: verified ? '已认证' : '待认证' };
        }).filter(item => item.verified).slice(0, 3)
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
    if (!member)
        return null;
    const targetUserId = Number(member.userId);
    if (!Number.isSafeInteger(targetUserId) || targetUserId <= 0)
        return null;
    return {
        targetUserId,
        targetMemberId: member.id
    };
}
function countText(total) {
    return total ? `${total} 位会员可浏览 · 下滑下一位，点击查看资料` : '暂无可浏览会员';
}
Page({
    _showcaseScope: '',
    _showcaseLoadedAt: 0,
    _showcaseQuery: null,
    _showcaseRequestGeneration: 0,
    _showcaseUnloaded: false,
    _showcaseLoadKey: '',
    _showcaseLoadPromise: null,
    _showcaseMorePromise: null,
    _showcaseMoreGeneration: 0,
    _advanceAfterMore: false,
    _favoriteGeneration: 0,
    _popularityRefreshNeeded: false,
    _hiddenGeneration: 0,
    data: {
        category: 'recommend',
        categories: SHOWCASE_CATEGORIES,
        categoryDescription: '',
        keyword: '',
        city: '',
        gender: '',
        draftKeyword: '',
        draftCity: '',
        draftGender: '',
        filterChips: [],
        filterOpen: false,
        hiddenPanelOpen: false,
        hiddenMembers: [],
        hiddenLoading: false,
        hiddenError: '',
        hiddenPage: 0,
        hiddenTotal: 0,
        restoringUserId: 0,
        undoHidden: null,
        list: [],
        currentIndex: 0,
        currentMember: null,
        positionText: '',
        total: 0,
        showcasePage: 1,
        hasMore: false,
        loadingMore: false,
        paginationError: '',
        countText: '正在整理会员资料',
        emptyTitle: '暂无可推荐会员',
        emptyNote: '可以调整筛选条件，或稍后再查看主理人精选的公开会员。',
        gifts: [],
        giftPanelOpen: false,
        giftLoading: false,
        favoriteLoading: false,
        hideLoading: false,
        sendingGiftId: '',
        actionEffect: '',
        actionAnimating: false,
        favoriteQuota: null,
        loading: false
    },
    onShow() {
        this._showcaseUnloaded = false;
        if (!this.sessionScope()) {
            (0, showcase_cache_1.readShowcaseCache)('', this.showcaseQuery());
            wx.redirectTo({ url: '/pages/index/index' });
            return;
        }
        (0, user_navigation_1.syncUserTabBar)(this, 'members');
        return this.load(false);
    },
    onUnload() {
        this._showcaseUnloaded = true;
        this._popularityRefreshNeeded = false;
        this._favoriteGeneration += 1;
        this._hiddenGeneration += 1;
        if (this.data.favoriteLoading || this.data.hideLoading || this.data.sendingGiftId)
            wx.hideLoading();
        this.setData({ favoriteLoading: false });
        this.invalidateShowcaseLoad();
        this._showcaseMorePromise = null;
        this._showcaseMoreGeneration += 1;
        clearActionTimers();
    },
    sessionScope() {
        const app = getApp();
        return (0, showcase_cache_1.showcaseSessionScope)(app.globalData.token || wx.getStorageSync('token'), app.globalData.user || wx.getStorageSync('user'), app.globalData.env);
    },
    showcaseQuery() {
        return {
            page: 1,
            pageSize: SHOWCASE_PAGE_SIZE,
            keyword: this.data.keyword,
            city: this.data.city,
            gender: this.data.gender,
            category: this.data.category
        };
    },
    invalidateShowcaseLoad() {
        this._showcaseRequestGeneration += 1;
        this._showcaseLoadPromise = null;
        this._showcaseLoadKey = '';
        this._showcaseMorePromise = null;
        this._showcaseMoreGeneration += 1;
    },
    load(force = true, refresh = false) {
        const scope = this.sessionScope();
        const query = this.showcaseQuery();
        const key = `${scope}:${(0, showcase_cache_1.showcaseQueryKey)(query)}`;
        if (force === false && !refresh && this._showcaseLoadPromise && this._showcaseLoadKey === key)
            return this._showcaseLoadPromise;
        if (!scope || this._showcaseUnloaded)
            return Promise.resolve();
        const cached = force === false && !refresh ? (0, showcase_cache_1.readShowcaseCache)(scope, query) : null;
        const retained = force === false ? (0, showcase_cache_1.readShowcaseCache)(scope, query, true) : null;
        const retainedPage = retained ? retained.result.page : 1;
        if (cached && this._showcaseScope === scope && this._showcaseQuery
            && (0, showcase_cache_1.showcaseQueryKey)(this._showcaseQuery) === (0, showcase_cache_1.showcaseQueryKey)(query)
            && this._showcaseLoadedAt === cached.loadedAt) {
            return Promise.resolve();
        }
        const generation = ++this._showcaseRequestGeneration;
        this._showcaseMorePromise = null;
        this._showcaseMoreGeneration += 1;
        if (force !== false)
            this._advanceAfterMore = false;
        const isCurrent = () => !this._showcaseUnloaded
            && this._showcaseRequestGeneration === generation
            && this.sessionScope() === scope
            && (0, showcase_cache_1.showcaseQueryKey)(this.showcaseQuery()) === (0, showcase_cache_1.showcaseQueryKey)(query);
        const sameQuery = this._showcaseScope === scope && !!this._showcaseQuery
            && (0, showcase_cache_1.showcaseQueryKey)(this._showcaseQuery) === (0, showcase_cache_1.showcaseQueryKey)(query);
        const previousMemberId = sameQuery && this.data.currentMember
            ? String(this.data.currentMember.id)
            : '';
        const previousIndex = sameQuery ? this.data.currentIndex : 0;
        const hasSnapshot = this._showcaseScope === scope && !!this._showcaseQuery
            && (0, showcase_cache_1.showcaseQueryKey)(this._showcaseQuery) === (0, showcase_cache_1.showcaseQueryKey)(query)
            && this._showcaseLoadedAt > 0;
        if (this._showcaseScope !== scope) {
            this._favoriteGeneration += 1;
            if (this.data.favoriteLoading || this.data.hideLoading || this.data.sendingGiftId)
                wx.hideLoading();
            clearActionTimers();
            this.setData({ list: [], ...selectionState([], 0), total: 0, showcasePage: 1, hasMore: false,
                favoriteQuota: null, giftPanelOpen: false, favoriteLoading: false, actionEffect: '', actionAnimating: false,
                hiddenPanelOpen: false, hiddenMembers: [], undoHidden: null, restoringUserId: 0, hiddenLoading: false,
                hideLoading: false, sendingGiftId: '' });
        }
        this.setData({ loading: force !== false || !hasSnapshot, loadingMore: false, paginationError: '' });
        const loadPromise = (async () => {
            await Promise.resolve();
            try {
                let snapshot = cached || await (0, showcase_cache_1.requestShowcase)(scope, query, () => member_1.memberApi.showcase(query), force !== false || refresh, isCurrent);
                if (!isCurrent())
                    return;
                // Refresh the previously browsed pages so a category keeps its position after qualification changes.
                if (!cached) {
                    for (let page = 2; page <= retainedPage && snapshot.result.list.length < snapshot.result.total; page += 1) {
                        const nextQuery = { ...query, page };
                        const incoming = await (0, showcase_cache_1.requestShowcase)(scope, nextQuery, () => member_1.memberApi.showcase(nextQuery), true, isCurrent);
                        if (!isCurrent())
                            return;
                        const merged = (0, showcase_cache_1.mergeShowcasePage)(scope, query, incoming);
                        if (!merged)
                            return;
                        snapshot = merged;
                        if (!incoming.result.list.length)
                            break;
                    }
                }
                const list = snapshot.result.list.map(row => normalizeMember(row));
                const hasCurrentSelection = this._showcaseScope === scope && !!this._showcaseQuery
                    && (0, showcase_cache_1.showcaseQueryKey)(this._showcaseQuery) === (0, showcase_cache_1.showcaseQueryKey)(query)
                    && !!this.data.currentMember;
                const selectedId = hasCurrentSelection
                    ? String(this.data.currentMember.id)
                    : previousMemberId || snapshot.selectedMemberId;
                const matchingIndex = selectedId ? list.findIndex(row => String(row.id) === selectedId) : -1;
                const fallbackIndex = hasCurrentSelection
                    ? this.data.currentIndex
                    : (previousMemberId ? previousIndex : snapshot.currentIndex);
                const index = matchingIndex >= 0 ? matchingIndex : fallbackIndex;
                const selected = selectionState(list, index);
                this._showcaseScope = scope;
                this._showcaseQuery = query;
                this._showcaseLoadedAt = snapshot.loadedAt;
                this.setData({
                    list,
                    ...selected,
                    total: snapshot.result.total,
                    showcasePage: snapshot.result.page,
                    hasMore: list.length < snapshot.result.total,
                    countText: countText(snapshot.result.total),
                    favoriteQuota: snapshot.result.favoriteQuota,
                    ...categoryEmptyState(this.data.category, this.hasFilters())
                });
                (0, showcase_cache_1.rememberShowcaseSelection)(scope, query, selected.currentMember && selected.currentMember.id, selected.currentIndex);
            }
            catch (err) {
                if (!isCurrent() || err instanceof showcase_cache_1.ShowcaseRequestDiscarded)
                    return;
                console.warn('load user members failed', err);
                if (hasSnapshot)
                    return;
                this._showcaseLoadedAt = 0;
                this.setData({
                    list: [],
                    ...selectionState([], 0),
                    total: 0,
                    showcasePage: 1, hasMore: false,
                    countText: '云服务暂不可用',
                    emptyTitle: '数据暂不可用',
                    emptyNote: '暂时无法加载会员，请稍后重试。'
                });
            }
            finally {
                if (this._showcaseRequestGeneration === generation && !this._showcaseUnloaded) {
                    this.setData({ loading: false });
                    this._showcaseLoadPromise = null;
                    this._showcaseLoadKey = '';
                    this.prefetchMore();
                }
            }
        })();
        this._showcaseLoadKey = key;
        this._showcaseLoadPromise = loadPromise;
        return loadPromise;
    },
    prefetchMore() {
        if (this.data.hasMore && !this._showcaseLoadPromise
            && (this._advanceAfterMore || this.data.currentIndex >= this.data.list.length - 3)) {
            void this.loadMoreShowcase();
        }
    },
    loadMoreShowcase() {
        const scope = this.sessionScope();
        if (!scope || !this.data.hasMore || this._showcaseUnloaded)
            return Promise.resolve();
        if (this.data.favoriteLoading || this.data.hideLoading || this.data.sendingGiftId || this.data.actionAnimating)
            return Promise.resolve();
        if (this._showcaseMorePromise)
            return this._showcaseMorePromise;
        if (this._showcaseLoadPromise)
            return Promise.resolve();
        if (!this.isShowcaseFresh())
            return this.load(false);
        const generation = this._showcaseRequestGeneration;
        const moreGeneration = ++this._showcaseMoreGeneration;
        const query = this.showcaseQuery();
        const isCurrent = () => !this._showcaseUnloaded && this.sessionScope() === scope
            && generation === this._showcaseRequestGeneration
            && moreGeneration === this._showcaseMoreGeneration
            && (0, showcase_cache_1.showcaseQueryKey)(this.showcaseQuery()) === (0, showcase_cache_1.showcaseQueryKey)(query);
        const initialLength = this.data.list.length;
        this.setData({ loadingMore: true, paginationError: '' });
        const promise = Promise.resolve().then(async () => {
            try {
                let appended = 0;
                do {
                    // Refilling an offset page after a hide avoids skipping its shifted boundary member.
                    const page = Math.floor(this.data.list.length / SHOWCASE_PAGE_SIZE) + 1;
                    const nextQuery = { ...query, page };
                    const incoming = await (0, showcase_cache_1.requestShowcase)(scope, nextQuery, () => member_1.memberApi.showcase(nextQuery), true, isCurrent);
                    if (!isCurrent())
                        return;
                    if (incoming.result.total < this.data.total) {
                        await this.load(false, true);
                        return;
                    }
                    const snapshot = (0, showcase_cache_1.mergeShowcasePage)(scope, query, incoming);
                    if (!snapshot)
                        return;
                    const list = snapshot.result.list.map(normalizeMember);
                    const previousLength = this.data.list.length;
                    const selectedId = this.data.currentMember ? String(this.data.currentMember.id) : '';
                    const selectedIndex = list.findIndex(row => String(row.id) === selectedId);
                    let index = selectedIndex >= 0 ? selectedIndex : this.data.currentIndex;
                    if (this._advanceAfterMore && list.length > previousLength
                        && !this.data.actionAnimating && !this.data.favoriteLoading && !this.data.hideLoading && !this.data.sendingGiftId) {
                        index += 1;
                        this._advanceAfterMore = false;
                    }
                    const hasMore = incoming.result.list.length > 0 && list.length < snapshot.result.total;
                    this.setData({ list, ...selectionState(list, index), total: snapshot.result.total,
                        countText: countText(snapshot.result.total), showcasePage: snapshot.result.page,
                        hasMore, favoriteQuota: snapshot.result.favoriteQuota });
                    this.rememberSelection();
                    appended = list.length - initialLength;
                    if (list.length === previousLength || !hasMore)
                        break;
                } while (appended < SHOWCASE_PAGE_SIZE);
                if (isCurrent() && this._advanceAfterMore && !this.data.hasMore
                    && !this.data.actionAnimating && !this.data.favoriteLoading && !this.data.hideLoading && !this.data.sendingGiftId) {
                    this._advanceAfterMore = false;
                    this.setData(selectionState(this.data.list, 0));
                    this.rememberSelection();
                }
            }
            catch (err) {
                if (!isCurrent() || err instanceof showcase_cache_1.ShowcaseRequestDiscarded)
                    return;
                this.setData({ paginationError: '更多会员暂时无法加载，请重试。' });
            }
            finally {
                if (isCurrent())
                    this.setData({ loadingMore: false });
                if (this._showcaseMorePromise === promise)
                    this._showcaseMorePromise = null;
            }
        });
        this._showcaseMorePromise = promise;
        return promise;
    },
    async loadGifts(force = false) {
        if (this.data.gifts.length && !force)
            return this.data.gifts;
        this.setData({ giftLoading: true });
        try {
            const gifts = normalizeGifts(await member_1.memberApi.gifts(false));
            this.setData({ gifts });
            return gifts;
        }
        finally {
            this.setData({ giftLoading: false });
        }
    },
    onKeyword(e) {
        this.setData({ draftKeyword: e.detail.value });
    },
    switchCategory(e) {
        const category = SHOWCASE_CATEGORIES.find(item => item.id === e.currentTarget.dataset.category);
        if (!category || category.id === this.data.category)
            return Promise.resolve();
        if (this.data.favoriteLoading || this.data.hideLoading || this.data.sendingGiftId || this.data.actionAnimating)
            return Promise.resolve();
        this.rememberSelection();
        this.invalidateShowcaseLoad();
        this._advanceAfterMore = false;
        this._popularityRefreshNeeded = false;
        clearActionTimers();
        this.setData({
            category: category.id,
            categoryDescription: category.description,
            list: [], ...selectionState([], 0), total: 0, showcasePage: 1, hasMore: false,
            loadingMore: false, paginationError: '', giftPanelOpen: false, filterOpen: false,
            actionEffect: '', actionAnimating: false, countText: '正在整理会员资料',
            ...categoryEmptyState(category.id, this.hasFilters())
        });
        return this.load(false);
    },
    onCity(e) {
        this.setData({ draftCity: e.detail.value });
    },
    setGender(e) {
        this.setData({ draftGender: String(e.currentTarget.dataset.gender || '') });
    },
    toggleFilter() {
        if (this.data.favoriteLoading || this.data.hideLoading || this.data.sendingGiftId || this.data.actionAnimating)
            return;
        this.setData({ filterOpen: !this.data.filterOpen,
            draftKeyword: this.data.keyword, draftCity: this.data.city, draftGender: this.data.gender });
    },
    hasFilters() {
        return !!(this.data.keyword || this.data.city || this.data.gender);
    },
    search() {
        this.invalidateShowcaseLoad();
        this.setData({ keyword: this.data.draftKeyword.trim(), city: this.data.draftCity.trim(),
            gender: this.data.draftGender, filterOpen: false });
        this.updateFilterChips();
        return this.load(true);
    },
    updateFilterChips() {
        this.setData({ filterChips: [
                { key: 'keyword', label: this.data.keyword },
                { key: 'city', label: this.data.city ? `城市：${this.data.city}` : '' },
                { key: 'gender', label: this.data.gender === '1' ? '男士' : this.data.gender === '2' ? '女士' : '' }
            ].filter(item => item.label) });
    },
    removeFilter(e) {
        const key = String(e.currentTarget.dataset.key || '');
        if (!['keyword', 'city', 'gender'].includes(key) || this.isCardBusy(false))
            return;
        this.invalidateShowcaseLoad();
        this.setData({ [key]: '' });
        this.updateFilterChips();
        return this.load(true);
    },
    clearKeyword() {
        this.setData({ keyword: '', city: '', gender: '', filterOpen: false });
        this.updateFilterChips();
        return this.load(true);
    },
    isShowcaseFresh() {
        return this._showcaseScope === this.sessionScope()
            && !!this._showcaseQuery
            && (0, showcase_cache_1.showcaseQueryKey)(this._showcaseQuery) === (0, showcase_cache_1.showcaseQueryKey)(this.showcaseQuery())
            && Date.now() - this._showcaseLoadedAt < showcase_cache_1.SHOWCASE_CACHE_TTL_MS;
    },
    isCardBusy(requireFresh = true) {
        if (requireFresh && !this.data.loading && this.data.list.length && !this.isShowcaseFresh()) {
            void this.load(false);
            return true;
        }
        return this.data.loading || this.data.favoriteLoading || this.data.hideLoading
            || !!this.data.sendingGiftId || this.data.actionAnimating || this.data.giftPanelOpen
            || this.data.filterOpen || this.data.hiddenPanelOpen || !!this.data.restoringUserId;
    },
    nextMember() {
        if (!this.data.list.length || this.isCardBusy(false))
            return;
        if (this.data.currentIndex === this.data.list.length - 1 && this.data.hasMore) {
            this._advanceAfterMore = true;
            void this.loadMoreShowcase();
            return;
        }
        this.setData(selectionState(this.data.list, this.data.currentIndex + 1));
        this.rememberSelection();
        this.prefetchMore();
    },
    previousMember() {
        if (!this.data.list.length || this.isCardBusy(false))
            return;
        this.setData(selectionState(this.data.list, this.data.currentIndex - 1));
        this.rememberSelection();
    },
    rememberSelection() {
        if (!this._showcaseQuery || this._showcaseScope !== this.sessionScope())
            return;
        (0, showcase_cache_1.rememberShowcaseSelection)(this._showcaseScope, this._showcaseQuery, this.data.currentMember && this.data.currentMember.id, this.data.currentIndex);
    },
    rememberActionSelection(list, index) {
        if (!this._showcaseQuery || this._showcaseScope !== this.sessionScope())
            return;
        const selected = selectionState(list, index);
        (0, showcase_cache_1.rememberShowcaseSelection)(this._showcaseScope, this._showcaseQuery, selected.currentMember && selected.currentMember.id, selected.currentIndex);
    },
    cacheInteraction(targetUserId, action, quota = null, active = true) {
        if (!this._showcaseQuery || this._showcaseScope !== this.sessionScope())
            return;
        (0, showcase_cache_1.applyShowcaseInteraction)(this._showcaseScope, this._showcaseQuery, targetUserId, action, quota, active);
        if (action === 'favorite') {
            (0, showcase_cache_1.invalidateShowcaseCategory)(this._showcaseScope, 'popularity');
            if (this.data.category === 'popularity') {
                this._showcaseLoadedAt = Math.min(this._showcaseLoadedAt, Date.now() - showcase_cache_1.SHOWCASE_CACHE_TTL_MS);
                this._popularityRefreshNeeded = true;
            }
        }
        this._showcaseMoreGeneration += 1;
        this._showcaseMorePromise = null;
        this.setData({ loadingMore: false });
    },
    refreshPopularityAfterInteraction() {
        if (!this._popularityRefreshNeeded || this._showcaseUnloaded || this.data.category !== 'popularity')
            return;
        if (this.data.favoriteLoading || this.data.sendingGiftId || this.data.actionAnimating)
            return;
        this._popularityRefreshNeeded = false;
        void this.load(false, true);
    },
    onCardTouchStart(e) {
        cardTapBlocked = false;
        const touch = e.touches && e.touches[0];
        if (!touch)
            return;
        touchStartX = touch.clientX;
        touchStartY = touch.clientY;
    },
    onCardTouchEnd(e) {
        const touch = e.changedTouches && e.changedTouches[0];
        if (!touch)
            return;
        const deltaX = touch.clientX - touchStartX;
        const deltaY = touch.clientY - touchStartY;
        const absX = Math.abs(deltaX);
        const absY = Math.abs(deltaY);
        cardTapBlocked = absX > 10 || absY > 10;
        if (!this.data.list.length || this.isCardBusy(false))
            return;
        const isVerticalSwipe = absY >= SWIPE_DISTANCE && absY > absX;
        if (isVerticalSwipe) {
            if (deltaY > 0)
                this.nextMember();
            else
                this.previousMember();
            return;
        }
        const isHorizontalSwipe = absX >= SWIPE_DISTANCE && absX >= absY;
        if (!isHorizontalSwipe)
            return;
        if (deltaX < 0) {
            this.nextMember();
            return;
        }
        this.previousMember();
    },
    onCardTap() {
        if (cardTapBlocked || this.isCardBusy(false))
            return;
        this.goMemberDetail();
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
            this.refreshPopularityAfterInteraction();
            this.prefetchMore();
            actionAdvanceTimer = null;
        }, 460);
        actionEffectTimer = setTimeout(() => {
            this.setData({ actionEffect: '' });
            actionEffectTimer = null;
        }, 640);
    },
    setCurrentFavoriteAndStay(active, currentIndex, effect, extraState = {}, targetUserId) {
        const list = this.data.list.map(item => (Number(item.userId) === targetUserId ? { ...item, isFavorite: active } : item));
        this.rememberActionSelection(list, currentIndex);
        if (this.data.giftPanelOpen) {
            this.setData({ giftPanelOpen: false });
        }
        this.runActionEffect(effect, () => {
            const currentList = this.data.list.map(item => Number(item.userId) === targetUserId ? { ...item, isFavorite: active } : item);
            this.setData({
                list: currentList,
                ...selectionState(currentList, currentIndex),
                ...extraState,
                giftPanelOpen: false
            });
            this.rememberSelection();
        });
    },
    async toggleFavorite() {
        if (this.isCardBusy())
            return;
        const member = this.data.currentMember;
        const target = memberTarget(member);
        if (!member || !target) {
            wx.showToast({ title: '暂无法关注该会员', icon: 'none' });
            return;
        }
        const scope = this.sessionScope();
        if (!scope)
            return;
        const active = !member.isFavorite;
        const generation = ++this._favoriteGeneration;
        const isCurrent = () => !this._showcaseUnloaded && generation === this._favoriteGeneration && this.sessionScope() === scope;
        this.setData({ favoriteLoading: true });
        wx.showLoading({ title: active ? '正在送出爱心' : '正在撤回爱心', mask: true });
        try {
            const result = record(await member_1.memberApi.interact({ ...target, actionType: 'favorite', active }, false));
            if (!isCurrent())
                return;
            wx.hideLoading();
            const favoriteQuota = (0, showcase_cache_1.normalizeFavoriteQuota)(result && result.favoriteQuota);
            const viewerState = record(result.viewerState);
            const savedActive = typeof viewerState.isFavorite === 'boolean' ? viewerState.isFavorite : active;
            this.cacheInteraction(target.targetUserId, 'favorite', favoriteQuota, savedActive);
            const list = this.data.list.map(item => Number(item.userId) === target.targetUserId ? { ...item, isFavorite: savedActive } : item);
            this.setData({ list, ...selectionState(list, this.data.currentIndex), ...(favoriteQuota ? { favoriteQuota } : {}) });
            this.rememberSelection();
            if (savedActive !== active) {
                wx.showToast({ title: active ? '爱心未送出，请重试' : '爱心未撤回，请重试', icon: 'none' });
                return;
            }
            if (savedActive)
                this.runActionEffect('heart', () => { if (isCurrent())
                    this.rememberSelection(); });
            wx.showToast({
                title: !savedActive ? '已撤回爱心' : result && result.mutualFavorite
                    ? (result.canChat ? '已互相喜欢，可在消息里聊天' : '已互相喜欢，开通会员后可聊天')
                    : '已关注，对方会收到通知',
                icon: 'none'
            });
        }
        catch (err) {
            if (!isCurrent())
                return;
            wx.hideLoading();
            console.warn('toggle favorite failed', err);
            wx.showToast({ title: (0, api_1.apiErrorMessage)(err) || (active ? '爱心未送出，请重试' : '爱心撤回失败，请重试'), icon: 'none', duration: 3000 });
        }
        finally {
            if (isCurrent()) {
                this.setData({ favoriteLoading: false });
                this.refreshPopularityAfterInteraction();
            }
        }
    },
    async hideCurrent() {
        if (this.isCardBusy())
            return;
        const member = this.data.currentMember;
        const target = memberTarget(member);
        if (!target) {
            wx.showToast({ title: '暂无法处理该会员', icon: 'none' });
            return;
        }
        const currentIndex = this.data.currentIndex;
        const scope = this.sessionScope();
        const isCurrent = () => !this._showcaseUnloaded && this.sessionScope() === scope;
        this.setData({ hideLoading: true });
        wx.showLoading({ title: '正在处理', mask: true });
        try {
            await member_1.memberApi.interact({ ...target, actionType: 'hide', active: true }, false);
            if (!isCurrent())
                return;
            wx.hideLoading();
            this.cacheInteraction(target.targetUserId, 'hide');
            const list = this.data.list.filter(item => Number(item.userId) !== target.targetUserId);
            const removed = this.data.list.length - list.length;
            const total = Math.max(Number(this.data.total || this.data.list.length) - removed, 0);
            const hasMore = list.length < total;
            const waitingForMore = currentIndex >= list.length && hasMore;
            const index = waitingForMore ? Math.max(list.length - 1, 0) : currentIndex;
            this.rememberActionSelection(list, index);
            this.runActionEffect('hide', () => {
                this.setData({
                    list,
                    ...selectionState(list, index),
                    total,
                    hasMore,
                    countText: countText(total),
                    giftPanelOpen: false,
                    undoHidden: { targetUserId: target.targetUserId, displayName: member.displayName }
                });
                if (waitingForMore)
                    this._advanceAfterMore = true;
                this.prefetchMore();
            });
        }
        catch (err) {
            if (!isCurrent())
                return;
            wx.hideLoading();
            console.warn('hide member failed', err);
            wx.showToast({ title: (0, api_1.apiErrorMessage)(err) || '操作未完成，请重试', icon: 'none', duration: 3000 });
        }
        finally {
            if (isCurrent())
                this.setData({ hideLoading: false });
        }
    },
    async openHiddenPanel() {
        this.setData({ filterOpen: false, hiddenPanelOpen: true, hiddenMembers: [], hiddenPage: 0, hiddenTotal: 0 });
        await this.loadHidden(true);
    },
    closeHiddenPanel() {
        this._hiddenGeneration += 1;
        this.setData({ hiddenPanelOpen: false, hiddenLoading: false });
    },
    async loadHidden(reset = false) {
        if (this.data.hiddenLoading)
            return;
        const scope = this.sessionScope();
        const generation = ++this._hiddenGeneration;
        const isCurrent = () => !this._showcaseUnloaded && scope === this.sessionScope() && generation === this._hiddenGeneration;
        const page = reset ? 1 : this.data.hiddenPage + 1;
        this.setData({ hiddenLoading: true, hiddenError: '' });
        try {
            const result = await member_1.memberApi.hidden(page);
            if (!isCurrent())
                return;
            this.setData({ hiddenMembers: reset ? result.list : [...this.data.hiddenMembers, ...result.list],
                hiddenPage: result.page, hiddenTotal: result.total });
        }
        catch (err) {
            if (isCurrent())
                this.setData({ hiddenError: '暂时无法加载，请重试。' });
        }
        finally {
            if (isCurrent())
                this.setData({ hiddenLoading: false });
        }
    },
    loadMoreHidden() { return this.loadHidden(this.data.hiddenPage === 0); },
    undoHide() {
        if (this.data.undoHidden)
            return this.restoreHiddenUser(this.data.undoHidden.targetUserId);
    },
    restoreHidden(e) {
        return this.restoreHiddenUser(Number(e.currentTarget.dataset.userId));
    },
    async restoreHiddenUser(targetUserId) {
        if (!Number.isSafeInteger(targetUserId) || targetUserId <= 0 || this.data.restoringUserId || this.data.actionAnimating)
            return;
        const scope = this.sessionScope();
        const isCurrent = () => !this._showcaseUnloaded && scope === this.sessionScope();
        this.setData({ restoringUserId: targetUserId });
        try {
            const result = record(await member_1.memberApi.interact({ targetUserId, actionType: 'hide', active: false }, false));
            if (!isCurrent())
                return;
            if (record(result.viewerState).isHidden !== false)
                throw new Error('服务尚未确认恢复');
            this.cacheInteraction(targetUserId, 'hide', null, false);
            this.setData({ undoHidden: this.data.undoHidden?.targetUserId === targetUserId ? null : this.data.undoHidden });
            if (this.data.hiddenPanelOpen)
                await this.loadHidden(true);
            await this.load(false);
            if (isCurrent())
                wx.showToast({ title: '已恢复推荐，仍按分类条件展示', icon: 'none' });
        }
        catch (err) {
            if (isCurrent())
                wx.showToast({ title: '恢复未完成，请重试', icon: 'none' });
        }
        finally {
            if (isCurrent())
                this.setData({ restoringUserId: 0 });
        }
    },
    async openGiftPanel() {
        if (this.data.giftLoading || this.isCardBusy())
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
        if (!this.isShowcaseFresh()) {
            this.setData({ giftPanelOpen: false });
            void this.load(false);
            return;
        }
        const member = this.data.currentMember;
        const target = memberTarget(member);
        if (!target) {
            wx.showToast({ title: '暂无法赠送礼物', icon: 'none' });
            return;
        }
        const currentIndex = this.data.currentIndex;
        const scope = this.sessionScope();
        const isCurrent = () => !this._showcaseUnloaded && this.sessionScope() === scope;
        this.setData({ sendingGiftId: giftId });
        wx.showLoading({ title: '正在赠送礼物', mask: true });
        try {
            const result = record(await member_1.memberApi.sendGift({ ...target, giftId }, false));
            if (!isCurrent())
                return;
            wx.hideLoading();
            const favoriteResult = record(result.favorite);
            const favoriteQuota = (0, showcase_cache_1.normalizeFavoriteQuota)(favoriteResult.favoriteQuota);
            this.cacheInteraction(target.targetUserId, 'favorite', favoriteQuota);
            this.setCurrentFavoriteAndStay(true, currentIndex, 'gift', favoriteQuota ? {
                favoriteQuota
            } : {}, target.targetUserId);
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
            if (!isCurrent())
                return;
            wx.hideLoading();
            console.warn('send gift failed', err);
            wx.showToast({ title: (0, api_1.apiErrorMessage)(err) || '礼物未送出，请重试', icon: 'none', duration: 3000 });
        }
        finally {
            if (isCurrent()) {
                this.setData({ sendingGiftId: '' });
                this.refreshPopularityAfterInteraction();
            }
        }
    },
    noop() { },
    goMemberDetail() {
        if (this.isCardBusy(false))
            return;
        const member = this.data.currentMember;
        if (!member || !member.id) {
            wx.showToast({ title: '暂无法查看该会员', icon: 'none' });
            return;
        }
        const cachedMember = { ...member };
        delete cachedMember.financialAssetRange;
        delete cachedMember.financialAssetText;
        wx.setStorageSync('selectedUserMember', cachedMember);
        wx.setStorageSync('selectedUserMemberScope', this.sessionScope());
        wx.navigateTo({ url: `/pages/user/member-detail?id=${encodeURIComponent(String(member.id))}` });
    },
    goProfile() {
        wx.switchTab({ url: '/pages/user/profile' });
    }
});
