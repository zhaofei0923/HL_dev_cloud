"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.salonController = void 0;
const matchmaker_workspace_1 = require("../../utils/matchmaker-workspace");
const salon_1 = require("../../services/salon");
const matchmaker_1 = require("../../services/matchmaker");
const member_1 = require("../../services/member");
const invite_1 = require("../../utils/invite");
const salon_availability_1 = require("../../utils/salon-availability");
const matchmaker_page_cache_1 = require("../../utils/matchmaker-page-cache");
const PAGE_ROUTE = '/pages/matchmaker/salon';
function errorCode(error) {
    return error && typeof error === 'object' ? Number(error.code) : 0;
}
function denied(error) {
    const code = errorCode(error);
    return code === 401 || code === 403 || Math.floor(code / 100) === 401 || Math.floor(code / 100) === 403;
}
function missingMatchmaker(error) {
    return errorCode(error) === 40400 && error !== null && typeof error === 'object'
        && error.message === 'matchmaker not found';
}
function pickedRow(row, fields) {
    const result = {};
    fields.forEach(field => { if (row[field] !== undefined)
        result[field] = row[field]; });
    return result;
}
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
    const maxParticipants = Number(row.maxParticipants || 0);
    const currentParticipants = Number(row.currentParticipants || 0);
    const price = Number(row.price || 0);
    const statusMap = {
        pending: '待审核',
        upcoming: '报名中',
        rejected: '未通过',
        cancelled: '已取消',
        ended: '已结束'
    };
    return {
        ...row,
        idText: String(row.id || ''),
        eventDateText: formatDate(row.eventDate || ''),
        locationText: row.location || '地点待定',
        statusText: (0, salon_availability_1.salonAvailability)(row).expired ? '已过期，无法报名' : (statusMap[row.status] || row.status || '待定'),
        canInvite: (0, salon_availability_1.salonAvailability)(row).canRegister,
        participantText: maxParticipants > 0 ? `${currentParticipants}/${maxParticipants} 人` : `${currentParticipants} 人报名`,
        seatText: maxParticipants > 0 ? `剩余 ${Math.max(maxParticipants - currentParticipants, 0)} 席` : '席位不限',
        priceText: price > 0 ? `¥${price}` : '免费'
    };
}
function certificationView(matchmaker) {
    const status = Number((matchmaker && matchmaker.certificationStatus) || 0);
    const remark = (matchmaker && matchmaker.certificationRemark) || '';
    if (status === 2) {
        return {
            canOperate: true,
            statusText: '已认证',
            statusTagClass: 'gold',
            statusNote: '已认证的主理人及其合伙人可创建和管理自己的沙龙活动。'
        };
    }
    if (status === 1) {
        return {
            canOperate: false,
            statusText: '已拒绝',
            statusTagClass: 'rose',
            statusNote: remark || '本次申请暂未通过，请完善资料后重新提交。'
        };
    }
    return {
        canOperate: false,
        statusText: '待审批',
        statusTagClass: '',
        statusNote: '主理人认证通过后，才可以发起沙龙并管理活动。'
    };
}
exports.salonController = (0, matchmaker_workspace_1.defineMatchmakerController)({
    _pageScope: '',
    _pageRevision: 0,
    _pageLoadedAt: 0,
    _pageInitialized: false,
    _pageLoadedActive: '',
    _pageGeneration: 0,
    _pagePendingKey: '',
    _pagePending: null,
    _pageRestored: false,
    _pageUnloaded: false,
    _forceNextShow: false,
    _inviteMembersLoadedAt: 0,
    _inviteMembersGeneration: 0,
    _inviteMembersPromise: null,
    data: {
        active: 'mine',
        list: [],
        members: [],
        memberOptions: [],
        selectedMemberIndex: 0,
        selectedMemberName: '',
        loading: false,
        initialized: false,
        refreshError: '',
        loadingMembers: false,
        memberOptionsError: '',
        cancellingId: '',
        invitingId: '',
        managingEventId: '',
        canOperate: false,
        shareCode: '',
        statusText: '待审批',
        statusTagClass: '',
        statusNote: '主理人认证通过后，才可以发起沙龙并管理活动。'
    },
    onLoad() {
        this.restorePageSnapshot();
    },
    onShow() {
        this._pageUnloaded = false;
        this.restorePageSnapshot();
        this.refreshExpiredEvents();
        const force = this._forceNextShow;
        this._forceNextShow = false;
        return this.refreshGate(force);
    },
    onHide() {
        this.savePageSnapshot();
    },
    refreshExpiredEvents() {
        const list = this.data.list.map(row => {
            const availability = (0, salon_availability_1.salonAvailability)(row);
            return availability.expired ? { ...row, canInvite: false, statusText: availability.statusText, seatText: availability.statusText } : row;
        });
        this.setData({ list });
    },
    onUnload() {
        this.savePageSnapshot();
        this._pageUnloaded = true;
        this._pageGeneration += 1;
        this._pagePending = null;
        this._inviteMembersGeneration += 1;
        this._inviteMembersPromise = null;
    },
    ensurePageSession() {
        const scope = (0, matchmaker_page_cache_1.matchmakerPageSessionScope)();
        const revision = (0, matchmaker_page_cache_1.matchmakerPageSnapshotRevision)();
        if (scope === this._pageScope && revision === this._pageRevision)
            return scope;
        this._pageScope = scope;
        this._pageRevision = revision;
        this._pageGeneration += 1;
        this._pagePending = null;
        this._pagePendingKey = '';
        this._pageLoadedAt = 0;
        this._pageLoadedActive = '';
        this._pageInitialized = false;
        this._pageRestored = false;
        this._forceNextShow = false;
        this._inviteMembersLoadedAt = 0;
        this._inviteMembersGeneration += 1;
        this._inviteMembersPromise = null;
        this.setData({
            list: [], active: 'mine', members: [], memberOptions: [], selectedMemberIndex: 0,
            selectedMemberName: '', managingEventId: '', invitingId: '', cancellingId: '',
            initialized: false, loading: false, refreshError: '', canOperate: false, shareCode: '',
            loadingMembers: false, memberOptionsError: '',
            statusText: '待审批', statusTagClass: '',
            statusNote: '主理人认证通过后，才可以发起沙龙并管理活动。'
        });
        return scope;
    },
    restorePageSnapshot() {
        if (!this.ensurePageSession() || this._pageRestored)
            return;
        this._pageRestored = true;
        const snapshot = (0, matchmaker_page_cache_1.readMatchmakerPageSnapshot)(PAGE_ROUTE);
        if (!snapshot)
            return;
        const { loadedActive, inviteMembersLoadedAt, ...state } = snapshot.data;
        this.setData({ ...state, loading: false, loadingMembers: false, invitingId: '', cancellingId: '' });
        this._pageLoadedAt = snapshot.loadedAt;
        this._pageLoadedActive = loadedActive;
        this._pageInitialized = state.initialized === true;
        this._inviteMembersLoadedAt = Number(inviteMembersLoadedAt || 0);
    },
    savePageSnapshot() {
        const scope = this.ensurePageSession();
        if (!scope || !this._pageInitialized || !this.data.canOperate
            || this._pageRevision !== (0, matchmaker_page_cache_1.matchmakerPageSnapshotRevision)())
            return;
        const snapshot = {
            list: this.data.list.map(row => pickedRow(row, [
                'id', 'idText', 'title', 'status', 'eventDate', 'eventDateText', 'locationText',
                'statusText', 'canInvite', 'participantText', 'seatText', 'priceText', 'maxParticipants', 'currentParticipants'
            ])),
            members: this.data.members.map(row => pickedRow(row, ['id', 'userId', 'realName', 'nickname'])),
            active: this.data.active, memberOptions: this.data.memberOptions,
            selectedMemberIndex: this.data.selectedMemberIndex, selectedMemberName: this.data.selectedMemberName,
            managingEventId: this.data.managingEventId, shareCode: this.data.shareCode,
            initialized: true, canOperate: this.data.canOperate,
            statusText: this.data.statusText, statusTagClass: this.data.statusTagClass, statusNote: this.data.statusNote,
            refreshError: this.data.refreshError, loadedActive: this._pageLoadedActive,
            inviteMembersLoadedAt: this._inviteMembersLoadedAt
        };
        (0, matchmaker_page_cache_1.writeMatchmakerPageSnapshot)(PAGE_ROUTE, snapshot, this._pageLoadedAt);
    },
    clearRestrictedView(note = '访问权限已变化，请重新加载。') {
        this._pageLoadedAt = 0;
        this._pageInitialized = false;
        (0, matchmaker_page_cache_1.invalidateMatchmakerPageSnapshots)();
        this._pageRevision = (0, matchmaker_page_cache_1.matchmakerPageSnapshotRevision)();
        this._pageGeneration += 1;
        this._pagePending = null;
        this._pagePendingKey = '';
        this._inviteMembersGeneration += 1;
        this._inviteMembersPromise = null;
        this._inviteMembersLoadedAt = 0;
        this.setData({
            list: [], members: [], memberOptions: [], selectedMemberIndex: 0, selectedMemberName: '',
            managingEventId: '', shareCode: '', canOperate: false, initialized: false, refreshError: '', loading: false,
            loadingMembers: false, memberOptionsError: '',
            statusText: '待核验', statusTagClass: 'rose', statusNote: note
        });
    },
    markWriteRefresh() {
        (0, matchmaker_page_cache_1.invalidateMatchmakerPageSnapshots)();
        this._pageRevision = (0, matchmaker_page_cache_1.matchmakerPageSnapshotRevision)();
        this._pageLoadedAt = Date.now() - matchmaker_page_cache_1.MATCHMAKER_PAGE_TTL_MS;
        this._pageGeneration += 1;
        this._pagePending = null;
        this._pagePendingKey = '';
        this._forceNextShow = true;
        this._inviteMembersGeneration += 1;
        this._inviteMembersPromise = null;
        this._inviteMembersLoadedAt = 0;
        this.setData({ loadingMembers: false });
    },
    isPageCurrent(scope, generation, active, revision) {
        return !this._pageUnloaded && this.ensurePageSession() === scope
            && (generation === undefined || this._pageGeneration === generation)
            && (active === undefined || this.data.active === active)
            && (revision === undefined || (0, matchmaker_page_cache_1.matchmakerPageSnapshotRevision)() === revision);
    },
    refreshGate(force = true) {
        const scope = this.ensurePageSession();
        if (!scope || this._pageUnloaded)
            return Promise.resolve();
        const active = this.data.active;
        const key = `${scope}:${active}`;
        if (force === false && this._pagePending && this._pagePendingKey === key)
            return this._pagePending;
        if (force === false && this._pageInitialized && this._pageLoadedActive === active
            && Date.now() - this._pageLoadedAt < matchmaker_page_cache_1.MATCHMAKER_PAGE_TTL_MS)
            return Promise.resolve();
        const generation = ++this._pageGeneration;
        const revision = (0, matchmaker_page_cache_1.matchmakerPageSnapshotRevision)();
        const isCurrent = () => this.isPageCurrent(scope, generation, active, revision);
        this.setData({ loading: force !== false || !this.data.initialized });
        const promise = (async () => {
            await Promise.resolve();
            try {
                const dashboardSnapshot = await (0, matchmaker_page_cache_1.requestMatchmakerPageSnapshot)('/matchmaker/dashboard', async () => {
                    try {
                        return await matchmaker_1.matchmakerApi.dashboard(false);
                    }
                    catch (err) {
                        if (!missingMatchmaker(err))
                            throw err;
                        if (!isCurrent())
                            throw new matchmaker_page_cache_1.MatchmakerPageRequestDiscarded();
                        await matchmaker_1.matchmakerApi.apply();
                        if (!isCurrent())
                            throw new matchmaker_page_cache_1.MatchmakerPageRequestDiscarded();
                        return matchmaker_1.matchmakerApi.dashboard();
                    }
                }, force !== false, isCurrent);
                if (!isCurrent())
                    return;
                const dashboard = dashboardSnapshot.data;
                const view = certificationView(dashboard.matchmaker);
                if (!view.canOperate) {
                    this.clearRestrictedView(view.statusNote);
                    this.setData(view);
                    return;
                }
                this.setData({ ...view, shareCode: String(dashboard.matchmaker?.inviteCode || '') });
                const events = await (active === 'all'
                    ? salon_1.salonApi.list({ page: 1, pageSize: 50 }) : salon_1.salonApi.myEvents({ page: 1, pageSize: 50 }));
                if (!isCurrent())
                    return;
                const list = (events.list || []).map(normalizeSalonRow);
                this.setData({ list, initialized: true, refreshError: '',
                    managingEventId: list.some((row) => row.idText === this.data.managingEventId)
                        ? this.data.managingEventId : '' });
                this._pageInitialized = true;
                this._pageLoadedActive = active;
                this._pageLoadedAt = Date.now();
                this.savePageSnapshot();
                if (active === 'mine' && this.data.managingEventId)
                    void this.loadInviteMembers();
            }
            catch (err) {
                if (!isCurrent() || err instanceof matchmaker_page_cache_1.MatchmakerPageRequestDiscarded)
                    return;
                console.warn('refresh matchmaker salon gate failed', err);
                if (denied(err))
                    this.clearRestrictedView();
                else {
                    this._pageLoadedAt = Date.now() - matchmaker_page_cache_1.MATCHMAKER_PAGE_TTL_MS;
                    this.setData({ refreshError: '暂时无法更新，请重试。',
                        statusNote: this._pageInitialized ? this.data.statusNote : '暂时无法连接服务，请重新加载。' });
                    this.savePageSnapshot();
                }
            }
            finally {
                if (this.isPageCurrent(scope, generation, undefined, revision)) {
                    this.setData({ loading: false });
                    this._pagePending = null;
                    this._pagePendingKey = '';
                }
            }
        })();
        this._pagePending = promise;
        this._pagePendingKey = key;
        return promise;
    },
    loadMembers() {
        return this.loadInviteMembers(true);
    },
    loadInviteMembers(force = false) {
        const scope = this.ensurePageSession();
        if (!scope || !this.data.canOperate || this.data.active !== 'mine' || !this.data.managingEventId)
            return Promise.resolve();
        if (force === false && this._inviteMembersPromise)
            return this._inviteMembersPromise;
        if (force === false && this._inviteMembersLoadedAt > 0
            && Date.now() - this._inviteMembersLoadedAt < matchmaker_page_cache_1.MATCHMAKER_PAGE_TTL_MS)
            return Promise.resolve();
        const generation = ++this._inviteMembersGeneration;
        const revision = (0, matchmaker_page_cache_1.matchmakerPageSnapshotRevision)();
        const isCurrent = () => this.isPageCurrent(scope, undefined, undefined, revision)
            && generation === this._inviteMembersGeneration;
        this.setData({ loadingMembers: true, memberOptionsError: '' });
        const promise = Promise.resolve().then(async () => {
            try {
                const rows = [];
                const seen = new Set();
                let page = 1;
                let total = 0;
                do {
                    const result = await member_1.memberApi.inviteOptions({ page, pageSize: 100 });
                    if (!isCurrent())
                        return;
                    const incoming = result.list || [];
                    const previousLength = rows.length;
                    incoming.forEach(row => {
                        if (!seen.has(String(row.id))) {
                            seen.add(String(row.id));
                            rows.push(row);
                        }
                    });
                    total = Number(result.total || 0);
                    if (!incoming.length || rows.length === previousLength)
                        break;
                    page += 1;
                } while (rows.length < total);
                if (!isCurrent())
                    return;
                const selected = this.data.members[this.data.selectedMemberIndex];
                const selectedId = selected ? String(selected.userId || selected.id) : '';
                const matchingIndex = rows.findIndex(row => String(row.userId || row.id) === selectedId);
                const index = matchingIndex >= 0 ? matchingIndex : Math.min(this.data.selectedMemberIndex, Math.max(rows.length - 1, 0));
                const member = rows[index];
                this._inviteMembersLoadedAt = Date.now();
                this.setData({ members: rows, memberOptions: rows.map(row => row.realName || row.nickname || '我的会员'),
                    selectedMemberIndex: index, selectedMemberName: member ? (member.realName || member.nickname || '我的会员') : '' });
                this.savePageSnapshot();
            }
            catch (err) {
                if (!isCurrent())
                    return;
                if (denied(err))
                    this.clearRestrictedView();
                else {
                    this._inviteMembersLoadedAt = 0;
                    this.setData({ memberOptionsError: '邀请名单暂时无法更新，请重试。' });
                }
            }
            finally {
                if (isCurrent())
                    this.setData({ loadingMembers: false });
                if (this._inviteMembersPromise === promise)
                    this._inviteMembersPromise = null;
            }
        });
        this._inviteMembersPromise = promise;
        return promise;
    },
    onInviteMemberChange(e) {
        const index = Number(e.detail.value || 0);
        const selected = this.data.members[index];
        this.setData({
            selectedMemberIndex: index,
            selectedMemberName: selected ? (selected.realName || selected.nickname || '我的会员') : ''
        });
    },
    toggleEventManagement(e) {
        if (!this.ensurePageSession() || !this.data.canOperate || this.data.active !== 'mine')
            return;
        const id = String(e.currentTarget.dataset.id || '');
        if (!this.data.list.some(item => String(item.id) === id))
            return;
        this.setData({ managingEventId: this.data.managingEventId === id ? '' : id });
        if (this.data.managingEventId)
            return this.loadInviteMembers();
        return Promise.resolve();
    },
    loadMine(force = true) {
        this.setData({ active: 'mine' });
        return this.refreshGate(force);
    },
    loadAll(force = true) {
        this.setData({ active: 'all' });
        return this.refreshGate(force);
    },
    goCreate() {
        if (!this.ensurePageSession())
            return;
        if (!this.data.canOperate) {
            wx.showToast({ title: '主理人认证通过后可创建沙龙', icon: 'none' });
            return;
        }
        this._forceNextShow = true;
        wx.navigateTo({ url: '/pages/matchmaker/salon-form' });
    },
    async applyAgain() {
        const scope = this.ensurePageSession();
        if (!scope)
            return;
        if (this.data.loading)
            return;
        this.setData({ loading: true });
        try {
            await matchmaker_1.matchmakerApi.apply();
            if (!this.isPageCurrent(scope))
                return;
            this.markWriteRefresh();
            wx.showToast({ title: '已重新提交' });
            await this.refreshGate();
        }
        catch (err) {
            if (!this.isPageCurrent(scope))
                return;
            if (denied(err))
                this.clearRestrictedView();
            console.warn('apply matchmaker failed', err);
        }
        finally {
            if (this.isPageCurrent(scope))
                this.setData({ loading: false });
        }
    },
    async inviteSelected(e) {
        const scope = this.ensurePageSession();
        if (!scope || !this.data.canOperate || this.data.loadingMembers)
            return;
        const id = e.currentTarget.dataset.id;
        const member = this.data.members[this.data.selectedMemberIndex];
        if (!id || !member) {
            wx.showToast({ title: '请先选择会员', icon: 'none' });
            return;
        }
        this.setData({ invitingId: `${id}:one` });
        try {
            await salon_1.salonApi.invite(id, [Number(member.userId || member.id)]);
            if (!this.isPageCurrent(scope))
                return;
            this.markWriteRefresh();
            wx.showToast({ title: '已推送会员' });
            await this.refreshGate(true);
        }
        catch (err) {
            if (!this.isPageCurrent(scope))
                return;
            if (denied(err))
                this.clearRestrictedView();
            console.warn('invite selected member failed', err);
        }
        finally {
            if (this.isPageCurrent(scope))
                this.setData({ invitingId: '' });
        }
    },
    async inviteAll(e) {
        const scope = this.ensurePageSession();
        if (!scope || !this.data.canOperate || this.data.loadingMembers)
            return;
        const id = e.currentTarget.dataset.id;
        if (!id || !this.data.members.length) {
            wx.showToast({ title: '暂无可推送会员', icon: 'none' });
            return;
        }
        this.setData({ invitingId: `${id}:all` });
        try {
            await salon_1.salonApi.invite(id, [], true);
            if (!this.isPageCurrent(scope))
                return;
            this.markWriteRefresh();
            wx.showToast({ title: '已推送全部' });
            await this.refreshGate(true);
        }
        catch (err) {
            if (!this.isPageCurrent(scope))
                return;
            if (denied(err))
                this.clearRestrictedView();
            console.warn('invite all members failed', err);
        }
        finally {
            if (this.isPageCurrent(scope))
                this.setData({ invitingId: '' });
        }
    },
    async cancel(e) {
        const scope = this.ensurePageSession();
        if (!scope || !this.data.canOperate)
            return;
        const id = e.currentTarget.dataset.id;
        if (!id)
            return;
        wx.showModal({
            title: '确认取消活动',
            content: '取消后该沙龙将不再接受报名。',
            confirmText: '取消活动',
            confirmColor: '#963b35',
            success: async (res) => {
                if (!res.confirm || !this.isPageCurrent(scope))
                    return;
                this.setData({ cancellingId: String(id) });
                try {
                    await salon_1.salonApi.cancelEvent(id);
                    if (!this.isPageCurrent(scope))
                        return;
                    this.markWriteRefresh();
                    wx.showToast({ title: '已取消' });
                    await this.loadMine();
                }
                catch (err) {
                    if (!this.isPageCurrent(scope))
                        return;
                    if (denied(err))
                        this.clearRestrictedView();
                    console.warn('cancel salon event failed', err);
                }
                finally {
                    if (this.isPageCurrent(scope))
                        this.setData({ cancellingId: '' });
                }
            }
        });
    },
    onShareAppMessage(options) {
        if (!this.ensurePageSession() || !this.data.canOperate)
            return {
                title: '邀请你注册成为会员', path: '/pages/user/members'
            };
        const dataset = options && options.target && options.target.dataset ? options.target.dataset : {};
        const eventId = dataset.id || '';
        const title = dataset.title || '沙龙活动';
        const code = this.data.shareCode || '';
        const event = this.data.list.find(row => String(row.id) === String(eventId));
        if (event && (0, salon_availability_1.salonAvailability)(event).canRegister) {
            return {
                title: `邀请你报名沙龙《${title}》`,
                path: `/pages/user/salon-detail?id=${encodeURIComponent(String(eventId))}&source=salonShare`
            };
        }
        return {
            title: '邀请你注册成为会员',
            path: code ? (0, invite_1.invitePath)(code, 'matchmakerShare') : '/pages/user/members'
        };
    }
});
