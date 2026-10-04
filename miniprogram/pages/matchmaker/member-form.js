"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const member_1 = require("../../services/member");
const api_1 = require("../../services/api");
const local_image_1 = require("../../utils/local-image");
const profile_options_1 = require("../../utils/profile-options");
const member_intake_1 = require("../../utils/member-intake");
const GENDER_OPTIONS = ['男', '女'];
const GENDER_VALUES = ['1', '2'];
const EDUCATION_OPTIONS = ['大专', '本科', '硕士', '博士', '其他'];
const PARTNER_EDUCATION_OPTIONS = ['不限', ...EDUCATION_OPTIONS];
const MARITAL_OPTIONS = ['未婚', '离异', '丧偶'];
const FINANCIAL_ASSET_OPTIONS = ['50万以内', '50–200万', '200–500万', '500万–1000万', '千万以上'];
const FINANCIAL_ASSET_VALUES = ['under_500k', '500k_2m', '2m_5m', '5m_10m', 'over_10m'];
const SMOKING_OPTIONS = ['是', '否'];
const SMOKING_VALUES = ['yes', 'no'];
const DRINKING_OPTIONS = ['经常', '偶尔', '从不'];
const DRINKING_VALUES = ['frequent', 'occasional', 'never'];
const INCOME_SOURCE_OPTIONS = [
    { label: '工资', value: 'salary' },
    { label: '企业经营', value: 'business' },
    { label: '投资收益', value: 'investment' },
    { label: '其他', value: 'other' }
];
const EVIDENCE_OPTIONS = [
    { label: '工资流水截图', value: 'salary_statement' },
    { label: '企业经营证明', value: 'business_proof' },
    { label: '个税记录', value: 'tax_record' },
    { label: '其他资产证明', value: 'other_asset_proof' }
];
const PROPERTY_PROOF_OPTIONS = [
    { label: '房产证照片', value: 'property_certificate' },
    { label: '购房合同', value: 'purchase_contract' }
];
const VEHICLE_PROOF_OPTIONS = [
    { label: '行驶证照片', value: 'vehicle_license' }
];
const PARTNER_MARITAL_OPTIONS = [
    { label: '不限', value: '不限' },
    { label: '未婚', value: '未婚' },
    { label: '离异', value: '离异' },
    { label: '丧偶', value: '丧偶' }
];
const CUSTOMER_SOURCE_OPTIONS = [
    { label: '短视频', value: 'short_video' },
    { label: '小红书', value: 'xiaohongshu' },
    { label: '活动报名', value: 'event_registration' },
    { label: '朋友转介绍', value: 'friend_referral' },
    { label: 'BOSS / 其他渠道', value: 'boss_or_other' }
];
const PACKAGE_OPTIONS = [
    { label: '未付费', value: 'unpaid' },
    { label: '9980 三个月', value: '9980_3m' },
    { label: '其他套餐', value: 'other' }
];
const TAG_OPTIONS = [
    { label: '高净值', value: '高净值' },
    { label: '颜值优先', value: '颜值优先' },
    { label: '急脱单', value: '急脱单' },
    { label: '谨慎型', value: '谨慎型' }
];
const INTAKE_STAGES = [
    {
        no: '01',
        key: 'identity',
        short: '身份验资',
        title: '身份与验资',
        note: '基础信息、职业收入与资产存档',
        sections: ['basic', 'career', 'assets']
    },
    {
        no: '02',
        key: 'matching',
        short: '个人择偶',
        title: '个人与择偶',
        note: '生活方式、内部照片与匹配边界',
        sections: ['personal', 'partner']
    },
    {
        no: '03',
        key: 'operations',
        short: '业务确认',
        title: '业务与确认',
        note: '客户来源、服务周期与合规确认',
        sections: ['business', 'compliance']
    }
];
function optionLabel(options, value, placeholder) {
    const match = options.find(item => item.value === String(value || ''));
    return match ? match.label : placeholder;
}
function scalarLabel(options, value, placeholder) {
    const text = String(value || '');
    return options.includes(text) ? text : placeholder;
}
function updatePath(source, path, value) {
    const keys = path.split('.').filter(Boolean);
    if (!keys.length)
        return source;
    const next = { ...source };
    let nextCursor = next;
    let sourceCursor = source;
    keys.forEach((key, index) => {
        if (index === keys.length - 1) {
            nextCursor[key] = value;
            return;
        }
        const sourceChild = sourceCursor && typeof sourceCursor[key] === 'object' ? sourceCursor[key] : {};
        const nextChild = { ...sourceChild };
        nextCursor[key] = nextChild;
        nextCursor = nextChild;
        sourceCursor = sourceChild;
    });
    return next;
}
function sectionForField(field) {
    if (field.startsWith('assetVerification.'))
        return 'assets';
    if (field.startsWith('personalProfile.'))
        return 'personal';
    if (field.startsWith('partnerPreferences.'))
        return 'partner';
    if (field.startsWith('businessRegistration.'))
        return 'business';
    if (field.startsWith('compliance.'))
        return 'compliance';
    if ([
        'occupation',
        'companyName',
        'jobTitle',
        'annualIncomePreTax',
        'incomeSources',
        'otherIncomeSource',
        'verificationEvidenceTypes',
        'verificationCredentialLocation'
    ].includes(field))
        return 'career';
    return 'basic';
}
function stageIndexForSection(section) {
    const index = INTAKE_STAGES.findIndex(stage => stage.sections.includes(section));
    return index >= 0 ? index : 0;
}
function stageIndexForError(error) {
    return stageIndexForSection(sectionForField(error.field));
}
function stageProgressView(form, currentStageIndex) {
    const errorsByStage = INTAKE_STAGES.map(() => 0);
    (0, member_intake_1.validateMemberIntake)(form).errors.forEach(error => {
        errorsByStage[stageIndexForError(error)] += 1;
    });
    const stageNav = INTAKE_STAGES.map((stage, index) => ({
        ...stage,
        active: index === currentStageIndex,
        complete: errorsByStage[index] === 0,
        statusText: errorsByStage[index] === 0 ? '已完成' : `${errorsByStage[index]}项待补充`
    }));
    const current = stageNav[currentStageIndex] || stageNav[0];
    const pendingCount = errorsByStage[currentStageIndex] || 0;
    return {
        stageNav,
        currentStageKey: current.key,
        currentStageNo: current.no,
        currentStageTitle: current.title,
        currentStageNote: current.note,
        currentStageComplete: pendingCount === 0,
        currentStageStatusText: pendingCount === 0 ? '本阶段已完成' : `本阶段还需补充 ${pendingCount} 项`,
        nextStageLabel: currentStageIndex < INTAKE_STAGES.length - 1
            ? INTAKE_STAGES[currentStageIndex + 1].short
            : ''
    };
}
function sessionTimeText(date = new Date()) {
    const hour = String(date.getHours()).padStart(2, '0');
    const minute = String(date.getMinutes()).padStart(2, '0');
    return `${hour}:${minute}`;
}
function derivedView(form, lifePhotoDisplayUrls, currentStageIndex) {
    const business = form.businessRegistration || {};
    const assets = form.assetVerification || {};
    const personal = form.personalProfile || {};
    const photos = Array.isArray(personal.lifePhotos) ? personal.lifePhotos : [];
    return {
        genderText: Number(form.gender) === 1 ? '男' : Number(form.gender) === 2 ? '女' : '请选择',
        birthDateText: form.birthDate || '请选择日期',
        ageText: form.age ? `${form.age} 岁` : '选择出生年月后自动计算',
        cityText: form.city || '请选择省 / 市 / 区',
        educationText: scalarLabel(EDUCATION_OPTIONS, form.education, '请选择学历'),
        maritalText: scalarLabel(MARITAL_OPTIONS, form.maritalStatus, '请选择婚姻状态'),
        financialAssetText: FINANCIAL_ASSET_OPTIONS[FINANCIAL_ASSET_VALUES.indexOf(String(assets.financialAssetRange || ''))] || '请选择区间',
        smokingText: SMOKING_OPTIONS[SMOKING_VALUES.indexOf(String(personal.smokingStatus || ''))] || '请选择',
        drinkingText: DRINKING_OPTIONS[DRINKING_VALUES.indexOf(String(personal.drinkingStatus || ''))] || '请选择',
        partnerEducationText: scalarLabel(PARTNER_EDUCATION_OPTIONS, (form.partnerPreferences || {}).educationMinimum, '请选择学历底线'),
        customerSourceText: optionLabel(CUSTOMER_SOURCE_OPTIONS, business.customerSource, '请选择来源'),
        packageText: optionLabel(PACKAGE_OPTIONS, business.packageType, '请选择套餐'),
        expiryDateText: business.expiryDate || (business.packageType === 'unpaid' ? '无到期日' : '请选择日期'),
        hasOtherIncomeSource: Array.isArray(form.incomeSources) && form.incomeSources.includes('other'),
        hasProperty: Number(assets.propertyCount || 0) > 0,
        hasVehicle: Number(assets.vehicleCount || 0) > 0,
        lifePhotoCount: photos.length,
        lifePhotoDisplayUrls,
        ...stageProgressView(form, currentStageIndex)
    };
}
function currentOperator() {
    const user = (0, api_1.currentUser)() || {};
    return {
        id: String(user.id || ''),
        name: String(user.nickname || user.realName || '')
    };
}
Page({
    _pageUnloaded: false,
    _intakeCommitted: false,
    _privateOwnerKey: '',
    _newPrivatePhotoFileIDs: [],
    data: {
        saving: false,
        uploading: false,
        formError: '',
        errorSection: '',
        today: (0, member_intake_1.todayText)(),
        form: (0, member_intake_1.createMemberIntakeDefaults)(''),
        lifePhotoDisplayUrls: [],
        stageNav: INTAKE_STAGES.map((stage, index) => ({
            ...stage,
            active: index === 0,
            complete: false,
            statusText: '待完善'
        })),
        currentStageIndex: 0,
        currentStageKey: INTAKE_STAGES[0].key,
        currentStageNo: INTAKE_STAGES[0].no,
        currentStageTitle: INTAKE_STAGES[0].title,
        currentStageNote: INTAKE_STAGES[0].note,
        currentStageComplete: false,
        currentStageStatusText: '本阶段待完善',
        nextStageLabel: INTAKE_STAGES[1].short,
        draftSavedAt: '',
        draftDirty: false,
        draftStatusText: '内容仅保留在当前页面 · 未正式建档',
        openSections: {
            basic: true,
            career: false,
            assets: false,
            personal: false,
            partner: false,
            business: false,
            compliance: false
        },
        genderOptions: GENDER_OPTIONS,
        educationOptions: EDUCATION_OPTIONS,
        partnerEducationOptions: PARTNER_EDUCATION_OPTIONS,
        maritalOptions: MARITAL_OPTIONS,
        financialAssetOptions: FINANCIAL_ASSET_OPTIONS,
        smokingOptions: SMOKING_OPTIONS,
        drinkingOptions: DRINKING_OPTIONS,
        incomeSourceOptions: INCOME_SOURCE_OPTIONS,
        evidenceOptions: EVIDENCE_OPTIONS,
        propertyProofOptions: PROPERTY_PROOF_OPTIONS,
        vehicleProofOptions: VEHICLE_PROOF_OPTIONS,
        partnerMaritalOptions: PARTNER_MARITAL_OPTIONS,
        customerSourceOptions: CUSTOMER_SOURCE_OPTIONS,
        packageOptions: PACKAGE_OPTIONS,
        tagOptions: TAG_OPTIONS,
        genderText: '请选择',
        birthDateText: '请选择日期',
        ageText: '选择出生年月后自动计算',
        cityText: '请选择省 / 市 / 区',
        educationText: '请选择学历',
        maritalText: '请选择婚姻状态',
        financialAssetText: '请选择区间',
        smokingText: '请选择',
        drinkingText: '请选择',
        partnerEducationText: '请选择学历底线',
        customerSourceText: '请选择来源',
        packageText: '请选择套餐',
        expiryDateText: '请选择日期',
        hasOtherIncomeSource: false,
        hasProperty: false,
        hasVehicle: false,
        lifePhotoCount: 0
    },
    onLoad() {
        const operator = currentOperator();
        this._pageUnloaded = false;
        this._intakeCommitted = false;
        this._privateOwnerKey = operator.id;
        this._newPrivatePhotoFileIDs = [];
        const form = (0, member_intake_1.createMemberIntakeDefaults)(operator.name);
        this.setData({
            form,
            currentStageIndex: 0,
            draftSavedAt: '',
            draftDirty: false,
            draftStatusText: '内容仅保留在当前页面 · 未正式建档',
            ...derivedView(form, [], 0)
        });
    },
    onUnload() {
        this._pageUnloaded = true;
        if (this._intakeCommitted || this.data.saving || !this._newPrivatePhotoFileIDs.length)
            return;
        const fileIDs = this._newPrivatePhotoFileIDs.slice();
        void this.cleanupNewPrivateFiles(fileIDs).catch(err => {
            console.warn('cleanup abandoned private photos failed', err);
        });
    },
    async cleanupNewPrivateFiles(fileIDs) {
        const tracked = new Set(this._newPrivatePhotoFileIDs);
        const targets = Array.from(new Set(fileIDs.filter(fileID => tracked.has(fileID))));
        if (!targets.length)
            return;
        await (0, local_image_1.deleteCloudFiles)(targets);
        const removed = new Set(targets);
        this._newPrivatePhotoFileIDs = this._newPrivatePhotoFileIDs.filter(fileID => !removed.has(fileID));
    },
    setForm(form, extra = {}) {
        const lifePhotoDisplayUrls = extra.lifePhotoDisplayUrls || this.data.lifePhotoDisplayUrls;
        const currentStageIndex = Number.isInteger(extra.currentStageIndex)
            ? Number(extra.currentStageIndex)
            : this.data.currentStageIndex;
        this.setData({
            form,
            formError: '',
            errorSection: '',
            draftDirty: true,
            draftStatusText: this.data.draftSavedAt
                ? '本页草稿有新修改 · 未正式建档'
                : '内容仅保留在当前页面 · 未正式建档',
            ...derivedView(form, lifePhotoDisplayUrls, currentStageIndex),
            ...extra
        });
    },
    setField(path, value) {
        this.setForm(updatePath(this.data.form, path, value));
    },
    onInput(e) {
        const field = String(e.currentTarget.dataset.field || '');
        if (!field)
            return;
        const value = e.detail.value;
        let form = updatePath(this.data.form, field, value);
        const isExplicitZero = String(value).trim() !== '' && Number(value) === 0;
        if (field === 'assetVerification.propertyCount' && isExplicitZero) {
            form = updatePath(form, 'assetVerification.propertyCities', '');
            form = updatePath(form, 'assetVerification.propertyProofTypes', []);
        }
        if (field === 'assetVerification.vehicleCount' && isExplicitZero) {
            form = updatePath(form, 'assetVerification.vehicleModels', '');
            form = updatePath(form, 'assetVerification.vehicleProofTypes', []);
        }
        this.setForm(form);
    },
    onCheckboxChange(e) {
        const field = String(e.currentTarget.dataset.field || '');
        if (!field)
            return;
        const values = Array.isArray(e.detail.value) ? e.detail.value : [];
        let form = updatePath(this.data.form, field, values);
        if (field === 'incomeSources' && !values.includes('other')) {
            form = updatePath(form, 'otherIncomeSource', '');
        }
        this.setForm(form);
    },
    onBooleanRadioChange(e) {
        const field = String(e.currentTarget.dataset.field || '');
        if (!field)
            return;
        const hasChildren = e.detail.value === 'true';
        let form = updatePath(this.data.form, field, hasChildren);
        if (!hasChildren)
            form = updatePath(form, 'childrenCount', 0);
        this.setForm(form);
    },
    onGenderChange(e) {
        this.setField('gender', GENDER_VALUES[Number(e.detail.value)]);
    },
    onBirthDateChange(e) {
        const birthDate = String(e.detail.value || '');
        let form = updatePath(this.data.form, 'birthDate', birthDate);
        form = updatePath(form, 'age', (0, member_intake_1.ageFromBirthDate)(birthDate));
        this.setForm(form);
    },
    onCityChange(e) {
        this.setField('city', (0, profile_options_1.regionValueText)(e.detail.value));
    },
    onEducationChange(e) {
        this.setField('education', EDUCATION_OPTIONS[Number(e.detail.value)]);
    },
    onMaritalChange(e) {
        this.setField('maritalStatus', MARITAL_OPTIONS[Number(e.detail.value)]);
    },
    onFinancialAssetChange(e) {
        this.setField('assetVerification.financialAssetRange', FINANCIAL_ASSET_VALUES[Number(e.detail.value)]);
    },
    onSmokingChange(e) {
        this.setField('personalProfile.smokingStatus', SMOKING_VALUES[Number(e.detail.value)]);
    },
    onDrinkingChange(e) {
        this.setField('personalProfile.drinkingStatus', DRINKING_VALUES[Number(e.detail.value)]);
    },
    onPartnerEducationChange(e) {
        this.setField('partnerPreferences.educationMinimum', PARTNER_EDUCATION_OPTIONS[Number(e.detail.value)]);
    },
    onCustomerSourceChange(e) {
        const option = CUSTOMER_SOURCE_OPTIONS[Number(e.detail.value)];
        if (!option)
            return;
        let form = updatePath(this.data.form, 'businessRegistration.customerSource', option.value);
        if (option.value !== 'boss_or_other') {
            form = updatePath(form, 'businessRegistration.otherCustomerSource', '');
        }
        this.setForm(form);
    },
    onPackageChange(e) {
        const option = PACKAGE_OPTIONS[Number(e.detail.value)];
        if (!option)
            return;
        let form = updatePath(this.data.form, 'businessRegistration.packageType', option.value);
        const joinDate = String((form.businessRegistration || {}).joinDate || '');
        form = updatePath(form, 'businessRegistration.expiryDate', (0, member_intake_1.expiryDateForPackage)(option.value, joinDate));
        if (option.value !== 'other')
            form = updatePath(form, 'businessRegistration.otherPackageName', '');
        this.setForm(form);
    },
    onJoinDateChange(e) {
        const joinDate = String(e.detail.value || '');
        let form = updatePath(this.data.form, 'businessRegistration.joinDate', joinDate);
        const packageType = String((form.businessRegistration || {}).packageType || '');
        if (packageType === '9980_3m' || packageType === 'unpaid') {
            form = updatePath(form, 'businessRegistration.expiryDate', (0, member_intake_1.expiryDateForPackage)(packageType, joinDate));
        }
        this.setForm(form);
    },
    onExpiryDateChange(e) {
        this.setField('businessRegistration.expiryDate', String(e.detail.value || ''));
    },
    onComplianceChange(e) {
        const values = Array.isArray(e.detail.value) ? e.detail.value : [];
        let form = updatePath(this.data.form, 'compliance.partialVerificationConfirmed', values.includes('partialVerificationConfirmed'));
        form = updatePath(form, 'compliance.voluntarySubmissionConfirmed', values.includes('voluntarySubmissionConfirmed'));
        this.setForm(form);
    },
    toggleSection(e) {
        const section = String(e.currentTarget.dataset.section || '');
        if (!section)
            return;
        this.setData({ [`openSections.${section}`]: !this.data.openSections[section] });
    },
    setStage(stageIndex) {
        if (!Number.isInteger(stageIndex) || stageIndex < 0 || stageIndex >= INTAKE_STAGES.length)
            return;
        const stage = INTAKE_STAGES[stageIndex];
        const openSections = { ...this.data.openSections };
        if (!stage.sections.some(section => openSections[section])) {
            openSections[stage.sections[0]] = true;
        }
        this.setData({
            currentStageIndex: stageIndex,
            openSections,
            ...derivedView(this.data.form, this.data.lifePhotoDisplayUrls, stageIndex)
        }, () => {
            wx.pageScrollTo({ scrollTop: 0, duration: 220 });
        });
    },
    switchStage(e) {
        if (this.data.saving || this.data.uploading)
            return;
        this.setStage(Number(e.currentTarget.dataset.stageIndex));
    },
    previousStage() {
        if (this.data.saving || this.data.uploading)
            return;
        this.setStage(this.data.currentStageIndex - 1);
    },
    nextStage() {
        if (this.data.saving || this.data.uploading)
            return;
        if (!this.data.currentStageComplete) {
            wx.showToast({ title: '本阶段未完成，可稍后返回', icon: 'none' });
        }
        this.setStage(this.data.currentStageIndex + 1);
    },
    saveDraft() {
        if (this.data.saving || this.data.uploading)
            return;
        const savedAt = sessionTimeText();
        // High-sensitivity intake data deliberately stays in this Page instance only.
        this.setData({
            draftSavedAt: savedAt,
            draftDirty: false,
            draftStatusText: `已暂存于本页 ${savedAt} · 未正式建档`
        });
        wx.showModal({
            title: '草稿仅保留在本页',
            content: '当前内容未提交到平台，也未正式建档。退出本页面后草稿会清除，临时上传的内部照片也会进入清理流程。',
            showCancel: false,
            confirmText: '知道了'
        });
    },
    async chooseLifePhotos() {
        if (this.data.saving || this.data.uploading)
            return;
        const currentPhotos = Array.isArray(this.data.form.personalProfile.lifePhotos)
            ? this.data.form.personalProfile.lifePhotos
            : [];
        const remaining = member_intake_1.MEMBER_LIFE_PHOTO_MAX - currentPhotos.length;
        if (remaining <= 0) {
            wx.showToast({ title: '生活照最多9张', icon: 'none' });
            return;
        }
        this.setData({ uploading: true });
        try {
            const images = await (0, local_image_1.chooseLocalImages)(remaining, {
                cloudFolder: 'member-private',
                privateOwnerKey: this._privateOwnerKey
            });
            if (!images.length)
                return;
            const uploadedFileIDs = images.map((image) => image.fileID);
            this._newPrivatePhotoFileIDs = Array.from(new Set(this._newPrivatePhotoFileIDs.concat(uploadedFileIDs)));
            if (this._pageUnloaded) {
                try {
                    await this.cleanupNewPrivateFiles(uploadedFileIDs);
                }
                catch (cleanupErr) {
                    console.warn('cleanup photos uploaded after page unload failed', cleanupErr);
                }
                return;
            }
            const nextPhotos = currentPhotos.concat(images.map((image) => image.fileID)).slice(0, member_intake_1.MEMBER_LIFE_PHOTO_MAX);
            const nextDisplayUrls = this.data.lifePhotoDisplayUrls
                .concat(images.map((image) => image.displayUrl))
                .slice(0, member_intake_1.MEMBER_LIFE_PHOTO_MAX);
            const form = updatePath(this.data.form, 'personalProfile.lifePhotos', nextPhotos);
            this.setForm(form, { lifePhotoDisplayUrls: nextDisplayUrls });
        }
        catch (err) {
            if (!this._pageUnloaded && !(0, local_image_1.isImageChooseCancel)(err)) {
                console.warn('upload private life photos failed', err);
                wx.showToast({ title: '照片上传失败，请重试', icon: 'none' });
            }
        }
        finally {
            if (!this._pageUnloaded)
                this.setData({ uploading: false });
        }
    },
    deleteLifePhoto(e) {
        if (this.data.saving || this.data.uploading)
            return;
        const index = Number(e.currentTarget.dataset.index);
        if (!Number.isInteger(index) || index < 0)
            return;
        wx.showModal({
            title: '删除生活照',
            content: '确定从内部档案中移除这张照片吗？',
            confirmText: '删除',
            confirmColor: '#a63831',
            success: result => {
                if (!result.confirm)
                    return;
                void this.removeLifePhoto(index);
            }
        });
    },
    async removeLifePhoto(index) {
        if (this.data.saving || this.data.uploading)
            return;
        const currentPhotos = Array.isArray(this.data.form.personalProfile.lifePhotos)
            ? this.data.form.personalProfile.lifePhotos
            : [];
        const fileID = String(currentPhotos[index] || '');
        if (!fileID)
            return;
        this.setData({ uploading: true });
        try {
            await this.cleanupNewPrivateFiles([fileID]);
            if (this._pageUnloaded)
                return;
            const photos = currentPhotos.filter((_, photoIndex) => photoIndex !== index);
            const displayUrls = this.data.lifePhotoDisplayUrls.filter((_, photoIndex) => photoIndex !== index);
            const form = updatePath(this.data.form, 'personalProfile.lifePhotos', photos);
            this.setForm(form, { lifePhotoDisplayUrls: displayUrls });
        }
        catch (err) {
            if (!this._pageUnloaded) {
                console.warn('delete private life photo failed', err);
                wx.showToast({ title: '照片删除失败，请重试', icon: 'none' });
            }
        }
        finally {
            if (!this._pageUnloaded)
                this.setData({ uploading: false });
        }
    },
    showValidationError(error) {
        const section = sectionForField(error.field);
        const stageIndex = stageIndexForSection(section);
        const openSections = { ...this.data.openSections, [section]: true };
        this.setData({
            currentStageIndex: stageIndex,
            formError: error.message,
            errorSection: section,
            openSections,
            ...derivedView(this.data.form, this.data.lifePhotoDisplayUrls, stageIndex)
        }, () => {
            wx.showToast({ title: error.message, icon: 'none', duration: 2600 });
            wx.pageScrollTo({ selector: `#section-${section}`, duration: 280 });
        });
    },
    async save() {
        if (this.data.saving || this.data.uploading)
            return;
        const validation = (0, member_intake_1.validateMemberIntake)(this.data.form);
        if (!validation.valid && validation.firstError) {
            this.showValidationError(validation.firstError);
            return;
        }
        this.setData({ saving: true, formError: '', errorSection: '' });
        try {
            const member = await member_1.memberApi.addManual((0, member_intake_1.buildMemberIntakePayload)(this.data.form));
            this._intakeCommitted = true;
            this._newPrivatePhotoFileIDs = [];
            if (this._pageUnloaded)
                return;
            wx.showModal({
                title: '会员档案已保存',
                content: member && member.memberNo ? `会员编号：${member.memberNo}` : '会员编号已由系统生成',
                showCancel: false,
                confirmText: '完成',
                success: () => wx.navigateBack()
            });
        }
        catch (err) {
            if (this._pageUnloaded) {
                try {
                    await this.cleanupNewPrivateFiles(this._newPrivatePhotoFileIDs.slice());
                }
                catch (cleanupErr) {
                    console.warn('cleanup private photos after failed save failed', cleanupErr);
                }
            }
            else {
                console.warn('save member intake failed', err);
            }
        }
        finally {
            if (!this._pageUnloaded)
                this.setData({ saving: false });
        }
    }
});
