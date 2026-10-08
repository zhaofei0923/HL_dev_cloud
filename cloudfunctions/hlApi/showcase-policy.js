'use strict';

const SHOWCASE_CATEGORIES = new Set(['recommend', 'popularity', 'education', 'assets']);
const EDUCATION_RANK = Object.freeze({ '本科': 1, '硕士': 2, '博士': 3 });
const APPLICATION_EDUCATION_LEVELS = new Set(['bachelors', 'master', 'doctor']);
const LEGACY_APPLICATION_EDUCATION_LEVELS = Object.freeze({ '本科': 'bachelors', '硕士': 'master', '博士': 'doctor' });
const FINANCIAL_ASSET_RANK = Object.freeze({
  under_500k: 1, '500k_2m': 2, '2m_5m': 3, '5m_10m': 4, over_10m: 5
});
const EDUCATION_SOURCES = new Set(['chsi', 'cscse']);
const ASSET_SOURCES = new Set(['bank_statement', 'securities_statement', 'combined_financial_statement']);
const CERTIFICATION_KINDS = Object.freeze(['identity', 'education', 'vehicle', 'property', 'assets']);
const OFFLINE_CERTIFICATION_SOURCES = Object.freeze({
  identity: 'identity_document', vehicle: 'vehicle_license', property: 'property_certificate',
  assets: 'combined_financial_statement'
});
const CERTIFICATION_STATUSES = new Set(['approved', 'rejected', 'revoked']);
const EDUCATION_METHODS = new Set(['chsi_code', 'diploma_photo', 'study_proof', 'cscse_number']);
const PRIVATE_CERTIFICATION_FIELDS = [
  'showcaseCertification', 'educationVerification', 'assetVerification',
  'identityVerification', 'vehicleVerification', 'propertyVerification',
  'identityVerified', 'vehicleVerified', 'propertyVerified',
  'educationVerified', 'verifiedEducation', 'assetVerified', 'financialAssetRange',
  'verifiedFinancialAssetRange', 'verificationEvidence', 'evidenceReference',
  'reviewedBy', 'reviewedAt'
];

function policyError(message) {
  const error = new Error(message);
  error.status = 422;
  error.code = 42240;
  return error;
}

function normalizeShowcaseCategory(value) {
  const category = value === undefined || value === null || value === '' ? 'recommend' : String(value);
  if (!SHOWCASE_CATEGORIES.has(category)) throw policyError('请选择有效的推荐分类');
  return category;
}

function assetPreferencePatch(data = {}) {
  const patch = {};
  ['assetCategoryConsent', 'assetRangeDisclosure'].forEach(field => {
    if (!Object.prototype.hasOwnProperty.call(data, field)) return;
    if (typeof data[field] !== 'boolean') throw policyError('资产分类及区间公开选项必须为布尔值');
    patch[field] = data[field] === true;
  });
  return patch;
}

function assetCertificationExpiresAt(review = {}) {
  const reviewedAt = new Date(review.reviewedAt || '').getTime();
  if (!Number.isFinite(reviewedAt)) return '';
  const expiry = new Date(reviewedAt);
  const day = expiry.getUTCDate();
  expiry.setUTCDate(1);
  expiry.setUTCMonth(expiry.getUTCMonth() + 6);
  const lastDay = new Date(Date.UTC(expiry.getUTCFullYear(), expiry.getUTCMonth() + 1, 0)).getUTCDate();
  expiry.setUTCDate(Math.min(day, lastDay));
  // A stored earlier deadline is binding; malformed or missing review dates never renew a legacy result.
  if (review.expiresAt) {
    const explicitExpiry = new Date(review.expiresAt).getTime();
    if (!Number.isFinite(explicitExpiry)) return '';
    return new Date(Math.min(expiry.getTime(), explicitExpiry)).toISOString();
  }
  return expiry.toISOString();
}

function assetCertificationCurrent(review, now = Date.now()) {
  const expiresAt = assetCertificationExpiresAt(review);
  return !!expiresAt && new Date(review.reviewedAt).getTime() <= now && new Date(expiresAt).getTime() > now;
}

function certificationState(profile = {}, now = Date.now()) {
  const summary = profile.showcaseCertification || {};
  if (summary.policyVersion !== 1) return { education: null, assets: null, identity: null, vehicle: null, property: null };
  const education = summary.education;
  const assets = summary.assets;
  return {
    education: education && education.status === 'approved' && EDUCATION_SOURCES.has(education.source)
      && Object.prototype.hasOwnProperty.call(EDUCATION_RANK, education.level) ? education : null,
    assets: assets && assets.status === 'approved' && ASSET_SOURCES.has(assets.source) && assetCertificationCurrent(assets, now)
      && Object.prototype.hasOwnProperty.call(FINANCIAL_ASSET_RANK, assets.financialAssetRange) ? assets : null,
    ...Object.fromEntries(['identity', 'vehicle', 'property'].map(kind => {
      const review = summary[kind];
      return [kind, review && review.status === 'approved' && review.source === OFFLINE_CERTIFICATION_SOURCES[kind] ? review : null];
    }))
  };
}

function publicCertificationFields(profile = {}, now = Date.now()) {
  const state = certificationState(profile, now);
  return {
    identityVerified: !!state.identity,
    vehicleVerified: !!state.vehicle,
    propertyVerified: !!state.property,
    educationVerified: !!state.education,
    verifiedEducation: state.education ? state.education.level : '',
    assetVerified: !!state.assets,
    ...(state.assets && profile.assetRangeDisclosure === true
      ? { financialAssetRange: state.assets.financialAssetRange } : {})
  };
}

function sanitizeProfileCertification(profile = {}) {
  const safe = { ...profile };
  PRIVATE_CERTIFICATION_FIELDS.forEach(field => { delete safe[field]; });
  return { ...safe, ...publicCertificationFields(profile) };
}

function categoryRank(category, profile = {}, popularityCount = 0, now = Date.now()) {
  if (category === 'recommend') return 0;
  if (category === 'popularity') return popularityCount >= 101 ? popularityCount : null;
  const state = certificationState(profile, now);
  if (category === 'education') return state.education ? EDUCATION_RANK[state.education.level] : null;
  if (category === 'assets') {
    const rank = state.assets ? FINANCIAL_ASSET_RANK[state.assets.financialAssetRange] : 0;
    return rank >= 3 && profile.assetCategoryConsent === true ? rank : null;
  }
  return null;
}

function isValidPopularityFavorite(row, now = Date.now()) {
  if (!row || row.actionType !== 'favorite') return false;
  if ([false, 0, '0', 'false'].includes(row.active)) return false;
  const status = row.status === undefined || row.status === null || row.status === '' ? 'active' : String(row.status);
  if (status !== 'active' || row.invalidatedAt || row.withdrawnAt || row.deletedAt) return false;
  if (row.expiresAt) {
    const expiry = new Date(row.expiresAt).getTime();
    if (!Number.isFinite(expiry) || expiry <= now) return false;
  }
  return true;
}

// Input is the latest favorite for each sender/target pair. Gift sending already
// creates/updates that favorite; gift history must not resurrect a withdrawn heart.
function popularityCounts(latestFavorites, usersById, now = Date.now()) {
  const sendersByTarget = new Map();
  latestFavorites.forEach(row => {
    const senderId = Number(row.userId), targetId = Number(row.targetUserId);
    const sender = usersById.get(senderId);
    if (!Number.isFinite(senderId) || senderId <= 0 || senderId === targetId
      || !Number.isFinite(targetId) || targetId <= 0 || !sender || Number(sender.status) !== 1
      || sender.mergedIntoUserId || !isValidPopularityFavorite(row, now)) return;
    if (!sendersByTarget.has(targetId)) sendersByTarget.set(targetId, new Set());
    sendersByTarget.get(targetId).add(senderId);
  });
  return new Map(Array.from(sendersByTarget, ([userId, senders]) => [userId, senders.size]));
}

function normalizeCertificationReview(data = {}) {
  const kind = String(data.kind || '');
  const status = String(data.status || '');
  if (!CERTIFICATION_KINDS.includes(kind)) throw policyError('请选择有效的认证审核类型');
  if (!CERTIFICATION_STATUSES.has(status)) throw policyError('请选择通过、驳回或撤销审核');
  const source = String(data.source || '').trim();
  const evidenceReference = String(data.evidenceReference || '').trim();
  const remark = String(data.remark || '').trim();
  const feedback = data.feedback === undefined ? '' : data.feedback;
  if (typeof feedback !== 'string' || feedback.trim().length > 500) throw policyError('本人可见审核反馈必须是最多500字的文字');
  if (data.applicationId !== undefined && (typeof data.applicationId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(data.applicationId))) {
    throw policyError('申请审核必须提供有效的申请ID');
  }
  const sources = kind === 'education' ? EDUCATION_SOURCES : kind === 'assets' ? ASSET_SOURCES : new Set([OFFLINE_CERTIFICATION_SOURCES[kind]]);
  if (source && !sources.has(source)) {
    throw policyError('核验来源与审核类型不匹配');
  }
  if (evidenceReference.length > 1000 || remark.length > 1000) throw policyError('审核凭据或备注过长');
  const level = String(data.educationLevel || '').trim();
  const financialAssetRange = String(data.financialAssetRange || '').trim();
  if (status === 'approved') {
    if (!source || !evidenceReference) throw policyError('审核通过必须提供核验来源及内部凭据引用');
    if (kind === 'education' && !Object.prototype.hasOwnProperty.call(EDUCATION_RANK, level)) throw policyError('请选择已核验的本科、硕士或博士层级');
    if (kind === 'assets' && !Object.prototype.hasOwnProperty.call(FINANCIAL_ASSET_RANK, financialAssetRange)) throw policyError('请选择已核验金融资产区间');
  }
  return { kind, status, source, evidenceReference, remark, feedback: feedback.trim(),
    ...(data.applicationId !== undefined ? { applicationId: data.applicationId } : {}),
    ...(kind === 'education' ? { level: status === 'approved' ? level : '' }
      : kind === 'assets' ? { financialAssetRange: status === 'approved' ? financialAssetRange : '' } : {}) };
}

function normalizeCertificationRequest(data = {}) {
  const allowed = new Set(['kind', 'source', 'educationLevel', 'institutionName', 'method',
    'verificationCode', 'certificateNumber', 'materialIds', 'declaredFinancialAssetRange', 'consentConfirmed']);
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => !allowed.has(key))) {
    throw policyError('认证申请包含不支持的字段，请按认证页面填写');
  }
  if (typeof data.kind !== 'string' || !CERTIFICATION_KINDS.includes(data.kind)) throw policyError('请选择有效的认证申请类型');
  if (data.consentConfirmed !== true) throw policyError('请先确认由本人申请并同意核验');
  const kind = data.kind;
  const materialIds = data.materialIds;
  if (!Array.isArray(materialIds) || materialIds.length > 3 || new Set(materialIds).size !== materialIds.length
    || materialIds.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(id))) {
    throw policyError('每项认证最多选择3份有效材料，不得重复');
  }
  if (kind !== 'education') {
    if (['source', 'educationLevel', 'institutionName', 'method', 'verificationCode', 'certificateNumber'].some(field => Object.prototype.hasOwnProperty.call(data, field))) {
      throw policyError('此认证申请不接收学历核验字段');
    }
    if (!materialIds.length) throw policyError('请至少上传1份相应认证材料');
    if (data.declaredFinancialAssetRange !== undefined && (kind !== 'assets' || typeof data.declaredFinancialAssetRange !== 'string'
      || !Object.prototype.hasOwnProperty.call(FINANCIAL_ASSET_RANK, data.declaredFinancialAssetRange))) {
      throw policyError('请选择有效的待核验金融资产档位');
    }
    return { kind, source: OFFLINE_CERTIFICATION_SOURCES[kind], materialIds: [...materialIds], consentConfirmed: true,
      ...(data.declaredFinancialAssetRange !== undefined ? { declaredFinancialAssetRange: data.declaredFinancialAssetRange } : {}) };
  }
  if (typeof data.source !== 'string' || !EDUCATION_SOURCES.has(data.source)) throw policyError('请选择国内学信网或国（境）外留服认证来源');
  if (typeof data.educationLevel !== 'string' || !APPLICATION_EDUCATION_LEVELS.has(data.educationLevel)) {
    throw policyError('请选择申请核验的本科、硕士或博士层级');
  }
  if (typeof data.institutionName !== 'string' || !data.institutionName.trim() || data.institutionName.trim().length > 120) {
    throw policyError('请填写已取得最高学历对应学校，最多120字');
  }
  if (typeof data.method !== 'string' || !EDUCATION_METHODS.has(data.method)) throw policyError('请选择有效的学历认证方式');
  if (data.declaredFinancialAssetRange !== undefined) throw policyError('学历申请不接收金融资产档位');
  const verification = {};
  if (data.method === 'chsi_code') {
    if (data.source !== 'chsi' || typeof data.verificationCode !== 'string' || !/^[a-zA-Z0-9]{6,64}$/.test(data.verificationCode.trim())
      || data.certificateNumber !== undefined) throw policyError('请填写有效的学信网报告验证码');
    verification.verificationCode = data.verificationCode.trim();
  } else if (data.method === 'cscse_number') {
    if (data.source !== 'cscse' || typeof data.certificateNumber !== 'string' || !data.certificateNumber.trim()
      || data.certificateNumber.trim().length > 120 || data.verificationCode !== undefined) throw policyError('请填写有效的国（境）外学历学位认证编号');
    verification.certificateNumber = data.certificateNumber.trim();
  } else if (!materialIds.length || data.verificationCode !== undefined || data.certificateNumber !== undefined) {
    throw policyError('证书或学籍证明方式请至少上传1份材料，不填写验证码或认证编号');
  }
  return { kind, source: data.source, educationLevel: data.educationLevel, method: data.method,
    institutionName: data.institutionName.trim(), materialIds: [...materialIds], ...verification,
    consentConfirmed: true };
}

// Explicit owner projection: private audit/evidence fields never enter this DTO.
function ownCertificationOverview(record = {}, now = Date.now()) {
  const current = record.current || {};
  const applications = record.applications || {};
  const state = certificationState({ showcaseCertification: { ...current, policyVersion: 1 } }, now);
  return { entries: CERTIFICATION_KINDS.map(kind => {
    const review = current[kind] || {};
    const application = applications[kind];
    const pending = application && application.status === 'pending';
    const expired = kind === 'assets' && review.status === 'approved' && !assetCertificationCurrent(review, now);
    const status = pending ? 'pending' : expired ? 'expired' : application?.status === 'rejected' && review.status !== 'revoked'
      ? 'rejected' : CERTIFICATION_STATUSES.has(review.status) ? review.status : 'unsubmitted';
    const feedbackReview = application?.status === 'rejected' && review.status !== 'revoked' ? application : review;
    const verified = !!state[kind];
    const source = pending ? application.source : review.source;
    const applicationLevel = application && (APPLICATION_EDUCATION_LEVELS.has(application.educationLevel)
      ? application.educationLevel : LEGACY_APPLICATION_EDUCATION_LEVELS[application.educationLevel]);
    const validSource = value => kind === 'education' ? EDUCATION_SOURCES.has(value) : kind === 'assets' ? ASSET_SOURCES.has(value)
      : value === OFFLINE_CERTIFICATION_SOURCES[kind];
    return { kind, status, verified,
      ...(verified && kind === 'education' ? { verifiedEducation: state.education.level } : {}),
      ...(verified && kind === 'assets' ? { verifiedFinancialAssetRange: state.assets.financialAssetRange } : {}),
      ...(source && validSource(source) ? { source } : {}),
      ...(application && typeof application.submittedAt === 'string' ? { submittedAt: application.submittedAt } : {}),
      ...(typeof review.reviewedAt === 'string' ? { reviewedAt: review.reviewedAt } : {}),
      ...(kind === 'assets' && review.status === 'approved' && assetCertificationExpiresAt(review)
        ? { expiresAt: assetCertificationExpiresAt(review) } : {}),
      ...(!pending && typeof feedbackReview.feedback === 'string' && feedbackReview.feedback.trim() && feedbackReview.feedback.trim().length <= 500
        ? { feedback: feedbackReview.feedback.trim() } : {}),
      ...(application ? { application: {
        status: ['pending', ...CERTIFICATION_STATUSES].includes(application.status) ? application.status : 'unsubmitted',
        ...(validSource(application.source) ? { source: application.source } : {}),
        ...(kind === 'education' && APPLICATION_EDUCATION_LEVELS.has(applicationLevel) ? { educationLevel: applicationLevel } : {}),
        ...(kind === 'education' && typeof application.institutionName === 'string' ? { institutionName: application.institutionName.slice(0, 120) } : {}),
        ...(kind === 'education' && EDUCATION_METHODS.has(application.method) ? { method: application.method } : {}),
        ...(Array.isArray(application.materialIds) ? { materialIds: application.materialIds.filter(id => typeof id === 'string').slice(0, 3) } : {}),
        ...(typeof application.submittedAt === 'string' ? { submittedAt: application.submittedAt } : {})
      } } : {})
    };
  }) };
}

module.exports = {
  assetCertificationExpiresAt,
  assetPreferencePatch, categoryRank, normalizeCertificationReview, normalizeCertificationRequest, normalizeShowcaseCategory,
  ownCertificationOverview,
  popularityCounts, publicCertificationFields, sanitizeProfileCertification
};
