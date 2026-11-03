'use strict';

const OCCUPATIONS = ['金融', '国企', '央企', '政府', '政企单位', 'AI行业', '医生', '军人', '互联网/科技', '教育/培训', '医疗/健康', '法律/咨询', '文化传媒', '设计/艺术', '公务员/事业单位', '企业管理', '创业/个体', '自由职业', '其他'];
const OPTIONS = {
  education: ['高中/中专', '大专', '本科', '硕士', '博士', '其他'],
  marriageTimeline: ['一年内', '两年内', '三年内', '顺其自然'],
  hasChildren: ['有', '无'], wantsChildren: ['想要', '不想要', '可以商量'],
  zodiac: ['鼠', '牛', '虎', '兔', '龙', '蛇', '马', '羊', '猴', '鸡', '狗', '猪'],
  constellation: ['白羊座', '金牛座', '双子座', '巨蟹座', '狮子座', '处女座', '天秤座', '天蝎座', '射手座', '摩羯座', '水瓶座', '双鱼座'],
  smoking: ['不吸烟', '偶尔吸烟', '吸烟'], drinking: ['不喝酒', '偶尔喝酒', '经常喝酒'],
  pets: ['养宠物', '不养宠物'], maritalStatus: ['未婚', '离异', '丧偶']
};

function invalid(message) {
  const error = new Error(message);
  error.status = 400; error.statusCode = 400; error.code = 40001;
  throw error;
}

function optionalNumber(value, label, min, max) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) invalid(`${label}须为${min}至${max}之间的整数`);
  return value;
}

function normalizeMatchingPreferences(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('匹配偏好格式不正确');
  const normalized = {
    ageMin: optionalNumber(value.ageMin, '最低年龄', 18, 100),
    ageMax: optionalNumber(value.ageMax, '最高年龄', 18, 100),
    heightMin: optionalNumber(value.heightMin, '最低身高', 100, 250),
    occupations: [], education: '', city: '', marriageTimeline: '', hasChildren: '', wantsChildren: '',
    weightMin: optionalNumber(value.weightMin, '最低体重', 20, 300),
    weightMax: optionalNumber(value.weightMax, '最高体重', 20, 300),
    zodiac: '', constellation: '', smoking: '', drinking: '', pets: '', maritalStatus: ''
  };
  for (const prefix of ['age', 'weight']) {
    if (normalized[`${prefix}Min`] !== null && normalized[`${prefix}Max`] !== null
      && normalized[`${prefix}Min`] > normalized[`${prefix}Max`]) invalid(prefix === 'age' ? '年龄下限不能高于上限' : '体重下限不能高于上限');
  }
  for (const [field, options] of Object.entries(OPTIONS)) {
    const selection = value[field] === undefined || value[field] === null ? '' : value[field];
    if (typeof selection !== 'string' || (selection !== '' && !options.includes(selection))) invalid(`${field}选项不正确`);
    normalized[field] = selection;
  }
  if (value.city !== undefined && value.city !== null) {
    if (typeof value.city !== 'string' || value.city.trim().length > 60) invalid('现居住地不能超过60字');
    normalized.city = value.city.trim();
  }
  if (value.occupations !== undefined && value.occupations !== null) {
    if (!Array.isArray(value.occupations) || value.occupations.length > OCCUPATIONS.length
      || value.occupations.some(item => typeof item !== 'string' || !OCCUPATIONS.includes(item))) invalid('职业选项不正确');
    normalized.occupations = [...new Set(value.occupations)];
  }
  return normalized;
}

function matchingPreferencesSummary(value = {}) {
  const preference = normalizeMatchingPreferences(value);
  const parts = [];
  if (preference.ageMin !== null || preference.ageMax !== null) parts.push(`${preference.ageMin || 18}–${preference.ageMax || 100}岁`);
  if (preference.heightMin !== null) parts.push(`${preference.heightMin}cm以上`);
  if (preference.weightMin !== null || preference.weightMax !== null) parts.push(`体重${preference.weightMin || 20}–${preference.weightMax || 300}kg`);
  parts.push(...preference.occupations);
  for (const field of ['education', 'city', 'marriageTimeline', 'zodiac', 'constellation', 'smoking', 'drinking', 'pets', 'maritalStatus']) {
    if (preference[field]) parts.push(preference[field]);
  }
  if (preference.hasChildren) parts.push(`${preference.hasChildren}孩子`);
  if (preference.wantsChildren) parts.push(`生育意愿：${preference.wantsChildren}`);
  return parts.join('；');
}

// This is a preference score, not an eligibility filter. Missing profile data
// never makes a person appear to have met a requested preference.
function matchingPreferenceScore(row, preference) {
  let score = 0;
  const numberMatches = (key, min, max) => {
    const value = Number(row[key]);
    if ((min === null || min === undefined) && (max === null || max === undefined)) return;
    if (!Number.isFinite(value) || value <= 0) return;
    if ((min === null || min === undefined || value >= min) && (max === null || max === undefined || value <= max)) score += 1;
  };
  numberMatches('age', preference.ageMin, preference.ageMax);
  numberMatches('height', preference.heightMin, null);
  numberMatches('weightKg', preference.weightMin, preference.weightMax);
  if (preference.occupations && preference.occupations.includes(row.occupation)) score += 1;
  if (preference.city && String(row.city || '').includes(preference.city)) score += 1;
  const education = row.educationVerified === true && row.verifiedEducation ? row.verifiedEducation : row.education;
  if (preference.education && preference.education === education) score += 1;
  for (const field of ['marriageTimeline', 'hasChildren', 'wantsChildren', 'zodiac', 'constellation', 'smoking', 'drinking', 'pets', 'maritalStatus']) {
    if (preference[field] && preference[field] === row[field]) score += 1;
  }
  return score;
}

module.exports = { OCCUPATIONS, OPTIONS, normalizeMatchingPreferences, matchingPreferencesSummary, matchingPreferenceScore };
