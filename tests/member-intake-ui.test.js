const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MEMBER_LIFE_PHOTO_MAX,
  MEMBER_LIFE_PHOTO_MIN,
  ageFromBirthDate,
  buildMemberIntakePayload,
  createMemberIntakeDefaults,
  expiryDateForPackage,
  todayText,
  validateMemberIntake
} = require('../miniprogram/utils/member-intake');

const NOW = new Date('2026-09-13T04:00:00.000Z');

function completeForm() {
  const form = createMemberIntakeDefaults('王老师');
  Object.assign(form, {
    realName: '李女士',
    gender: 2,
    age: 30,
    birthDate: '1995-09-14',
    phone: '13800138000',
    city: '四川省 成都市 武侯区',
    height: 165,
    weightKg: 52.5,
    education: '本科',
    graduateSchool: '四川大学',
    maritalStatus: '未婚',
    hasChildren: false,
    occupation: '品牌运营',
    companyName: '成都示例文化有限公司',
    jobTitle: '运营总监',
    annualIncomePreTax: 45,
    incomeSources: ['salary'],
    verificationEvidenceTypes: ['salary_statement'],
    verificationCredentialLocation: '内部加密档案柜 A-01'
  });
  Object.assign(form.assetVerification, {
    propertyCount: 0,
    vehicleCount: 0,
    financialAssetRange: '500k_2m'
  });
  Object.assign(form.personalProfile, {
    lifePhotos: [
      'cloud://env/hl_uploads/member-private/user-7/1.jpg',
      'cloud://env/hl_uploads/member-private/user-7/2.jpg',
      'cloud://env/hl_uploads/member-private/user-7/3.jpg'
    ]
  });
  Object.assign(form.partnerPreferences, {
    ageMin: 29,
    ageMax: 36,
    heightRequirement: '175cm以上',
    educationMinimum: '本科',
    maritalStatuses: ['未婚'],
    incomeAssetExpectation: '收入稳定',
    regionRequirement: '成都长期发展',
    dealBreakers: '隐瞒婚史',
    relationshipMode: '坦诚沟通'
  });
  Object.assign(form.businessRegistration, {
    customerSource: 'xiaohongshu',
    packageType: '9980_3m',
    joinDate: '2026-09-13',
    expiryDate: '2026-12-13'
  });
  Object.assign(form.compliance, {
    partialVerificationConfirmed: true,
    voluntarySubmissionConfirmed: true
  });
  return form;
}

test('uses the Shanghai calendar day for defaults and age boundaries', () => {
  assert.equal(todayText(new Date('2026-09-12T16:30:00.000Z')), '2026-09-13');
  assert.equal(ageFromBirthDate('1995-09-13', NOW), 31);
});

test('calculates age at the birthday boundary', () => {
  assert.equal(ageFromBirthDate('1995-09-14', new Date(2026, 8, 13)), 30);
  assert.equal(ageFromBirthDate('1995-09-13', new Date(2026, 8, 13)), 31);
});

test('adds three calendar months and clamps month-end dates', () => {
  assert.equal(expiryDateForPackage('9980_3m', '2026-11-30'), '2027-02-28');
  assert.equal(expiryDateForPackage('9980_3m', '2028-11-30'), '2029-02-28');
  assert.equal(expiryDateForPackage('9980_3m', '2026-01-31'), '2026-04-30');
  assert.equal(expiryDateForPackage('9980_3m', '2027-11-30'), '2028-02-29');
  assert.equal(expiryDateForPackage('unpaid', '2026-09-13'), '');
});

test('defaults keep internal photo boundaries and do not invent confirmations', () => {
  const form = createMemberIntakeDefaults('王老师');
  assert.equal(MEMBER_LIFE_PHOTO_MIN, 3);
  assert.equal(MEMBER_LIFE_PHOTO_MAX, 9);
  assert.equal(form.businessRegistration.responsibleMatchmaker, '王老师');
  assert.equal(form.businessRegistration.packageType, 'unpaid');
  assert.equal(form.compliance.partialVerificationConfirmed, false);
  assert.equal(form.compliance.voluntarySubmissionConfirmed, false);
});

test('build payload allowlists nested fields and removes display-only URLs', () => {
  const form = createMemberIntakeDefaults('王老师');
  form.realName = '李女士';
  form.lifePhotoDisplayUrls = ['wxfile://temporary.jpg'];
  form.openSections = { basic: true };
  form.personalProfile.lifePhotos = [
    'cloud://env/private/1.jpg',
    'cloud://env/private/2.jpg',
    'cloud://env/private/3.jpg'
  ];
  const payload = buildMemberIntakePayload(form);
  assert.equal(payload.realName, '李女士');
  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'lifePhotoDisplayUrls'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'openSections'), false);
  assert.deepEqual(payload.personalProfile.lifePhotos, form.personalProfile.lifePhotos);
});

test('validation points to the first incomplete section and enforces photo minimum', () => {
  const empty = validateMemberIntake(createMemberIntakeDefaults(''));
  assert.equal(empty.valid, false);
  assert.equal(empty.firstError.field, 'realName');

  const form = createMemberIntakeDefaults('王老师');
  form.realName = '李女士';
  form.gender = 2;
  form.birthDate = '1995-09-14';
  form.age = 30;
  form.phone = '13800138000';
  form.city = '四川省 成都市 武侯区';
  form.height = 165;
  form.weightKg = 52;
  form.education = '本科';
  form.graduateSchool = '四川大学';
  form.maritalStatus = '未婚';
  form.hasChildren = false;
  const result = validateMemberIntake(form, new Date(2026, 8, 13));
  assert.ok(result.errors.some(error => error.field === 'personalProfile.lifePhotos'));
});

test('frontend validation enforces the backend enum, date, length and private-photo contract', () => {
  assert.equal(validateMemberIntake(completeForm(), NOW).valid, true);

  const invalidPhoto = completeForm();
  invalidPhoto.personalProfile.lifePhotos[2] = 'wxfile://tmp/local.jpg';
  assert.ok(validateMemberIntake(invalidPhoto, NOW).errors.some(error => error.field === 'personalProfile.lifePhotos'));

  const ownerlessPhoto = completeForm();
  ownerlessPhoto.personalProfile.lifePhotos[2] = 'cloud://env/hl_uploads/member-private/3.jpg';
  assert.ok(validateMemberIntake(ownerlessPhoto, NOW).errors.some(error => error.field === 'personalProfile.lifePhotos'));

  const invalidChoices = completeForm();
  invalidChoices.assetVerification.financialAssetRange = 'unknown';
  invalidChoices.personalProfile.smokingStatus = 'sometimes';
  invalidChoices.businessRegistration.customerSource = 'unknown';
  const choiceErrors = validateMemberIntake(invalidChoices, NOW).errors.map(error => error.field);
  assert.ok(choiceErrors.includes('assetVerification.financialAssetRange'));
  assert.ok(choiceErrors.includes('personalProfile.smokingStatus'));
  assert.ok(choiceErrors.includes('businessRegistration.customerSource'));

  const invalidDate = completeForm();
  invalidDate.businessRegistration.packageType = 'other';
  invalidDate.businessRegistration.otherPackageName = '定制套餐';
  invalidDate.businessRegistration.expiryDate = '2026-02-31';
  assert.ok(validateMemberIntake(invalidDate, NOW).errors.some(error => error.field === 'businessRegistration.expiryDate'));

  const tooLong = completeForm();
  tooLong.companyName = '企'.repeat(121);
  assert.ok(validateMemberIntake(tooLong, NOW).errors.some(error => error.field === 'companyName'));
});

test('build payload clears values whose controlling choices are inactive', () => {
  const form = completeForm();
  form.phone = '+86 138-0013-8000';
  form.otherIncomeSource = '历史收入来源';
  Object.assign(form.assetVerification, {
    propertyCount: 0,
    propertyCities: '历史城市',
    propertyProofTypes: ['property_certificate'],
    vehicleCount: 0,
    vehicleModels: '历史车型',
    vehicleProofTypes: ['vehicle_license']
  });
  Object.assign(form.businessRegistration, {
    customerSource: 'xiaohongshu',
    otherCustomerSource: '历史渠道',
    packageType: 'unpaid',
    otherPackageName: '历史套餐',
    expiryDate: '2027-01-01'
  });

  const payload = buildMemberIntakePayload(form);
  assert.equal(payload.phone, '13800138000');
  assert.equal(payload.otherIncomeSource, '');
  assert.equal(payload.assetVerification.propertyCities, '');
  assert.deepEqual(payload.assetVerification.propertyProofTypes, []);
  assert.equal(payload.assetVerification.vehicleModels, '');
  assert.deepEqual(payload.assetVerification.vehicleProofTypes, []);
  assert.equal(payload.businessRegistration.otherCustomerSource, '');
  assert.equal(payload.businessRegistration.otherPackageName, '');
  assert.equal(payload.businessRegistration.expiryDate, '');
});
