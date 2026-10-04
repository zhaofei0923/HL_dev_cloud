const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MEMBER_INTAKE_VERSION,
  defaultMemberNo,
  normalizeMemberIntake,
  validateMemberIntake
} = require('../cloudfunctions/hlApi/member-intake-policy');

const NOW = new Date('2026-09-13T04:00:00.000Z');

function validIntake(overrides = {}) {
  const base = {
    realName: '李女士',
    gender: 2,
    age: 30,
    birthDate: '1995-09-14',
    phone: '13800138000',
    city: '成都·武侯区',
    height: 165,
    weightKg: 52.5,
    education: '本科',
    graduateSchool: '四川大学',
    maritalStatus: '未婚',
    hasChildren: false,
    childrenCount: 0,
    occupation: '品牌运营',
    companyName: '成都示例文化有限公司',
    jobTitle: '运营总监',
    annualIncomePreTax: 45,
    incomeSources: ['salary', 'investment'],
    otherIncomeSource: '',
    verificationEvidenceTypes: ['salary_statement', 'tax_record'],
    verificationCredentialLocation: '内部加密档案柜 A-01',
    assetVerification: {
      propertyCount: 1,
      propertyCities: '成都',
      propertyProofTypes: ['property_certificate'],
      vehicleModels: 'BMW 3系',
      vehicleCount: 1,
      vehicleProofTypes: ['vehicle_license'],
      financialAssetRange: '500k_2m',
      familyBackground: ''
    },
    personalProfile: {
      personalitySummary: '真诚直接，情绪稳定',
      hobbies: '阅读、徒步、展览',
      dailyRoutine: '工作日规律作息',
      smokingStatus: 'no',
      drinkingStatus: 'occasional',
      lifePhotos: [
        'cloud://env/hl_uploads/member-private/42/1.jpg',
        'cloud://env/hl_uploads/member-private/42/2.jpg',
        'cloud://env/hl_uploads/member-private/42/3.jpg'
      ]
    },
    partnerPreferences: {
      ageMin: 29,
      ageMax: 36,
      heightRequirement: '175cm以上',
      educationMinimum: '本科',
      maritalStatuses: ['未婚'],
      incomeAssetExpectation: '收入稳定，有长期规划',
      regionRequirement: '成都长期发展',
      dealBreakers: '隐瞒婚史、赌博',
      relationshipMode: '坦诚沟通，共同规划家庭生活'
    },
    businessRegistration: {
      customerSource: 'xiaohongshu',
      otherCustomerSource: '',
      packageType: '9980_3m',
      otherPackageName: '',
      responsibleMatchmaker: '王老师',
      joinDate: '2026-09-13',
      expiryDate: '2026-12-13',
      tags: ['高净值', '谨慎型'],
      otherTags: '',
      riskNotes: ''
    },
    compliance: {
      partialVerificationConfirmed: true,
      voluntarySubmissionConfirmed: true
    }
  };

  return { ...base, ...overrides };
}

test('exports a stable intake version and deterministic member number', () => {
  assert.equal(MEMBER_INTAKE_VERSION, 1);
  assert.equal(defaultMemberNo(7, NOW), 'HL20260913-000007');
  assert.throws(() => defaultMemberNo(0, NOW), /positive integer/);
  assert.throws(() => defaultMemberNo(1, 'not-a-date'), /must be valid/);
});

test('normalizes scalar aliases, phone, numbers and deduplicated lists without mass assignment', () => {
  const source = validIntake({
    realName: '  李女士  ',
    gender: '女',
    age: '30',
    phone: '+86 138-0013-8000',
    hasChildren: '无',
    incomeSources: ['salary', 'salary', ' investment '],
    unexpectedAdminField: true
  });
  const normalized = normalizeMemberIntake(source, NOW);

  assert.equal(normalized.intakeVersion, 1);
  assert.equal(normalized.realName, '李女士');
  assert.equal(normalized.gender, 2);
  assert.equal(normalized.age, 30);
  assert.equal(normalized.phone, '13800138000');
  assert.equal(normalized.hasChildren, false);
  assert.equal(normalized.childrenCount, 0);
  assert.deepEqual(normalized.incomeSources, ['salary', 'investment']);
  assert.equal(Object.prototype.hasOwnProperty.call(normalized, 'unexpectedAdminField'), false);
  assert.equal(source.realName, '  李女士  ');
});

test('normalization discards values from inactive conditional fields', () => {
  const source = validIntake({
    incomeSources: ['salary'],
    otherIncomeSource: '不应保留',
    assetVerification: {
      ...validIntake().assetVerification,
      propertyCount: 0,
      propertyCities: '不应保留',
      propertyProofTypes: ['property_certificate'],
      vehicleCount: 0,
      vehicleModels: '不应保留',
      vehicleProofTypes: ['vehicle_license']
    },
    businessRegistration: {
      ...validIntake().businessRegistration,
      customerSource: 'xiaohongshu',
      otherCustomerSource: '不应保留',
      packageType: 'unpaid',
      otherPackageName: '不应保留',
      expiryDate: '2099-01-01'
    }
  });
  const normalized = normalizeMemberIntake(source, NOW);

  assert.equal(normalized.otherIncomeSource, '');
  assert.equal(normalized.assetVerification.propertyCities, '');
  assert.deepEqual(normalized.assetVerification.propertyProofTypes, []);
  assert.equal(normalized.assetVerification.vehicleModels, '');
  assert.deepEqual(normalized.assetVerification.vehicleProofTypes, []);
  assert.equal(normalized.businessRegistration.otherCustomerSource, '');
  assert.equal(normalized.businessRegistration.otherPackageName, '');
  assert.equal(normalized.businessRegistration.expiryDate, '');
});

test('defaults the join date using the Shanghai calendar day', () => {
  const source = validIntake();
  source.businessRegistration = { ...source.businessRegistration, joinDate: '' };
  const normalized = normalizeMemberIntake(source, new Date('2026-09-12T17:30:00.000Z'));
  assert.equal(normalized.businessRegistration.joinDate, '2026-09-13');
});

test('accepts a complete required intake and returns an API-friendly result', () => {
  const result = validateMemberIntake(validIntake(), NOW);
  assert.equal(result.valid, true);
  assert.equal(result.firstError, null);
  assert.deepEqual(result.errors, []);
  assert.equal(result.data.businessRegistration.packageType, '9980_3m');
  assert.equal(result.data.personalProfile.lifePhotos.length, 3);
});

test('returns a structured first error and the complete error list', () => {
  const result = validateMemberIntake({}, NOW);
  assert.equal(result.valid, false);
  assert.deepEqual(result.firstError, {
    field: 'realName',
    code: 'required',
    message: '请输入姓名'
  });
  assert.ok(result.errors.length > 20);
  result.errors.forEach(error => {
    assert.equal(typeof error.field, 'string');
    assert.equal(typeof error.code, 'string');
    assert.equal(typeof error.message, 'string');
  });
});

test('requires 3 to 9 uploaded cloud life photos', () => {
  const tooFew = validIntake();
  tooFew.personalProfile = { ...tooFew.personalProfile, lifePhotos: ['cloud://env/hl_uploads/member-private/42/1.jpg', 'cloud://env/hl_uploads/member-private/42/2.jpg'] };
  const tooFewResult = validateMemberIntake(tooFew, NOW);
  assert.ok(tooFewResult.errors.some(error => error.field === 'personalProfile.lifePhotos' && error.code === 'min_items'));

  const tooMany = validIntake();
  tooMany.personalProfile = {
    ...tooMany.personalProfile,
    lifePhotos: Array.from({ length: 10 }, (_, index) => `cloud://env/hl_uploads/member-private/42/${index}.jpg`)
  };
  const tooManyResult = validateMemberIntake(tooMany, NOW);
  assert.ok(tooManyResult.errors.some(error => error.field === 'personalProfile.lifePhotos' && error.code === 'max_items'));

  const localPhoto = validIntake();
  localPhoto.personalProfile = {
    ...localPhoto.personalProfile,
    lifePhotos: ['cloud://env/hl_uploads/member-private/42/1.jpg', 'cloud://env/hl_uploads/member-private/42/2.jpg', 'wxfile://tmp/3.jpg']
  };
  const localResult = validateMemberIntake(localPhoto, NOW);
  assert.ok(localResult.errors.some(error => error.code === 'invalid_file_id'));

  assert.equal(validateMemberIntake(validIntake(), NOW, { privatePhotoOwnerKey: '42' }).valid, true);
  const wrongOwnerResult = validateMemberIntake(validIntake(), NOW, { privatePhotoOwnerKey: '99' });
  assert.ok(wrongOwnerResult.errors.some(error => error.code === 'invalid_file_id'));
});

test('keeps narrative personal fields optional while preserving required life photos', () => {
  const source = validIntake();
  source.personalProfile = {
    ...source.personalProfile,
    personalitySummary: '',
    hobbies: '',
    dailyRoutine: '',
    smokingStatus: '',
    drinkingStatus: ''
  };
  assert.equal(validateMemberIntake(source, NOW).valid, true);
});

test('cross-checks age with birth date and validates conditional children fields', () => {
  const mismatch = validateMemberIntake(validIntake({ age: 31 }), NOW);
  assert.ok(mismatch.errors.some(error => error.field === 'age' && error.code === 'age_mismatch'));

  const withChildren = validateMemberIntake(validIntake({ hasChildren: true, childrenCount: 0 }), NOW);
  assert.ok(withChildren.errors.some(error => error.field === 'childrenCount' && error.code === 'out_of_range'));

  const missingChoice = validateMemberIntake(validIntake({ hasChildren: '' }), NOW);
  assert.ok(missingChoice.errors.some(error => error.field === 'hasChildren' && error.code === 'required'));
});

test('enforces other-source and other-package descriptions', () => {
  const result = validateMemberIntake(validIntake({
    incomeSources: ['salary', 'other'],
    otherIncomeSource: '',
    businessRegistration: {
      ...validIntake().businessRegistration,
      customerSource: 'boss_or_other',
      otherCustomerSource: '',
      packageType: 'other',
      otherPackageName: ''
    }
  }), NOW);

  assert.ok(result.errors.some(error => error.field === 'otherIncomeSource'));
  assert.ok(result.errors.some(error => error.field === 'businessRegistration.otherCustomerSource'));
  assert.ok(result.errors.some(error => error.field === 'businessRegistration.otherPackageName'));
});

test('requires proof details when property or vehicles are declared', () => {
  const result = validateMemberIntake(validIntake({
    assetVerification: {
      ...validIntake().assetVerification,
      propertyCount: 2,
      propertyCities: '',
      propertyProofTypes: [],
      vehicleCount: 1,
      vehicleModels: '',
      vehicleProofTypes: []
    }
  }), NOW);

  assert.ok(result.errors.some(error => error.field === 'assetVerification.propertyCities'));
  assert.ok(result.errors.some(error => error.field === 'assetVerification.propertyProofTypes'));
  assert.ok(result.errors.some(error => error.field === 'assetVerification.vehicleModels'));
  assert.ok(result.errors.some(error => error.field === 'assetVerification.vehicleProofTypes'));
});

test('validates partner ranges, choices, service dates and compliance confirmations', () => {
  const result = validateMemberIntake(validIntake({
    partnerPreferences: {
      ...validIntake().partnerPreferences,
      ageMin: 40,
      ageMax: 30,
      maritalStatuses: ['不限', '未婚']
    },
    businessRegistration: {
      ...validIntake().businessRegistration,
      joinDate: '2026-12-01',
      expiryDate: '2026-11-01'
    },
    compliance: {
      partialVerificationConfirmed: false,
      voluntarySubmissionConfirmed: false
    }
  }), NOW);

  assert.ok(result.errors.some(error => error.field === 'partnerPreferences.ageMax' && error.code === 'invalid_range'));
  assert.ok(result.errors.some(error => error.field === 'partnerPreferences.maritalStatuses' && error.code === 'conflicting_choice'));
  assert.ok(result.errors.some(error => error.field === 'businessRegistration.expiryDate' && error.code === 'invalid_range'));
  assert.ok(result.errors.some(error => error.field === 'compliance.partialVerificationConfirmed'));
  assert.ok(result.errors.some(error => error.field === 'compliance.voluntarySubmissionConfirmed'));
});

test('allows unpaid membership without an expiry date but requires it for paid packages', () => {
  const unpaid = validIntake();
  unpaid.businessRegistration = {
    ...unpaid.businessRegistration,
    packageType: 'unpaid',
    expiryDate: ''
  };
  assert.equal(validateMemberIntake(unpaid, NOW).valid, true);

  const paid = validIntake();
  paid.businessRegistration = { ...paid.businessRegistration, expiryDate: '' };
  const paidResult = validateMemberIntake(paid, NOW);
  assert.ok(paidResult.errors.some(error => error.field === 'businessRegistration.expiryDate' && error.code === 'required'));
});

test('enforces the exact three-calendar-month term including month-end clamping', () => {
  const monthEnd = validIntake();
  monthEnd.businessRegistration = {
    ...monthEnd.businessRegistration,
    joinDate: '2026-11-30',
    expiryDate: '2027-02-28'
  };
  assert.equal(validateMemberIntake(monthEnd, NOW).valid, true);

  monthEnd.businessRegistration.expiryDate = '2027-03-01';
  const result = validateMemberIntake(monthEnd, NOW);
  assert.ok(result.errors.some(error => error.code === 'invalid_package_term'));
});
