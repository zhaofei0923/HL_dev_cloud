'use strict';

const MEMBER_INTAKE_VERSION = 1;

const EDUCATION_VALUES = new Set(['大专', '本科', '硕士', '博士', '其他']);
const PARTNER_EDUCATION_VALUES = new Set(['不限', ...EDUCATION_VALUES]);
const MARITAL_STATUS_VALUES = new Set(['未婚', '离异', '丧偶']);
const PARTNER_MARITAL_STATUS_VALUES = new Set(['不限', ...MARITAL_STATUS_VALUES]);
const INCOME_SOURCE_VALUES = new Set(['salary', 'business', 'investment', 'other']);
const VERIFICATION_EVIDENCE_VALUES = new Set([
  'salary_statement',
  'business_proof',
  'tax_record',
  'other_asset_proof'
]);
const PROPERTY_PROOF_VALUES = new Set(['property_certificate', 'purchase_contract']);
const VEHICLE_PROOF_VALUES = new Set(['vehicle_license']);
const FINANCIAL_ASSET_RANGE_VALUES = new Set([
  'under_500k',
  '500k_2m',
  '2m_5m',
  '5m_10m',
  'over_10m'
]);
const SMOKING_STATUS_VALUES = new Set(['yes', 'no']);
const DRINKING_STATUS_VALUES = new Set(['frequent', 'occasional', 'never']);
const CUSTOMER_SOURCE_VALUES = new Set([
  'short_video',
  'xiaohongshu',
  'event_registration',
  'friend_referral',
  'boss_or_other'
]);
const PACKAGE_TYPE_VALUES = new Set(['unpaid', '9980_3m', 'other']);

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function textValue(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\r\n/g, '\n').trim();
}

function numberValue(value) {
  if (value === '' || value === null || value === undefined) return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function booleanValue(value) {
  if (value === true || value === 1 || value === '1' || value === 'true' || value === 'yes' || value === '有') {
    return true;
  }
  if (value === false || value === 0 || value === '0' || value === 'false' || value === 'no' || value === '无') {
    return false;
  }
  return null;
}

function genderValue(value) {
  if (value === 1 || value === '1' || value === 'male' || value === '男') return 1;
  if (value === 2 || value === '2' || value === 'female' || value === '女') return 2;
  return 0;
}

function stringList(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const result = [];
  value.forEach(item => {
    const normalized = textValue(item);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    result.push(normalized);
  });
  return result;
}

function phoneValue(value) {
  let phone = textValue(value).replace(/[\s()-]/g, '');
  if (phone.startsWith('+86')) phone = phone.slice(3);
  if (phone.startsWith('86') && phone.length === 13) phone = phone.slice(2);
  return phone;
}

function dateValue(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  return textValue(value);
}

function normalizeMemberIntake(data = {}, now = new Date()) {
  const source = objectValue(data);
  const assets = objectValue(source.assetVerification);
  const personal = objectValue(source.personalProfile);
  const partner = objectValue(source.partnerPreferences);
  const business = objectValue(source.businessRegistration);
  const compliance = objectValue(source.compliance);
  const hasChildren = booleanValue(source.hasChildren);
  const incomeSources = stringList(source.incomeSources);
  const propertyCount = numberValue(assets.propertyCount);
  const vehicleCount = numberValue(assets.vehicleCount);
  const customerSource = textValue(business.customerSource);
  const packageType = textValue(business.packageType);

  return {
    intakeVersion: MEMBER_INTAKE_VERSION,
    realName: textValue(source.realName),
    gender: genderValue(source.gender),
    age: numberValue(source.age),
    birthDate: dateValue(source.birthDate),
    phone: phoneValue(source.phone),
    city: textValue(source.city),
    height: numberValue(source.height),
    weightKg: numberValue(source.weightKg),
    education: textValue(source.education),
    graduateSchool: textValue(source.graduateSchool),
    maritalStatus: textValue(source.maritalStatus),
    hasChildren,
    childrenCount: hasChildren === false ? 0 : numberValue(source.childrenCount),
    occupation: textValue(source.occupation),
    companyName: textValue(source.companyName),
    jobTitle: textValue(source.jobTitle),
    annualIncomePreTax: numberValue(source.annualIncomePreTax),
    incomeSources,
    otherIncomeSource: incomeSources.includes('other') ? textValue(source.otherIncomeSource) : '',
    verificationEvidenceTypes: stringList(source.verificationEvidenceTypes),
    verificationCredentialLocation: textValue(source.verificationCredentialLocation),
    assetVerification: {
      propertyCount,
      propertyCities: Number(propertyCount) > 0 ? textValue(assets.propertyCities) : '',
      propertyProofTypes: Number(propertyCount) > 0 ? stringList(assets.propertyProofTypes) : [],
      vehicleModels: Number(vehicleCount) > 0 ? textValue(assets.vehicleModels) : '',
      vehicleCount,
      vehicleProofTypes: Number(vehicleCount) > 0 ? stringList(assets.vehicleProofTypes) : [],
      financialAssetRange: textValue(assets.financialAssetRange),
      familyBackground: textValue(assets.familyBackground)
    },
    personalProfile: {
      personalitySummary: textValue(personal.personalitySummary),
      hobbies: textValue(personal.hobbies),
      dailyRoutine: textValue(personal.dailyRoutine),
      smokingStatus: textValue(personal.smokingStatus),
      drinkingStatus: textValue(personal.drinkingStatus),
      lifePhotos: stringList(personal.lifePhotos)
    },
    partnerPreferences: {
      ageMin: numberValue(partner.ageMin),
      ageMax: numberValue(partner.ageMax),
      heightRequirement: textValue(partner.heightRequirement),
      educationMinimum: textValue(partner.educationMinimum),
      maritalStatuses: stringList(partner.maritalStatuses),
      incomeAssetExpectation: textValue(partner.incomeAssetExpectation),
      regionRequirement: textValue(partner.regionRequirement),
      dealBreakers: textValue(partner.dealBreakers),
      relationshipMode: textValue(partner.relationshipMode)
    },
    businessRegistration: {
      customerSource,
      otherCustomerSource: customerSource === 'boss_or_other' ? textValue(business.otherCustomerSource) : '',
      packageType,
      otherPackageName: packageType === 'other' ? textValue(business.otherPackageName) : '',
      responsibleMatchmaker: textValue(business.responsibleMatchmaker),
      joinDate: dateValue(business.joinDate) || shanghaiDateKey(now),
      expiryDate: packageType === 'unpaid' ? '' : dateValue(business.expiryDate),
      tags: stringList(business.tags),
      otherTags: textValue(business.otherTags),
      riskNotes: textValue(business.riskNotes)
    },
    compliance: {
      partialVerificationConfirmed: booleanValue(compliance.partialVerificationConfirmed),
      voluntarySubmissionConfirmed: booleanValue(compliance.voluntarySubmissionConfirmed)
    }
  };
}

function isDateOnly(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

function shanghaiDateKey(value) {
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(parsed.getTime())) return '';
  return new Date(parsed.getTime() + (8 * 60 * 60 * 1000)).toISOString().slice(0, 10);
}

function ageOnDate(birthDate, now) {
  if (!isDateOnly(birthDate)) return null;
  const currentDate = shanghaiDateKey(now);
  if (!isDateOnly(currentDate)) return null;
  const [birthYear, birthMonth, birthDay] = birthDate.split('-').map(Number);
  const [year, month, day] = currentDate.split('-').map(Number);
  let age = year - birthYear;
  if (month < birthMonth || (month === birthMonth && day < birthDay)) age -= 1;
  return age;
}

function datePlusCalendarMonths(value, months) {
  if (!isDateOnly(value)) return '';
  const [year, month, day] = value.split('-').map(Number);
  const targetIndex = (year * 12) + (month - 1) + months;
  const targetYear = Math.floor(targetIndex / 12);
  const targetMonthIndex = targetIndex % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonthIndex + 1, 0)).getUTCDate();
  return `${targetYear}-${String(targetMonthIndex + 1).padStart(2, '0')}-${String(Math.min(day, lastDay)).padStart(2, '0')}`;
}

function validateMemberIntake(data = {}, now = new Date(), options = {}) {
  const normalized = normalizeMemberIntake(data, now);
  const errors = [];
  const addError = (field, code, message) => errors.push({ field, code, message });
  const requiredText = (field, value, message, maxLength = 200) => {
    if (!value) addError(field, 'required', message);
    else if (value.length > maxLength) addError(field, 'too_long', `${message.replace(/^请/, '')}不能超过${maxLength}字`);
  };
  const requiredNumber = (field, value, message, minimum, maximum, integer = false) => {
    if (value === null) addError(field, 'required', message);
    else if ((integer && !Number.isInteger(value)) || value < minimum || value > maximum) {
      addError(field, 'out_of_range', `${message.replace(/^请/, '')}格式或范围不正确`);
    }
  };
  const requireAllowed = (field, value, allowed, message) => {
    if (!value) addError(field, 'required', message);
    else if (!allowed.has(value)) addError(field, 'invalid_choice', message);
  };
  const requireList = (field, value, allowed, message) => {
    if (!value.length) {
      addError(field, 'required', message);
      return;
    }
    if (value.some(item => !allowed.has(item))) addError(field, 'invalid_choice', message);
  };

  requiredText('realName', normalized.realName, '请输入姓名', 50);
  if (![1, 2].includes(normalized.gender)) addError('gender', 'invalid_choice', '请选择性别');
  requiredNumber('age', normalized.age, '请输入年龄', 18, 100, true);
  if (!normalized.birthDate) addError('birthDate', 'required', '请选择出生年月');
  else if (!isDateOnly(normalized.birthDate)) addError('birthDate', 'invalid_date', '出生年月格式不正确');
  else {
    const calculatedAge = ageOnDate(normalized.birthDate, now);
    if (calculatedAge === null || calculatedAge < 18 || calculatedAge > 100) {
      addError('birthDate', 'out_of_range', '出生年月不在有效范围内');
    } else if (normalized.age !== null && normalized.age !== calculatedAge) {
      addError('age', 'age_mismatch', '年龄与出生年月不一致');
    }
  }
  if (!normalized.phone) addError('phone', 'required', '请输入联系电话');
  else if (!/^1[3-9]\d{9}$/.test(normalized.phone)) addError('phone', 'invalid_phone', '请输入有效的中国大陆手机号');
  requiredText('city', normalized.city, '请填写成都具体区域', 100);
  requiredNumber('height', normalized.height, '请输入身高', 120, 230, true);
  requiredNumber('weightKg', normalized.weightKg, '请输入体重', 30, 250);
  requireAllowed('education', normalized.education, EDUCATION_VALUES, '请选择学历');
  requiredText('graduateSchool', normalized.graduateSchool, '请输入毕业院校', 100);
  requireAllowed('maritalStatus', normalized.maritalStatus, MARITAL_STATUS_VALUES, '请选择婚姻状态');
  if (normalized.hasChildren === null) addError('hasChildren', 'required', '请选择有无子女');
  if (normalized.hasChildren === true) {
    requiredNumber('childrenCount', normalized.childrenCount, '请输入子女数量', 1, 20, true);
  }

  requiredText('occupation', normalized.occupation, '请输入当前职业或行业', 100);
  requiredText('companyName', normalized.companyName, '请输入公司名称', 120);
  requiredText('jobTitle', normalized.jobTitle, '请输入职位', 80);
  requiredNumber('annualIncomePreTax', normalized.annualIncomePreTax, '请输入税前年收入（万元）', 0.01, 10000);
  requireList('incomeSources', normalized.incomeSources, INCOME_SOURCE_VALUES, '请选择收入来源');
  if (normalized.incomeSources.includes('other')) {
    requiredText('otherIncomeSource', normalized.otherIncomeSource, '请填写其他收入来源', 100);
  }
  requireList(
    'verificationEvidenceTypes',
    normalized.verificationEvidenceTypes,
    VERIFICATION_EVIDENCE_VALUES,
    '请至少选择一项验资凭证'
  );
  requiredText(
    'verificationCredentialLocation',
    normalized.verificationCredentialLocation,
    '请填写验资凭证存放位置',
    300
  );

  const assets = normalized.assetVerification;
  requiredNumber('assetVerification.propertyCount', assets.propertyCount, '请输入房产套数', 0, 99, true);
  if (Number(assets.propertyCount) > 0) {
    requiredText('assetVerification.propertyCities', assets.propertyCities, '请填写房产城市分布', 200);
    requireList(
      'assetVerification.propertyProofTypes',
      assets.propertyProofTypes,
      PROPERTY_PROOF_VALUES,
      '请至少选择一项房产凭证'
    );
  } else if (assets.propertyProofTypes.some(item => !PROPERTY_PROOF_VALUES.has(item))) {
    addError('assetVerification.propertyProofTypes', 'invalid_choice', '房产凭证类型不正确');
  }
  requiredNumber('assetVerification.vehicleCount', assets.vehicleCount, '请输入车辆数量', 0, 99, true);
  if (Number(assets.vehicleCount) > 0) {
    requiredText('assetVerification.vehicleModels', assets.vehicleModels, '请填写车辆品牌型号', 200);
    requireList(
      'assetVerification.vehicleProofTypes',
      assets.vehicleProofTypes,
      VEHICLE_PROOF_VALUES,
      '请至少选择一项车辆凭证'
    );
  } else if (assets.vehicleProofTypes.some(item => !VEHICLE_PROOF_VALUES.has(item))) {
    addError('assetVerification.vehicleProofTypes', 'invalid_choice', '车辆凭证类型不正确');
  }
  requireAllowed(
    'assetVerification.financialAssetRange',
    assets.financialAssetRange,
    FINANCIAL_ASSET_RANGE_VALUES,
    '请选择金融资产区间'
  );
  if (assets.familyBackground.length > 500) {
    addError('assetVerification.familyBackground', 'too_long', '家庭背景简述不能超过500字');
  }

  const personal = normalized.personalProfile;
  if (personal.personalitySummary.length > 500) {
    addError('personalProfile.personalitySummary', 'too_long', '性格简述不能超过500字');
  }
  if (personal.hobbies.length > 500) addError('personalProfile.hobbies', 'too_long', '爱好不能超过500字');
  if (personal.dailyRoutine.length > 500) addError('personalProfile.dailyRoutine', 'too_long', '生活作息不能超过500字');
  if (personal.smokingStatus && !SMOKING_STATUS_VALUES.has(personal.smokingStatus)) {
    addError('personalProfile.smokingStatus', 'invalid_choice', '抽烟情况选项不正确');
  }
  if (personal.drinkingStatus && !DRINKING_STATUS_VALUES.has(personal.drinkingStatus)) {
    addError('personalProfile.drinkingStatus', 'invalid_choice', '饮酒情况选项不正确');
  }
  if (personal.lifePhotos.length < 3) {
    addError('personalProfile.lifePhotos', 'min_items', '请至少上传3张本人生活照');
  } else if (personal.lifePhotos.length > 9) {
    addError('personalProfile.lifePhotos', 'max_items', '本人生活照最多上传9张');
  }
  const privatePhotoOwnerKey = textValue(options.privatePhotoOwnerKey);
  const hasInvalidPrivatePhoto = personal.lifePhotos.some(fileID => {
    const match = /^cloud:\/\/[^/\s]+\/hl_uploads\/member-private\/([^/\s]+)\/\S+$/.exec(fileID);
    return !match || (privatePhotoOwnerKey && match[1] !== privatePhotoOwnerKey);
  });
  if (hasInvalidPrivatePhoto) {
    addError('personalProfile.lifePhotos', 'invalid_file_id', '生活照必须上传到内部档案专用目录');
  }

  const partner = normalized.partnerPreferences;
  requiredNumber('partnerPreferences.ageMin', partner.ageMin, '请输入希望对方最小年龄', 18, 100, true);
  requiredNumber('partnerPreferences.ageMax', partner.ageMax, '请输入希望对方最大年龄', 18, 100, true);
  if (partner.ageMin !== null && partner.ageMax !== null && partner.ageMin > partner.ageMax) {
    addError('partnerPreferences.ageMax', 'invalid_range', '希望对方最大年龄不能小于最小年龄');
  }
  requiredText('partnerPreferences.heightRequirement', partner.heightRequirement, '请输入身高要求', 100);
  requireAllowed(
    'partnerPreferences.educationMinimum',
    partner.educationMinimum,
    PARTNER_EDUCATION_VALUES,
    '请选择学历底线'
  );
  requireList(
    'partnerPreferences.maritalStatuses',
    partner.maritalStatuses,
    PARTNER_MARITAL_STATUS_VALUES,
    '请选择婚姻状态要求'
  );
  if (partner.maritalStatuses.includes('不限') && partner.maritalStatuses.length > 1) {
    addError('partnerPreferences.maritalStatuses', 'conflicting_choice', '选择不限后无需再选其他婚姻状态');
  }
  requiredText('partnerPreferences.incomeAssetExpectation', partner.incomeAssetExpectation, '请输入对方收入或资产预期', 500);
  requiredText('partnerPreferences.regionRequirement', partner.regionRequirement, '请输入地域要求', 300);
  requiredText('partnerPreferences.dealBreakers', partner.dealBreakers, '请输入核心硬性不能接受点', 1000);
  requiredText('partnerPreferences.relationshipMode', partner.relationshipMode, '请输入期待的相处模式', 1000);

  const business = normalized.businessRegistration;
  requireAllowed('businessRegistration.customerSource', business.customerSource, CUSTOMER_SOURCE_VALUES, '请选择客户来源');
  if (business.customerSource === 'boss_or_other') {
    requiredText('businessRegistration.otherCustomerSource', business.otherCustomerSource, '请填写其他客户来源', 100);
  }
  requireAllowed('businessRegistration.packageType', business.packageType, PACKAGE_TYPE_VALUES, '请选择办理套餐');
  if (business.packageType === 'other') {
    requiredText('businessRegistration.otherPackageName', business.otherPackageName, '请填写其他套餐名称', 100);
  }
  requiredText('businessRegistration.responsibleMatchmaker', business.responsibleMatchmaker, '请输入对接主理人或负责人', 80);
  if (!business.joinDate) addError('businessRegistration.joinDate', 'required', '请选择入会日期');
  else if (!isDateOnly(business.joinDate)) addError('businessRegistration.joinDate', 'invalid_date', '入会日期格式不正确');
  if (business.expiryDate && !isDateOnly(business.expiryDate)) {
    addError('businessRegistration.expiryDate', 'invalid_date', '到期日期格式不正确');
  }
  if (business.packageType !== 'unpaid' && !business.expiryDate) {
    addError('businessRegistration.expiryDate', 'required', '请选择到期日期');
  }
  if (business.packageType === '9980_3m' && isDateOnly(business.joinDate) && isDateOnly(business.expiryDate)) {
    const expectedExpiryDate = datePlusCalendarMonths(business.joinDate, 3);
    if (business.expiryDate !== expectedExpiryDate) {
      addError('businessRegistration.expiryDate', 'invalid_package_term', '9980三个月套餐到期日应为入会日后三个自然月');
    }
  }
  if (isDateOnly(business.joinDate) && isDateOnly(business.expiryDate) && business.expiryDate < business.joinDate) {
    addError('businessRegistration.expiryDate', 'invalid_range', '到期日期不能早于入会日期');
  }
  if (business.tags.length > 20) addError('businessRegistration.tags', 'max_items', '备注标签最多20个');
  if (business.tags.some(tag => tag.length > 30)) addError('businessRegistration.tags', 'too_long', '单个备注标签不能超过30字');
  if (business.otherTags.length > 200) addError('businessRegistration.otherTags', 'too_long', '其他标签不能超过200字');
  if (business.riskNotes.length > 1000) addError('businessRegistration.riskNotes', 'too_long', '重要风险备注不能超过1000字');

  if (normalized.compliance.partialVerificationConfirmed !== true) {
    addError('compliance.partialVerificationConfirmed', 'confirmation_required', '请确认已核验本人部分资料');
  }
  if (normalized.compliance.voluntarySubmissionConfirmed !== true) {
    addError('compliance.voluntarySubmissionConfirmed', 'confirmation_required', '请确认客户自愿提交资料');
  }

  return {
    valid: errors.length === 0,
    data: normalized,
    firstError: errors[0] || null,
    errors
  };
}

function defaultMemberNo(id, date = new Date()) {
  const numericId = Number(id);
  if (!Number.isInteger(numericId) || numericId <= 0) {
    throw new TypeError('member id must be a positive integer');
  }
  const dateKey = shanghaiDateKey(date);
  if (!dateKey) throw new TypeError('member date must be valid');
  return `HL${dateKey.replace(/-/g, '')}-${String(numericId).padStart(6, '0')}`;
}

module.exports = {
  MEMBER_INTAKE_VERSION,
  defaultMemberNo,
  normalizeMemberIntake,
  validateMemberIntake
};
