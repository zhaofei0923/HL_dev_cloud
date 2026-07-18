"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const member_1 = require("../../services/member");
const member_format_1 = require("../../utils/member-format");
const matchmaker_1 = require("../../services/matchmaker");
function normalizeMember(row) {
    return (0, member_format_1.normalizeMemberProfile)(row, true);
}
function memberName(member) {
    return member ? (member.displayName || member.realName || member.nickname || '会员') : '';
}
function memberOption(member) {
    const name = memberName(member);
    const meta = member && member.metaText ? ` · ${member.metaText}` : '';
    return `${name}${meta}`;
}
function recommendCard(member) {
    if (!member)
        return {};
    return {
        id: member.id,
        name: memberName(member),
        metaText: member.metaText || '基础信息待完善',
        occupationText: member.occupationText || '职业待完善',
        completionText: member.profileCompletionText || '0%',
        statusText: member.lastRecommendStatusText || '暂无推荐'
    };
}
function recommendState(list, sourceIndex = 0, targetIndex = 0) {
    const members = Array.isArray(list) ? list : [];
    const safeSourceIndex = members.length ? Math.min(Math.max(sourceIndex, 0), members.length - 1) : 0;
    const source = members[safeSourceIndex] || null;
    const targets = source ? members.filter(item => String(item.id) !== String(source.id)) : [];
    const safeTargetIndex = targets.length ? Math.min(Math.max(targetIndex, 0), targets.length - 1) : 0;
    const target = targets[safeTargetIndex] || null;
    return {
        recommendAIndex: safeSourceIndex,
        recommendBIndex: safeTargetIndex,
        recommendAOptions: members.map(memberOption),
        recommendBOptions: targets.map(memberOption),
        recommendA: recommendCard(source),
        recommendB: recommendCard(target),
        recommendReady: !!source && !!target,
        recommendHint: members.length >= 2 ? '选择两名会员后可发起待跟进互推。' : '至少需要两名名下会员。'
    };
}
function normalizeRequest(row) {
    const user = row.user || {};
    const profile = row.profile || {};
    const ageText = profile.age ? `${profile.age}岁` : '年龄待补充';
    const cityText = profile.city || '城市待补充';
    return {
        ...row,
        idText: String(row.id || ''),
        displayName: profile.realName || user.nickname || '待完善会员',
        metaText: `${cityText} · ${ageText}`,
        noteText: row.applyMessage || '申请添加为你的名下会员'
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
            statusNote: '主理人权限已开通，可录入会员并进入资源池协作。'
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
        statusNote: '主理人申请通过后，才可使用会员经营和资源池功能。'
    };
}
Page({
    data: {
        list: [],
        total: 0,
        keyword: '',
        city: '',
        gender: '',
        memberType: '',
        serviceLevel: '',
        memberTypeOptions: ['全部类型', '待消费会员', '免费会员', '付费会员', 'VIP会员'],
        memberTypeValues: ['', 'no_consumption', 'free', 'paid', 'vip'],
        serviceLevelOptions: ['全部等级', 'S级', 'A级', 'B级', 'C级'],
        serviceLevelValues: ['', 'S', 'A', 'B', 'C'],
        memberTypeLabel: '全部类型',
        serviceLevelLabel: '全部等级',
        pendingRequests: [],
        requestProcessingId: '',
        recommendAIndex: 0,
        recommendBIndex: 0,
        recommendAOptions: [],
        recommendBOptions: [],
        recommendA: {},
        recommendB: {},
        recommendReady: false,
        recommendHint: '至少需要两名名下会员。',
        recommendLoading: false,
        loading: false,
        removingId: '',
        canOperate: false,
        statusText: '待审批',
        statusTagClass: '',
        statusNote: '主理人申请通过后，才可使用会员经营和资源池功能。'
    },
    onShow() {
        this.refreshGate();
    },
    async refreshGate() {
        this.setData({ loading: true });
        try {
            let dashboard;
            try {
                dashboard = await matchmaker_1.matchmakerApi.dashboard(false);
            }
            catch (err) {
                await matchmaker_1.matchmakerApi.apply();
                dashboard = await matchmaker_1.matchmakerApi.dashboard();
            }
            const view = certificationView(dashboard.matchmaker);
            this.setData({
                canOperate: view.canOperate,
                statusText: view.statusText,
                statusTagClass: view.statusTagClass,
                statusNote: view.statusNote
            });
            if (view.canOperate) {
                await this.load();
            }
            else {
                this.setData({ list: [], total: 0, pendingRequests: [] });
            }
        }
        catch (err) {
            console.warn('refresh matchmaker member gate failed', err);
            this.setData({
                list: [],
                total: 0,
                pendingRequests: [],
                canOperate: false,
                statusText: '云服务未连接',
                statusTagClass: 'rose',
                statusNote: '请确认 hlApi 云函数已部署后重试。'
            });
        }
        finally {
            this.setData({ loading: false });
        }
    },
    async load() {
        if (!this.data.canOperate)
            return;
        this.setData({ loading: true });
        try {
            const result = await member_1.memberApi.list({
                page: 1,
                pageSize: 50,
                keyword: this.data.keyword,
                city: this.data.city,
                gender: this.data.gender,
                memberType: this.data.memberType,
                serviceLevel: this.data.serviceLevel
            });
            const list = (result.list || []).map((row) => normalizeMember(row));
            this.setData({
                list,
                total: Number(result.total || list.length || 0),
                ...recommendState(list, this.data.recommendAIndex, this.data.recommendBIndex)
            });
            await this.loadRequests();
        }
        catch (err) {
            console.warn('load matchmaker members failed', err);
            this.setData({ list: [], total: 0, ...recommendState([]) });
        }
        finally {
            this.setData({ loading: false });
        }
    },
    async loadRequests() {
        if (!this.data.canOperate)
            return;
        try {
            const result = await matchmaker_1.matchmakerApi.memberRequests({ status: 'pending', page: 1, pageSize: 20 }, false);
            this.setData({ pendingRequests: (result.list || []).map((row) => normalizeRequest(row)) });
        }
        catch (err) {
            console.warn('load member requests failed', err);
            this.setData({ pendingRequests: [] });
        }
    },
    async approveRequest(e) {
        const id = e.currentTarget.dataset.id;
        if (!id || this.data.requestProcessingId)
            return;
        this.setData({ requestProcessingId: String(id) });
        try {
            await matchmaker_1.matchmakerApi.approveMemberRequest(id);
            wx.showToast({ title: '已通过申请' });
            await this.load();
        }
        catch (err) {
            console.warn('approve member request failed', err);
        }
        finally {
            this.setData({ requestProcessingId: '' });
        }
    },
    rejectRequest(e) {
        const id = e.currentTarget.dataset.id;
        if (!id || this.data.requestProcessingId)
            return;
        wx.showModal({
            title: '拒绝申请',
            content: '拒绝后会员可重新提交申请。',
            confirmText: '拒绝',
            confirmColor: '#963b35',
            success: async (res) => {
                if (!res.confirm)
                    return;
                this.setData({ requestProcessingId: String(id) });
                try {
                    await matchmaker_1.matchmakerApi.rejectMemberRequest(id);
                    wx.showToast({ title: '已拒绝' });
                    await this.loadRequests();
                }
                catch (err) {
                    console.warn('reject member request failed', err);
                }
                finally {
                    this.setData({ requestProcessingId: '' });
                }
            }
        });
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
    onMemberTypeChange(e) {
        const index = Number(e.detail.value);
        this.setData({
            memberType: this.data.memberTypeValues[index],
            memberTypeLabel: this.data.memberTypeOptions[index]
        });
        this.load();
    },
    onServiceLevelChange(e) {
        const index = Number(e.detail.value);
        this.setData({
            serviceLevel: this.data.serviceLevelValues[index],
            serviceLevelLabel: this.data.serviceLevelOptions[index]
        });
        this.load();
    },
    clearFilters() {
        this.setData({
            keyword: '',
            city: '',
            gender: '',
            memberType: '',
            serviceLevel: '',
            memberTypeLabel: '全部类型',
            serviceLevelLabel: '全部等级'
        });
        this.load();
    },
    onRecommendAChange(e) {
        const index = Number(e.detail.value || 0);
        this.setData(recommendState(this.data.list, index, 0));
    },
    onRecommendBChange(e) {
        const index = Number(e.detail.value || 0);
        this.setData(recommendState(this.data.list, this.data.recommendAIndex, index));
    },
    async recommendInternal() {
        const source = this.data.recommendA;
        const target = this.data.recommendB;
        if (!source.id || !target.id) {
            wx.showToast({ title: '至少选择两名会员', icon: 'none' });
            return;
        }
        if (this.data.recommendLoading)
            return;
        this.setData({ recommendLoading: true });
        try {
            const result = await member_1.memberApi.recommend({
                mode: 'internal',
                myMemberId: source.id,
                targetMemberId: target.id,
                note: `${source.name} 与 ${target.name} 条件较匹配，进入互推待跟进。`
            });
            wx.showToast({ title: result && result.duplicated ? '已有待跟进互推' : '互推已创建' });
            await this.load();
        }
        catch (err) {
            console.warn('internal recommend failed', err);
        }
        finally {
            this.setData({ recommendLoading: false });
        }
    },
    goAdd() {
        wx.navigateTo({ url: '/pages/matchmaker/member-form' });
    },
    goResources() {
        wx.navigateTo({ url: '/pages/matchmaker/resources' });
    },
    async applyAgain() {
        if (this.data.loading)
            return;
        this.setData({ loading: true });
        try {
            await matchmaker_1.matchmakerApi.apply();
            wx.showToast({ title: '已重新提交' });
            await this.refreshGate();
        }
        catch (err) {
            console.warn('apply matchmaker failed', err);
        }
        finally {
            this.setData({ loading: false });
        }
    },
    openDetail(e) {
        const id = String(e.currentTarget.dataset.id || '');
        const member = this.data.list.find((item) => String(item.id) === id);
        if (!member)
            return;
        wx.setStorageSync('selectedMatchmakerMember', member);
        wx.navigateTo({ url: `/pages/matchmaker/member-detail?id=${id}&scope=own` });
    },
    async remove(e) {
        const id = e.currentTarget.dataset.id;
        if (!id)
            return;
        wx.showModal({
            title: '确认移除会员',
            content: '移除后该会员将不再出现在你的经营列表中。',
            confirmText: '移除',
            confirmColor: '#963b35',
            success: async (res) => {
                if (!res.confirm)
                    return;
                this.setData({ removingId: id });
                try {
                    await member_1.memberApi.remove(id);
                    wx.showToast({ title: '已移除' });
                    await this.load();
                }
                catch (err) {
                    console.warn('remove member failed', err);
                }
                finally {
                    this.setData({ removingId: '' });
                }
            }
        });
    }
});
