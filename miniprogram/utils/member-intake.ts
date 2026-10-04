export const MEMBER_INTAKE_VERSION = 1
export const MEMBER_LIFE_PHOTO_MIN = 3
export const MEMBER_LIFE_PHOTO_MAX = 9

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000
const EDUCATION_VALUES = new Set(['大专', '本科', '硕士', '博士', '其他'])
const PARTNER_EDUCATION_VALUES = new Set(['不限', ...Array.from(EDUCATION_VALUES)])
const MARITAL_STATUS_VALUES = new Set(['未婚', '离异', '丧偶'])
const PARTNER_MARITAL_STATUS_VALUES = new Set(['不限', ...Array.from(MARITAL_STATUS_VALUES)])
const INCOME_SOURCE_VALUES = new Set(['salary', 'business', 'investment', 'other'])
const VERIFICATION_EVIDENCE_VALUES = new Set([
  'salary_statement',
  'business_proof',
  'tax_record',
  'other_asset_proof'
])
const PROPERTY_PROOF_VALUES = new Set(['property_certificate', 'purchase_contract'])
const VEHICLE_PROOF_VALUES = new Set(['vehicle_license'])
const FINANCIAL_ASSET_RANGE_VALUES = new Set([
  'under_500k',
  '500k_2m',
  '2m_5m',
  '5m_10m',
  'over_10m'
])
const SMOKING_STATUS_VALUES = new Set(['yes', 'no'])
const DRINKING_STATUS_VALUES = new Set(['frequent', 'occasional', 'never'])
const CUSTOMER_SOURCE_VALUES = new Set([
  'short_video',
  'xiaohongshu',
  'event_registration',
  'friend_referral',
  'boss_or_other'
])
const PACKAGE_TYPE_VALUES = new Set(['unpaid', '9980_3m', 'other'])

export type MemberIntakeError = {
  field: string
  message: string
}

export type MemberIntakeValidation = {
  valid: boolean
  firstError: MemberIntakeError | null
  errors: MemberIntakeError[]
}

function pad2(value: number) {
  return String(value).padStart(2, '0')
}

function dateParts(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''))
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const parsed = new Date(Date.UTC(year, month - 1, day))
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) return null
  return { year, month, day }
}

export function todayText(date = new Date()) {
  const shanghaiDate = new Date(date.getTime() + SHANGHAI_OFFSET_MS)
  return `${shanghaiDate.getUTCFullYear()}-${pad2(shanghaiDate.getUTCMonth() + 1)}-${pad2(shanghaiDate.getUTCDate())}`
}

export function ageFromBirthDate(birthDate: string, today = new Date()): number | '' {
  const birth = dateParts(birthDate)
  if (!birth) return ''
  const current = dateParts(todayText(today))
  if (!current) return ''
  let age = current.year - birth.year
  const currentMonth = current.month
  const currentDay = current.day
  if (currentMonth < birth.month || (currentMonth === birth.month && currentDay < birth.day)) age -= 1
  return age
}

export function expiryDateForPackage(packageType: string, joinDate: string) {
  if (packageType !== '9980_3m') return ''
  const joined = dateParts(joinDate)
  if (!joined) return ''
  const zeroBasedTargetMonth = joined.month - 1 + 3
  const targetYear = joined.year + Math.floor(zeroBasedTargetMonth / 12)
  const targetMonthIndex = zeroBasedTargetMonth % 12
  const lastDay = new Date(Date.UTC(targetYear, targetMonthIndex + 1, 0)).getUTCDate()
  const targetDay = Math.min(joined.day, lastDay)
  return `${targetYear}-${pad2(targetMonthIndex + 1)}-${pad2(targetDay)}`
}

export function createMemberIntakeDefaults(responsibleMatchmaker = ''): Record<string, any> {
  const joinDate = todayText()
  return {
    intakeVersion: MEMBER_INTAKE_VERSION,
    realName: '',
    gender: '',
    age: '',
    birthDate: '',
    phone: '',
    city: '',
    height: '',
    weightKg: '',
    education: '',
    graduateSchool: '',
    maritalStatus: '',
    hasChildren: null,
    childrenCount: 0,
    occupation: '',
    companyName: '',
    jobTitle: '',
    annualIncomePreTax: '',
    incomeSources: [],
    otherIncomeSource: '',
    verificationEvidenceTypes: [],
    verificationCredentialLocation: '',
    assetVerification: {
      propertyCount: 0,
      propertyCities: '',
      propertyProofTypes: [],
      vehicleModels: '',
      vehicleCount: 0,
      vehicleProofTypes: [],
      financialAssetRange: '',
      familyBackground: ''
    },
    personalProfile: {
      personalitySummary: '',
      hobbies: '',
      dailyRoutine: '',
      smokingStatus: '',
      drinkingStatus: '',
      lifePhotos: []
    },
    partnerPreferences: {
      ageMin: '',
      ageMax: '',
      heightRequirement: '',
      educationMinimum: '',
      maritalStatuses: [],
      incomeAssetExpectation: '',
      regionRequirement: '',
      dealBreakers: '',
      relationshipMode: ''
    },
    businessRegistration: {
      customerSource: '',
      otherCustomerSource: '',
      packageType: 'unpaid',
      otherPackageName: '',
      responsibleMatchmaker,
      joinDate,
      expiryDate: '',
      tags: [],
      otherTags: '',
      riskNotes: ''
    },
    compliance: {
      partialVerificationConfirmed: false,
      voluntarySubmissionConfirmed: false
    }
  }
}

function text(value: unknown) {
  return String(value === null || value === undefined ? '' : value).replace(/\r\n/g, '\n').trim()
}

function numberOrNull(value: unknown) {
  if (value === '' || value === null || value === undefined) return null
  const result = Number(value)
  return Number.isFinite(result) ? result : null
}

function list(value: unknown) {
  if (!Array.isArray(value)) return []
  return Array.from(new Set(value.map(item => text(item)).filter(Boolean)))
}

function phoneValue(value: unknown) {
  let phone = text(value).replace(/[\s()-]/g, '')
  if (phone.startsWith('+86')) phone = phone.slice(3)
  if (phone.startsWith('86') && phone.length === 13) phone = phone.slice(2)
  return phone
}

function booleanValue(value: unknown): boolean | null {
  if (value === true || value === 1 || value === '1' || value === 'true' || value === 'yes' || value === '有') return true
  if (value === false || value === 0 || value === '0' || value === 'false' || value === 'no' || value === '无') return false
  return null
}

function genderValue(value: unknown) {
  if (value === 1 || value === '1' || value === 'male' || value === '男') return 1
  if (value === 2 || value === '2' || value === 'female' || value === '女') return 2
  return 0
}

function requiredText(
  errors: MemberIntakeError[],
  field: string,
  value: unknown,
  message: string,
  maximumLength = 200
) {
  const normalized = text(value)
  if (!normalized) errors.push({ field, message })
  else if (normalized.length > maximumLength) errors.push({ field, message: `${message.replace(/^请/, '')}不能超过${maximumLength}字` })
}

function optionalTextLength(errors: MemberIntakeError[], field: string, value: unknown, maximumLength: number, message: string) {
  if (text(value).length > maximumLength) errors.push({ field, message })
}

function requireAllowed(
  errors: MemberIntakeError[],
  field: string,
  value: unknown,
  allowed: Set<string>,
  message: string
) {
  const normalized = text(value)
  if (!normalized || !allowed.has(normalized)) errors.push({ field, message })
}

function requireList(
  errors: MemberIntakeError[],
  field: string,
  value: unknown,
  allowed: Set<string>,
  message: string
) {
  const normalized = list(value)
  if (!normalized.length || normalized.some(item => !allowed.has(item))) errors.push({ field, message })
}

function requiredNumber(
  errors: MemberIntakeError[],
  field: string,
  value: unknown,
  message: string,
  minimum: number,
  maximum: number,
  integer = false
) {
  const number = numberOrNull(value)
  if (number === null) {
    errors.push({ field, message })
  } else if (number < minimum || number > maximum || (integer && !Number.isInteger(number))) {
    errors.push({ field, message })
  }
}

export function validateMemberIntake(form: Record<string, any>, today = new Date()): MemberIntakeValidation {
  const errors: MemberIntakeError[] = []
  const assets = form.assetVerification || {}
  const personal = form.personalProfile || {}
  const partner = form.partnerPreferences || {}
  const business = form.businessRegistration || {}
  const compliance = form.compliance || {}

  requiredText(errors, 'realName', form.realName, '请输入姓名', 50)
  if (![1, 2].includes(genderValue(form.gender))) errors.push({ field: 'gender', message: '请选择性别' })
  const calculatedAge = ageFromBirthDate(text(form.birthDate), today)
  requiredNumber(errors, 'age', form.age, '请输入年龄', 18, 100, true)
  if (!text(form.birthDate)) errors.push({ field: 'birthDate', message: '请选择出生年月' })
  else if (calculatedAge === '') errors.push({ field: 'birthDate', message: '出生年月格式不正确' })
  else if (calculatedAge < 18 || calculatedAge > 100) errors.push({ field: 'birthDate', message: '出生年月不在有效范围内' })
  else if (numberOrNull(form.age) !== null && Number(form.age) !== calculatedAge) errors.push({ field: 'age', message: '年龄与出生年月不一致' })
  if (!/^1[3-9]\d{9}$/.test(phoneValue(form.phone))) errors.push({ field: 'phone', message: '请输入有效的中国大陆手机号' })
  requiredText(errors, 'city', form.city, '请填写成都具体区域', 100)
  requiredNumber(errors, 'height', form.height, '请输入120–230cm的身高', 120, 230, true)
  requiredNumber(errors, 'weightKg', form.weightKg, '请输入30–250kg的体重', 30, 250)
  requireAllowed(errors, 'education', form.education, EDUCATION_VALUES, '请选择学历')
  requiredText(errors, 'graduateSchool', form.graduateSchool, '请输入毕业院校', 100)
  requireAllowed(errors, 'maritalStatus', form.maritalStatus, MARITAL_STATUS_VALUES, '请选择婚姻状态')
  const hasChildren = booleanValue(form.hasChildren)
  if (hasChildren === null) errors.push({ field: 'hasChildren', message: '请选择有无子女' })
  if (hasChildren === true) requiredNumber(errors, 'childrenCount', form.childrenCount, '请输入正确的子女数量', 1, 20, true)

  requiredText(errors, 'occupation', form.occupation, '请输入当前职业或行业', 100)
  requiredText(errors, 'companyName', form.companyName, '请输入公司名称', 120)
  requiredText(errors, 'jobTitle', form.jobTitle, '请输入职位', 80)
  requiredNumber(errors, 'annualIncomePreTax', form.annualIncomePreTax, '请输入税前年收入（万元）', 0.01, 10000)
  requireList(errors, 'incomeSources', form.incomeSources, INCOME_SOURCE_VALUES, '请选择收入来源')
  if (list(form.incomeSources).includes('other')) requiredText(errors, 'otherIncomeSource', form.otherIncomeSource, '请填写其他收入来源', 100)
  requireList(errors, 'verificationEvidenceTypes', form.verificationEvidenceTypes, VERIFICATION_EVIDENCE_VALUES, '请至少选择一项验资凭证')
  requiredText(errors, 'verificationCredentialLocation', form.verificationCredentialLocation, '请填写验资凭证存放位置', 300)

  requiredNumber(errors, 'assetVerification.propertyCount', assets.propertyCount, '请输入房产套数，无则填0', 0, 99, true)
  if (Number(assets.propertyCount) > 0) {
    requiredText(errors, 'assetVerification.propertyCities', assets.propertyCities, '请填写房产城市分布', 200)
    requireList(errors, 'assetVerification.propertyProofTypes', assets.propertyProofTypes, PROPERTY_PROOF_VALUES, '请至少选择一项房产凭证')
  } else if (list(assets.propertyProofTypes).some(item => !PROPERTY_PROOF_VALUES.has(item))) {
    errors.push({ field: 'assetVerification.propertyProofTypes', message: '房产凭证类型不正确' })
  }
  requiredNumber(errors, 'assetVerification.vehicleCount', assets.vehicleCount, '请输入车辆数量，无则填0', 0, 99, true)
  if (Number(assets.vehicleCount) > 0) {
    requiredText(errors, 'assetVerification.vehicleModels', assets.vehicleModels, '请填写车辆品牌型号', 200)
    requireList(errors, 'assetVerification.vehicleProofTypes', assets.vehicleProofTypes, VEHICLE_PROOF_VALUES, '请至少选择一项车辆凭证')
  } else if (list(assets.vehicleProofTypes).some(item => !VEHICLE_PROOF_VALUES.has(item))) {
    errors.push({ field: 'assetVerification.vehicleProofTypes', message: '车辆凭证类型不正确' })
  }
  requireAllowed(errors, 'assetVerification.financialAssetRange', assets.financialAssetRange, FINANCIAL_ASSET_RANGE_VALUES, '请选择金融资产区间')
  optionalTextLength(errors, 'assetVerification.familyBackground', assets.familyBackground, 500, '家庭背景简述不能超过500字')

  const photos = list(personal.lifePhotos)
  if (photos.length < MEMBER_LIFE_PHOTO_MIN) errors.push({ field: 'personalProfile.lifePhotos', message: '请至少上传3张本人生活照' })
  if (photos.length > MEMBER_LIFE_PHOTO_MAX) errors.push({ field: 'personalProfile.lifePhotos', message: '本人生活照最多上传9张' })
  if (photos.some(fileID => !/^cloud:\/\/\S+\/hl_uploads\/member-private\/[^/\s]+\/\S+$/.test(fileID))) {
    errors.push({ field: 'personalProfile.lifePhotos', message: '生活照必须上传到内部档案专用目录' })
  }
  optionalTextLength(errors, 'personalProfile.personalitySummary', personal.personalitySummary, 500, '性格简述不能超过500字')
  optionalTextLength(errors, 'personalProfile.hobbies', personal.hobbies, 500, '爱好不能超过500字')
  optionalTextLength(errors, 'personalProfile.dailyRoutine', personal.dailyRoutine, 500, '生活作息不能超过500字')
  if (text(personal.smokingStatus) && !SMOKING_STATUS_VALUES.has(text(personal.smokingStatus))) {
    errors.push({ field: 'personalProfile.smokingStatus', message: '抽烟情况选项不正确' })
  }
  if (text(personal.drinkingStatus) && !DRINKING_STATUS_VALUES.has(text(personal.drinkingStatus))) {
    errors.push({ field: 'personalProfile.drinkingStatus', message: '饮酒情况选项不正确' })
  }

  requiredNumber(errors, 'partnerPreferences.ageMin', partner.ageMin, '请输入希望对方最小年龄', 18, 100, true)
  requiredNumber(errors, 'partnerPreferences.ageMax', partner.ageMax, '请输入希望对方最大年龄', 18, 100, true)
  if (numberOrNull(partner.ageMin) !== null && numberOrNull(partner.ageMax) !== null && Number(partner.ageMin) > Number(partner.ageMax)) {
    errors.push({ field: 'partnerPreferences.ageMax', message: '年龄上限不能小于下限' })
  }
  requiredText(errors, 'partnerPreferences.heightRequirement', partner.heightRequirement, '请输入身高要求', 100)
  requireAllowed(errors, 'partnerPreferences.educationMinimum', partner.educationMinimum, PARTNER_EDUCATION_VALUES, '请选择学历底线')
  const partnerMaritalStatuses = list(partner.maritalStatuses)
  requireList(errors, 'partnerPreferences.maritalStatuses', partnerMaritalStatuses, PARTNER_MARITAL_STATUS_VALUES, '请选择婚姻状态要求')
  if (partnerMaritalStatuses.includes('不限') && partnerMaritalStatuses.length > 1) errors.push({ field: 'partnerPreferences.maritalStatuses', message: '选择不限后无需再选其他婚姻状态' })
  requiredText(errors, 'partnerPreferences.incomeAssetExpectation', partner.incomeAssetExpectation, '请输入对方收入或资产预期', 500)
  requiredText(errors, 'partnerPreferences.regionRequirement', partner.regionRequirement, '请输入地域要求', 300)
  requiredText(errors, 'partnerPreferences.dealBreakers', partner.dealBreakers, '请输入核心硬性不能接受点', 1000)
  requiredText(errors, 'partnerPreferences.relationshipMode', partner.relationshipMode, '请输入期待的相处模式', 1000)

  requireAllowed(errors, 'businessRegistration.customerSource', business.customerSource, CUSTOMER_SOURCE_VALUES, '请选择客户来源')
  if (business.customerSource === 'boss_or_other') requiredText(errors, 'businessRegistration.otherCustomerSource', business.otherCustomerSource, '请填写BOSS或其他渠道', 100)
  requireAllowed(errors, 'businessRegistration.packageType', business.packageType, PACKAGE_TYPE_VALUES, '请选择办理套餐')
  if (business.packageType === 'other') requiredText(errors, 'businessRegistration.otherPackageName', business.otherPackageName, '请填写其他套餐名称', 100)
  requiredText(errors, 'businessRegistration.responsibleMatchmaker', business.responsibleMatchmaker, '请输入对接主理人或负责人', 80)
  const joinDate = text(business.joinDate)
  const expiryDate = text(business.expiryDate)
  if (!joinDate) errors.push({ field: 'businessRegistration.joinDate', message: '请选择入会日期' })
  else if (!dateParts(joinDate)) errors.push({ field: 'businessRegistration.joinDate', message: '入会日期格式不正确' })
  if (expiryDate && !dateParts(expiryDate)) errors.push({ field: 'businessRegistration.expiryDate', message: '到期日期格式不正确' })
  if (business.packageType !== 'unpaid' && !expiryDate) errors.push({ field: 'businessRegistration.expiryDate', message: '请选择到期日期' })
  if (business.packageType === '9980_3m' && dateParts(joinDate) && dateParts(expiryDate) && expiryDate !== expiryDateForPackage('9980_3m', joinDate)) {
    errors.push({ field: 'businessRegistration.expiryDate', message: '9980三个月套餐到期日应为入会日后三个自然月' })
  }
  if (dateParts(joinDate) && dateParts(expiryDate) && expiryDate < joinDate) errors.push({ field: 'businessRegistration.expiryDate', message: '到期日期不能早于入会日期' })
  const tags = list(business.tags)
  if (tags.length > 20) errors.push({ field: 'businessRegistration.tags', message: '备注标签最多20个' })
  if (tags.some(tag => tag.length > 30)) errors.push({ field: 'businessRegistration.tags', message: '单个备注标签不能超过30字' })
  optionalTextLength(errors, 'businessRegistration.otherTags', business.otherTags, 200, '其他标签不能超过200字')
  optionalTextLength(errors, 'businessRegistration.riskNotes', business.riskNotes, 1000, '重要风险备注不能超过1000字')

  if (compliance.partialVerificationConfirmed !== true) errors.push({ field: 'compliance.partialVerificationConfirmed', message: '请确认已核验本人部分资料' })
  if (compliance.voluntarySubmissionConfirmed !== true) errors.push({ field: 'compliance.voluntarySubmissionConfirmed', message: '请确认客户自愿提交资料' })

  return {
    valid: errors.length === 0,
    firstError: errors[0] || null,
    errors
  }
}

export function buildMemberIntakePayload(form: Record<string, any>) {
  const assets = form.assetVerification || {}
  const personal = form.personalProfile || {}
  const partner = form.partnerPreferences || {}
  const business = form.businessRegistration || {}
  const compliance = form.compliance || {}
  const hasChildren = booleanValue(form.hasChildren)
  const incomeSources = list(form.incomeSources)
  const propertyCount = numberOrNull(assets.propertyCount)
  const vehicleCount = numberOrNull(assets.vehicleCount)
  const customerSource = text(business.customerSource)
  const packageType = text(business.packageType)
  return {
    intakeVersion: MEMBER_INTAKE_VERSION,
    realName: text(form.realName),
    gender: genderValue(form.gender),
    age: numberOrNull(form.age),
    birthDate: text(form.birthDate),
    phone: phoneValue(form.phone),
    city: text(form.city),
    height: numberOrNull(form.height),
    weightKg: numberOrNull(form.weightKg),
    education: text(form.education),
    graduateSchool: text(form.graduateSchool),
    maritalStatus: text(form.maritalStatus),
    hasChildren,
    childrenCount: hasChildren === true ? numberOrNull(form.childrenCount) : 0,
    occupation: text(form.occupation),
    companyName: text(form.companyName),
    jobTitle: text(form.jobTitle),
    annualIncomePreTax: numberOrNull(form.annualIncomePreTax),
    incomeSources,
    otherIncomeSource: incomeSources.includes('other') ? text(form.otherIncomeSource) : '',
    verificationEvidenceTypes: list(form.verificationEvidenceTypes),
    verificationCredentialLocation: text(form.verificationCredentialLocation),
    assetVerification: {
      propertyCount,
      propertyCities: Number(propertyCount) > 0 ? text(assets.propertyCities) : '',
      propertyProofTypes: Number(propertyCount) > 0 ? list(assets.propertyProofTypes) : [],
      vehicleModels: Number(vehicleCount) > 0 ? text(assets.vehicleModels) : '',
      vehicleCount,
      vehicleProofTypes: Number(vehicleCount) > 0 ? list(assets.vehicleProofTypes) : [],
      financialAssetRange: text(assets.financialAssetRange),
      familyBackground: text(assets.familyBackground)
    },
    personalProfile: {
      personalitySummary: text(personal.personalitySummary),
      hobbies: text(personal.hobbies),
      dailyRoutine: text(personal.dailyRoutine),
      smokingStatus: text(personal.smokingStatus),
      drinkingStatus: text(personal.drinkingStatus),
      lifePhotos: list(personal.lifePhotos)
    },
    partnerPreferences: {
      ageMin: numberOrNull(partner.ageMin),
      ageMax: numberOrNull(partner.ageMax),
      heightRequirement: text(partner.heightRequirement),
      educationMinimum: text(partner.educationMinimum),
      maritalStatuses: list(partner.maritalStatuses),
      incomeAssetExpectation: text(partner.incomeAssetExpectation),
      regionRequirement: text(partner.regionRequirement),
      dealBreakers: text(partner.dealBreakers),
      relationshipMode: text(partner.relationshipMode)
    },
    businessRegistration: {
      customerSource,
      otherCustomerSource: customerSource === 'boss_or_other' ? text(business.otherCustomerSource) : '',
      packageType,
      otherPackageName: packageType === 'other' ? text(business.otherPackageName) : '',
      responsibleMatchmaker: text(business.responsibleMatchmaker),
      joinDate: text(business.joinDate),
      expiryDate: packageType === 'unpaid' ? '' : text(business.expiryDate),
      tags: list(business.tags),
      otherTags: text(business.otherTags),
      riskNotes: text(business.riskNotes)
    },
    compliance: {
      partialVerificationConfirmed: booleanValue(compliance.partialVerificationConfirmed) === true,
      voluntarySubmissionConfirmed: booleanValue(compliance.voluntarySubmissionConfirmed) === true
    }
  }
}
