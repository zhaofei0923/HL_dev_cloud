const cloud = require('wx-server-sdk');
const crypto = require('node:crypto');
const { normalizeMemberLocation, currentLocation, memberDistanceText } = require('./member-location-policy');
const { normalizeMatchingPreferences, matchingPreferenceScore } = require('./matching-preferences-policy');
const { createMemberRelationshipService } = require('./member-relationship-service');
const { miniprogramAdminEntry } = require('./admin-entry-policy');
const { createPublicBrowseService } = require('./public-browse');
const { createContentSecurityService } = require('./content-security');
const {
  activeAttendance,
  latestAttendanceRows,
  isPublicRegistrationPhoto,
  minimumRegistrationStatus,
  registrationName,
  registrationPhotos,
  salonAvailability
} = require('./salon-policy');
const {
  TOKEN_TYPES,
  createTokenService,
  normalizeWechatPhoneResult,
  resolveWechatOpenid
} = require('./auth-policy');
const {
  buildMembershipFulfillment,
  createPendingPaymentOrder,
  normalizeMembershipPlan,
  paymentOrderIdentity,
  paymentDetailsMatch,
  paymentConfirmationMatches,
  paymentIntegrationConfig,
  paymentProviderConfig,
  MATCHMAKER_LIFETIME_PLAN,
  assertMatchmakerLifetimeProduct
} = require('./membership-payment-policy');
const { createMatchmakerActivationService, matchmakerActivationSnapshot, matchmakerActivationEligibility } = require('./matchmaker-activation-service');
const { createVipMembershipService, VIP_COLLECTIONS, DEFAULT_MEMBERSHIP_PLANS, RETIRED_MATCHMAKING_PLAN_CODES } = require('./vip-membership-service');
const { DIRECT_PURCHASE_CONTRACT, isDirectPurchaseOrder, assertPurchaseContract } = require('./purchase-contract-policy');
const { paymentTestAccess, paymentTestRunId, paymentTestDocumentId, paymentTestPushOnly, paymentTestPlan,
  assertTestCheckout, assertCurrentTestCheckout } = require('./payment-test-policy');
const {
  buildVirtualCloseProof,
  buildVirtualConfirmation,
  buildVirtualRefundProof,
  buildVirtualSignData,
  clientPaymentSignatures,
  createVirtualPaymentClient,
  assertVirtualLoginCode,
  assertVirtualOrderNumber,
  assertVirtualPayer,
  mapVirtualOrderState,
  validateGoodsDeliverPush,
  virtualPaymentConfig
} = require('./virtual-payment-policy');
const {
  createLockedRelationshipPreview,
  isPremiumMembership,
  partitionFavoriteRelationships,
  relationshipNotificationView,
  requiresPremiumForConversation
} = require('./relationship-policy');
const {
  defaultMemberNo,
  validateMemberIntake
} = require('./member-intake-policy');
const { createMemberAssignmentService } = require('./member-assignment-policy');
const {
  assetPreferencePatch, categoryRank, normalizeCertificationReview, normalizeCertificationRequest, normalizeShowcaseCategory,
  assetCertificationExpiresAt, ownCertificationOverview, popularityCounts, publicCertificationFields, sanitizeProfileCertification
} = require('./showcase-policy');
const {
  validateMaterialInput, sealMaterial, openMaterial, sealVerification, openVerification
} = require('./certification-material-policy');
const {
  archivedMergedOpenid,
  claimExpiresAt,
  claimTokenMatches,
  createClaimToken,
  fillTargetProfileBlanks,
  hashClaimToken,
  isClaimExpired,
  isManualIdentity,
  maskMemberNo,
  maskName,
  maskPhone,
  normalizeMainlandPhone,
  parseClaimToken
} = require('./account-claim-policy');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const _ = db.command;
const publicBrowse = createPublicBrowseService({ db, plans: DEFAULT_MEMBERSHIP_PLANS, env: process.env });
const contentSecurity = createContentSecurityService({ cloud, error: createHttpError, env: process.env,
  logger: (record) => console.log('content_security_check', record) });

const C = {
  users: 'hl_users',
  profiles: 'hl_profiles',
  matchmakers: 'hl_matchmakers',
  members: 'hl_members',
  memberPrivateArchives: 'hl_member_private_archives',
  memberCertifications: 'hl_member_certifications',
  salonEvents: 'hl_salon_events',
  registrations: 'hl_registrations',
  matchRecords: 'hl_match_records',
  memberRequests: 'hl_member_matchmaker_requests',
  messages: 'hl_messages',
  conversations: 'hl_conversations',
  chatMessages: 'hl_chat_messages',
  memberInteractions: 'hl_member_interactions',
  giftRecords: 'hl_gift_records',
  identityClaims: 'hl_member_identity_claims',
  membershipPlans: 'hl_membership_plans',
  paymentOrders: 'hl_payment_orders',
  counters: 'hl_counters',
  ...VIP_COLLECTIONS
};

const memberAssignments = createMemberAssignmentService({ db, error: createHttpError,
  listMembers: userId => memberAssignmentRows(userId) });

const MATCHMAKER_CERTIFICATION_STATUSES = new Set([0, 1, 2]);
const SALON_REVIEW_STATUSES = new Set(['upcoming', 'rejected']);
const MEMBER_PHOTO_LIMIT = 3;
const DAILY_FREE_FAVORITE_LIMIT = 8;
const LIKED_ME_LOCKED_PREVIEW_LIMIT = 4;
const RELATIONSHIP_LOCKED_PREVIEW_LIMIT = 2;
const SHANGHAI_UTC_OFFSET_MS = 8 * 60 * 60 * 1000;

const SEEDED_MEMBER_GROUPS = [
  [
    {
      realName: '陈先生',
      gender: 1,
      age: 31,
      height: 178,
      city: '杭州',
      province: '浙江',
      nativePlace: '绍兴',
      education: '本科',
      occupation: '产品经理',
      incomeRange: '30-50万',
      maritalStatus: '未婚',
      houseStatus: '已购房',
      carStatus: '有车',
      memberType: 'vip',
      serviceLevel: 'A',
      selfIntro: '互联网产品负责人，生活规律，喜欢徒步、摄影和做饭。',
      partnerRequirement: '希望对方真诚稳定，年龄 26-32 岁，杭州或上海发展。'
    },
    {
      realName: '林先生',
      gender: 1,
      age: 34,
      height: 181,
      city: '上海',
      province: '上海',
      nativePlace: '宁波',
      education: '硕士',
      occupation: '金融分析师',
      incomeRange: '50-80万',
      maritalStatus: '未婚',
      houseStatus: '已购房',
      carStatus: '有车',
      memberType: 'paid',
      serviceLevel: 'A',
      selfIntro: '券商研究岗，做事稳妥，注重家庭沟通和长期规划。',
      partnerRequirement: '希望认识本科以上、情绪稳定、有共同成长意愿的女士。'
    }
  ],
  [
    {
      realName: '许女士',
      gender: 2,
      age: 29,
      height: 166,
      city: '杭州',
      province: '浙江',
      nativePlace: '温州',
      education: '硕士',
      occupation: '品牌主理人',
      incomeRange: '30-50万',
      maritalStatus: '未婚',
      houseStatus: '计划购房',
      carStatus: '无车',
      memberType: 'vip',
      serviceLevel: 'S',
      selfIntro: '独立品牌经营者，审美在线，喜欢展览、旅行和咖啡。',
      partnerRequirement: '希望对方成熟坦诚，有稳定事业和清晰婚恋目标。'
    },
    {
      realName: '周女士',
      gender: 2,
      age: 27,
      height: 164,
      city: '苏州',
      province: '江苏',
      nativePlace: '南京',
      education: '本科',
      occupation: '中学教师',
      incomeRange: '20-30万',
      maritalStatus: '未婚',
      houseStatus: '与父母同住',
      carStatus: '有车',
      memberType: 'paid',
      serviceLevel: 'B',
      selfIntro: '性格温和，工作稳定，喜欢读书、烘焙和周边短途游。',
      partnerRequirement: '希望对方责任心强，工作稳定，江浙沪发展优先。'
    }
  ]
];

const NEW_MATCHMAKER_DEMO_MEMBERS = [
  {
    realName: '唐女士',
    gender: 2,
    age: 30,
    height: 167,
    city: '杭州',
    province: '浙江',
    nativePlace: '成都',
    education: '硕士',
    occupation: '市场总监',
    incomeRange: '40-60万',
    maritalStatus: '未婚',
    houseStatus: '已购房',
    carStatus: '有车',
    memberType: 'vip',
    serviceLevel: 'A',
    selfIntro: '外企市场负责人，沟通直接，喜欢旅行、瑜伽和艺术展。',
    partnerRequirement: '希望对方稳定成熟，有共同生活规划，江浙沪优先。'
  },
  {
    realName: '陆先生',
    gender: 1,
    age: 33,
    height: 179,
    city: '上海',
    province: '上海',
    nativePlace: '无锡',
    education: '本科',
    occupation: '建筑设计师',
    incomeRange: '30-50万',
    maritalStatus: '未婚',
    houseStatus: '已购房',
    carStatus: '无车',
    memberType: 'paid',
    serviceLevel: 'A',
    selfIntro: '建筑设计从业者，审美稳定，喜欢城市漫步和纪录片。',
    partnerRequirement: '希望对方真诚温和，重视沟通和长期关系。'
  }
];

const MEMBER_IMAGE_ROOT = '/assets/members/';
const MEMBER_AVATARS = {
  male: [`${MEMBER_IMAGE_ROOT}avatar-male-1.png`, `${MEMBER_IMAGE_ROOT}avatar-male-2.png`],
  female: [`${MEMBER_IMAGE_ROOT}avatar-female-1.png`, `${MEMBER_IMAGE_ROOT}avatar-female-2.png`]
};
const MEMBER_PHOTOS = [
  `${MEMBER_IMAGE_ROOT}lifestyle-gallery.png`,
  `${MEMBER_IMAGE_ROOT}lifestyle-cafe.png`,
  `${MEMBER_IMAGE_ROOT}lifestyle-city.png`,
  `${MEMBER_IMAGE_ROOT}lifestyle-travel.png`,
  `${MEMBER_IMAGE_ROOT}lifestyle-reading.png`,
  `${MEMBER_IMAGE_ROOT}lifestyle-sport.png`
];

const GIFT_CATALOG = [
  { id: 'flower', name: '鲜花', description: '表达一份认真好感', symbol: '花', tone: 'rose' },
  { id: 'coffee', name: '咖啡', description: '邀请对方轻松聊聊', symbol: '咖', tone: 'coffee' },
  { id: 'star', name: '星光', description: '送出特别关注', symbol: '星', tone: 'star' },
  { id: 'candy', name: '糖果', description: '传递轻松甜意', symbol: '糖', tone: 'sweet' }
];

let collectionsReady;
const collectionReadyByName = {};
let seedReady;

function shouldAutoCreateCollections() {
  return process.env.AUTO_CREATE_COLLECTIONS !== 'false';
}

function createHttpError(message, status = 400, code = 40001) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

async function ok(data = null, message = 'success') {
  // Server-owned images remain PRIVATE in storage. Resolve only display fields
  // already present in an authorized DTO; editable profile.photos keep file IDs.
  const displayKeys = new Set(['avatarUrl', 'coverUrl', 'coverImage']);
  const files = new Set();
  function visit(value, urls, depth = 0) {
    if (!value || typeof value !== 'object' || depth > 12) return value;
    if (Array.isArray(value)) return value.map(item => visit(item, urls, depth + 1));
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      if (displayKeys.has(key) && typeof item === 'string'
        && /^cloud:\/\/[^/]+\/hl_moderated\/images\/[a-f0-9]{64}\.(?:jpg|png)$/.test(item)) {
        files.add(item);
        return [key, urls ? (urls[item] || '') : item];
      }
      return [key, visit(item, urls, depth + 1)];
    }));
  }
  visit(data);
  if (files.size) data = visit(data, await memberMediaURLMap([...files]));
  return { code: 0, message, data };
}

function fail(err) {
  const status = err.status || 500;
  const code = err.code || (status >= 500 ? 50000 : 40000);
  const details = status < 500 && Array.isArray(err.details) ? clone(err.details) : null;
  return { code, message: err.message || 'server error', data: details ? { details } : null };
}

function nowIso() {
  return new Date().toISOString();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isMissingCollectionError(err) {
  const raw = String((err && (err.errMsg || err.message || err.code)) || err || '');
  return /DATABASE_COLLECTION_NOT_EXIST|ResourceNotFound|database collection not exists|Db or Table not exist/i.test(raw);
}

function stripInternal(row) {
  if (!row) return row;
  const safe = clone(row);
  delete safe._id;
  return safe;
}

function toNumber(value) {
  return Number(value);
}

function isTrue(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function normalizeCertificationStatus(value) {
  const status = Number(value);
  if (!Number.isInteger(status) || !MATCHMAKER_CERTIFICATION_STATUSES.has(status)) {
    throw createHttpError('invalid certification status');
  }
  return status;
}

function hashText(value) {
  return String(value || 'hl').split('').reduce((hash, char) => ((hash * 31) + char.charCodeAt(0)) >>> 0, 0);
}

const INVITE_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function normalizeInviteCode(value) {
  return String(value || '').trim().replace(/\s+/g, '').toUpperCase();
}

function randomInviteCode() {
  const bytes = crypto.randomBytes(6);
  let suffix = '';
  for (let index = 0; index < 6; index += 1) {
    suffix += INVITE_CODE_ALPHABET[bytes[index] % INVITE_CODE_ALPHABET.length];
  }
  return `HL${suffix}`;
}

function defaultMatchmakerNo(id) {
  return `MM${String(Number(id) || Date.now()).padStart(6, '0')}`;
}

async function uniqueInviteCode(excludeMatchmakerId = null) {
  for (let tries = 0; tries < 12; tries += 1) {
    const code = randomInviteCode();
    const existing = await getOne(C.matchmakers, { inviteCode: code });
    if (!existing || Number(existing.id) === Number(excludeMatchmakerId)) return code;
  }
  return `HL${String(Date.now()).slice(-6).toUpperCase()}`;
}

function defaultMemberMedia(data = {}) {
  const key = data.realName || data.nickname || data.city || data.gender || 'hl';
  const hash = hashText(key);
  const avatarPool = Number(data.gender) === 1 ? MEMBER_AVATARS.male : MEMBER_AVATARS.female;
  const start = hash % MEMBER_PHOTOS.length;
  return {
    avatarUrl: avatarPool[hash % avatarPool.length],
    photos: [0, 1, 2].map(offset => MEMBER_PHOTOS[(start + offset) % MEMBER_PHOTOS.length])
  };
}

function normalizeMemberPhotos(photos) {
  if (!Array.isArray(photos)) return [];
  const seen = new Set();
  const normalized = [];
  photos.forEach(photo => {
    if (typeof photo !== 'string') return;
    const value = photo.trim();
    if (!value || seen.has(value) || normalized.length >= MEMBER_PHOTO_LIMIT) return;
    seen.add(value);
    normalized.push(value);
  });
  return normalized;
}

function withMemberMedia(data = {}) {
  const defaults = defaultMemberMedia(data);
  const photos = normalizeMemberPhotos(data.photos);
  return {
    avatarUrl: photos[0] || defaults.avatarUrl,
    photos
  };
}

const tokenService = createTokenService();

async function ensureCollection(name) {
  if (!collectionReadyByName[name]) {
    collectionReadyByName[name] = (async () => {
      try {
        await db.createCollection(name);
      } catch (err) {
        // Collection already exists or the environment forbids creation here.
      }
    })();
  }
  return collectionReadyByName[name];
}

async function ensureCollections() {
  if (!collectionsReady) {
    collectionsReady = Promise.all(Object.values(C).map(name => ensureCollection(name)));
  }
  return collectionsReady;
}

function baseCollectionsForPath(path) {
  const common = [C.users, C.profiles, C.counters];
  if (path.startsWith('/member/relationship-') || path === '/member/unmatch') return [...common, C.memberInteractions, C.matchRecords, C.conversations];
  if (path === '/user/profile') return [...common, C.memberCertifications, C.members, VIP_COLLECTIONS.entitlements];
  if (path === '/matchmaker/status') return [C.users, C.matchmakers];
  if (path === '/member/invite-options') return [C.users, C.matchmakers, C.members, C.profiles];
  if (path === '/member/gifts') return [C.users];
  if (path === '/user/certifications' || path === '/user/certification-requests' || path.startsWith('/user/certification-materials')) {
    return [C.users, C.profiles, C.memberCertifications];
  }
  if (path === '/member/showcase' || /^\/member\/showcase\/(?:\d+|profile_\d+)$/.test(path)) {
    const names = [C.users, C.profiles, C.members, C.matchRecords, C.memberInteractions, C.memberCertifications];
    return path === '/member/showcase' ? names : [...names, C.matchmakers];
  }
  if (path === '/member/hidden') return [C.users, C.profiles, C.members, C.memberInteractions, C.memberCertifications];
  if (path === '/member/interactions' || path === '/member/gifts/send') {
    const names = [C.users, C.profiles, C.members, C.memberInteractions, C.counters, C.messages, C.conversations, C.memberCertifications];
    return path === '/member/gifts/send' ? [...names, C.giftRecords] : names;
  }
  if (path.startsWith('/admin/')) return Object.values(C);
  if (path.startsWith('/auth/member-claim')) {
    return [...common, C.identityClaims, C.members, C.matchmakers, C.memberPrivateArchives, C.memberCertifications];
  }
  if (path.startsWith('/matchmaker')) {
    return [...common, C.matchmakers, C.members, C.memberRequests, C.salonEvents, C.registrations, C.matchRecords, C.messages, C.identityClaims, C.memberCertifications];
  }
  if (path.startsWith('/member')) {
    return [...common, C.matchmakers, C.members, C.memberPrivateArchives, C.memberRequests, C.matchRecords, C.salonEvents, C.messages, C.memberInteractions, C.giftRecords, C.membershipPlans, C.paymentOrders, C.identityClaims, C.memberCertifications];
  }
  if (path.startsWith('/internal/payment-orders')) {
    return [...common, C.members, C.membershipPlans, C.paymentOrders];
  }
  if (path.startsWith('/salon')) {
    return [...common, C.matchmakers, C.members, C.salonEvents, C.registrations, C.messages, C.memberCertifications];
  }
  if (path.startsWith('/chat')) {
    return [...common, C.matchmakers, C.members, C.matchRecords, C.conversations, C.chatMessages, C.memberInteractions];
  }
  if (path.startsWith('/messages')) {
    return [...common, C.members, C.messages, C.conversations, C.memberInteractions];
  }
  return common;
}

function collectionsForPath(path) {
  const names = baseCollectionsForPath(path);
  if (path === '/matchmaker/status' || path === '/member/invite-options') return names;
  if (path.startsWith('/auth/member-claim')) return [...new Set([...names, ...Object.values(VIP_COLLECTIONS)])];
  if (/^\/member\/(?:vip|matchmaking)(?:\/|$)/.test(path) || path.startsWith('/internal/payment-orders')) {
    return [...new Set([...names, ...Object.values(VIP_COLLECTIONS), C.conversations])];
  }
  if (/^\/(?:member|chat|messages|matchmaker)(?:\/|$)/.test(path)) {
    return [...new Set([...names, VIP_COLLECTIONS.entitlements,
      ...(path === '/member/membership-plans' || path === '/member/payment-orders'
        ? Object.values(VIP_COLLECTIONS) : [])])];
  }
  return names;
}

async function ensureCollectionsForPath(path) {
  if (!shouldAutoCreateCollections()) return;
  const names = Array.from(new Set(collectionsForPath(path)));
  return Promise.all(names.map(name => ensureCollection(name)));
}

async function getAll(collectionName, query = null, maxRows = 1000, options = {}) {
  const rows = [];
  const pageSize = 100;
  for (let offset = 0; offset < maxRows; offset += pageSize) {
    let ref = query ? db.collection(collectionName).where(query) : db.collection(collectionName);
    if (options.fields) ref = ref.field(options.fields);
    let res;
    try {
      res = await ref.skip(offset).limit(Math.min(pageSize, maxRows - offset)).get();
    } catch (err) {
      if (!isMissingCollectionError(err)) throw err;
      await ensureCollection(collectionName);
      try {
        res = await ref.skip(offset).limit(Math.min(pageSize, maxRows - offset)).get();
      } catch (retryErr) {
        if (isMissingCollectionError(retryErr)) return rows;
        throw retryErr;
      }
    }
    rows.push(...(res.data || []));
    if (!res.data || res.data.length < pageSize) break;
  }
  return rows;
}

async function getOne(collectionName, query, options = {}) {
  const read = () => {
    let ref = db.collection(collectionName).where(query);
    if (options.fields) ref = ref.field(options.fields);
    return ref.limit(1).get();
  };
  let res;
  try {
    res = await read();
  } catch (err) {
    if (!isMissingCollectionError(err)) throw err;
    await ensureCollection(collectionName);
    try {
      res = await read();
    } catch (retryErr) {
      if (isMissingCollectionError(retryErr)) return null;
      throw retryErr;
    }
  }
  return (res.data || [])[0] || null;
}

async function getById(collectionName, id) {
  return getOne(collectionName, { id: toNumber(id) });
}

async function queryRead(collectionName, query, options = {}, count = false) {
  const read = async () => {
    let ref = db.collection(collectionName).where(query);
    if (count) return ref.count();
    if (options.fields) ref = ref.field(options.fields);
    (options.order || []).forEach(([field, direction]) => { ref = ref.orderBy(field, direction); });
    const limit = options.limit || 100;
    const result = await ref.skip(options.offset || 0).limit(Math.min(limit, 100)).get();
    if (limit > 100 && (result.data || []).length === 100) {
      const rest = await queryRead(collectionName, query, { ...options, offset: (options.offset || 0) + 100, limit: limit - 100 });
      return { ...result, data: [...result.data, ...(rest.data || [])] };
    }
    return result;
  };
  try {
    return await read();
  } catch (err) {
    if (!isMissingCollectionError(err)) throw err;
    await ensureCollection(collectionName);
    try { return await read(); } catch (retryErr) {
      if (isMissingCollectionError(retryErr)) return count ? { total: 0 } : { data: [] };
      throw retryErr;
    }
  }
}

async function getFirstRowsByNumericField(collectionName, field, values, knownRows = [], options = {}) {
  const keys = Array.from(new Set(values.map(Number).filter(value => Number.isFinite(value) && value > 0)));
  const requested = new Set(keys);
  const rowsByValue = new Map();
  knownRows.forEach(row => {
    const value = row[field];
    if (typeof value === 'number' && requested.has(value) && !rowsByValue.has(value)) {
      rowsByValue.set(value, row);
    }
  });
  const missing = keys.filter(value => !rowsByValue.has(value));
  const batches = [];
  for (let index = 0; index < missing.length; index += 50) batches.push(missing.slice(index, index + 50));
  await Promise.all(batches.map(async batch => {
    const rows = await getAll(collectionName, { [field]: _.in(batch) }, options.complete ? Infinity : 1000, options);
    rows.forEach(row => {
      const value = row[field];
      if (requested.has(value) && !rowsByValue.has(value)) rowsByValue.set(value, row);
    });
    // A truncated batch must not turn an existing identity/profile into a missing row.
    await Promise.all(batch.filter(value => !rowsByValue.has(value)).map(async value => {
      rowsByValue.set(value, rows.length >= 1000 ? await getOne(collectionName, { [field]: value }, options) : null);
    }));
  }));
  return rowsByValue;
}

async function memberReadContext(rows, matchRecords = [], profiles = null) {
  const userIds = rows.map(row => Number(row.userId));
  const [usersById, profilesByUserId] = await Promise.all([
    getFirstRowsByNumericField(C.users, 'id', userIds, [], { complete: true }),
    getFirstRowsByNumericField(C.profiles, 'userId', userIds, profiles || [], { complete: true })
  ]);
  const legacyAssetReviewsByUserId = await legacyAssetCertificationReviews([...profilesByUserId.values(), ...(profiles || [])]);
  return { usersById, profilesByUserId, legacyAssetReviewsByUserId, matchRecords, recommendationStatusByUserId: recommendationStatusIndex(matchRecords) };
}

async function rowsByFieldBatches(collectionName, field, values, options = {}) {
  const keys = Array.from(new Set(values));
  const batches = [];
  for (let index = 0; index < keys.length; index += 50) batches.push(keys.slice(index, index + 50));
  const rows = await Promise.all(batches.map(batch => getAll(collectionName, { [field]: _.in(batch) }, Infinity, options)));
  return rows.flat();
}

async function addRow(collectionName, row) {
  await ensureCollection(collectionName);
  const payload = { ...row, createdAt: row.createdAt || nowIso(), updatedAt: row.updatedAt || nowIso() };
  await db.collection(collectionName).add({ data: payload });
  return payload;
}

async function updateRow(collectionName, row, patch) {
  if (!row || !row._id) throw createHttpError('record not found', 404, 40400);
  const data = { ...patch, updatedAt: patch.updatedAt || nowIso() };
  delete data._id;
  await db.collection(collectionName).doc(row._id).update({ data });
  return { ...row, ...data };
}

async function nextId(key) {
  const ref = db.collection(C.counters).doc(key);
  try {
    await ref.update({ data: { value: _.inc(1), updatedAt: nowIso() } });
    const res = await ref.get();
    return Number(res.data.value);
  } catch (err) {
    try {
      await ref.set({ data: { key, value: 1, updatedAt: nowIso() } });
      return 1;
    } catch (setErr) {
      await ref.update({ data: { value: _.inc(1), updatedAt: nowIso() } });
      const res = await ref.get();
      return Number(res.data.value);
    }
  }
}

async function ensureMatchmakerIdentity(row) {
  if (!row) return row;
  const patch = {};
  if (!row.matchmakerNo) patch.matchmakerNo = defaultMatchmakerNo(row.id);
  if (!row.inviteCode) patch.inviteCode = await uniqueInviteCode(row.id);
  if (!row.inviteCodeStatus) patch.inviteCodeStatus = 'active';
  if (!row.inviteCodeUpdatedAt) patch.inviteCodeUpdatedAt = nowIso();
  if (!Object.keys(patch).length) return row;
  return updateRow(C.matchmakers, row, patch);
}

async function ensureInviteQrCode(row) {
  const matchmaker = await ensureMatchmakerIdentity(row);
  if (matchmaker.inviteQrFileID && matchmaker.inviteQrCodeFor === matchmaker.inviteCode) {
    return matchmaker.inviteQrFileID;
  }
  if (!cloud.openapi || !cloud.openapi.wxacode || !cloud.openapi.wxacode.getUnlimited) {
    return matchmaker.inviteQrFileID || '';
  }
  try {
    const codeRes = await cloud.openapi.wxacode.getUnlimited({
      scene: `code=${matchmaker.inviteCode}`,
      page: 'pages/user/matchmaker-invite',
      checkPath: false
    });
    const rawContent = codeRes && (codeRes.buffer || codeRes.fileContent);
    const fileContent = Buffer.isBuffer(rawContent)
      ? rawContent
      : (rawContent instanceof ArrayBuffer || ArrayBuffer.isView(rawContent) ? Buffer.from(rawContent) : null);
    if (!fileContent) return matchmaker.inviteQrFileID || '';
    const uploadRes = await cloud.uploadFile({
      cloudPath: `matchmaker-invites/${matchmaker.id}-${matchmaker.inviteCode}.png`,
      fileContent
    });
    const fileID = uploadRes && uploadRes.fileID ? uploadRes.fileID : '';
    if (fileID) {
      await updateRow(C.matchmakers, matchmaker, {
        inviteQrFileID: fileID,
        inviteQrCodeFor: matchmaker.inviteCode
      });
    }
    return fileID;
  } catch (err) {
    console.warn('generate invite qr code failed', err);
    return matchmaker.inviteQrFileID || '';
  }
}

function paginate(rows, page = 1, pageSize = 20) {
  const safePage = Math.max(Number(page) || 1, 1);
  const safePageSize = Math.max(Number(pageSize) || 20, 1);
  const start = (safePage - 1) * safePageSize;
  return {
    total: rows.length,
    page: safePage,
    pageSize: safePageSize,
    list: rows.slice(start, start + safePageSize)
  };
}

function isCloudFileID(value) {
  return /^cloud:\/\//.test(String(value || ''));
}

function collectMemberMediaFileIDs(row) {
  const fileIDs = [];
  if (isCloudFileID(row.avatarUrl)) fileIDs.push(row.avatarUrl);
  if (isCloudFileID(row.coverUrl)) fileIDs.push(row.coverUrl);
  if (Array.isArray(row.photos)) {
    row.photos.forEach(photo => {
      if (isCloudFileID(photo)) fileIDs.push(photo);
    });
  }
  return fileIDs;
}

async function memberMediaURLMap(fileIDs = []) {
  const uniqueFileIDs = Array.from(new Set(fileIDs.filter(isCloudFileID)));
  const urlMap = {};
  for (let index = 0; index < uniqueFileIDs.length; index += 50) {
    const fileList = uniqueFileIDs.slice(index, index + 50);
    try {
      const result = await cloud.getTempFileURL({ fileList });
      (result.fileList || []).forEach(item => {
        if (item.fileID && item.tempFileURL && Number(item.status) === 0) {
          urlMap[item.fileID] = item.tempFileURL;
        }
      });
    } catch (err) {
      console.warn('resolve member media temp urls failed', err);
    }
  }
  return urlMap;
}

function applyMemberMediaURLMap(row, urlMap) {
  const next = { ...row };
  if (isCloudFileID(next.avatarUrl) && urlMap[next.avatarUrl]) {
    next.avatarUrl = urlMap[next.avatarUrl];
  }
  if (isCloudFileID(next.coverUrl) && urlMap[next.coverUrl]) {
    next.coverUrl = urlMap[next.coverUrl];
  }
  if (Array.isArray(next.photos)) {
    next.photos = next.photos.map(photo => (isCloudFileID(photo) && urlMap[photo] ? urlMap[photo] : photo));
  }
  return next;
}

async function resolveMemberMediaPage(page) {
  const list = Array.isArray(page.list) ? page.list : [];
  const fileIDs = list.reduce((ids, row) => ids.concat(collectMemberMediaFileIDs(row)), []);
  if (!fileIDs.length) return page;
  const urlMap = await memberMediaURLMap(fileIDs);
  if (!Object.keys(urlMap).length) return page;
  return {
    ...page,
    list: list.map(row => applyMemberMediaURLMap(row, urlMap))
  };
}

function publicUser(user) {
  const safe = stripInternal(user) || {};
  delete safe.openid;
  delete safe.authVersion;
  delete safe.claimedFromUserId;
  delete safe.mergedAt;
  delete safe.mergedIntoUserId;
  return safe;
}

function profileCompletionFor(row) {
  const fields = [
    'realName',
    'gender',
    'age',
    'height',
    'city',
    'nativePlace',
    'education',
    'occupation',
    'incomeRange',
    'maritalStatus',
    'houseStatus',
    'carStatus',
    'selfIntro',
    'partnerRequirement'
  ];
  const filled = fields.filter(field => String(row[field] || '').trim()).length
    + (Array.isArray(row.photos) && row.photos.length ? 1 : 0);
  const total = fields.length + 1;
  const percent = Math.round((filled / total) * 100);
  return {
    percent,
    text: `${percent}%`,
    missingCount: Math.max(total - filled, 0)
  };
}

function displayStatusForMember(row, completion) {
  if (Number(row.status) !== 0 && !row.displayEnabled) return '未展示';
  if (Number(row.status) === 0) return '已移除';
  if (completion.percent >= 70) return '可展示';
  return '待完善';
}

function lastRecommendationStatusForUser(userId, records = []) {
  const related = records
    .filter(record => Number(record.userAId) === Number(userId) || Number(record.userBId) === Number(userId))
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0) || Number(b.id || 0) - Number(a.id || 0));
  if (!related.length) return '暂无推荐';
  const status = related[0].status || 'pending';
  if (status === 'pending') return '待跟进';
  if (status === 'accepted') return '已同意';
  if (status === 'rejected') return '已拒绝';
  return status;
}

function recommendationStatusIndex(records = []) {
  const relatedByUserId = new Map();
  records.forEach(record => {
    const userIds = new Set([Number(record.userAId), Number(record.userBId)]);
    userIds.forEach(userId => {
      if (!Number.isFinite(userId)) return;
      if (!relatedByUserId.has(userId)) relatedByUserId.set(userId, []);
      relatedByUserId.get(userId).push(record);
    });
  });
  // Keep each user's original row order and comparator, including invalid dates and tied IDs.
  return new Map(Array.from(relatedByUserId, ([userId, related]) => [userId, lastRecommendationStatusForUser(userId, related)]));
}

function recommendationStatusForView(userId, context) {
  return context.recommendationStatusByUserId
    ? context.recommendationStatusByUserId.get(Number(userId)) || '暂无推荐'
    : lastRecommendationStatusForUser(userId, context.matchRecords || []);
}

function sortMemberRowsDesc(a, b) {
  return Number(b.sortId || b.id || 0) - Number(a.sortId || a.id || 0);
}

function needsLegacyAssetCertificationDates(profile) {
  const summary = profile?.showcaseCertification;
  const assets = summary?.assets;
  return summary?.policyVersion === 1 && assets?.status === 'approved'
    && (assets.reviewedAt === undefined || assets.reviewedAt === null || assets.reviewedAt === '')
    && Number.isSafeInteger(Number(profile.userId)) && Number(profile.userId) > 0;
}

async function legacyAssetCertificationReviews(profiles) {
  const userIds = [...new Set(profiles.filter(needsLegacyAssetCertificationDates).map(profile => Number(profile.userId)))];
  const reviews = new Map(userIds.map(userId => [userId, null]));
  if (!userIds.length) return reviews;
  // Only controlled review fields are read. Evidence, applications and encrypted
  // materials are never loaded for a public profile or recommendation request.
  const fields = { _id: true, userId: true, ...Object.fromEntries([
    'status', 'source', 'financialAssetRange', 'reviewedAt', 'expiresAt'
  ].map(field => [`current.assets.${field}`, true])) };
  const records = await rowsByFieldBatches(C.memberCertifications, '_id', userIds.map(userId => `user_${userId}`), { fields });
  records.forEach(record => {
    const userId = Number(record.userId);
    if (reviews.has(userId) && record._id === `user_${userId}`) reviews.set(userId, record.current?.assets || null);
  });
  return reviews;
}

function profileWithLegacyAssetCertificationDates(profile, reviews) {
  if (!needsLegacyAssetCertificationDates(profile)) return profile;
  const assets = profile.showcaseCertification.assets;
  const review = reviews.get(Number(profile.userId));
  if (review?.status !== 'approved' || review.source !== assets.source
    || review.financialAssetRange !== assets.financialAssetRange || typeof review.reviewedAt !== 'string') return profile;
  const privateExpiry = assetCertificationExpiresAt(review);
  const summaryExpiry = assetCertificationExpiresAt({ reviewedAt: review.reviewedAt, expiresAt: assets.expiresAt });
  if (!privateExpiry || !summaryExpiry) return profile;
  const expiresAt = new Date(Math.min(Date.parse(privateExpiry), Date.parse(summaryExpiry))).toISOString();
  // Read compatibility only: retain the original review clock and copy no
  // private audit fields into the profile or its public projection.
  return { ...profile, showcaseCertification: { ...profile.showcaseCertification,
    assets: { ...assets, reviewedAt: review.reviewedAt, expiresAt } } };
}

async function readableCertificationProfile(profile, context = {}) {
  if (!needsLegacyAssetCertificationDates(profile)) return profile;
  const userId = Number(profile.userId);
  const reviews = context.legacyAssetReviewsByUserId?.has(userId)
    ? context.legacyAssetReviewsByUserId : await legacyAssetCertificationReviews([profile]);
  return profileWithLegacyAssetCertificationDates(profile, reviews);
}

async function memberView(member, context = {}) {
  const userId = Number(member.userId);
  const user = (context.usersById && context.usersById.has(userId)
    ? context.usersById.get(userId)
    : await getById(C.users, member.userId)) || {};
  const profile = await readableCertificationProfile((context.profilesByUserId && context.profilesByUserId.has(userId)
    ? context.profilesByUserId.get(userId)
    : await getOne(C.profiles, { userId })) || {}, context);
  const identityStatus = isManualIdentity(user.openid) ? 'pending' : 'claimed';
  const photos = normalizeMemberPhotos(profile.photos);
  const media = withMemberMedia({ ...profile, gender: profile.gender || user.gender, photos });
  const row = {
    id: Number(member.id),
    sortId: Number(member.id),
    source: 'member',
    memberNo: member.memberNo || defaultMemberNo(member.id, member.createdAt || new Date()),
    matchmakerId: Number(member.matchmakerId),
    userId: Number(member.userId),
    memberType: member.memberType || 'no_consumption',
    serviceLevel: member.serviceLevel || '',
    expireAt: member.expireAt || null,
    remark: member.remark || '',
    status: member.status === undefined ? 1 : Number(member.status),
    createdAt: member.createdAt || '',
    updatedAt: member.updatedAt || '',
    nickname: user.nickname || profile.realName || '',
    phone: user.phone || '',
    avatarUrl: photos[0] || media.avatarUrl,
    gender: user.gender || 0,
    isVerified: user.isVerified || 0,
    ...publicCertificationFields(profile),
    identityStatus,
    identityStatusText: identityStatus === 'pending' ? '待会员认领' : '已绑定微信',
    realName: profile.realName || user.nickname || '',
    age: profile.age || null,
    height: profile.height || null,
    education: profile.education || '',
    occupation: profile.occupation || '',
    incomeRange: profile.incomeRange || '',
    city: profile.city || '',
    province: profile.province || '',
    nativePlace: profile.nativePlace || '',
    maritalStatus: profile.maritalStatus || '',
    houseStatus: profile.houseStatus || '',
    carStatus: profile.carStatus || '',
    selfIntro: profile.selfIntro || '',
    partnerRequirement: profile.partnerRequirement || '',
    photos,
    displayEnabled: profile.relationshipStatus !== 'coupled' && isTrue(profile.displayEnabled),
    displayUpdatedAt: profile.displayUpdatedAt || ''
  };
  const completion = profileCompletionFor(row);
  return {
    ...row,
    profileCompletion: completion,
    displayStatus: displayStatusForMember(row, completion),
    lastRecommendStatus: recommendationStatusForView(row.userId, context)
  };
}

async function profileMemberView(profile, context = {}) {
  profile = await readableCertificationProfile(profile, context);
  const userId = Number(profile.userId);
  const user = (context.usersById && context.usersById.has(userId)
    ? context.usersById.get(userId)
    : await getById(C.users, profile.userId)) || {};
  const profileId = Number(profile.id || profile.userId || 0);
  const photos = normalizeMemberPhotos(profile.photos);
  const media = withMemberMedia({ ...profile, gender: profile.gender || user.gender, photos });
  const row = {
    id: `profile_${profileId || Number(profile.userId)}`,
    sortId: profileId || Number(profile.userId) || 0,
    source: 'profile',
    matchmakerId: null,
    userId: Number(profile.userId),
    memberType: 'self_profile',
    serviceLevel: '',
    expireAt: null,
    remark: '',
    status: user.status === undefined ? 1 : Number(user.status),
    nickname: user.nickname || profile.realName || '',
    phone: user.phone || '',
    avatarUrl: photos[0] || media.avatarUrl,
    gender: user.gender || profile.gender || 0,
    isVerified: user.isVerified || 0,
    ...publicCertificationFields(profile),
    realName: profile.realName || user.nickname || '',
    age: profile.age || null,
    height: profile.height || null,
    education: profile.education || '',
    occupation: profile.occupation || '',
    incomeRange: profile.incomeRange || '',
    city: profile.city || '',
    province: profile.province || '',
    nativePlace: profile.nativePlace || '',
    maritalStatus: profile.maritalStatus || '',
    houseStatus: profile.houseStatus || '',
    carStatus: profile.carStatus || '',
    selfIntro: profile.selfIntro || '',
    partnerRequirement: profile.partnerRequirement || '',
    photos,
    displayEnabled: profile.relationshipStatus !== 'coupled' && isTrue(profile.displayEnabled),
    displayUpdatedAt: profile.displayUpdatedAt || ''
  };
  const completion = profileCompletionFor(row);
  return {
    ...row,
    profileCompletion: completion,
    displayStatus: displayStatusForMember(row, completion),
    lastRecommendStatus: recommendationStatusForView(row.userId, context)
  };
}

function sanitizePublicMemberRow(row, options = {}) {
  const safe = { ...row };
  delete safe.phone;
  delete safe.memberNo;
  delete safe.matchmakerId;
  if (!options.keepUserId) delete safe.userId;
  delete safe.displayEnabled;
  delete safe.displayUpdatedAt;
  delete safe.serviceLevel;
  delete safe.expireAt;
  delete safe.remark;
  delete safe.privateArchive;
  return safe;
}

async function publicMemberView(member, context = {}, options = {}) {
  const row = await memberView(member, context);
  if (!row.displayEnabled) return null;
  return sanitizePublicMemberRow(row, options);
}

function giftCatalogView(gift) {
  return { ...gift };
}

function giftById(giftId) {
  const id = String(giftId || '').trim();
  return GIFT_CATALOG.find(item => item.id === id) || null;
}

async function publicShowcaseRows(options = {}) {
  const [rows, profiles, matchRecords] = await Promise.all([
    getAll(C.members, { status: 1 }, Infinity),
    getAll(C.profiles, null, Infinity),
    getAll(C.matchRecords, null, Infinity)
  ]);
  const memberUserIds = new Set(rows.map(row => Number(row.userId)));
  const profileRows = profiles
    .filter(row => row.relationshipStatus !== 'coupled' && isTrue(row.displayEnabled))
    .filter(row => !memberUserIds.has(Number(row.userId)));
  const [usersById, profilesByUserId] = await Promise.all([
    getFirstRowsByNumericField(C.users, 'id', [...memberUserIds, ...profileRows.map(row => row.userId)]),
    getFirstRowsByNumericField(C.profiles, 'userId', Array.from(memberUserIds), profiles)
  ]);
  const context = { matchRecords, usersById, profilesByUserId, recommendationStatusByUserId: recommendationStatusIndex(matchRecords) };
  context.legacyAssetReviewsByUserId = await legacyAssetCertificationReviews([...profiles, ...profilesByUserId.values()]);
  const [memberViews, profileViews] = await Promise.all([
    Promise.all(rows.map(row => publicMemberView(row, context, options))),
    Promise.all(profileRows.map(async row => {
      const view = await profileMemberView(row, context);
      if (!view.displayEnabled) return null;
      return sanitizePublicMemberRow(view, options);
    }))
  ]);
  return [...memberViews, ...profileViews]
    .filter(row => row && Number(row.status) === 1);
}

const SHOWCASE_MEMBER_INDEX_FIELDS = Object.fromEntries([
  'id', 'userId', 'status', 'memberType', 'createdAt', 'updatedAt'
].map(field => [field, true]));
const SHOWCASE_PROFILE_INDEX_FIELDS = Object.fromEntries([
  '_id', 'id', 'userId', 'displayEnabled', 'realName', 'gender', 'age', 'city',
  'occupation', 'education', 'maritalStatus', 'incomeRange', 'height', 'relationshipStatus',
  'weightKg', 'marriageTimeline', 'hasChildren', 'wantsChildren', 'zodiac', 'constellation', 'smoking', 'drinking', 'pets',
  'showcaseCertification', 'assetCategoryConsent', 'assetRangeDisclosure'
].map(field => [field, true]));
const SHOWCASE_USER_INDEX_FIELDS = { id: true, nickname: true, gender: true, status: true };
const SHOWCASE_PROFILE_FIELDS = Object.fromEntries([
  ...Object.keys(SHOWCASE_PROFILE_INDEX_FIELDS), 'displayUpdatedAt', 'height', 'province',
  'nativePlace', 'houseStatus', 'carStatus', 'selfIntro', 'partnerRequirement',
  'photos', 'avatarUrl', 'coverUrl'
].map(field => [field, true]));

function showcaseProfileKey(profile) {
  return JSON.stringify([profile._id || null, profile.id === undefined ? null : profile.id, profile.userId]);
}

async function pageRecommendationRecords(userIds) {
  const targets = new Set(userIds.map(Number).filter(Number.isFinite));
  if (!targets.size) return [];
  const references = Array.from(targets);
  if (targets.has(1)) references.push(true); // Preserve Number(true) === 1 in imported references.
  const fields = { id: true, userAId: true, userBId: true, status: true, createdAt: true };
  // Current writers can still emit string user references. Read that legacy subset once,
  // then compare Number(...) exactly as before (including '003', whitespace and exponents).
  // Unusually large API pages retain the complete metadata fallback instead of oversized in queries.
  const query = references.length <= 50 ? _.or([
    { userAId: _.in(references) }, { userBId: _.in(references) },
    { userAId: db.RegExp({ regexp: '^' }) }, { userBId: db.RegExp({ regexp: '^' }) }
  ]) : null;
  const rows = await getAll(C.matchRecords, query, Infinity, { fields });
  return rows.filter(row => targets.has(Number(row.userAId)) || targets.has(Number(row.userBId)));
}

async function publicShowcasePage(userId, filters = {}) {
  const ownProfile = await getOne(C.profiles, { userId: Number(userId) }, { fields: { userId: true, matchingPreferences: true } });
  const matchingPreferences = normalizeMatchingPreferences(ownProfile?.matchingPreferences || {});
  const category = normalizeShowcaseCategory(filters.category);
  // Source indexes stay fresh per request. Exact mixed-source totals and legacy visibility
  // require these lightweight scans; full profiles, users and recommendation history are page-scoped.
  const [members, indexedProfiles] = await Promise.all([
    getAll(C.members, { status: 1 }, Infinity, { fields: SHOWCASE_MEMBER_INDEX_FIELDS }),
    getAll(C.profiles, null, Infinity, { fields: SHOWCASE_PROFILE_INDEX_FIELDS })
  ]);
  const indexedLegacyReviews = await legacyAssetCertificationReviews(indexedProfiles);
  const profiles = indexedProfiles.map(profile => profileWithLegacyAssetCertificationDates(profile, indexedLegacyReviews));
  // Imported non-positive/missing references use the original lookups and defaults.
  // Keeping this rare compatibility path also avoids changing visibility of malformed legacy rows.
  if (category === 'recommend' && [...members, ...profiles].some(row => !Number.isFinite(Number(row.userId)) || Number(row.userId) <= 0)) {
    const rows = await withMemberViewerState(await publicShowcaseRows({ keepUserId: true }), userId);
    return paginate(rows.filter(row => Number(row.userId) !== Number(userId))
      .filter(row => !row.viewerState.isHidden && matchesMemberFilters(row, filters))
      .sort(sortMemberRowsDesc), filters.page, filters.pageSize);
  }
  const memberUserIds = new Set(members.map(row => Number(row.userId)));
  const firstNumericProfiles = new Map();
  profiles.forEach(profile => {
    if (typeof profile.userId === 'number' && !firstNumericProfiles.has(profile.userId)) firstNumericProfiles.set(profile.userId, profile);
  });
  const standalone = profiles.filter(profile => isTrue(profile.displayEnabled) && !memberUserIds.has(Number(profile.userId)));
  const indexedUserIds = standalone.map(profile => Number(profile.userId));
  if (filters.keyword || filters.gender || category !== 'recommend') indexedUserIds.push(...memberUserIds);
  const usersById = await getFirstRowsByNumericField(C.users, 'id', indexedUserIds, [], {
    fields: { ...SHOWCASE_USER_INDEX_FIELDS, ...(category !== 'recommend' ? { mergedIntoUserId: true } : {}) }
  });
  const candidates = [];
  function appendCandidate(member, profile) {
    if (!profile || profile.relationshipStatus === 'coupled' || !isTrue(profile.displayEnabled)) return;
    const targetUserId = Number(member ? member.userId : profile.userId);
    const user = usersById.get(targetUserId) || {};
    if (category !== 'recommend' && (!Number.isFinite(targetUserId) || targetUserId <= 0
      || Number(user.status) !== 1 || user.mergedIntoUserId)) return;
    const profileId = Number(profile.id || profile.userId || 0);
    const row = {
      id: member ? Number(member.id) : `profile_${profileId || Number(profile.userId)}`,
      sortId: member ? Number(member.id) : profileId || Number(profile.userId) || 0,
      source: member ? 'member' : 'profile', userId: targetUserId,
      status: member ? Number(member.status) : user.status === undefined ? 1 : Number(user.status),
      memberType: member ? member.memberType || 'no_consumption' : 'self_profile',
      nickname: user.nickname || profile.realName || '', realName: profile.realName || user.nickname || '',
      gender: member ? user.gender || 0 : user.gender || profile.gender || 0,
      age: profile.age || null, city: profile.city || '', occupation: profile.occupation || '',
      education: publicCertificationFields(profile).verifiedEducation || profile.education || '', maritalStatus: profile.maritalStatus || '', incomeRange: profile.incomeRange || '',
      member, profile
    };
    if (row.status === 1 && targetUserId !== Number(userId) && matchesMemberFilters(row, filters)) candidates.push(row);
  }
  members.forEach(member => appendCandidate(member, firstNumericProfiles.get(Number(member.userId))));
  standalone.forEach(profile => appendCandidate(null, profile));
  const viewerStates = await memberInteractionStateMap(userId, candidates.map(row => row.userId));
  const counts = category === 'popularity' ? await memberPopularityCounts(candidates.map(row => row.userId)) : new Map();
  const visible = candidates
    .filter(row => !(viewerStates[String(row.userId)] || {}).hide)
    .map(row => ({ ...row, categoryRank: categoryRank(category, row.profile, counts.get(row.userId) || 0) }))
    .filter(row => row.categoryRank !== null)
    .sort((a, b) => b.categoryRank - a.categoryRank
      || (category === 'recommend' ? matchingPreferenceScore(b.profile, matchingPreferences) - matchingPreferenceScore(a.profile, matchingPreferences) : 0)
      || sortMemberRowsDesc(a, b));
  const page = paginate(visible, filters.page, filters.pageSize);
  if (!page.list.length) return page;
  const pageUserIds = page.list.map(row => row.userId);
  const profileReferences = page.list.map(row => row.member ? Number(row.member.userId) : row.profile.userId);
  const [pageUsers, rawPageProfiles, records] = await Promise.all([
    getFirstRowsByNumericField(C.users, 'id', pageUserIds, [], { fields: { ...SHOWCASE_USER_INDEX_FIELDS, openid: true, isVerified: true } }),
    rowsByFieldBatches(C.profiles, 'userId', profileReferences, { fields: SHOWCASE_PROFILE_FIELDS }),
    pageRecommendationRecords(pageUserIds)
  ]);
  // Refresh legacy review metadata for this page so a revocation between index
  // selection and detail hydration cannot restore a stale certification.
  const legacyAssetReviewsByUserId = await legacyAssetCertificationReviews(rawPageProfiles);
  const pageProfiles = rawPageProfiles.map(profile => profileWithLegacyAssetCertificationDates(profile, legacyAssetReviewsByUserId));
  const pageProfilesByKey = new Map(pageProfiles.map(profile => [showcaseProfileKey(profile), profile]));
  const pageProfilesByUserId = new Map();
  pageProfiles.forEach(profile => {
    if (typeof profile.userId === 'number' && !pageProfilesByUserId.has(profile.userId)) pageProfilesByUserId.set(profile.userId, profile);
  });
  // Explicit nulls avoid per-card fallback reads for known missing users and profiles.
  pageUserIds.forEach(id => { if (!pageUsers.has(id)) pageUsers.set(id, null); if (!pageProfilesByUserId.has(id)) pageProfilesByUserId.set(id, null); });
  const context = { usersById: pageUsers, profilesByUserId: pageProfilesByUserId, legacyAssetReviewsByUserId,
    recommendationStatusByUserId: recommendationStatusIndex(records) };
  const list = await Promise.all(page.list.map(async candidate => {
    const profile = pageProfilesByKey.get(showcaseProfileKey(candidate.profile));
    if (!profile) return null;
    const view = candidate.member
      ? await publicMemberView(candidate.member, context, { keepUserId: true })
      : sanitizePublicMemberRow(await profileMemberView(profile, context), { keepUserId: true });
    if (!view || profile.relationshipStatus === 'coupled' || !isTrue(profile.displayEnabled) || Number(view.status) !== 1 || !matchesMemberFilters(view, filters)
      || categoryRank(category, profile, counts.get(candidate.userId) || 0) === null) return null;
    const state = viewerStates[String(candidate.userId)] || {};
    return { ...view, ...(category === 'popularity' ? { popularityCount: counts.get(candidate.userId) || 0 } : {}),
      viewerState: { isFavorite: !!state.favorite, isHidden: !!state.hide } };
  }));
  return { ...page, list: list.filter(Boolean) };
}

async function memberPopularityCounts(targetUserIds) {
  const targets = new Set(targetUserIds.map(Number).filter(id => Number.isFinite(id) && id > 0));
  if (!targets.size) return new Map();
  const references = Array.from(targets);
  const fields = { id: true, userId: true, targetUserId: true, actionType: true,
    active: true, status: true, createdAt: true, updatedAt: true, expiresAt: true,
    invalidatedAt: true, withdrawnAt: true, deletedAt: true };
  // Include legacy string references before deduplication: a newer withdrawal
  // must win over an older numeric heart for the same sender and target.
  const query = references.length <= 50 ? _.and([
    { actionType: 'favorite' }, _.or([{ targetUserId: _.in(references) }, { targetUserId: db.RegExp({ regexp: '^' }) }])
  ]) : { actionType: 'favorite' };
  const rows = await getAll(C.memberInteractions, query, Infinity, { fields });
  const latest = latestMemberInteractionRows(rows.filter(row => targets.has(Number(row.targetUserId))));
  const users = await getFirstRowsByNumericField(C.users, 'id', latest.map(row => row.userId), [], {
    fields: { id: true, status: true, mergedIntoUserId: true }
  });
  return popularityCounts(latest, users);
}

async function memberInteractionStateMap(userId, targetUserIds = []) {
  const targets = new Set(
    targetUserIds
      .map(id => Number(id))
      .filter(id => Number.isFinite(id) && id > 0)
  );
  if (!Number(userId) || !targets.size) return {};

  const rows = await getAll(C.memberInteractions, _.or([
    { userId: Number(userId) }, { targetUserId: Number(userId), actionType: 'unmatch' }
  ]), Infinity);
  return latestMemberInteractionRows(rows).reduce((map, row) => {
    const targetUserId = row.actionType === 'unmatch' && Number(row.targetUserId) === Number(userId)
      ? Number(row.userId) : Number(row.targetUserId);
    if (!targets.has(targetUserId) || !isActiveInteraction(row)) return map;
    const key = String(targetUserId);
    map[key] = map[key] || {};
    map[key][row.actionType === 'unmatch' ? 'hide' : row.actionType] = true;
    return map;
  }, {});
}

async function withMemberViewerState(rows, userId) {
  const stateMap = await memberInteractionStateMap(userId, rows.map(row => row.userId));
  return rows.map(row => {
    const state = stateMap[String(row.userId)] || {};
    return {
      ...row,
      viewerState: {
        isFavorite: !!state.favorite,
        isHidden: !!state.hide
      }
    };
  });
}

function interactionTargetUserId(data = {}) {
  const targetUserId = Number(data.targetUserId || data.receiverId || data.userId);
  if (!Number.isFinite(targetUserId) || targetUserId <= 0) {
    throw createHttpError('targetUserId is required');
  }
  return targetUserId;
}

function shanghaiDateKey(date = new Date()) {
  return new Date(date.getTime() + SHANGHAI_UTC_OFFSET_MS).toISOString().slice(0, 10);
}

async function dailyFreeFavoriteStats(userId, targetUserId = null) {
  const dateKey = shanghaiDateKey();
  const rows = await getAll(C.memberInteractions, {
    userId: Number(userId),
    actionType: 'favorite',
    freeFavoriteDate: dateKey
  }, 2000);
  const targetIds = new Set();
  rows.forEach(row => {
    const id = Number(row.targetUserId);
    if (Number.isFinite(id) && id > 0) targetIds.add(id);
  });
  const targetId = Number(targetUserId);
  const used = targetIds.size;
  return {
    dateKey,
    limit: DAILY_FREE_FAVORITE_LIMIT,
    used,
    remaining: Math.max(DAILY_FREE_FAVORITE_LIMIT - used, 0),
    targetCounted: Number.isFinite(targetId) && targetIds.has(targetId)
  };
}

async function assertDailyFreeFavoriteQuota(userId, targetUserId) {
  const stats = await dailyFreeFavoriteStats(userId, targetUserId);
  if (!stats.targetCounted && stats.used >= DAILY_FREE_FAVORITE_LIMIT) {
    throw createHttpError('\u4eca\u65e5\u514d\u8d39\u7231\u5fc3\u5df2\u9001\u5b8c\uff0c\u660e\u5929\u518d\u6765\u770b\u770b\u5427', 429, 42901);
  }
  return stats;
}

async function memberFavoriteQuota(userId, targetUserId = null) {
  if (await hasPremiumMemberEntitlement(userId)) {
    return { dateKey: shanghaiDateKey(), limit: 0, used: 0, remaining: 0, unlimited: true, targetCounted: false };
  }
  return dailyFreeFavoriteStats(userId, targetUserId);
}

async function assertVipDiscoveryAccess(userId, filters = {}) {
  const advanced = ['ageMin', 'ageMax', 'education', 'maritalStatus', 'incomeRange']
    .some(key => filters[key] !== undefined && filters[key] !== null && String(filters[key]).trim() !== '');
  if (advanced && !(await hasPremiumMemberEntitlement(userId))) {
    throw createHttpError('开通VIP后可使用高级筛选', 403, 40302);
  }
}

async function withVipBadges(page) {
  const ids = [...new Set((page.list || []).map(row => Number(row.userId)).filter(id => id > 0))];
  const [users, records] = await Promise.all([
    getFirstRowsByNumericField(C.users, 'id', ids, [], { complete: true, fields: { id: true, status: true, mergedIntoUserId: true } }),
    getFirstRowsByNumericField(VIP_COLLECTIONS.entitlements, 'userId', ids, [], { complete: true,
      fields: { userId: true, lifetime: true, legacyLifetime: true, expireAt: true } })
  ]);
  const legacyIds = ids.filter(id => !records.get(id));
  const legacy = legacyIds.length ? await rowsByFieldBatches(C.members, 'userId', legacyIds,
    { fields: { userId: true, status: true, memberType: true, expireAt: true } }) : [];
  const states = new Map(ids.map(id => {
    const user = users.get(id), record = records.get(id);
    const active = record ? (record.lifetime === true || record.legacyLifetime === true
      || !!record.expireAt && isPremiumMembership({ memberType: 'vip', expireAt: record.expireAt }))
      : legacy.some(row => Number(row.userId) === id && Number(row.status) === 1 && isPremiumMembership(row));
    return [id, !!user && Number(user.status) === 1 && !user.mergedIntoUserId && !!active];
  }));
  return { ...page, list: (page.list || []).map(row => ({ ...row, vipBadge: !!states.get(Number(row.userId)),
    membershipTier: states.get(Number(row.userId)) ? 'vip' : 'free' })) };
}

function quotaAfterFreeFavoriteUse(stats) {
  const used = stats.targetCounted ? stats.used : stats.used + 1;
  return {
    dateKey: stats.dateKey,
    limit: stats.limit,
    used,
    remaining: Math.max(stats.limit - used, 0)
  };
}

async function publicShowcaseTarget(data = {}) {
  const targetUserId = interactionTargetUserId(data);
  const userIds = _.in([targetUserId, String(targetUserId)]);
  const [members, profiles, user] = await Promise.all([
    getAll(C.members, { userId: userIds, status: 1 }, Infinity),
    getAll(C.profiles, { userId: userIds }, Infinity),
    getById(C.users, targetUserId)
  ]);
  const memberProfile = profiles.find(row => row.userId === targetUserId)
    || (members.length && profiles.length >= 1000 ? await getOne(C.profiles, { userId: targetUserId }) : null);
  const context = {
    usersById: new Map([[targetUserId, user]]),
    profilesByUserId: new Map([[targetUserId, memberProfile]])
  };
  // An active assignment takes precedence even when its public profile is disabled.
  // No other person's rows, private archive, or recommendation history are needed here.
  let target = null;
  if (members.length) {
    target = await publicMemberView(members[0], context, { keepUserId: true });
  } else {
    const profile = profiles.find(row => row.relationshipStatus !== 'coupled' && isTrue(row.displayEnabled));
    if (profile) {
      const row = await profileMemberView(profile, context);
      if (Number(row.status) === 1) target = sanitizePublicMemberRow(row, { keepUserId: true });
    }
  }
  if (!target) throw createHttpError('target member not found', 404, 40400);
  return target;
}

async function upsertMemberInteraction(userId, targetUserId, actionType, active, extra = {}) {
  const payload = {
    userId: Number(userId),
    targetUserId: Number(targetUserId),
    actionType,
    active: !!active,
    status: active ? 'active' : 'inactive',
    ...extra
  };
  const existing = await latestMemberInteraction(payload.userId, payload.targetUserId, actionType);
  if (existing) return updateRow(C.memberInteractions, existing, payload);
  return addRow(C.memberInteractions, {
    id: await nextId('memberInteraction'),
    ...payload
  });
}

function isActiveInteraction(row) {
  return !!row && row.active !== false && String(row.status || 'active') !== 'inactive';
}

function latestMemberInteractionRows(rows = []) {
  const latest = new Map();
  const timestamp = row => new Date(row.updatedAt || row.createdAt || 0).getTime() || 0;
  [...rows]
    .sort((a, b) => timestamp(b) - timestamp(a) || Number(b.id || 0) - Number(a.id || 0))
    .forEach(row => {
      const key = `${Number(row.userId)}:${Number(row.targetUserId)}:${row.actionType}`;
      if (!latest.has(key)) latest.set(key, row);
    });
  return Array.from(latest.values());
}

async function latestMemberInteraction(userId, targetUserId, actionType) {
  const rows = await getAll(C.memberInteractions, {
    userId: Number(userId),
    targetUserId: Number(targetUserId),
    actionType
  }, Infinity);
  return latestMemberInteractionRows(rows)[0] || null;
}

async function activeInteraction(userId, targetUserId, actionType) {
  const row = await latestMemberInteraction(userId, targetUserId, actionType);
  return isActiveInteraction(row) ? row : null;
}

async function hasActiveFavorite(userId, targetUserId) {
  return !!(await activeInteraction(userId, targetUserId, 'favorite'));
}

async function areMutualFavorites(userAId, userBId) {
  if (!Number(userAId) || !Number(userBId) || Number(userAId) === Number(userBId)) return false;
  const [aToB, bToA] = await Promise.all([
    hasActiveFavorite(userAId, userBId),
    hasActiveFavorite(userBId, userAId)
  ]);
  return aToB && bToA;
}

async function chatRelationshipPeers(userId) {
  const viewerId = Number(userId);
  const rows = latestMemberInteractionRows(await getAll(C.memberInteractions, _.and([
    { actionType: _.in(['favorite', 'unmatch']) },
    _.or([{ userId: viewerId }, { targetUserId: viewerId }])
  ]), Infinity)).filter(isActiveInteraction);
  const unmatchedPeerIds = new Set(rows.filter(row => row.actionType === 'unmatch')
    .map(row => Number(row.userId) === viewerId ? Number(row.targetUserId) : Number(row.userId)));
  const favorites = rows.filter(row => row.actionType === 'favorite');
  const outgoing = new Set(favorites.filter(row => Number(row.userId) === viewerId).map(row => Number(row.targetUserId)));
  const mutualPeerIds = new Set(favorites.filter(row => Number(row.targetUserId) === viewerId
    && Number(row.userId) !== viewerId && !unmatchedPeerIds.has(Number(row.userId)) && outgoing.has(Number(row.userId)))
    .map(row => Number(row.userId)));
  return { mutualPeerIds, unmatchedPeerIds };
}

async function mutualFavoritePeerIds(userId) {
  return (await chatRelationshipPeers(userId)).mutualPeerIds;
}

async function createFavoriteNotification(senderId, target, conversation = null) {
  return addRow(C.messages, {
    id: await nextId('message'),
    senderId: Number(senderId),
    receiverId: Number(target.userId),
    contentType: 'interaction',
    messageType: 'member_favorite',
    content: '有人喜欢了你，开通会员后可查看并回应。',
    targetUserId: Number(senderId),
    targetMemberId: '',
    conversationId: conversation ? Number(conversation.id) : null,
    isRead: 0,
    status: 'active'
  });
}

async function favoriteActionResponse(userId, target, interaction, active, wasFavoriteActive, favoriteQuota = null) {
  let notification = null;
  let conversation = null;
  let conversationView = null;
  let mutualFavorite = false;
  let premiumRequired = false;
  if (active) {
    mutualFavorite = await areMutualFavorites(userId, target.userId);
    if (mutualFavorite) {
      const isPremiumMember = await hasPremiumMemberEntitlement(userId);
      premiumRequired = !isPremiumMember;
      if (isPremiumMember) {
        conversation = await ensureMutualFavoriteConversation(userId, target.userId);
        conversationView = conversation ? await chatConversationView(conversation, userId) : null;
      }
    }
    if (!wasFavoriteActive) {
      notification = await createFavoriteNotification(userId, target, conversation);
    }
  }
  const stateMap = await memberInteractionStateMap(userId, [target.userId]);
  const viewerState = stateMap[String(target.userId)] || {};
  return {
    interaction: stripInternal(interaction),
    targetUserId: Number(target.userId),
    actionType: 'favorite',
    active,
    mutualFavorite,
    premiumRequired,
    canChat: !!conversationView,
    conversation: conversationView,
    notification: notification ? stripInternal(notification) : null,
    viewerState: {
      isFavorite: !!viewerState.favorite,
      isHidden: !!viewerState.hide
    },
    favoriteQuota: favoriteQuota || await dailyFreeFavoriteStats(userId, target.userId)
  };
}

async function findActiveConversation(participantIds, conversationType = 'member_pair') {
  const participantKey = chatParticipantKey(participantIds);
  const rows = await getAll(C.conversations, { participantKey, conversationType });
  return rows.find(row => Number(row.status || 1) !== 0) || null;
}

async function ensureMutualFavoriteConversation(userAId, userBId, context = {}) {
  const isMutual = context.mutualFavoritePeerIds
    ? context.mutualFavoritePeerIds.has(Number(userBId))
    : await areMutualFavorites(userAId, userBId);
  const blocked = context.unmatchedPeerIds ? context.unmatchedPeerIds.has(Number(userBId))
    : await memberRelationships.isUnmatched(userAId, userBId);
  if (!isMutual || blocked) return null;
  return ensureChatConversation(
    [Number(userAId), Number(userBId)],
    'member_pair',
    { chatOpenReason: 'mutual_favorite' }, context
  );
}

function chatParticipantKey(userIds) {
  return Array.from(new Set(userIds.map(id => Number(id)).filter(id => Number.isFinite(id))))
    .sort((a, b) => a - b)
    .join(':');
}

function chatParticipantIds(conversation) {
  return Array.isArray(conversation.participantIds)
    ? conversation.participantIds.map(id => Number(id)).filter(id => Number.isFinite(id))
    : [];
}

function chatUnreadMap(conversation) {
  return conversation && conversation.unreadBy && typeof conversation.unreadBy === 'object'
    ? { ...conversation.unreadBy }
    : {};
}

function chatUnreadCount(conversation, userId) {
  return Number(chatUnreadMap(conversation)[String(userId)] || 0);
}

function normalizeChatText(value) {
  const content = String(value || '').replace(/\r\n/g, '\n').trim();
  if (!content) throw createHttpError('请输入消息内容');
  if (content.length > 500) throw createHttpError('消息不能超过 500 字');
  return content;
}

function normalizeChatVoice(data = {}) {
  const voiceFileID = String(data.voiceFileID || data.fileID || '').trim();
  if (!voiceFileID || !isCloudFileID(voiceFileID)) throw createHttpError('语音文件无效');
  const rawDuration = Number(data.voiceDuration || data.duration || 0);
  const duration = rawDuration > 600 ? Math.ceil(rawDuration / 1000) : Math.ceil(rawDuration);
  const voiceDuration = Math.max(Math.min(duration || 0, 60), 1);
  const voiceFormat = String(data.voiceFormat || data.format || 'mp3').toLowerCase();
  const voiceFileSize = Math.max(Number(data.voiceFileSize || data.fileSize || 0), 0);
  if (!['mp3', 'aac', 'wav'].includes(voiceFormat)) throw createHttpError('语音格式暂不支持');
  return {
    voiceFileID,
    voiceDuration,
    voiceFormat,
    voiceFileSize,
    content: `[语音] ${voiceDuration}秒`
  };
}

function assertChatParticipant(conversation, userId) {
  if (!conversation || String(conversation.status) === '0') {
    throw createHttpError('conversation not found', 404, 40400);
  }
  if (!chatParticipantIds(conversation).includes(Number(userId))) {
    throw createHttpError('conversation forbidden', 403, 40300);
  }
}

function isCertifiedActiveMatchmaker(row) {
  return row && Number(row.status) === 1 && Number(row.certificationStatus) === 2;
}

async function chatParticipantContext(userIds) {
  const [usersById, profilesByUserId] = await Promise.all([
    getFirstRowsByNumericField(C.users, 'id', userIds, [], { complete: true, fields: {
      id: true, nickname: true, avatarUrl: true, gender: true
    } }),
    getFirstRowsByNumericField(C.profiles, 'userId', userIds, [], { complete: true, fields: {
      userId: true, realName: true, photos: true, gender: true
    } })
  ]);
  return { usersById, profilesByUserId };
}

async function chatParticipantView(userId, context = {}) {
  const id = Number(userId);
  const user = context.usersById?.has(id) ? context.usersById.get(id) : await getById(C.users, id);
  const profile = (context.profilesByUserId?.has(id) ? context.profilesByUserId.get(id) : await getOne(C.profiles, { userId: id })) || {};
  const photos = normalizeMemberPhotos(profile.photos);
  const media = withMemberMedia({ ...profile, gender: profile.gender || (user && user.gender), photos });
  return {
    id: Number(userId),
    nickname: profile.realName || (user && user.nickname) || `User ${userId}`,
    avatarUrl: (user && user.avatarUrl) || photos[0] || media.avatarUrl
  };
}

async function chatConversationView(conversation, currentUserId, context = {}) {
  const ids = chatParticipantIds(conversation);
  const peerId = ids.find(id => Number(id) !== Number(currentUserId));
  const peer = peerId ? await chatParticipantView(peerId, context) : null;
  const unreadCount = chatUnreadCount(conversation, currentUserId);
  return {
    ...publicChatConversation(conversation),
    canViewReadReceipts: context.canViewReadReceipts === undefined
      ? await hasPremiumMemberEntitlement(currentUserId) : context.canViewReadReceipts,
    participantIds: ids,
    peer,
    title: peer ? peer.nickname : 'Conversation',
    unreadCount,
    hasUnread: unreadCount > 0,
    lastMessageContent: conversation.lastMessageContent || '',
    lastMessageAt: conversation.lastMessageAt || conversation.updatedAt || conversation.createdAt || ''
  };
}

function publicChatConversation(conversation) {
  const safe = stripInternal(conversation);
  delete safe.unreadBy;
  return safe;
}

function chatReadStatus(message, currentUserId, canView) {
  if (!canView || Number(message.senderId) !== Number(currentUserId)) return undefined;
  return Array.isArray(message.readBy) && message.readBy.map(Number).includes(Number(message.receiverId)) ? 'read' : 'unread';
}

async function chatMessageView(message, currentUserId, context = {}) {
  const safe = stripInternal(message);
  delete safe.readBy;
  delete safe.readAt;
  const canView = context.canViewReadReceipts === undefined ? await hasPremiumMemberEntitlement(currentUserId) : context.canViewReadReceipts;
  const readStatus = chatReadStatus(message, currentUserId, canView);
  return { ...safe, ...(readStatus ? { readStatus } : {}),
    isMine: Number(message.senderId) === Number(currentUserId),
    sender: await chatParticipantView(message.senderId, context) };
}

async function resolveTargetUserId(data = {}) {
  if (data.targetUserId !== undefined && data.targetUserId !== '') {
    const targetUserId = Number(data.targetUserId);
    if (!Number.isFinite(targetUserId)) throw createHttpError('聊天对象无效');
    return targetUserId;
  }
  const memberId = data.targetMemberId !== undefined ? data.targetMemberId : data.memberId;
  if (memberId !== undefined && memberId !== '') {
    const memberRow = await getById(C.members, memberId);
    if (!memberRow) throw createHttpError('未找到会员档案', 404, 40400);
    return Number(memberRow.userId);
  }
  throw createHttpError('请选择聊天对象');
}

async function resolveMemberMatchmakerChatAccess(userId, targetUserId) {
  const ownAssignment = await activeMemberAssignment(userId);
  if (ownAssignment) {
    const matchmakerRow = await getById(C.matchmakers, ownAssignment.matchmakerId);
    if (isCertifiedActiveMatchmaker(matchmakerRow) && Number(matchmakerRow.userId) === Number(targetUserId)) {
      return {
        conversationType: 'member_matchmaker',
        memberId: Number(ownAssignment.id),
        matchmakerId: Number(matchmakerRow.id),
        matchmakerUserId: Number(targetUserId)
      };
    }
  }

  const targetAssignment = await activeMemberAssignment(targetUserId);
  if (targetAssignment) {
    const matchmakerRow = await getById(C.matchmakers, targetAssignment.matchmakerId);
    if (isCertifiedActiveMatchmaker(matchmakerRow) && Number(matchmakerRow.userId) === Number(userId)) {
      return {
        conversationType: 'member_matchmaker',
        memberId: Number(targetAssignment.id),
        matchmakerId: Number(matchmakerRow.id),
        matchmakerUserId: Number(userId)
      };
    }
  }
  return null;
}

async function resolveMemberPairChatAccess(userId, targetUserId) {
  const records = await getAll(C.matchRecords, _.or([
    { userAId: _.in([Number(userId), String(userId)]), userBId: _.in([Number(targetUserId), String(targetUserId)]) },
    { userBId: _.in([Number(userId), String(userId)]), userAId: _.in([Number(targetUserId), String(targetUserId)]) }
  ]), Infinity);
  const record = records
    .filter(row => {
      const users = [Number(row.userAId), Number(row.userBId)];
      return users.includes(Number(userId)) && users.includes(Number(targetUserId))
        && !['rejected', 'cancelled'].includes(String(row.status || ''));
    })
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0) || Number(b.id || 0) - Number(a.id || 0))[0];
  if (!record) return null;
  return {
    conversationType: 'member_pair',
    matchRecordId: Number(record.id),
    matchmakerId: record.matchmakerId ? Number(record.matchmakerId) : null
  };
}

async function resolveMutualFavoriteChatAccess(userId, targetUserId) {
  if (!(await areMutualFavorites(userId, targetUserId))) return null;
  if (!(await hasPremiumMemberEntitlement(userId))) {
    throw createHttpError('开通会员后可使用互选聊天', 403, 40302);
  }
  return {
    conversationType: 'member_pair',
    chatOpenReason: 'mutual_favorite'
  };
}

async function resolveChatAccess(userId, targetUserId) {
  if (!targetUserId || Number(userId) === Number(targetUserId)) {
    throw createHttpError('不能和自己聊天');
  }
  const targetUser = await getById(C.users, targetUserId);
  if (!targetUser || Number(targetUser.status || 1) === 0) {
    throw createHttpError('未找到聊天对象', 404, 40400);
  }

  const memberMatchmakerAccess = await resolveMemberMatchmakerChatAccess(userId, targetUserId);
  if (memberMatchmakerAccess) return memberMatchmakerAccess;

  if (await memberRelationships.isUnmatched(userId, targetUserId)) throw createHttpError('已解除匹配，无法继续聊天', 403, 40300);
  if (!(await hasPremiumMemberEntitlement(userId))) throw createHttpError('开通VIP后可聊天', 403, 40302);
  const memberPairAccess = await resolveMemberPairChatAccess(userId, targetUserId);
  if (memberPairAccess) return memberPairAccess;

  const mutualFavoriteAccess = await resolveMutualFavoriteChatAccess(userId, targetUserId);
  if (mutualFavoriteAccess) return mutualFavoriteAccess;

  throw createHttpError('需要建立服务关系或配对后才能聊天', 403, 40300);
}

async function getChatConversationOrThrow(userId, conversationId) {
  const conversation = await getById(C.conversations, conversationId);
  assertChatParticipant(conversation, userId);
  if (requiresPremiumForConversation(conversation)) {
    const peerId = chatParticipantIds(conversation).find(id => Number(id) !== Number(userId));
    if (peerId && await memberRelationships.isUnmatched(userId, peerId)) throw createHttpError('已解除匹配，无法继续聊天', 403, 40300);
    if (!(await hasPremiumMemberEntitlement(userId))) {
      throw createHttpError('开通VIP后可聊天', 403, 40302);
    }
    const formalPairAccess = peerId ? await resolveMemberPairChatAccess(userId, peerId) : null;
    if (formalPairAccess) return promoteChatConversation(conversation, formalPairAccess);
    if (!peerId || !(await areMutualFavorites(userId, peerId))) {
      throw createHttpError('互选已取消，暂不能继续聊天', 403, 40300);
    }
  }
  return conversation;
}

function conversationMetadataPatch(existing, metadata = {}) {
  const patch = {};
  if (metadata.memberId && !existing.memberId) patch.memberId = metadata.memberId;
  if (metadata.matchmakerId && !existing.matchmakerId) patch.matchmakerId = metadata.matchmakerId;
  if (metadata.matchmakerUserId && !existing.matchmakerUserId) patch.matchmakerUserId = metadata.matchmakerUserId;
  if (metadata.matchRecordId) {
    if (!existing.matchRecordId) patch.matchRecordId = metadata.matchRecordId;
    if (existing.chatOpenReason != null) patch.chatOpenReason = null;
  }
  if (metadata.chatOpenReason && !existing.chatOpenReason && !existing.matchRecordId && !metadata.matchRecordId) {
    patch.chatOpenReason = metadata.chatOpenReason;
  }
  return patch;
}

async function promoteChatConversation(conversation, metadata = {}) {
  if (conversation && !Object.keys(conversationMetadataPatch(conversation, metadata)).length) return conversation;
  if (!conversation || !conversation._id) {
    const patch = conversationMetadataPatch(conversation || {}, metadata);
    return Object.keys(patch).length ? updateRow(C.conversations, conversation, patch) : conversation;
  }
  return db.runTransaction(async transaction => {
    const ref = transaction.collection(C.conversations).doc(conversation._id);
    const snapshot = await ref.get();
    const current = snapshot && snapshot.data ? snapshot.data : null;
    if (!current) throw createHttpError('conversation not found', 404, 40400);
    const patch = conversationMetadataPatch(current, metadata);
    if (!Object.keys(patch).length) return { ...current, _id: current._id || conversation._id };
    const update = { ...patch, updatedAt: nowIso() };
    await ref.update({ data: update });
    return { ...current, ...update, _id: current._id || conversation._id };
  });
}

function conversationDocumentId(participantKey, conversationType) {
  const digest = crypto.createHash('sha256')
    .update(`${String(conversationType || '')}:${String(participantKey || '')}`)
    .digest('hex');
  return `conversation_${digest.slice(0, 40)}`;
}

async function createChatConversationAtomically(normalizedIds, participantKey, conversationType, metadata = {}) {
  const documentId = conversationDocumentId(participantKey, conversationType);
  const proposedId = await nextId('conversation');
  const unreadBy = {};
  normalizedIds.forEach(id => { unreadBy[String(id)] = 0; });

  return db.runTransaction(async transaction => {
    const ref = transaction.collection(C.conversations).doc(documentId);
    const existing = await salonTransactionDocument(transaction, C.conversations, documentId);
    if (existing && Number(existing.status || 1) !== 0) {
      const patch = conversationMetadataPatch(existing, metadata);
      if (!Object.keys(patch).length) return { ...existing, _id: existing._id || documentId };
      const update = { ...patch, updatedAt: nowIso() };
      await ref.update({ data: update });
      return { ...existing, ...update, _id: existing._id || documentId };
    }

    const timestamp = nowIso();
    const payload = {
      ...(existing || {}),
      id: existing && existing.id ? existing.id : proposedId,
      conversationType,
      participantIds: normalizedIds,
      participantKey,
      memberId: metadata.memberId || (existing && existing.memberId) || null,
      matchmakerId: metadata.matchmakerId || (existing && existing.matchmakerId) || null,
      matchmakerUserId: metadata.matchmakerUserId || (existing && existing.matchmakerUserId) || null,
      matchRecordId: metadata.matchRecordId || (existing && existing.matchRecordId) || null,
      chatOpenReason: metadata.matchRecordId
        ? null
        : (metadata.chatOpenReason || (existing && existing.chatOpenReason) || null),
      lastMessageContent: (existing && existing.lastMessageContent) || '',
      lastMessageAt: (existing && existing.lastMessageAt) || '',
      lastSenderId: (existing && existing.lastSenderId) || null,
      unreadBy: (existing && existing.unreadBy) || unreadBy,
      status: 'active',
      createdAt: (existing && existing.createdAt) || timestamp,
      updatedAt: timestamp
    };
    delete payload._id;
    await ref.set({ data: payload });
    return { ...payload, _id: documentId };
  });
}

async function ensureChatConversation(participantIds, conversationType, metadata = {}, context = {}) {
  const normalizedIds = participantIds.map(id => Number(id)).filter(id => Number.isFinite(id));
  if (normalizedIds.length !== 2 || normalizedIds[0] === normalizedIds[1]) return null;
  normalizedIds.sort((a, b) => a - b);
  const participantKey = chatParticipantKey(normalizedIds);
  const key = `${conversationType}:${participantKey}`;
  const existingRows = context.rowsByPair?.has(key)
    ? context.rowsByPair.get(key) : await getAll(C.conversations, { participantKey, conversationType }, Infinity);
  const existing = existingRows.find(row => Number(row.status || 1) !== 0);
  if (existing) return promoteChatConversation(existing, metadata);
  return createChatConversationAtomically(normalizedIds, participantKey, conversationType, metadata);
}

async function ensureMemberMatchmakerConversation(memberRow, matchmakerRow, context = {}) {
  if (!memberRow || !matchmakerRow) return null;
  return ensureChatConversation(
    [Number(memberRow.userId), Number(matchmakerRow.userId)],
    'member_matchmaker',
    {
      memberId: Number(memberRow.id),
      matchmakerId: Number(matchmakerRow.id),
      matchmakerUserId: Number(matchmakerRow.userId)
    }, context
  );
}

async function ensureMemberPairConversation(matchRecord, context = {}) {
  if (!matchRecord) return null;
  const blocked = context.unmatchedPeerIds ? [matchRecord.userAId, matchRecord.userBId].some(id => context.unmatchedPeerIds.has(Number(id)))
    : await memberRelationships.isUnmatched(matchRecord.userAId, matchRecord.userBId);
  if (blocked) return null;
  return ensureChatConversation(
    [Number(matchRecord.userAId), Number(matchRecord.userBId)],
    'member_pair',
    {
      matchRecordId: Number(matchRecord.id),
      matchmakerId: matchRecord.matchmakerId ? Number(matchRecord.matchmakerId) : null
    }, context
  );
}

async function ensureDefaultChatConversationsForUser(userId, isPremiumMember = false, context = {}) {
  const assignment = await activeMemberAssignment(userId);
  if (assignment) {
    const matchmakerRow = await getById(C.matchmakers, assignment.matchmakerId);
    if (isCertifiedActiveMatchmaker(matchmakerRow)) {
      await ensureMemberMatchmakerConversation(assignment, matchmakerRow, context);
    }
  }

  const matchmakerRow = await getOne(C.matchmakers, { userId: Number(userId) });
  if (isCertifiedActiveMatchmaker(matchmakerRow)) {
    const members = await getAll(C.members, { matchmakerId: Number(matchmakerRow.id), status: 1 }, Infinity);
    await Promise.all(members.map(memberRow => ensureMemberMatchmakerConversation(memberRow, matchmakerRow, context)));
  }

  const matchRecords = (await getAll(C.matchRecords, _.or([
    { userAId: _.in([Number(userId), String(userId)]) }, { userBId: _.in([Number(userId), String(userId)]) }
  ]), Infinity))
    .filter(record => {
      const users = [Number(record.userAId), Number(record.userBId)];
      return users.includes(Number(userId))
        && !['rejected', 'cancelled'].includes(String(record.status || ''));
    });
  await Promise.all(matchRecords.map(record => ensureMemberPairConversation(record, context)));

  if (isPremiumMember) {
    const peerIds = context.mutualFavoritePeerIds || await mutualFavoritePeerIds(userId);
    await Promise.all(Array.from(peerIds).map(peerId => ensureMutualFavoriteConversation(
      userId, peerId, { ...context, mutualFavoritePeerIds: peerIds }
    )));
  }
}

async function markChatRead(userId, conversationId, context = {}) {
  const conversation = context.conversation || await getChatConversationOrThrow(userId, conversationId);
  const unreadBy = chatUnreadMap(conversation);
  unreadBy[String(userId)] = 0;
  const messages = context.messages || await getAll(C.chatMessages, {
    conversationId: Number(conversation.id),
    receiverId: _.in([Number(userId), String(Number(userId))]),
    readBy: _.nin([Number(userId), String(Number(userId))])
  }, Infinity, { fields: { _id: true, id: true, receiverId: true, readBy: true, readAt: true } });
  await Promise.all(messages
    .filter(message => Number(message.receiverId) === Number(userId)
      && !(Array.isArray(message.readBy) && message.readBy.map(id => Number(id)).includes(Number(userId))))
    .map(message => updateRow(C.chatMessages, message, {
      readBy: Array.from(new Set([...(Array.isArray(message.readBy) ? message.readBy : []), Number(userId)])),
      readAt: nowIso()
    })));
  const updated = await updateRow(C.conversations, conversation, { unreadBy });
  return chatConversationView(updated, userId, context);
}

async function participantConversations(userId, activeOnly = false) {
  const ids = [Number(userId), String(Number(userId))];
  const query = { participantIds: _.in(ids) };
  if (activeOnly) query.status = 'active';
  return getAll(C.conversations, query, Infinity);
}

const chat = {
  async listConversations(userId, filters = {}) {
    const isPremiumMember = await hasPremiumMemberEntitlement(userId);
    const initial = await participantConversations(userId);
    const rowsByPair = new Map();
    initial.forEach(row => {
      const key = `${row.conversationType}:${row.participantKey}`;
      if (!rowsByPair.has(key)) rowsByPair.set(key, []);
      rowsByPair.get(key).push(row);
    });
    const relationships = await chatRelationshipPeers(userId);
    const mutualPeerIds = isPremiumMember ? relationships.mutualPeerIds : new Set();
    await ensureDefaultChatConversationsForUser(userId, isPremiumMember, {
      rowsByPair, mutualFavoritePeerIds: mutualPeerIds, unmatchedPeerIds: relationships.unmatchedPeerIds
    });
    const candidates = (await participantConversations(userId, true))
      .filter(row => row.status === 'active')
      .filter(row => chatParticipantIds(row).includes(Number(userId)))
      .filter(row => isPremiumMember || !requiresPremiumForConversation(row));
    const formalPeers = new Set((await getAll(C.matchRecords, _.or([
      { userAId: _.in([Number(userId), String(userId)]) }, { userBId: _.in([Number(userId), String(userId)]) }
    ]), Infinity)).filter(row => !['rejected', 'cancelled'].includes(String(row.status || '')))
      .map(row => Number(row.userAId) === Number(userId) ? Number(row.userBId) : Number(row.userAId)));
    const unblocked = candidates.filter(row => row.conversationType !== 'member_pair'
      || !relationships.unmatchedPeerIds.has(chatParticipantIds(row).find(id => Number(id) !== Number(userId))));
    const rows = unblocked.filter(row => !requiresPremiumForConversation(row)
      || formalPeers.has(chatParticipantIds(row).find(id => Number(id) !== Number(userId)))
      || mutualPeerIds.has(chatParticipantIds(row).find(id => Number(id) !== Number(userId))))
      .sort((a, b) => {
        const aTime = new Date(a.lastMessageAt || a.updatedAt || a.createdAt || 0).getTime();
        const bTime = new Date(b.lastMessageAt || b.updatedAt || b.createdAt || 0).getTime();
        return bTime - aTime || Number(b.id || 0) - Number(a.id || 0);
      });
    const page = paginate(rows, filters.page, Math.min(Number(filters.pageSize) || 50, 100));
    const context = { ...await chatParticipantContext(page.list.flatMap(chatParticipantIds)), canViewReadReceipts: isPremiumMember };
    return { ...page, list: await Promise.all(page.list.map(row => chatConversationView(row, userId, context))) };
  },

  async getOrCreateConversation(userId, data = {}) {
    const targetUserId = await resolveTargetUserId(data);
    const access = await resolveChatAccess(userId, targetUserId);
    const participantIds = [Number(userId), Number(targetUserId)];
    const conversation = await ensureChatConversation(participantIds, access.conversationType, access);
    return chatConversationView(conversation, userId);
  },

  async listMessages(userId, conversationId, filters = {}) {
    const conversation = await getChatConversationOrThrow(userId, conversationId);
    const hasBefore = filters.beforeId !== undefined && filters.beforeId !== null && filters.beforeId !== '';
    const hasAfter = filters.afterId !== undefined && filters.afterId !== null && filters.afterId !== '';
    const beforeId = Number(filters.beforeId || 0);
    const afterId = Number(filters.afterId || 0);
    if ((hasBefore && (!Number.isSafeInteger(beforeId) || beforeId <= 0))
      || (hasAfter && (!Number.isSafeInteger(afterId) || afterId < 0)) || (hasBefore && hasAfter)) {
      throw createHttpError('消息游标无效');
    }
    const query = { conversationId: Number(conversation.id), status: _.nin([0, '0']) };
    const cursorQuery = { ...query };
    if (hasBefore) cursorQuery.id = _.lt(beforeId);
    if (hasAfter) cursorQuery.id = _.gt(afterId);
    const pageSize = Math.min(Math.max(Math.floor(Number(filters.pageSize) || 80), 1), 100);
    const pageNumber = Math.max(Math.floor(Number(filters.page) || 1), 1);
    const offset = (pageNumber - 1) * pageSize;
    const [window, count] = await Promise.all([
      queryRead(C.chatMessages, cursorQuery, { order: [['id', hasAfter ? 'asc' : 'desc']], offset, limit: pageSize + 1 }),
      queryRead(C.chatMessages, query, {}, true)
    ]);
    const selected = (window.data || []).slice(0, pageSize);
    const messageRows = selected.sort((a, b) => Number(a.id) - Number(b.id));
    const context = { ...await chatParticipantContext([...chatParticipantIds(conversation), ...messageRows.map(row => row.senderId)]),
      canViewReadReceipts: await hasPremiumMemberEntitlement(userId) };
    const receiptWindow = context.canViewReadReceipts ? await queryRead(C.chatMessages, {
      conversationId: Number(conversation.id), senderId: _.in([Number(userId), String(userId)]), status: _.nin([0, '0'])
    }, { order: [['id', 'desc']], limit: 100, fields: { id: true, senderId: true, receiverId: true, readBy: true } }) : { data: [] };
    const conversationView = await markChatRead(userId, conversation.id, { ...context, conversation });
    return {
      conversation: conversationView,
      readReceipts: (receiptWindow.data || []).map(row => ({ id: row.id, readStatus: chatReadStatus(row, userId, true) })),
      messages: await Promise.all(messageRows.map(row => chatMessageView(row, userId, context))),
      total: Number(count.total || 0),
      page: pageNumber,
      pageSize,
      hasMore: (window.data || []).length > pageSize,
      beforeId: selected.length ? Math.min(...selected.map(row => Number(row.id))) : 0,
      latestId: selected.length ? Math.max(...selected.map(row => Number(row.id))) : 0
    };
  },

  async sendMessage(userId, conversationId, data = {}) {
    // New audio cannot be delivered until its asynchronous moderation callback
    // is configured. Existing approved text and historical playback remain usable.
    if (data.contentType === 'voice') throw createHttpError('语音发送暂不可用，请发送文字消息', 503, 50363);
    const contentType = String(data.contentType || 'text') === 'voice' ? 'voice' : 'text';
    const voicePayload = contentType === 'voice' ? normalizeChatVoice(data) : null;
    const content = voicePayload ? voicePayload.content : normalizeChatText(data.content);
    const conversation = await getChatConversationOrThrow(userId, conversationId);
    const receiverId = chatParticipantIds(conversation).find(id => Number(id) !== Number(userId));
    if (!receiverId) throw createHttpError('receiver not found');
    if (contentType === 'text') await assertUserText(userId, [content], 2);
    // Moderation can wait on the network; refresh access before delivering.
    await getChatConversationOrThrow(userId, conversationId);
    const payload = {
      id: await nextId('chatMessage'),
      conversationId: Number(conversation.id),
      senderId: Number(userId),
      receiverId: Number(receiverId),
      contentType,
      content,
      readBy: [Number(userId)],
      status: 'active'
    };
    if (voicePayload) {
      payload.voiceFileID = voicePayload.voiceFileID;
      payload.voiceDuration = voicePayload.voiceDuration;
      payload.voiceFormat = voicePayload.voiceFormat;
      payload.voiceFileSize = voicePayload.voiceFileSize;
    }
    const message = await addRow(C.chatMessages, payload);
    const unreadBy = chatUnreadMap(conversation);
    unreadBy[String(receiverId)] = Number(unreadBy[String(receiverId)] || 0) + 1;
    unreadBy[String(userId)] = 0;
    await updateRow(C.conversations, conversation, {
      lastMessageContent: content,
      lastMessageAt: message.createdAt,
      lastSenderId: Number(userId),
      unreadBy
    });
    return chatMessageView(message, userId);
  },

  async markRead(userId, conversationId) {
    return markChatRead(userId, conversationId);
  }
};

function isMessageRead(row) {
  return Number(row.isRead) === 1 || row.isRead === true;
}

async function notificationMessageView(row, currentUserId, isPremiumMember = false, context = {}) {
  const favoriteMessage = String(row.messageType || '') === 'member_favorite';
  const sender = row.senderId && (!favoriteMessage || isPremiumMember)
    ? await chatParticipantView(row.senderId, context)
    : null;
  let conversationId = row.conversationId ? Number(row.conversationId) : null;
  if (favoriteMessage && !isPremiumMember) conversationId = null;
  if (!conversationId && favoriteMessage && isPremiumMember && row.senderId) {
    const conversation = await findActiveConversation([Number(row.senderId), Number(currentUserId)], 'member_pair');
    if (conversation) conversationId = Number(conversation.id);
  }
  const relationshipView = relationshipNotificationView({
    row: stripInternal(row),
    sender,
    conversationId,
    isPremiumMember
  });
  return {
    ...relationshipView,
    isRead: isMessageRead(row),
    hasUnread: !isMessageRead(row),
    createdAt: row.createdAt || ''
  };
}

const messages = {
  async list(userId, filters = {}) {
    const isPremiumMember = await hasPremiumMemberEntitlement(userId);
    const rows = (await getAll(C.messages, { receiverId: Number(userId) }, 2000))
      .filter(row => Number(row.status || 1) !== 0)
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0) || Number(b.id || 0) - Number(a.id || 0));
    const page = paginate(rows, filters.page, filters.pageSize || 20);
    // Resolve only identities visible on this page; hidden favorite senders
    // must never be loaded merely to render a free member's notifications.
    const senderIds = page.list
      .filter(row => row.senderId && (String(row.messageType || '') !== 'member_favorite' || isPremiumMember))
      .map(row => row.senderId);
    const [usersById, profilesByUserId] = await Promise.all([
      getFirstRowsByNumericField(C.users, 'id', senderIds, [], { complete: true, fields: {
        id: true, nickname: true, avatarUrl: true, gender: true
      } }),
      getFirstRowsByNumericField(C.profiles, 'userId', senderIds, [], { complete: true, fields: {
        userId: true, realName: true, photos: true, gender: true, nickname: true, city: true
      } })
    ]);
    const context = { usersById, profilesByUserId };
    return {
      ...page,
      unreadCount: rows.filter(row => !isMessageRead(row)).length,
      list: await Promise.all(page.list.map(row => notificationMessageView(row, userId, isPremiumMember, context)))
    };
  },

  async markRead(userId, messageId) {
    const row = await getById(C.messages, messageId);
    if (!row) throw createHttpError('message not found', 404, 40400);
    if (Number(row.receiverId) !== Number(userId)) {
      throw createHttpError('message forbidden', 403, 40300);
    }
    const updated = isMessageRead(row)
      ? row
      : await updateRow(C.messages, row, { isRead: 1, readAt: nowIso() });
    return notificationMessageView(updated, userId, await hasPremiumMemberEntitlement(userId));
  }
};

async function eventViewContext(events, currentUserId = null) {
  const registrations = await rowsByFieldBatches(C.registrations, 'eventId', events.flatMap(event => [Number(event.id), String(event.id)]));
  const usersById = await getFirstRowsByNumericField(C.users, 'id', [
    ...events.map(event => event.organizerId), ...registrations.filter(row => row.status === 'registered').map(row => row.userId)
  ], [], { complete: true, fields: { id: true, nickname: true, avatarUrl: true, gender: true, status: true } });
  const profilesByUserId = await getFirstRowsByNumericField(C.profiles, 'userId', registrations.map(row => row.userId), [], {
    complete: true, fields: { userId: true, realName: true, photos: true, displayEnabled: true }
  });
  const registrationsByEventId = new Map(events.map(event => [Number(event.id), []]));
  registrations.forEach(row => registrationsByEventId.get(Number(row.eventId))?.push(row));
  const hiddenUserIds = currentUserId ? await salonHiddenUserIds(currentUserId, registrations.map(row => row.userId)) : new Set();
  const registrationRequirements = currentUserId ? await getMinimumRegistrationRequirements(currentUserId) : { complete: false, missingFields: ['phone', 'nickname', 'photo'] };
  return { usersById, profilesByUserId, registrationsByEventId, hiddenUserIds, registrationRequirements };
}

async function eventView(event, currentUserId = null, context = {}) {
  const organizerId = Number(event.organizerId);
  const organizer = context.usersById?.has(organizerId) ? context.usersById.get(organizerId) : await getById(C.users, organizerId);
  const allRegistrations = context.registrationsByEventId?.has(Number(event.id))
    ? context.registrationsByEventId.get(Number(event.id)) : await getAll(C.registrations, { eventId: _.in([Number(event.id), String(event.id)]) }, Infinity);
  const registrations = activeAttendance(allRegistrations);
  const hiddenUserIds = context.hiddenUserIds || (currentUserId ? await salonHiddenUserIds(currentUserId, registrations.map(reg => reg.userId)) : new Set());
  const canViewProfiles = Number(event.organizerId) === Number(currentUserId) || registrations.some(reg => Number(reg.userId) === Number(currentUserId));
  const registrationViews = (await Promise.all(registrations.map(async reg => {
    const targetUserId = Number(reg.userId);
    if (hiddenUserIds.has(targetUserId)) return null;
    const user = context.usersById?.has(targetUserId) ? context.usersById.get(targetUserId) : await getById(C.users, targetUserId);
    if (!user || Number(user.status) !== 1) return null;
    const profile = context.profilesByUserId?.has(targetUserId) ? context.profilesByUserId.get(targetUserId) : await getOne(C.profiles, { userId: targetUserId });
    const identity = salonAttendeeIdentity(user, profile || {});
    return { id: reg.id, eventId: Number(event.id), userId: targetUserId, status: 'registered',
      user: { id: targetUserId, nickname: identity.displayName, avatarUrl: identity.avatarUrl },
      canViewProfile: canViewProfiles && salonProfileConsent(reg, profile || {}) };
  }))).filter(Boolean);
  const currentRegistration = currentUserId
    ? latestAttendanceRows(allRegistrations).find(reg => Number(reg.userId) === Number(currentUserId))
    : null;
  return {
    ...stripInternal(event),
    organizer: organizer ? {
      id: organizer.id,
      nickname: organizer.nickname,
      avatarUrl: organizer.avatarUrl || ''
    } : null,
    registrations: registrationViews,
    currentParticipants: registrations.length,
    registrationStatus: currentRegistration ? currentRegistration.status : 'none',
    isRegistered: !!currentRegistration && currentRegistration.status === 'registered',
    isOrganizer: Number(event.organizerId) === Number(currentUserId),
    ...salonAvailability(event, registrations.length),
    registrationRequirements: context.registrationRequirements || (currentUserId ? await getMinimumRegistrationRequirements(currentUserId) : { complete: false, missingFields: ['phone', 'nickname', 'photo'] })
  };
}

function salonProfileConsent(registration, profile) {
  return registration.participantProfileVisible === true || isTrue(profile.displayEnabled);
}

function salonPublicPhotos(profile) {
  return normalizeMemberPhotos(profile.photos).filter(value => !/\/hl_uploads\/member-private\//i.test(value));
}

function salonAttendeeIdentity(user, profile) {
  const photos = salonPublicPhotos(profile);
  const avatar = String(user.avatarUrl || '');
  return { displayName: String(profile.realName || user.nickname || '会员').trim() || '会员',
    avatarUrl: photos[0] || (!/\/hl_uploads\/member-private\//i.test(avatar) ? avatar : '') || defaultMemberMedia({ ...profile, gender: user.gender }).avatarUrl };
}

async function salonHiddenUserIds(viewerUserId, userIds) {
  const targets = Array.from(new Set(userIds.map(Number).filter(id => Number.isSafeInteger(id) && id > 0)));
  if (!targets.length) return new Set();
  const [outgoing, incoming] = await Promise.all([
    memberInteractionStateMap(viewerUserId, targets),
    getAll(C.memberInteractions, { targetUserId: Number(viewerUserId), actionType: 'hide' }, Infinity, {
      fields: { userId: true, targetUserId: true, active: true }
    })
  ]);
  const hidden = new Set(targets.filter(id => outgoing[String(id)]?.hide));
  incoming.forEach(row => { if (row.active !== false && targets.includes(Number(row.userId))) hidden.add(Number(row.userId)); });
  return hidden;
}

async function getMinimumRegistrationRequirements(userId) {
  const [user, profile] = await Promise.all([
    getById(C.users, userId), getOne(C.profiles, { userId: Number(userId) })
  ]);
  return minimumRegistrationStatus(user || {}, profile || {});
}

async function minimumRegistrationView(userId) {
  const [user, profile] = await Promise.all([getUserOrThrow(userId), getOne(C.profiles, { userId: Number(userId) })]);
  const status = minimumRegistrationStatus(user, profile || {});
  const photos = registrationPhotos(user, profile || {});
  const urls = await memberMediaURLMap(photos);
  return { completed: status.complete, missingFields: status.missingFields,
    user: { id: Number(user.id), nickname: registrationName(user, profile || {}) || user.nickname || '',
      phone: user.phone || '', avatarUrl: user.avatarUrl || '' },
    profile: { realName: profile?.realName || '', photos, photoDisplayUrls: photos.map(fileID => urls[fileID] || '') },
    phoneStatus: user.phoneSource === 'wechat' ? 'verified' : 'filled' };
}

async function ownProfileResponse(user, profile) {
  const safeProfile = profile ? sanitizeProfileCertification(stripInternal(await readableCertificationProfile(profile))) : null;
  if (safeProfile) {
    const photos = normalizeMemberPhotos(safeProfile.photos);
    const urls = await memberMediaURLMap(photos);
    safeProfile.photoDisplayUrls = photos.map(fileID => urls[fileID] || (isCloudFileID(fileID) ? '' : fileID));
  }
  return { ...publicUser(user), profile: safeProfile };
}

async function validateRegistrationPhotos(photos) {
  if (!photos.length || !photos.every(isPublicRegistrationPhoto)) throw createHttpError('请上传至少一张本人照片', 422, 42231);
  const envId = process.env.TCB_ENV || process.env.CLOUDBASE_ENV_ID || '';
  if (envId && photos.some(fileID => !fileID.startsWith(`cloud://${envId}.`))) throw createHttpError('照片不属于当前小程序，请重新上传', 422, 42231);
  const result = await cloud.getTempFileURL({ fileList: photos });
  const available = new Set((result.fileList || []).filter(row => Number(row.status) === 0 && row.tempFileURL).map(row => row.fileID));
  if (photos.some(fileID => !available.has(fileID))) throw createHttpError('照片上传未完成，请重新上传', 422, 42231);
}

async function saveMinimumRegistration(userId, data = {}) {
  const user = await getUserOrThrow(userId);
  const phone = normalizeMainlandPhone(data.phone);
  const nickname = registrationName({ nickname: data.nickname });
  let photos = normalizeMemberPhotos(data.photos);
  const missingFields = [];
  if (!phone) missingFields.push('phone');
  if (!nickname) missingFields.push('nickname');
  if (!photos.length || !photos.every(isPublicRegistrationPhoto)) missingFields.push('photo');
  if (missingFields.length) {
    const error = createHttpError('请完善手机号、称呼和本人照片后再报名', 422, 42230);
    error.details = missingFields.map(field => ({ field, code: 'required' }));
    throw error;
  }
  const owner = await uniqueActiveUser({ phone }, '该手机号对应多个账号，请联系平台核验');
  if (owner && Number(owner.id) !== Number(user.id)) throw createHttpError('该手机号已被其他账号使用，请联系平台核验', 409, 40920);
  await validateRegistrationPhotos(photos);
  await assertUserText(user, [nickname]);
  photos = await contentSecurity.assertImages({ images: data.photos });
  const profile = await getOne(C.profiles, { userId: Number(userId) });
  await Promise.all([ensureCollection(C.profiles), ensureCollection(C.counters)]);
  await db.runTransaction(async transaction => {
    const profileId = profile?._id || `profile_user_${Number(userId)}`;
    const [currentUser, currentProfile] = await Promise.all([
      salonTransactionDocument(transaction, C.users, user._id),
      salonTransactionDocument(transaction, C.profiles, profileId)
    ]);
    if (!currentUser || Number(currentUser.status) !== 1 || currentUser.mergedIntoUserId) throw createHttpError('登录状态已失效，请重新登录', 401, 40100);
    const timestamp = nowIso();
    await transaction.collection(C.users).doc(user._id).update({ data: {
      phone, nickname, avatarUrl: photos[0], updatedAt: timestamp,
      phoneSource: phone === currentUser.phone && currentUser.phoneSource === 'wechat' ? 'wechat' : 'manual'
    } });
    if (currentProfile) await transaction.collection(C.profiles).doc(profileId).update({ data: { realName: nickname, photos, updatedAt: timestamp } });
    else {
      const counter = await salonTransactionDocument(transaction, C.counters, 'profile');
      const id = (Number(counter?.value) || 0) + 1;
      await transaction.collection(C.counters).doc('profile').set({ data: { key: 'profile', value: id, updatedAt: timestamp } });
      await transaction.collection(C.profiles).doc(profileId).set({ data: { id, userId: Number(userId),
        realName: nickname, photos, displayEnabled: false, createdAt: timestamp, updatedAt: timestamp } });
    }
  });
  return minimumRegistrationView(userId);
}

async function getUserOrThrow(userId) {
  const user = await getById(C.users, userId);
  if (!user || user.status === 0) {
    throw createHttpError('user not found', 404, 40400);
  }
  return user;
}

// The subject is always the authenticated submitter, including when a
// matchmaker edits somebody else's profile. Never accept an OpenID from data.
async function assertUserText(userOrId, values, scene = 1) {
  const parts = values.filter(value => value !== undefined && value !== null && value !== '');
  if (parts.some(value => typeof value !== 'string')) {
    throw createHttpError('请填写有效的文字内容', 400, 40001);
  }
  const content = parts.join('\n').trim();
  if (!content) return;
  const user = typeof userOrId === 'object' ? userOrId : await getUserOrThrow(userOrId);
  const openid = typeof user?.openid === 'string' ? user.openid.trim() : '';
  if (!openid || /^(manual_|mock_|merged_)/i.test(openid)) {
    throw createHttpError('内容安全检测暂不可用，请通过微信登录后重试', 503, 50301);
  }
  await contentSecurity.assertText({ openid, scene, content });
}

async function getMatchmakerByUserIdOrThrow(userId) {
  const matchmaker = await getOne(C.matchmakers, { userId: Number(userId), status: 1 });
  if (!matchmaker) {
    throw createHttpError('matchmaker not found', 404, 40400);
  }
  return ensureMatchmakerIdentity(matchmaker);
}

async function getCertifiedMatchmakerByUserIdOrThrow(userId) {
  const matchmaker = await getMatchmakerByUserIdOrThrow(userId);
  if (Number(matchmaker.certificationStatus) !== 2) {
    throw createHttpError('主理人认证通过后可使用', 403, 40301);
  }
  return matchmaker;
}

async function resolveMatchmakerForRequest(data = {}) {
  const rawCode = normalizeInviteCode(data.matchmakerNo || data.inviteCode || data.code || '');
  if (data.matchmakerId) {
    const byId = await getById(C.matchmakers, data.matchmakerId);
    return byId ? ensureMatchmakerIdentity(byId) : null;
  }
  if (!rawCode) throw createHttpError('matchmaker code is required');
  if (/^MBR\d+$/i.test(rawCode)) {
    const byLegacy = await getById(C.matchmakers, Number(rawCode.replace(/^MBR0*/i, '')));
    return byLegacy ? ensureMatchmakerIdentity(byLegacy) : null;
  }
  const byInvite = await getOne(C.matchmakers, { inviteCode: rawCode, inviteCodeStatus: 'active' });
  if (byInvite) return ensureMatchmakerIdentity(byInvite);
  const byNo = await getOne(C.matchmakers, { matchmakerNo: rawCode });
  if (byNo) return ensureMatchmakerIdentity(byNo);
  if (/^\d+$/.test(rawCode)) {
    const numeric = await getById(C.matchmakers, Number(rawCode));
    return numeric ? ensureMatchmakerIdentity(numeric) : null;
  }
  return null;
}

function requestApplySource(data = {}) {
  const source = String(data.applySource || data.source || '').trim();
  if (['scan', 'share', 'inviteCode', 'manual', 'matchmakerShare', 'memberShare', 'salonShare', 'memberSalonShare'].includes(source)) return source;
  if (data.scanResult || data.scene) return 'scan';
  if (data.inviteCode) return 'inviteCode';
  return 'manual';
}

function isShareInviteSource(data = {}) {
  const source = requestApplySource(data);
  return ['share', 'matchmakerShare', 'memberShare', 'salonShare', 'memberSalonShare'].includes(source);
}

async function matchmakerInvitePreview(data = {}) {
  const matchmaker = await resolveMatchmakerForRequest(data);
  if (!matchmaker || Number(matchmaker.status) !== 1) {
    throw createHttpError('matchmaker not found', 404, 40400);
  }
  if (Number(matchmaker.certificationStatus) !== 2) {
    throw createHttpError('matchmaker is not certified', 403, 40301);
  }
  const user = await getById(C.users, matchmaker.userId);
  const members = await getAll(C.members, { matchmakerId: matchmaker.id, status: 1 });
  return {
    matchmakerNo: matchmaker.matchmakerNo,
    nickname: (user && user.nickname) || '主理人',
    avatarUrl: (user && user.avatarUrl) || '',
    level: matchmaker.level || 1,
    memberCount: members.length,
    certificationStatus: matchmaker.certificationStatus,
    applySource: requestApplySource(data)
  };
}

async function memberAssignmentRows(userId) {
  const found = await Promise.all([Number(userId), String(userId)].map(value => getAll(C.members, { userId: value }, Infinity)));
  return [...new Map(found.flat().map(row => [row._id, row])).values()];
}

async function memberAssignmentUserOrThrow(userId) {
  const user = await getUserOrThrow(userId);
  if (Number(user.status) !== 1 || user.mergedIntoUserId) throw createHttpError('user unavailable for member assignment', 409, 40901);
  return user;
}

async function activeMemberAssignment(userId) {
  const rows = (await memberAssignmentRows(userId)).filter(row => Number(row.status) === 1);
  if (rows.length > 1) throw createHttpError('duplicate active member assignments', 409, 40901);
  return rows[0] || null;
}

async function hasPremiumMemberEntitlement(userId) {
  return (await vipMembership.getEntitlement(userId)).isPremiumMember;
}

function relationshipType(value) {
  return String(value || '').trim().toLowerCase() === 'mutual' ? 'mutual' : 'incoming';
}

async function favoriteRelationshipGroups(userId) {
  const [incomingRows, outgoingRows, hiddenRows] = await Promise.all([
    getAll(C.memberInteractions, {
      targetUserId: Number(userId),
      actionType: 'favorite'
    }, 2000),
    getAll(C.memberInteractions, {
      userId: Number(userId),
      actionType: 'favorite'
    }, 2000),
    getAll(C.memberInteractions, {
      userId: Number(userId),
      actionType: 'hide'
    }, 2000)
  ]);
  return partitionFavoriteRelationships({
    viewerUserId: userId,
    incomingRows,
    outgoingRows,
    hiddenRows
  });
}

async function memberRequestView(row) {
  const user = await getById(C.users, row.userId);
  const profile = await getOne(C.profiles, { userId: Number(row.userId) }) || {};
  const matchmaker = await getById(C.matchmakers, row.matchmakerId);
  const matchmakerUser = matchmaker ? await getById(C.users, matchmaker.userId) : null;
  const profileView = sanitizeProfileCertification(stripInternal(await readableCertificationProfile(profile)) || {});
  return {
    ...stripInternal(row),
    user: user ? publicUser(user) : null,
    profile: profileView,
    profileCompletion: profileCompletionFor({ ...profileView, avatarUrl: user && user.avatarUrl }),
    matchmaker: matchmaker ? {
      id: matchmaker.id,
      matchmakerNo: matchmaker.matchmakerNo,
      user: matchmakerUser ? publicUser(matchmakerUser) : null
    } : null
  };
}

async function createMemberMatchmakerRequest(userId, data = {}) {
  // Entered codes and scanned invitations use the same atomic assignment as
  // shared invitations; the source is metadata, not an approval requirement.
  return acceptMemberMatchmakerInvite(userId, data, { requireShareSource: false });
}

async function approveMemberMatchmakerRequest(matchmakerUserId, requestId) {
  const mm = await getCertifiedMatchmakerByUserIdOrThrow(matchmakerUserId);
  const request = await getById(C.memberRequests, requestId);
  if (!request || Number(request.matchmakerId) !== Number(mm.id)) {
    throw createHttpError('request not found', 404, 40400);
  }
  if (request.status !== 'pending') throw createHttpError('request is not pending');

  const assignment = await activeMemberAssignment(request.userId);
  if (assignment && Number(assignment.matchmakerId) !== Number(mm.id)) {
    throw createHttpError('member already has another matchmaker', 409, 40901);
  }

  const [user, principalUser] = await Promise.all([
    memberAssignmentUserOrThrow(request.userId), memberAssignmentUserOrThrow(matchmakerUserId)
  ]);
  const snapshot = await memberAssignments.prepare(request.userId, [
    { collection: C.matchmakers, row: mm }, { collection: C.users, row: user },
    { collection: C.users, row: principalUser }, { collection: C.memberRequests, row: request }
  ]);
  const requestPatch = { status: 'approved', reviewRemark: '', reviewedAt: nowIso(), reviewerId: Number(matchmakerUserId) };
  const changed = await memberAssignments.mutate(snapshot, { matchmakerId: mm.id,
    patch: memberRow => ({ memberNo: memberRow.memberNo || defaultMemberNo(memberRow.id, memberRow.createdAt || new Date()), status: 1 }),
    create: memberId => ({
      memberNo: defaultMemberNo(memberId),
      memberType: 'free',
      serviceLevel: '',
      expireAt: null,
      remark: 'member request approved',
      status: 1
    }), updates: [{ collection: C.memberRequests, documentId: request._id, patch: requestPatch }]
  });
  const memberRow = changed.member;
  const reviewed = changed.snapshot.dependencies.find(item => item.collection === C.memberRequests).row;
  await addRow(C.messages, {
    id: await nextId('message'),
    senderId: Number(matchmakerUserId),
    receiverId: Number(request.userId),
    contentType: 'system',
    content: '主理人已通过您的添加申请。',
    isRead: 0
  });
  await ensureMemberMatchmakerConversation(memberRow, mm);
  return {
    request: await memberRequestView(reviewed),
    member: await memberView(memberRow)
  };
}

async function validateInviteEventForMatchmaker(eventId, matchmaker) {
  if (!eventId) return null;
  const event = await getById(C.salonEvents, eventId);
  if (!event) throw createHttpError('event not found', 404, 40400);
  if (Number(event.organizerId) !== Number(matchmaker.userId)) {
    throw createHttpError('event does not belong to matchmaker', 403, 40300);
  }
  return event;
}

async function acceptMemberMatchmakerInvite(userId, data = {}, options = {}) {
  const inviteUser = await memberAssignmentUserOrThrow(userId);
  if (data.eventId && ['salonShare', 'memberSalonShare'].includes(requestApplySource(data))) {
    // An activity invitation is registration, never approval of an assignment.
    const registration = await salon.register(data.eventId, userId, data);
    return { status: 'registered', registration, assignmentUnchanged: true,
      event: await salon.getEventDetail(data.eventId, userId) };
  }
  const matchmaker = await resolveMatchmakerForRequest(data);
  if (!matchmaker || Number(matchmaker.status) !== 1) {
    throw createHttpError('matchmaker not found', 404, 40400);
  }
  if (Number(matchmaker.certificationStatus) !== 2) {
    throw createHttpError('matchmaker is not certified', 403, 40301);
  }
  if (options.requireShareSource !== false && !isShareInviteSource(data)) {
    throw createHttpError('share invite source is required');
  }

  const event = await validateInviteEventForMatchmaker(data.eventId, matchmaker);
  const assignment = await activeMemberAssignment(userId);
  if (assignment && Number(assignment.matchmakerId) !== Number(matchmaker.id)) {
    throw createHttpError('member already has another matchmaker', 409, 40901);
  }

  await assertUserText(inviteUser, [data.message], 2);
  const existingRows = (await getAll(C.memberRequests, { userId: Number(userId), matchmakerId: Number(matchmaker.id) }))
    .sort((a, b) => Number(b.id || 0) - Number(a.id || 0));
  let request = existingRows.find(row => row.status === 'pending') || existingRows[0] || null;
  const settledRequests = existingRows.filter(row => row === request || row.status === 'pending');
  const requestPatch = {
    status: 'approved',
    applySource: requestApplySource(data),
    applyMessage: data.message || '',
    reviewRemark: 'member invite accepted',
    reviewedAt: nowIso(),
    reviewerId: Number(matchmaker.userId)
  };
  const principalUser = await memberAssignmentUserOrThrow(matchmaker.userId);
  const snapshot = await memberAssignments.prepare(userId, [
    { collection: C.matchmakers, row: matchmaker }, { collection: C.users, row: inviteUser },
    { collection: C.users, row: principalUser },
    ...settledRequests.map(row => ({ collection: C.memberRequests, row })),
    ...(event ? [{ collection: C.salonEvents, row: event }] : [])
  ]);
  const changed = await memberAssignments.mutate(snapshot, { matchmakerId: matchmaker.id,
    patch: memberRow => ({ memberNo: memberRow.memberNo || defaultMemberNo(memberRow.id, memberRow.createdAt || new Date()),
      memberType: memberRow.memberType || 'free', status: 1 }),
    create: memberId => ({ memberNo: defaultMemberNo(memberId), memberType: 'free', serviceLevel: '', expireAt: null,
      remark: 'member invite accepted', status: 1 }),
    updates: settledRequests.map(row => ({ collection: C.memberRequests, documentId: row._id, patch: requestPatch })) });
  const memberRow = changed.member;
  const isNewAssignment = !changed.wasActive;
  request = request
    ? changed.snapshot.dependencies.find(item => item.collection === C.memberRequests && item.row._id === request._id).row
    : await addRow(C.memberRequests, {
      id: await nextId('memberRequest'),
      userId: Number(userId),
      matchmakerId: Number(matchmaker.id),
      ...requestPatch
    });

  if (isNewAssignment) {
    await addRow(C.messages, {
      id: await nextId('message'),
      senderId: Number(matchmaker.userId),
      receiverId: Number(userId),
      contentType: 'system',
      content: '您已成为主理人名下会员。',
      isRead: 0
    });
  }
  await ensureMemberMatchmakerConversation(memberRow, matchmaker);

  return {
    status: 'approved',
    alreadyAssigned: !isNewAssignment,
    invite: await matchmakerInvitePreview(data),
    member: await memberView(memberRow),
    request: await memberRequestView(request),
    event: event ? stripInternal(event) : null
  };
}

async function rejectMemberMatchmakerRequest(matchmakerUserId, requestId, remark = '') {
  const mm = await getCertifiedMatchmakerByUserIdOrThrow(matchmakerUserId);
  const request = await getById(C.memberRequests, requestId);
  if (!request || Number(request.matchmakerId) !== Number(mm.id)) {
    throw createHttpError('request not found', 404, 40400);
  }
  if (request.status !== 'pending') throw createHttpError('request is not pending');
  await assertUserText(matchmakerUserId, [remark], 2);
  const reviewed = await updateRow(C.memberRequests, request, {
    status: 'rejected',
    reviewRemark: remark || '',
    reviewedAt: nowIso(),
    reviewerId: Number(matchmakerUserId)
  });
  await addRow(C.messages, {
    id: await nextId('message'),
    senderId: Number(matchmakerUserId),
    receiverId: Number(request.userId),
    contentType: 'system',
    content: remark ? `主理人暂未通过您的添加申请：${remark}` : '主理人暂未通过您的添加申请。',
    isRead: 0
  });
  return memberRequestView(reviewed);
}

function matchesMemberFilters(row, filters = {}) {
  if (filters.keyword) {
    const keyword = String(filters.keyword);
    const haystack = [row.nickname, row.realName, row.phone, row.city, row.occupation].join(' ');
    if (!haystack.includes(keyword)) return false;
  }
  if (filters.gender && Number(row.gender) !== Number(filters.gender)) return false;
  if (filters.memberType && row.memberType !== filters.memberType) return false;
  if (filters.serviceLevel && row.serviceLevel !== filters.serviceLevel) return false;
  if (filters.status !== undefined && filters.status !== '' && Number(row.status) !== Number(filters.status)) return false;
  if (filters.ageMin && Number(row.age || 0) < Number(filters.ageMin)) return false;
  if (filters.ageMax && Number(row.age || 0) > Number(filters.ageMax)) return false;
  const education = row.educationVerified === true && row.verifiedEducation ? row.verifiedEducation : row.education;
  if (filters.education && education !== filters.education) return false;
  if (filters.maritalStatus && row.maritalStatus !== filters.maritalStatus) return false;
  if (filters.incomeRange && row.incomeRange !== filters.incomeRange) return false;
  if (filters.city && !String(row.city || '').includes(String(filters.city))) return false;
  return true;
}

async function filteredOwnMemberViews(matchmaker, filters = {}) {
  const query = { matchmakerId: matchmaker.id };
  if (filters.memberType && filters.memberType !== 'no_consumption') query.memberType = filters.memberType;
  if (filters.serviceLevel) query.serviceLevel = filters.serviceLevel;
  let rows = await getAll(C.members, query, Infinity);
  if (filters.status === undefined || filters.status === '') rows = rows.filter(row => Number(row.status) === 1);
  const matchRecords = await getAll(C.matchRecords, { matchmakerId: matchmaker.id }, Infinity);
  const context = await memberReadContext(rows, matchRecords);
  const views = await Promise.all(rows.map(row => memberView(row, context)));
  return views.filter(row => matchesMemberFilters(row, filters)).sort((a, b) => b.id - a.id);
}

async function requireUser(token) {
  const session = tokenService.verify(token, { expectedType: TOKEN_TYPES.ACCESS });
  if (!Number.isSafeInteger(session.userId) || session.userId <= 0) {
    throw createHttpError('unauthorized', 401, 40100);
  }
  const user = await getById(C.users, session.userId);
  if (!user || Number(user.status) !== 1 || user.mergedIntoUserId) {
    throw createHttpError('登录状态已失效，请重新登录', 401, 40100);
  }
  const tokenAuthVersion = Number(session.authVersion || 1);
  const userAuthVersion = Number(user.authVersion || 1);
  if (tokenAuthVersion !== userAuthVersion) {
    throw createHttpError('登录状态已失效，请重新登录', 401, 40100);
  }
  return session;
}

function requireAdmin(token) {
  const session = tokenService.verify(token, { expectedType: TOKEN_TYPES.ADMIN });
  if (session.role !== 'admin') {
    throw createHttpError('仅管理员可访问', 403, 40303);
  }
  return session;
}

function issueUserSession(user) {
  const authVersion = Number(user.authVersion || 1);
  return {
    token: tokenService.sign(
      { userId: Number(user.id), currentRole: user.currentRole || 'user', authVersion },
      { type: TOKEN_TYPES.ACCESS }
    ),
    refreshToken: tokenService.sign(
      { userId: Number(user.id), authVersion },
      { type: TOKEN_TYPES.REFRESH }
    ),
    user: publicUser(user)
  };
}

async function uniqueActiveUser(query, conflictMessage) {
  const rows = (await getAll(C.users, query, 3)).filter(row => Number(row.status) !== 0);
  if (rows.length > 1) {
    throw createHttpError(conflictMessage || '账号数据存在重复，请联系平台人工核验', 409, 40920);
  }
  return rows[0] || null;
}

function assertWechatCallerOwnsUser(user) {
  const openid = String((cloud.getWXContext() || {}).OPENID || '').trim();
  if (!openid && process.env.ALLOW_MOCK_WECHAT_LOGIN === 'true' && /^mock_/.test(String(user.openid || ''))) {
    return String(user.openid);
  }
  if (!openid || openid !== String(user.openid || '')) {
    throw createHttpError('微信身份校验失败，请重新登录', 401, 40103);
  }
  return openid;
}

async function exchangeWechatPhone(code) {
  if (!String(code || '').trim()) throw createHttpError('手机号授权 code 不能为空');
  if (!cloud.openapi || !cloud.openapi.phonenumber || !cloud.openapi.phonenumber.getPhoneNumber) {
    throw createHttpError('当前云环境暂不支持微信手机号授权', 503, 50302);
  }
  let phoneResult;
  try {
    phoneResult = await cloud.openapi.phonenumber.getPhoneNumber({ code: String(code).trim() });
  } catch (err) {
    console.warn('wechat phone authorization failed', err);
    throw createHttpError('手机号授权已失效，请重新授权', 400, 40003);
  }
  try {
    return normalizeWechatPhoneResult(phoneResult);
  } catch (err) {
    throw createHttpError(err.message || '未获取到有效手机号', 400, 40003);
  }
}

function identityClaimDocumentId(memberId) {
  return `member_${Number(memberId)}`;
}

async function getIdentityClaimDocument(memberId) {
  try {
    const snapshot = await db.collection(C.identityClaims).doc(identityClaimDocumentId(memberId)).get();
    return snapshot && snapshot.data ? { ...snapshot.data, _id: identityClaimDocumentId(memberId) } : null;
  } catch (err) {
    if (isMissingCollectionError(err) || /DOCUMENT_NOT_EXIST|document not exist|not found/i.test(String(err && (err.errMsg || err.message)))) {
      return null;
    }
    throw err;
  }
}

function assertUsableIdentityClaim(token, claim) {
  if (!claim || !claimTokenMatches(token, claim.tokenHash)) {
    throw createHttpError('认领邀请无效，请联系主理人重新发送', 410, 41020);
  }
  if (String(claim.status) !== 'pending') {
    throw createHttpError('该认领邀请已使用，请勿重复提交', 409, 40921);
  }
  if (isClaimExpired(claim.expiresAt)) {
    throw createHttpError('认领邀请已过期，请联系主理人重新发送', 410, 41021);
  }
}

async function identityClaimContext(token) {
  const parsed = parseClaimToken(token);
  if (!parsed) throw createHttpError('认领邀请无效，请联系主理人重新发送', 410, 41020);
  const claim = await getIdentityClaimDocument(parsed.memberId);
  if (claim && String(claim.status) === 'claimed' && claimTokenMatches(token, claim.tokenHash)) {
    return { parsed, claim, claimed: true };
  }
  assertUsableIdentityClaim(token, claim);
  const memberRow = await getById(C.members, parsed.memberId);
  if (!memberRow || Number(memberRow.status) !== 1 || Number(memberRow.userId) !== Number(claim.targetUserId)) {
    throw createHttpError('待认领会员档案不存在', 404, 40420);
  }
  const targetUser = await getById(C.users, memberRow.userId);
  if (!targetUser || Number(targetUser.status) !== 1 || !isManualIdentity(targetUser.openid)) {
    throw createHttpError('该会员档案已完成认领或状态已变更', 409, 40921);
  }
  const matchmakerRow = await getById(C.matchmakers, memberRow.matchmakerId);
  if (!matchmakerRow || Number(matchmakerRow.status) !== 1 || Number(matchmakerRow.id) !== Number(claim.matchmakerId)) {
    throw createHttpError('主理人服务关系已变更，请重新生成邀请', 409, 40922);
  }
  return { parsed, claim, memberRow, targetUser, matchmakerRow, claimed: false };
}

async function identityClaimPreview(token) {
  const context = await identityClaimContext(token);
  if (context.claimed) {
    return { status: 'claimed', title: '该档案已完成认领' };
  }
  const profile = await getOne(C.profiles, { userId: Number(context.targetUser.id) }) || {};
  const matchmakerUser = await getById(C.users, context.matchmakerRow.userId);
  return {
    status: 'pending',
    member: {
      nameMasked: maskName(profile.realName || context.targetUser.nickname),
      memberNoMasked: maskMemberNo(context.memberRow.memberNo || defaultMemberNo(context.memberRow.id, context.memberRow.createdAt || new Date())),
      phoneMasked: maskPhone(context.targetUser.phone)
    },
    matchmaker: {
      nickname: (matchmakerUser && matchmakerUser.nickname) || '主理人',
      matchmakerNo: context.matchmakerRow.matchmakerNo || defaultMatchmakerNo(context.matchmakerRow.id)
    },
    expiresAt: context.claim.expiresAt
  };
}

async function sourceAccountConflictReasons(sourceUserId) {
  const sourceId = Number(sourceUserId);
  const [
    matchmakers,
    members,
    memberRequests,
    matchRecordsA,
    matchRecordsB,
    sentMessages,
    receivedMessages,
    chatMessages,
    interactionsFrom,
    interactionsTo,
    giftsFrom,
    giftsReceived,
    giftsTargeted,
    registrations,
    paymentOrders,
    salonEvents,
    conversations,
    vipEntitlements,
    matchmakingPackages,
    matchmakingRequests,
    wechatExchanges
  ] = await Promise.all([
    getAll(C.matchmakers, { userId: sourceId }, 1),
    getAll(C.members, { userId: sourceId, status: 1 }, 1),
    getAll(C.memberRequests, { userId: sourceId }, 1),
    getAll(C.matchRecords, { userAId: sourceId }, 1),
    getAll(C.matchRecords, { userBId: sourceId }, 1),
    getAll(C.messages, { senderId: sourceId }, 1),
    getAll(C.messages, { receiverId: sourceId }, 1),
    getAll(C.chatMessages, { senderId: sourceId }, 1),
    getAll(C.memberInteractions, { userId: sourceId }, 1),
    getAll(C.memberInteractions, { targetUserId: sourceId }, 1),
    getAll(C.giftRecords, { senderId: sourceId }, 1),
    getAll(C.giftRecords, { receiverId: sourceId }, 1),
    getAll(C.giftRecords, { targetUserId: sourceId }, 1),
    getAll(C.registrations, { userId: sourceId }, 1),
    getAll(C.paymentOrders, { userId: sourceId }, 1),
    getAll(C.salonEvents, { organizerId: sourceId }, 1),
    getAll(C.conversations, null, 2000),
    getAll(VIP_COLLECTIONS.entitlements, { userId: sourceId }, 1),
    getAll(VIP_COLLECTIONS.matchmakingPackages, { userId: sourceId }, 1),
    getAll(VIP_COLLECTIONS.matchmakingRequests, _.or([{ memberUserId: sourceId }, { targetUserId: sourceId }]), 1),
    getAll(VIP_COLLECTIONS.wechatExchanges, _.or([{ requesterId: sourceId }, { recipientId: sourceId }]), 1)
  ]);
  const conversationConflict = conversations.some(row => (
    Array.isArray(row.participantIds) && row.participantIds.some(id => Number(id) === sourceId)
  ));
  const groups = [
    matchmakers,
    members,
    memberRequests,
    matchRecordsA,
    matchRecordsB,
    sentMessages,
    receivedMessages,
    chatMessages,
    interactionsFrom,
    interactionsTo,
    giftsFrom,
    giftsReceived,
    giftsTargeted,
    registrations,
    paymentOrders,
    salonEvents,
    vipEntitlements,
    matchmakingPackages,
    matchmakingRequests,
    wechatExchanges
  ];
  return groups.some(rows => rows.length > 0) || conversationConflict
    ? ['independent_business_data']
    : [];
}

async function createMemberIdentityClaimInvite(matchmakerUserId, memberId) {
  const matchmakerRow = await getCertifiedMatchmakerByUserIdOrThrow(matchmakerUserId);
  const matchmakerUser = await getUserOrThrow(matchmakerRow.userId);
  const memberRow = await getById(C.members, memberId);
  if (!memberRow || Number(memberRow.status) !== 1 || Number(memberRow.matchmakerId) !== Number(matchmakerRow.id)) {
    throw createHttpError('member not found', 404, 40400);
  }
  const targetUser = await getById(C.users, memberRow.userId);
  if (!targetUser || Number(targetUser.status) !== 1) throw createHttpError('member not found', 404, 40400);
  const token = createClaimToken(memberRow.id);
  const claimInviteVersion = hashClaimToken(token);
  const timestamp = nowIso();
  const expiresAt = claimExpiresAt(Date.now());
  const targetPhone = String(targetUser.phone || '').trim();
  const phoneOwnerRows = targetPhone ? await getAll(C.users, { phone: targetPhone }, 3) : [];
  const result = await db.runTransaction(async transaction => {
    const matchmakerRef = transaction.collection(C.matchmakers).doc(matchmakerRow._id);
    const memberRef = transaction.collection(C.members).doc(memberRow._id);
    const targetRef = transaction.collection(C.users).doc(targetUser._id);
    const claimRef = transaction.collection(C.identityClaims).doc(identityClaimDocumentId(memberRow.id));
    const snapshots = await Promise.all([
      matchmakerRef.get(),
      memberRef.get(),
      targetRef.get(),
      salonTransactionDocument(transaction, C.identityClaims, identityClaimDocumentId(memberRow.id)),
      Promise.all(phoneOwnerRows.map(row => salonTransactionDocument(transaction, C.users, row._id))),
      salonTransactionDocument(transaction, C.users, matchmakerUser._id)
    ]);
    const currentMatchmaker = snapshots[0] && snapshots[0].data;
    const currentMember = snapshots[1] && snapshots[1].data;
    const currentTarget = snapshots[2] && snapshots[2].data;
    const currentClaim = snapshots[3];
    const currentMatchmakerUser = snapshots[5];

    if (
      !currentMatchmaker
      || Number(currentMatchmaker.id) !== Number(matchmakerRow.id)
      || Number(currentMatchmaker.userId) !== Number(matchmakerUserId)
      || Number(currentMatchmaker.status) !== 1
      || Number(currentMatchmaker.certificationStatus) !== 2
      || !currentMatchmakerUser
      || Number(currentMatchmakerUser.id) !== Number(currentMatchmaker.userId)
      || Number(currentMatchmakerUser.status) !== 1
      || currentMatchmakerUser.mergedIntoUserId
      || !currentMember
      || Number(currentMember.id) !== Number(memberRow.id)
      || Number(currentMember.status) !== 1
      || Number(currentMember.matchmakerId) !== Number(currentMatchmaker.id)
      || Number(currentMember.userId) !== Number(targetUser.id)
      || !currentTarget
      || Number(currentTarget.id) !== Number(targetUser.id)
      || Number(currentTarget.status) !== 1
      || currentTarget.mergedIntoUserId
    ) {
      throw createHttpError('会员或主理人状态已变化，请重新生成邀请', 409, 40922);
    }
    if (!isManualIdentity(currentTarget.openid)) {
      return { status: 'claimed', identityStatusText: '已绑定微信' };
    }
    if (currentClaim && String(currentClaim.status) === 'claimed') {
      return { status: 'claimed', identityStatusText: '已绑定微信' };
    }

    if (!targetPhone || String(currentTarget.phone || '').trim() !== targetPhone) {
      throw createHttpError('该会员尚未留存手机号，请补录后再生成认领邀请', 422, 42220);
    }
    const phoneOwners = snapshots[4].filter(row => row && Number(row.status) !== 0 && String(row.phone || '') === targetPhone);
    if (phoneOwners.length !== 1 || Number(phoneOwners[0].id) !== Number(currentTarget.id)) {
      throw createHttpError('会员手机号归属异常，请联系平台人工核验', 409, 40920);
    }

    const memberNo = currentMember.memberNo
      || defaultMemberNo(currentMember.id, currentMember.createdAt || new Date());
    if (!currentMember.memberNo) {
      await memberRef.update({ data: { memberNo, updatedAt: timestamp } });
    }
    await targetRef.update({ data: { claimInviteVersion, updatedAt: timestamp } });
    const claim = {
      memberId: Number(currentMember.id),
      memberNo,
      matchmakerId: Number(currentMatchmaker.id),
      createdByUserId: Number(matchmakerUserId),
      targetUserId: Number(currentTarget.id),
      tokenHash: hashClaimToken(token),
      claimInviteVersion,
      status: 'pending',
      expiresAt,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    await claimRef.set({ data: claim });
    return {
      status: 'pending',
      memberNo,
      targetName: currentTarget.nickname,
      targetPhone
    };
  });
  if (result.status === 'claimed') return result;
  return {
    status: 'pending',
    sharePath: `/pages/user/member-claim?token=${encodeURIComponent(token)}`,
    expiresAt,
    member: {
      nameMasked: maskName(result.targetName),
      memberNoMasked: maskMemberNo(result.memberNo),
      phoneMasked: maskPhone(result.targetPhone)
    }
  };
}

const CLAIM_PROFILE_FIELDS = [
  'realName', 'age', 'height', 'education', 'occupation', 'incomeRange', 'province', 'city',
  'nativePlace', 'maritalStatus', 'houseStatus', 'carStatus', 'selfIntro', 'partnerRequirement', 'photos'
];

async function confirmMemberIdentityClaim(sourceUserId, token, phoneCode) {
  const sourceUser = await getUserOrThrow(sourceUserId);
  const trustedOpenid = assertWechatCallerOwnsUser(sourceUser);
  if (isManualIdentity(sourceUser.openid)) {
    throw createHttpError('当前账号无需认领手工档案', 409, 40923);
  }
  const context = await identityClaimContext(token);
  if (context.claimed) {
    if (Number(context.claim.canonicalUserId) === Number(sourceUser.id)) {
      return {
        ...issueUserSession(sourceUser),
        claimStatus: 'claimed',
        idempotent: true
      };
    }
    if (Number(context.claim.claimedBySourceUserId) === Number(sourceUser.id)) {
      const canonicalUser = await getById(C.users, context.claim.canonicalUserId);
      if (
        canonicalUser
        && Number(canonicalUser.status) === 1
        && String(canonicalUser.openid || '') === trustedOpenid
      ) {
        return {
          ...issueUserSession(canonicalUser),
          claimStatus: 'claimed',
          idempotent: true
        };
      }
    }
    throw createHttpError('该档案已由其他微信账号认领', 409, 40921);
  }
  if (Number(context.targetUser.id) === Number(sourceUser.id)) return issueUserSession(sourceUser);
  const phone = await exchangeWechatPhone(phoneCode);
  if (String(context.targetUser.phone || '') !== phone) {
    throw createHttpError('微信手机号与主理人留存手机号不一致，请联系主理人核对', 409, 40924);
  }
  if (sourceUser.phone && String(sourceUser.phone) !== phone) {
    throw createHttpError('当前微信账号已绑定其他手机号，请联系主理人进行人工合并', 409, 40925);
  }
  const phoneOwner = await uniqueActiveUser(
    { phone },
    '该手机号对应多条档案，请联系平台人工核验'
  );
  if (!phoneOwner || Number(phoneOwner.id) !== Number(context.targetUser.id)) {
    throw createHttpError('手机号归属异常，请联系平台人工核验', 409, 40920);
  }
  const conflictReasons = await sourceAccountConflictReasons(sourceUser.id);
  if (conflictReasons.length) {
    throw createHttpError('当前微信账号已有独立业务记录，请联系主理人进行人工合并', 409, 40925);
  }

  const [sourceProfile, targetProfile, phoneOwnerRows, openidOwnerRows, matchmakerUser] = await Promise.all([
    getOne(C.profiles, { userId: Number(sourceUser.id) }),
    getOne(C.profiles, { userId: Number(context.targetUser.id) }),
    getAll(C.users, { phone }, 3),
    getAll(C.users, { openid: trustedOpenid }, 3),
    getUserOrThrow(context.matchmakerRow.userId)
  ]);
  if (!targetProfile || !targetProfile._id) {
    throw createHttpError('手工会员档案不完整，请联系主理人核验', 409, 40926);
  }
  const timestamp = nowIso();
  const result = await db.runTransaction(async transaction => {
    const claimRef = transaction.collection(C.identityClaims).doc(identityClaimDocumentId(context.memberRow.id));
    const memberRef = transaction.collection(C.members).doc(context.memberRow._id);
    const matchmakerRef = transaction.collection(C.matchmakers).doc(context.matchmakerRow._id);
    const sourceRef = transaction.collection(C.users).doc(sourceUser._id);
    const targetRef = transaction.collection(C.users).doc(context.targetUser._id);
    const targetProfileRef = transaction.collection(C.profiles).doc(targetProfile._id);
    const sourceProfileRef = sourceProfile && sourceProfile._id
      ? transaction.collection(C.profiles).doc(sourceProfile._id)
      : null;
    const snapshots = await Promise.all([
      claimRef.get(),
      memberRef.get(),
      matchmakerRef.get(),
      sourceRef.get(),
      targetRef.get(),
      targetProfileRef.get(),
      sourceProfileRef ? sourceProfileRef.get() : Promise.resolve(null),
      Promise.all(phoneOwnerRows.map(row => salonTransactionDocument(transaction, C.users, row._id))),
      Promise.all(openidOwnerRows.map(row => salonTransactionDocument(transaction, C.users, row._id))),
      salonTransactionDocument(transaction, C.users, matchmakerUser._id)
    ]);
    const currentClaim = snapshots[0] && snapshots[0].data;
    const currentMember = snapshots[1] && snapshots[1].data;
    const currentMatchmaker = snapshots[2] && snapshots[2].data;
    const currentSource = snapshots[3] && snapshots[3].data;
    const currentTarget = snapshots[4] && snapshots[4].data;
    const currentTargetProfile = snapshots[5] && snapshots[5].data;
    const currentSourceProfile = snapshots[6] && snapshots[6].data;
    const currentPhoneOwners = snapshots[7]
      .filter(row => row && Number(row.status) !== 0 && String(row.phone || '') === phone);
    const currentOpenidOwners = snapshots[8]
      .filter(row => row && Number(row.status) !== 0 && String(row.openid || '') === trustedOpenid);
    const currentMatchmakerUser = snapshots[9];

    if (currentClaim && String(currentClaim.status) === 'claimed') {
      if (Number(currentClaim.claimedBySourceUserId) !== Number(sourceUser.id)
        || !currentTarget || Number(currentTarget.status) !== 1 || currentTarget.mergedIntoUserId
        || Number(currentClaim.canonicalUserId) !== Number(currentTarget.id)
        || String(currentTarget.openid || '') !== trustedOpenid) {
        throw createHttpError('该档案已由其他微信账号认领', 409, 40921);
      }
      return { canonicalUser: currentTarget, idempotent: true };
    }
    assertUsableIdentityClaim(token, currentClaim);
    if (
      !currentSource
      || !currentTarget
      || !currentTargetProfile
      || !currentMember
      || !currentMatchmaker
      || Number(currentSource.id) !== Number(sourceUser.id)
      || Number(currentTarget.id) !== Number(context.targetUser.id)
      || Number(currentMember.id) !== Number(context.memberRow.id)
      || Number(currentMember.status) !== 1
      || Number(currentMember.userId) !== Number(currentTarget.id)
      || Number(currentMember.matchmakerId) !== Number(currentMatchmaker.id)
      || Number(currentMatchmaker.id) !== Number(context.matchmakerRow.id)
      || Number(currentMatchmaker.status) !== 1
      || Number(currentMatchmaker.certificationStatus) !== 2
      || !currentMatchmakerUser
      || Number(currentMatchmakerUser.id) !== Number(currentMatchmaker.userId)
      || Number(currentMatchmakerUser.status) !== 1
      || currentMatchmakerUser.mergedIntoUserId
      || Number(currentClaim.matchmakerId) !== Number(currentMatchmaker.id)
      || Number(currentClaim.targetUserId) !== Number(currentTarget.id)
      || Number(currentClaim.memberId) !== Number(context.memberRow.id)
      || !currentClaim.claimInviteVersion
      || String(currentTarget.claimInviteVersion || '') !== String(currentClaim.claimInviteVersion)
      || Number(currentSource.status) !== 1
      || Number(currentTarget.status) !== 1
      || currentSource.mergedIntoUserId
      || currentTarget.mergedIntoUserId
      || String(currentSource.openid || '') !== trustedOpenid
      || (currentSource.phone && String(currentSource.phone) !== phone)
      || !isManualIdentity(currentTarget.openid)
      || String(currentTarget.phone || '') !== phone
      || currentPhoneOwners.length !== 1
      || Number(currentPhoneOwners[0].id) !== Number(currentTarget.id)
      || currentOpenidOwners.length !== 1
      || Number(currentOpenidOwners[0].id) !== Number(currentSource.id)
    ) {
      throw createHttpError('账号状态已变化，请重新发起认领', 409, 40927);
    }
    const targetAuthVersion = Number(currentTarget.authVersion || 1) + 1;
    const sourceAuthVersion = Number(currentSource.authVersion || 1) + 1;
    const targetPatch = {
      openid: trustedOpenid,
      phone,
      nickname: currentTarget.nickname || currentSource.nickname || `会员${currentTarget.id}`,
      avatarUrl: currentTarget.avatarUrl || currentSource.avatarUrl || '',
      gender: Number(currentTarget.gender || currentSource.gender || 0),
      currentRole: 'user',
      isVerified: 1,
      identitySource: 'manual_claimed',
      identityStatus: 'claimed',
      claimInviteVersion: '',
      claimedFromUserId: Number(currentSource.id),
      claimedAt: timestamp,
      authVersion: targetAuthVersion,
      updatedAt: timestamp
    };
    const sourcePatch = {
      openid: archivedMergedOpenid(currentSource.id, trustedOpenid),
      phone: '',
      status: 0,
      identityStatus: 'merged',
      mergedIntoUserId: Number(currentTarget.id),
      mergedAt: timestamp,
      authVersion: sourceAuthVersion,
      updatedAt: timestamp
    };
    const profilePatch = {
      ...fillTargetProfileBlanks(currentTargetProfile, currentSourceProfile || {}, CLAIM_PROFILE_FIELDS),
      updatedAt: timestamp
    };
    const claimedPatch = {
      status: 'claimed',
      claimedBySourceUserId: Number(currentSource.id),
      canonicalUserId: Number(currentTarget.id),
      claimedAt: timestamp,
      updatedAt: timestamp
    };
    await targetRef.update({ data: targetPatch });
    await sourceRef.update({ data: sourcePatch });
    await targetProfileRef.update({ data: profilePatch });
    if (sourceProfileRef) {
      await sourceProfileRef.update({
        data: {
          displayEnabled: false,
          mergedIntoUserId: Number(currentTarget.id),
          mergedAt: timestamp,
          updatedAt: timestamp
        }
      });
    }
    await claimRef.update({ data: claimedPatch });
    return { canonicalUser: { ...currentTarget, ...targetPatch }, idempotent: false };
  });
  return {
    ...issueUserSession(result.canonicalUser),
    claimStatus: 'claimed',
    idempotent: result.idempotent
  };
}

async function withMemberDistances(page, userId) {
  const ids = [Number(userId), ...(page.list || []).map(row => Number(row.userId))];
  const profiles = await getFirstRowsByNumericField(C.profiles, 'userId', ids, [], {
    complete: true, fields: { userId: true, privateLocation: true }
  });
  const own = profiles.get(Number(userId))?.privateLocation;
  return { ...page, list: (page.list || []).map(row => ({ ...row,
    distanceText: memberDistanceText(own, profiles.get(Number(row.userId))?.privateLocation) })) };
}

const memberRelationships = createMemberRelationshipService({ collections: C, command: _, getAll, getOne, getById,
  addRow, updateRow, nextId, nowIso, createHttpError, upsertMemberInteraction, activeInteraction,
  areMutualFavorites, resolveMemberPairChatAccess });

async function saveOwnProfileFields(userId, patch) {
  const profile = await getOne(C.profiles, { userId: Number(userId) });
  return profile ? updateRow(C.profiles, profile, patch) : addRow(C.profiles, {
    id: await nextId('profile'), userId: Number(userId), displayEnabled: false, ...patch
  });
}

const auth = {
  async wxLogin(payload = {}) {
    const wxContext = cloud.getWXContext();
    const { code, nickname, avatarUrl, role, inviteCode } = payload;
    let openid;
    try {
      openid = resolveWechatOpenid({
        wxContext,
        payload: { code },
        allowMockLogin: process.env.ALLOW_MOCK_WECHAT_LOGIN === 'true'
      });
    } catch (err) {
      throw createHttpError('微信登录上下文缺失，请通过小程序云环境重试', 401, 40103);
    }
    await assertUserText({ openid }, [nickname]);
    const checkedAvatar = avatarUrl ? (await contentSecurity.assertImages({ images: [avatarUrl] }))[0] : '';
    let user = await uniqueActiveUser({ openid }, '同一微信身份存在重复账号，请联系平台处理');

    if (!user) {
      const id = await nextId('user');
      user = await addRow(C.users, {
        id,
        openid,
        phone: '',
        nickname: nickname || `用户${String(id).padStart(4, '0')}`,
        avatarUrl: checkedAvatar,
        gender: 0,
        currentRole: role === 'matchmaker' ? 'matchmaker' : 'user',
        isVerified: 0,
        authVersion: 1,
        identitySource: 'wechat',
        identityStatus: 'active',
        status: 1
      });
    } else {
      const patch = {
        currentRole: role === 'matchmaker' ? 'matchmaker' : user.currentRole || 'user'
      };
      if (registrationName({ nickname })) patch.nickname = String(nickname).trim();
      if (checkedAvatar) patch.avatarUrl = checkedAvatar;
      user = await updateRow(C.users, user, patch);
    }

    if (inviteCode) {
      try {
        await createMemberMatchmakerRequest(user.id, { inviteCode, source: 'share' });
      } catch (err) {
        console.warn('login invite request failed', err);
      }
    }

    return issueUserSession(user);
  },

  async bindWechatPhone(userId, code) {
    const user = await getUserOrThrow(userId);
    assertWechatCallerOwnsUser(user);
    const phone = await exchangeWechatPhone(code);
    const existing = await uniqueActiveUser({ phone }, '该手机号对应多条账号，请联系平台人工核验');
    if (existing && Number(existing.id) !== Number(user.id)) {
      if (isManualIdentity(existing.openid)) {
        throw createHttpError('该手机号已有主理人建档，请从主理人发送的认领邀请进入', 409, 40929);
      }
      throw createHttpError('该手机号已绑定其他账号', 400, 40002);
    }
    const updated = await updateRow(C.users, user, { phone, phoneSource: 'wechat' });
    return publicUser(updated);
  },

  async previewMemberIdentityClaim(token) {
    return identityClaimPreview(token);
  },

  async confirmMemberIdentityClaim(userId, token, code) {
    return confirmMemberIdentityClaim(userId, token, code);
  }
};

function paymentOrderNo(id, timestamp = Date.now()) {
  const date = new Date(timestamp);
  const datePart = [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0')
  ].join('');
  return `HLM${datePart}${String(Number(id)).padStart(10, '0')}`;
}

function assertPaymentCallbackToken(value) {
  const configured = String(process.env.PAYMENT_CALLBACK_TOKEN || '').trim();
  if (configured.length < 32) throw createHttpError('支付回调尚未安全配置', 503, 50301);
  const supplied = String(value || '');
  const expectedBuffer = Buffer.from(configured);
  const suppliedBuffer = Buffer.from(supplied);
  if (expectedBuffer.length !== suppliedBuffer.length || !crypto.timingSafeEqual(expectedBuffer, suppliedBuffer)) {
    throw createHttpError('支付内部调用鉴权失败', 403, 40304);
  }
}

function publicPaymentOrder(row) {
  const safe = stripInternal(row) || {};
  delete safe.payerOpenid;
  delete safe.memberRecordId;
  delete safe.memberMatchmakerId;
  delete safe.virtualPaymentAttempts;
  delete safe.cancellationProof;
  delete safe.paymentTestPlanCode;
  delete safe.paymentTestRunId;
  delete safe.userDocumentId;
  delete safe.matchmakerDocumentId;
  delete safe.matchmakerAuthorizationSnapshot;
  safe.fulfillmentStatus = safe.fulfillmentStatus || (safe.status === 'paid' ? 'fulfilled' : '');
  safe.fulfillmentMessage = safe.fulfillmentMessage || '';
  return safe;
}

// Member-facing history is separate from payment recovery and never mutates
// orders, probes, reservations, entitlements, or provider state.
const MEMBER_ORDER_STATUSES = ['pending', 'confirming', 'paid', 'closed', 'failed', 'refunded'];
const MEMBER_ORDER_FLAGS = ['isTest', 'isDemo', 'testMode', 'isGuard', 'isProbe', 'isSandbox', 'paymentGuard', 'guard'];
const MEMBER_ORDER_SOURCES = ['source', 'dataSource', 'origin', 'recordType', 'kind'];
const MEMBER_ORDER_TEST_MARKERS = ['test', 'demo', 'seed', 'sandbox', 'probe', 'mock', 'guard'];
const MEMBER_ORDER_FIELDS = Object.fromEntries([
  '_id', 'id', 'userId', 'outTradeNo', 'planCode', 'planTitle', 'amountFen', 'durationDays', 'status',
  'fulfillmentStatus', 'fulfillmentMessage', 'createdAt', 'updatedAt', 'paidAt', 'productType', 'serviceCount',
  'paymentProvider', 'refundedAt', 'transactionId', 'virtualPaymentEnv', 'paymentTestPlanCode', 'paymentTestRunId', 'lifetime',
  'probeArchivedAt', 'cancelledAt', 'cancelReason', ...MEMBER_ORDER_FLAGS, ...MEMBER_ORDER_SOURCES
].map(field => [field, true]));

function memberOrderUnavailable() {
  return createHttpError('订单不存在或暂不可查看', 404, 40400);
}

async function memberOrderRead(query, { fields = MEMBER_ORDER_FIELDS, offset = 0, limit = 20, count = false, ordered = false } = {}) {
  // Deliberately bypass helpers that may create a missing collection on error.
  try {
    let ref = db.collection(C.paymentOrders).where(query);
    if (count) return await ref.count();
    ref = ref.field(fields);
    if (ordered) ref = ref.orderBy('createdAt', 'desc').orderBy('outTradeNo', 'desc').orderBy('_id', 'desc');
    return await ref.skip(offset).limit(limit).get();
  } catch (_) {
    throw createHttpError('订单暂不可读取，请稍后重试', 503, 50301);
  }
}

function memberOrderQuery(userId, outTradeNo) {
  const markerValues = MEMBER_ORDER_TEST_MARKERS.flatMap(value => [value, value.toUpperCase(), value[0].toUpperCase() + value.slice(1)]);
  const query = {
    userId: _.in([Number(userId), String(Number(userId))]), id: _.gt(0), amountFen: _.gt(0),
    status: _.in(MEMBER_ORDER_STATUSES),
    outTradeNo: outTradeNo || db.RegExp({ regexp: '^(?!.*(?:guard|probe|sandbox|test))[a-z0-9][a-z0-9_-]{7,31}$', options: 'i' }),
    planCode: db.RegExp({ regexp: '^(?!hl_payment_probe$)[a-z0-9][a-z0-9_-]{1,31}$' }),
    planTitle: db.RegExp({ regexp: '\\S' }),
    _id: db.RegExp({ regexp: '^(?!.*(?:guard|probe|sandbox)).+$', options: 'i' }),
    paymentTestPlanCode: _.exists(false), paymentTestRunId: _.exists(false), probeArchivedAt: _.exists(false),
    virtualPaymentEnv: _.nin([1, '1']),
    ...Object.fromEntries(MEMBER_ORDER_FLAGS.map(field => [field, _.nin([true, 1, 'true', 'TRUE', '1'])])),
    ...Object.fromEntries(MEMBER_ORDER_SOURCES.map(field => [field, _.nin(markerValues)]))
  };
  return _.and([query,
    _.or([{ paymentProvider: _.exists(false) }, { paymentProvider: _.in(['jsapi', 'virtual']) }]),
    _.or([{ durationDays: _.gt(0), productType: _.exists(false) },
      { durationDays: _.gt(0), productType: _.in(['vip', 'matchmaking']) },
      { durationDays: 0, productType: 'matchmaker', lifetime: true, planCode: MATCHMAKER_LIFETIME_PLAN.planCode, amountFen: MATCHMAKER_LIFETIME_PLAN.amountFen }]),
    _.or([{ fulfillmentStatus: _.exists(false) }, { fulfillmentStatus: _.in(['', 'fulfilled', 'requires_review']) }])
  ]);
}

function memberOrderDto(row, userId) {
  const validDate = value => typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));
  const lifetimeActivation = row && row.productType === 'matchmaker' && row.planCode === MATCHMAKER_LIFETIME_PLAN.planCode
    && row.amountFen === MATCHMAKER_LIFETIME_PLAN.amountFen && row.durationDays === 0 && row.lifetime === true && row.serviceCount === 0;
  if (!row || Number(row.userId) !== Number(userId) || !Number.isSafeInteger(row.id) || row.id <= 0
    || typeof row.outTradeNo !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{7,31}$/.test(row.outTradeNo)
    || /guard|probe|sandbox|test/i.test(row.outTradeNo) || /guard|probe|sandbox/i.test(String(row._id || ''))
    || !Number.isSafeInteger(row.amountFen) || row.amountFen <= 0
    || !Number.isSafeInteger(row.durationDays) || (!lifetimeActivation && row.durationDays <= 0)
    || !MEMBER_ORDER_STATUSES.includes(row.status)
    || typeof row.planCode !== 'string' || !/^[a-z0-9][a-z0-9_-]{1,31}$/.test(row.planCode)
    || row.planCode === 'hl_payment_probe' || typeof row.planTitle !== 'string' || !row.planTitle.trim()
    || !validDate(row.createdAt)
    || ['paymentTestPlanCode', 'paymentTestRunId', 'probeArchivedAt'].some(field => Object.prototype.hasOwnProperty.call(row, field))
    || Number(row.virtualPaymentEnv) === 1
    || MEMBER_ORDER_FLAGS.some(field => [true, 1, 'true', 'TRUE', '1'].includes(row[field]))
    || MEMBER_ORDER_SOURCES.some(field => MEMBER_ORDER_TEST_MARKERS.includes(String(row[field] || '').toLowerCase()))) {
    throw memberOrderUnavailable();
  }
  const paymentProvider = row.paymentProvider === undefined ? 'jsapi' : row.paymentProvider;
  const productType = row.productType === undefined ? 'vip' : row.productType;
  const fulfillmentStatus = row.fulfillmentStatus || '';
  const serviceCount = row.serviceCount === undefined && productType === 'vip' ? 0 : row.serviceCount;
  if (!['jsapi', 'virtual'].includes(paymentProvider) || !['vip', 'matchmaking', 'matchmaker'].includes(productType)
    || (productType === 'matchmaker' && (!lifetimeActivation || paymentProvider !== 'virtual'))
    || !['', 'fulfilled', 'requires_review'].includes(fulfillmentStatus)
    || !Number.isSafeInteger(serviceCount) || serviceCount < 0 || (productType === 'matchmaking' && serviceCount <= 0)
    || (row.updatedAt !== undefined && !validDate(row.updatedAt))
    || (row.paidAt !== undefined && row.paidAt !== null && row.paidAt !== '' && !validDate(row.paidAt))
    || (row.refundedAt !== undefined && row.refundedAt !== null && row.refundedAt !== '' && !validDate(row.refundedAt))
    || (row.transactionId !== undefined && row.transactionId !== ''
      && (typeof row.transactionId !== 'string' || !/^[a-zA-Z0-9_-]{8,64}$/.test(row.transactionId)))) {
    throw memberOrderUnavailable();
  }
  return {
    outTradeNo: row.outTradeNo, planCode: row.planCode, planTitle: row.planTitle,
    amountFen: row.amountFen, durationDays: row.durationDays, status: row.status,
    fulfillmentStatus, fulfillmentMessage: typeof row.fulfillmentMessage === 'string' ? row.fulfillmentMessage : '',
    createdAt: row.createdAt, updatedAt: row.updatedAt || row.createdAt, paidAt: row.paidAt || null,
    productType, serviceCount, paymentProvider, ...(lifetimeActivation ? { lifetime: true } : {}),
    ...(row.refundedAt ? { refundedAt: row.refundedAt } : {}),
    ...(row.transactionId ? { transactionId: row.transactionId } : {}),
    ...(validDate(row.cancelledAt) && row.cancelReason === 'user_requested'
      ? { cancelledAt: row.cancelledAt, cancelReason: row.cancelReason } : {})
  };
}

const memberOrders = {
  async authorize(token) {
    const session = tokenService.verify(token, { expectedType: TOKEN_TYPES.ACCESS });
    if (!Number.isSafeInteger(session.userId) || session.userId <= 0) throw createHttpError('登录状态已失效，请重新登录', 401, 40100);
    let users;
    try {
      users = await db.collection(C.users).where({ id: session.userId })
        .field({ id: true, status: true, authVersion: true, mergedIntoUserId: true }).limit(2).get();
    } catch (_) { throw createHttpError('订单暂不可读取，请稍后重试', 503, 50301); }
    const user = users.data?.length === 1 ? users.data[0] : null;
    if (!user || Number(user.status) !== 1 || user.mergedIntoUserId
      || Number(session.authVersion || 1) !== Number(user.authVersion || 1)) {
      throw createHttpError('登录状态已失效，请重新登录', 401, 40100);
    }
    return session.userId;
  },

  async list(userId, data = {}) {
    const page = data.page === undefined ? 1 : Number(data.page);
    const requestedSize = data.pageSize === undefined ? 20 : Number(data.pageSize);
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(requestedSize) || requestedSize < 1) {
      throw createHttpError('订单分页参数无效', 400, 40001);
    }
    const pageSize = Math.min(requestedSize, 50), offset = (page - 1) * pageSize;
    if (!Number.isSafeInteger(offset)) throw createHttpError('订单分页参数无效', 400, 40001);
    const query = memberOrderQuery(userId);
    const [count, result] = await Promise.all([
      memberOrderRead(query, { count: true }), memberOrderRead(query, { offset, limit: pageSize, ordered: true })
    ]);
    const total = Number(count.total);
    if (!Number.isSafeInteger(total) || total < 0 || !Array.isArray(result.data)) throw memberOrderUnavailable();
    return { list: result.data.map(row => memberOrderDto(row, userId)), page, pageSize, total,
      hasMore: offset + result.data.length < total };
  },

  async detail(userId, outTradeNo) {
    if (typeof outTradeNo !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{7,31}$/.test(outTradeNo)) throw memberOrderUnavailable();
    const owned = await memberOrderRead(memberOrderQuery(userId, outTradeNo), { limit: 2 });
    if (!Array.isArray(owned.data) || owned.data.length !== 1) throw memberOrderUnavailable();
    const dto = memberOrderDto(owned.data[0], userId);
    // Only after finding the caller's eligible order, check number uniqueness
    // without reading any other payer's financial or identity fields.
    const matching = await memberOrderRead({ outTradeNo }, { fields: { _id: true }, limit: 2 });
    if (!Array.isArray(matching.data) || matching.data.length !== 1) throw memberOrderUnavailable();
    return dto;
  }
};

function unresolvedPaymentOrder(order) {
  return !!order && (['pending', 'confirming'].includes(order.status)
    || (order.status === 'paid' && order.fulfillmentStatus === 'requires_review'));
}

async function unresolvedUserPaymentOrders(userId) {
  const user = Number(userId);
  // Filter before pagination: completed historical orders must never hide an
  // older cashier that can still be paid. Legacy orders have no user slot.
  const groups = await Promise.all([
    getAll(C.paymentOrders, { userId: user, status: 'pending' }, Infinity),
    getAll(C.paymentOrders, { userId: user, status: 'confirming' }, Infinity),
    getAll(C.paymentOrders, { userId: user, status: 'paid', fulfillmentStatus: 'requires_review' }, Infinity)
  ]);
  return groups.flat().sort((a, b) => Number(b.fulfillmentStatus === 'requires_review')
    - Number(a.fulfillmentStatus === 'requires_review') || Number(a.id || 0) - Number(b.id || 0));
}

async function uniquePaymentOrder(outTradeNo, userId) {
  const rows = await getAll(C.paymentOrders, { outTradeNo: String(outTradeNo || '') }, 2);
  // Keep ordinary callers' unknown and other-owner responses identical while
  // refusing legacy duplicate merchant numbers instead of choosing one row.
  if (userId !== undefined && !rows.some(row => Number(row.userId) === Number(userId))) {
    throw createHttpError('支付订单不存在', 404, 40400);
  }
  if (rows.length > 1) throw createHttpError('支付订单号存在历史冲突，请联系工作人员核查', 409, 40908);
  return rows[0] || null;
}

async function optionalPaymentDocument(ref) {
  try {
    const snapshot = await ref.get();
    return snapshot && snapshot.data || null;
  } catch (error) {
    const missing = String(error && (error.errCode || error.code)) === 'DOCUMENT_NOT_EXIST'
      || /document.*(?:not exist|not found)/i.test(String(error && (error.errMsg || error.message)));
    if (!missing) throw error;
    return null;
  }
}

async function allocatePaymentOrderId(transaction) {
  // Payment allocations share one transactional document. No other nextId
  // caller can reset it or read a later caller's increment. The time floor also
  // separates these IDs from pre-migration small numeric payment IDs.
  const ref = transaction.collection(C.counters).doc('paymentOrderAtomic');
  const current = await optionalPaymentDocument(ref);
  if (current && (!Number.isSafeInteger(current.value) || current.value < 0)) {
    throw createHttpError('支付订单序号异常，请联系工作人员', 503, 50301);
  }
  const id = Math.max(current ? current.value + 1 : 1, Date.now() * 1000);
  if (!Number.isSafeInteger(id) || id <= 0) throw createHttpError('支付订单序号不可用', 503, 50301);
  await ref.set({ data: { key: 'paymentOrderAtomic', value: id, updatedAt: nowIso() } });
  return id;
}

function activePaymentMember(order, member) {
  return !!member && Number(member.status) === 1 && Number(member.userId) === Number(order.userId)
    && Number(member.id) === Number(order.memberRecordId)
    && Number.isSafeInteger(Number(member.matchmakerId)) && Number(member.matchmakerId) > 0
    && (order.memberMatchmakerId === undefined
      || Number(order.memberMatchmakerId) === Number(member.matchmakerId));
}

function activePaymentUser(order, user, requirePhone = false) {
  return !!user && Number(user.id) === Number(order.userId) && Number(user.status) === 1
    && !user.mergedIntoUserId && user.openid === order.payerOpenid && (!requirePhone || !!user.phone);
}

async function reservePaymentCheckout(transaction, order, documentId, unresolvedOrders) {
  const ref = transaction.collection(C.counters).doc(`paymentPendingUser_${Number(order.userId)}`);
  const slot = await optionalPaymentDocument(ref);
  const candidates = [...unresolvedOrders];
  if (slot && slot.blockedReviewDocumentId) {
    candidates.unshift({ _id: slot.blockedReviewDocumentId });
  }
  if (slot && slot.orderDocumentId && !candidates.some(row => row._id === slot.orderDocumentId)) {
    candidates.push({ _id: slot.orderDocumentId });
  }
  for (const candidate of candidates) {
    const current = await optionalPaymentDocument(transaction.collection(C.paymentOrders).doc(candidate._id));
    if (!current || !unresolvedPaymentOrder(current)) continue;
    if (Number(current.userId) !== Number(order.userId) || candidate._id !== documentId) {
      throw createHttpError('请先查询并处理当前未完成的支付订单', 409, 40905);
    }
    if (!slot || slot.orderDocumentId !== documentId) {
      await ref.set({ data: { key: `paymentPendingUser_${Number(order.userId)}`, userId: Number(order.userId),
        orderDocumentId: documentId, updatedAt: nowIso() } });
    }
    return;
  }
  throw createHttpError('支付订单状态已变更，请先查询', 409, 40905);
}

async function settlePaymentSlot(transaction, order, documentId, release) {
  const ref = transaction.collection(C.counters).doc(`paymentPendingUser_${Number(order.userId)}`);
  const slot = await optionalPaymentDocument(ref);
  if (release && slot && slot.orderDocumentId !== documentId) return;
  if (!slot && release) return;
  const slotData = { ...(slot || {}) };
  // doc(id) selects the system id; the SDK rejects _id inside set's data.
  delete slotData._id;
  await ref.set({ data: { ...slotData, key: `paymentPendingUser_${Number(order.userId)}`,
    userId: Number(order.userId), orderDocumentId: release ? '' : (slot && slot.orderDocumentId || documentId),
    ...(!release ? { blockedReviewDocumentId: documentId } : {}), updatedAt: nowIso() } });
}

function publicMembershipPlan(row) {
  return normalizeMembershipPlan(row);
}

function trustedPaymentOrder(row, requesterOpenid) {
  assertPurchaseContract(row);
  if (row.productType === 'matchmaker' || row.planCode === MATCHMAKER_LIFETIME_PLAN.planCode) assertMatchmakerLifetimeProduct(row);
  const identity = paymentOrderIdentity(row);
  const registered = paymentOrderIdentity();
  if (Object.keys(registered).some(field => identity[field] !== registered[field])) {
    throw createHttpError('支付订单商户信息不匹配', 409, 40907);
  }
  if (!String(requesterOpenid || '').trim() || String(row.payerOpenid || '') !== String(requesterOpenid)) {
    throw createHttpError('支付订单不属于当前微信用户', 403, 40304);
  }
  return {
    outTradeNo: row.outTradeNo,
    description: row.planTitle,
    amountFen: Number(row.amountFen),
    payerOpenid: row.payerOpenid,
    userId: Number(row.userId),
    status: row.status,
    order: publicPaymentOrder(row),
    ...identity
  };
}

function vipCatalogReady() {
  return String(process.env.VIP_MEMBERSHIP_CATALOG_READY || '').toLowerCase() === 'true';
}

async function activeMembershipPlans() {
  const configuredRows = (await getAll(C.membershipPlans, null, 200))
    .filter(row => !RETIRED_MATCHMAKING_PLAN_CODES.includes(String(row.planCode || '').trim().toLowerCase()));
  const newCodes = new Set(DEFAULT_MEMBERSHIP_PLANS.map(plan => plan.planCode));
  const source = vipCatalogReady() || !configuredRows.length
    ? DEFAULT_MEMBERSHIP_PLANS.map(plan => canonicalMembershipPlan(plan, configuredRows.find(row => row.planCode === plan.planCode)))
    : configuredRows.filter(row => !newCodes.has(row.planCode) || row.active)
      .map(row => newCodes.has(row.planCode) ? { ...row, active: false } : row);
  const plans = [];
  for (const row of source) {
    try {
      const normalized = publicMembershipPlan(row);
      if (normalized.active || newCodes.has(normalized.planCode)) plans.push(normalized);
    } catch (err) {
      console.warn('skip invalid membership plan', row && row.planCode, err.message);
    }
  }
  return plans.sort((a, b) => b.sortOrder - a.sortOrder || a.amountFen - b.amountFen);
}

function canonicalMembershipPlan(plan, configured) {
  return { ...(configured || {}), ...plan,
    active: vipCatalogReady() && (configured?.active === undefined || isTrue(configured.active)),
    description: configured?.description || plan.description, badge: configured?.badge || plan.badge,
    sortOrder: configured?.sortOrder ?? plan.sortOrder };
}

function membershipPaymentAvailability({ config, assignment, user, plans }) {
  if (!config.available) return { ...config, available: false };
  if (!assignment && !plans.some(plan => ['vip', 'matchmaking'].includes(plan.productType))) return { ...config, available: false, reason: 'member_assignment_required' };
  if (!user.phone) return { ...config, available: false, reason: 'phone_required' };
  if (!plans.some(plan => plan.active)) return { ...config, available: false, reason: 'plans_not_configured' };
  return config;
}

function matchmakingPaymentIntegration() {
  // Online matchmaking shares the virtual-payment credentials, while its
  // product publication retains an independent gate. Service preparation is
  // checked when delivering a human service, not while purchasing the package.
  return paymentProviderConfig({ ...process.env,
    PAYMENT_INTEGRATION_READY: process.env.MATCHMAKING_PAYMENT_READY || 'false' });
}

function membershipPaymentIntegration(userId, productType = 'vip') {
  if (productType === 'matchmaking') return matchmakingPaymentIntegration();
  const integration = paymentProviderConfig(process.env);
  if (productType === 'matchmaker') return integration;
  if (integration.available || !paymentTestAccess(process.env, userId)) return integration;
  const testing = paymentProviderConfig({ ...process.env, PAYMENT_INTEGRATION_READY: 'true' });
  return testing.available ? { ...testing, testMode: true } : integration;
}

function paymentOrderProvider(order = {}) {
  if (order.paymentProvider === undefined) return 'jsapi';
  if (!['virtual', 'jsapi'].includes(order.paymentProvider)) {
    throw createHttpError('订单支付通道记录无效，请联系工作人员核查', 409, 40907);
  }
  return order.paymentProvider;
}

function assertPaymentProviderContract(order, data = {}) {
  const requested = data.paymentProvider === undefined ? 'jsapi' : data.paymentProvider;
  if (!['virtual', 'jsapi'].includes(requested) || paymentOrderProvider(order) !== requested) {
    throw createHttpError('订单与原支付通道不匹配，请查询原订单', 409, 40907);
  }
}

function membershipOrderPaymentIntegration(userId, order) {
  if (paymentOrderProvider(order) === 'virtual') {
    const integration = membershipPaymentIntegration(userId, order.productType);
    if (isPaymentProbeOrder(order)) {
      let currentBatch = false;
      if (integration.testMode) {
        try { currentBatch = assertCurrentTestCheckout(order, process.env); } catch {}
      }
      if (!currentBatch) return { ...integration, available: false, reason: 'historical_test_query_required' };
    }
    return RETIRED_MATCHMAKING_PLAN_CODES.includes(String(order.planCode || '').trim().toLowerCase())
      ? { ...integration, available: false, reason: 'retired_plan_query_required' } : integration;
  }
  // Existing JSAPI cashiers may still produce a late payment or refund. Keep
  // their original query path visible even when every new cashier is closed.
  return { ...paymentIntegrationConfig(process.env), available: false, createPath: '',
    reason: 'historical_payment_query_required' };
}

// 虚拟支付（米大师）客户端按进程缓存，access_token 在实例内复用。
let virtualPaymentClient = null;
function virtualClient() {
  if (!virtualPaymentClient) virtualPaymentClient = createVirtualPaymentClient({ appId: paymentOrderIdentity().appId });
  return virtualPaymentClient;
}

function assertVirtualOrderConfiguration(order, config) {
  if (order.paymentProvider !== 'virtual') {
    throw createHttpError('历史支付订单需先核查原通道，请联系工作人员', 409, 40905);
  }
  if (order.virtualPaymentEnv !== config.env || order.virtualPaymentOfferId !== config.offerId) {
    throw createHttpError('订单支付环境已变更，请恢复原配置核查订单', 409, 40907);
  }
}

// Keep every issued cashier number: a cancellation is not proof that a late
// payment cannot arrive. Business order numbers never change on a retry.
async function queryVirtualPaymentAttempts(trusted, config) {
  const order = await uniquePaymentOrder(trusted.outTradeNo);
  if (!order) throw createHttpError('支付订单不存在', 404, 40400);
  trustedPaymentOrder(order, trusted.payerOpenid);
  assertVirtualOrderConfiguration(order, config);
  const attempts = Array.isArray(order.virtualPaymentAttempts) ? order.virtualPaymentAttempts : [];
  if (attempts.length > 10) throw createHttpError('支付尝试记录异常，请联系工作人员', 409, 40908);
  const numbers = new Set();
  for (const attempt of attempts) {
    assertVirtualOrderNumber(attempt.outTradeNo);
    if (numbers.has(attempt.outTradeNo) || attempt.env !== config.env || attempt.offerId !== config.offerId) {
      throw createHttpError('支付尝试记录与订单环境不匹配', 409, 40907);
    }
    numbers.add(attempt.outTradeNo);
  }
  // Warm the shared credential once before independent order queries.
  if (attempts.length) await virtualClient().accessToken(config.appSecret);
  const results = await Promise.all(attempts.map(async attempt => {
    const xpayOrder = await virtualClient().queryOrder({
      appSecret: config.appSecret, appKey: config.appKey, openid: order.payerOpenid,
      env: attempt.env, outTradeNo: attempt.outTradeNo
    });
    if (xpayOrder && (xpayOrder.order_id !== attempt.outTradeNo
      || Number(xpayOrder.env_type) !== (attempt.env === 1 ? 2 : 1))) {
      throw createHttpError('微信查询结果与支付尝试不匹配', 409, 40907);
    }
    return { attempt, xpayOrder };
  }));
  return { order, results };
}

async function virtualPaymentOrderForAttempt(paymentAttemptNo) {
  assertVirtualOrderNumber(paymentAttemptNo);
  const mapping = await optionalPaymentDocument(db.collection(C.counters).doc(`virtualPaymentAttempt_${paymentAttemptNo}`));
  if (!mapping) return uniquePaymentOrder(paymentAttemptNo);
  const order = await optionalPaymentDocument(db.collection(C.paymentOrders).doc(mapping.orderDocumentId));
  if (!order || order.outTradeNo !== mapping.businessOutTradeNo
    || !Array.isArray(order.virtualPaymentAttempts)
    || !order.virtualPaymentAttempts.some(attempt => attempt.outTradeNo === paymentAttemptNo
      && attempt.env === mapping.env && attempt.offerId === mapping.offerId)) {
    throw createHttpError('支付尝试归属记录异常，请联系工作人员', 409, 40908);
  }
  return order;
}

async function allocateVirtualPaymentAttempt(trusted, config, observedAttempts) {
  const order = await uniquePaymentOrder(trusted.outTradeNo);
  const member = order && await getById(C.members, order.memberRecordId);
  const user = order && await getById(C.users, order.userId);
  if (!order || (!member && order.productType !== 'vip' && !isDirectPurchaseOrder(order)) || !user) throw createHttpError('支付订单归属已变化，请先核查', 409, 40906);
  return db.runTransaction(async transaction => {
    const orderRef = transaction.collection(C.paymentOrders).doc(order._id);
    const current = await optionalPaymentDocument(orderRef);
    if (!current) throw createHttpError('支付订单不存在', 404, 40400);
    trustedPaymentOrder(current, trusted.payerOpenid);
    assertVirtualOrderConfiguration(current, config);
    assertMembershipCheckoutMode(current);
    if (!['pending', 'confirming'].includes(current.status) || current.paymentReviewRequired) {
      throw createHttpError('订单状态已变化，请先查询付款结果', 409, 40905);
    }
    const attempts = Array.isArray(current.virtualPaymentAttempts) ? current.virtualPaymentAttempts : [];
    if (JSON.stringify(attempts) !== JSON.stringify(observedAttempts)) {
      throw createHttpError('已有新的支付尝试，请先查询订单，勿同时拉起付款', 409, 40905);
    }
    if (attempts.length >= 10) throw createHttpError('支付尝试次数较多，请联系工作人员核查', 409, 40905);
    const slot = await optionalPaymentDocument(transaction.collection(C.counters).doc(`paymentPendingUser_${Number(current.userId)}`));
    if (slot?.blockedReviewDocumentId) {
      const blocked = await optionalPaymentDocument(transaction.collection(C.paymentOrders).doc(slot.blockedReviewDocumentId));
      if (unresolvedPaymentOrder(blocked)) {
        throw createHttpError('已有付款待核查，暂不能发起新支付，请联系工作人员', 409, 40906);
      }
    }
    const currentMember = member ? await optionalPaymentDocument(transaction.collection(C.members).doc(member._id)) : null;
    const currentUser = await optionalPaymentDocument(transaction.collection(C.users).doc(user._id));
    if ((current.productType !== 'vip' && !isDirectPurchaseOrder(current) && !activePaymentMember(current, currentMember)) || !activePaymentUser(current, currentUser, true)) {
      throw createHttpError('账号或会员关系已变化，请先核查后再付款', 409, 40906);
    }
    if (current.productType === 'matchmaking' && !isDirectPurchaseOrder(current)) await vipMembership.assertMatchmakingReady(current.userId, transaction);
    const paymentAttemptNo = `HLA${crypto.randomBytes(12).toString('hex')}`;
    const mapRef = transaction.collection(C.counters).doc(`virtualPaymentAttempt_${paymentAttemptNo}`);
    if (await optionalPaymentDocument(mapRef)) throw createHttpError('支付尝试编号冲突，请重试', 409, 40908);
    const attempt = { outTradeNo: paymentAttemptNo, env: config.env, offerId: config.offerId, createdAt: nowIso() };
    await mapRef.set({ data: { key: `virtualPaymentAttempt_${paymentAttemptNo}`, orderDocumentId: order._id,
      businessOutTradeNo: current.outTradeNo, env: config.env, offerId: config.offerId, createdAt: attempt.createdAt } });
    const patch = { virtualPaymentAttempts: [...attempts, attempt], updatedAt: attempt.createdAt };
    await orderRef.update({ data: patch });
    return { order: publicPaymentOrder({ ...current, ...patch }), paymentAttemptNo };
  });
}

// 虚拟支付查单与履约的共享通道：前端查单与发货推送都走这里。
// 本地状态永远以 hlApi 订单为准，付款事实永远以微信服务端查单为准。
async function recordVirtualDelivery(orderNo, attemptNo, transactionId, deliveryStatus = '') {
  const order = await uniquePaymentOrder(orderNo);
  if (!order) throw createHttpError('支付订单不存在', 404, 40400);
  return db.runTransaction(async transaction => {
    const ref = transaction.collection(C.paymentOrders).doc(order._id);
    const current = await optionalPaymentDocument(ref);
    if (!current || current.status !== 'paid' || current.transactionId !== transactionId
      || (current.virtualPaidAttemptNo && current.virtualPaidAttemptNo !== attemptNo)) {
      throw createHttpError('虚拟支付发货记录与付款订单不匹配', 409, 40908);
    }
    if (deliveryStatus && current.fulfillmentStatus !== 'fulfilled') {
      throw createHttpError('会员权益尚未发放，不能确认发货', 409, 40906);
    }
    if (current.virtualDeliveryStatus === 'confirmed' && current.virtualDeliveryOrderNo === attemptNo) return current;
    const timestamp = nowIso();
    const patch = { virtualPaidAttemptNo: attemptNo,
      ...(deliveryStatus ? { virtualDeliveryOrderNo: attemptNo, virtualDeliveryStatus: deliveryStatus,
        virtualDeliveryUpdatedAt: timestamp,
        ...(deliveryStatus === 'confirmed' ? { virtualDeliveryConfirmedAt: timestamp } : {}) } : {}) };
    await ref.update({ data: patch });
    return { ...current, ...patch };
  });
}

async function recordDuplicateVirtualPayments(orderNo, transactionId, confirmations) {
  const order = await uniquePaymentOrder(orderNo);
  if (!order) throw createHttpError('支付订单不存在', 404, 40400);
  await db.runTransaction(async transaction => {
    const ref = transaction.collection(C.paymentOrders).doc(order._id);
    const current = await optionalPaymentDocument(ref);
    if (!current || current.status !== 'paid' || current.transactionId !== transactionId) {
      throw createHttpError('重复付款复核记录与会员订单不匹配', 409, 40908);
    }
    const duplicates = Array.isArray(current.duplicateVirtualPayments) ? [...current.duplicateVirtualPayments] : [];
    for (const { attempt, confirmation, paidTime } of confirmations) {
      if (confirmation.transactionId === transactionId || duplicates.some(payment =>
        payment.paymentAttemptNo === attempt.outTradeNo && payment.transactionId === confirmation.transactionId)) continue;
      duplicates.push({ paymentAttemptNo: attempt.outTradeNo, transactionId: confirmation.transactionId,
        amountFen: confirmation.amountFen, paidTime });
    }
    await settlePaymentSlot(transaction, current, order._id, false);
    await ref.update({ data: { duplicateVirtualPayments: duplicates, paymentReviewRequired: true,
      fulfillmentStatus: 'requires_review', reviewReason: 'duplicate_payment',
      fulfillmentMessage: '检测到多笔付款，请联系工作人员核查重复收款。', updatedAt: nowIso() } });
  });
}

async function reconcileVirtualPaymentOrder(trusted, config, origin = {}) {
  const local = {
    outTradeNo: trusted.outTradeNo,
    amountFen: Number(trusted.amountFen),
    payerOpenid: trusted.payerOpenid,
    userId: Number(trusted.userId),
    status: String(trusted.status)
  };
  const identity = paymentOrderIdentity();
  let queried;
  try {
    queried = await queryVirtualPaymentAttempts(trusted, config);
  } catch (error) {
    throw createHttpError(error && error.message || '微信订单查询失败，请稍后重试',
      Number(error && error.status) || 503, Number(error && error.code) || 50301);
  }
  const results = queried.results;
  const refundedResults = results.filter(result => result.xpayOrder && mapVirtualOrderState(result.xpayOrder) === 'REFUNDED');
  const originalRefund = refundedResults.find(({ attempt, xpayOrder }) => {
    const transactionId = String(xpayOrder.wxpay_order_id || xpayOrder.channel_order_id || xpayOrder.wx_order_id || '');
    return queried.order.transactionId && transactionId === queried.order.transactionId
      && (!queried.order.virtualPaidAttemptNo || queried.order.virtualPaidAttemptNo === attempt.outTradeNo);
  });
  if (originalRefund && ['paid', 'refunded'].includes(local.status)) {
    const { attempt, xpayOrder } = originalRefund;
    if (queried.order.duplicateVirtualPayments?.length || results.some(result => result.xpayOrder
      && mapVirtualOrderState(result.xpayOrder) === 'SUCCESS')) {
      throw createHttpError('该订单存在其他付款待复核，不能按单笔退款解除复核', 409, 40908);
    }
    let proof;
    try { proof = buildVirtualRefundProof({ ...local, outTradeNo: attempt.outTradeNo }, xpayOrder, attempt.env, identity); }
    catch (error) {
      if (local.status === 'paid') {
        await db.runTransaction(async transaction => {
          const ref = transaction.collection(C.paymentOrders).doc(queried.order._id);
          const current = await optionalPaymentDocument(ref);
          if (current?.status !== 'paid' || current.transactionId !== queried.order.transactionId) return;
          await ref.update({ data: { paymentReviewRequired: true, reviewReason: 'virtual_refund_proof_missing',
            fulfillmentStatus: 'requires_review', fulfillmentMessage: '平台退款凭据需由主理人核查，剩余权益尚未自动回收。', updatedAt: nowIso() } });
        });
      }
      throw createHttpError('平台退款金额凭据不完整，请联系主理人核查', 409, 40907);
    }
    const settled = await membership.refundPayment({ callbackToken: config.callbackToken, ...proof,
      paymentProvider: 'virtual', outTradeNo: local.outTradeNo });
    const safe = settled?.order;
    if (!safe || safe.status !== 'refunded' || safe.outTradeNo !== local.outTradeNo || safe.transactionId !== proof.transactionId
      || safe.amountFen !== local.amountFen || safe.userId !== local.userId) throw createHttpError('退款权益处理尚未确认', 502, 50201);
    return { order: safe, providerRefunded: true };
  }
  const paidResults = results.filter(result => result.xpayOrder && mapVirtualOrderState(result.xpayOrder) === 'SUCCESS');
  if (paidResults.length) {
    const confirmations = paidResults.map(({ attempt, xpayOrder }) => ({ attempt, providerStatus: Number(xpayOrder.status),
      paidTime: Number(xpayOrder.paid_time),
      confirmation: buildVirtualConfirmation({ ...local, outTradeNo: attempt.outTradeNo }, xpayOrder, attempt.env, identity) }));
    const existingTransactionId = String(queried.order.transactionId || '');
    const selected = confirmations.find(result => result.confirmation.transactionId === existingTransactionId) || confirmations[0];
    const { attempt, confirmation } = selected;
    confirmation.outTradeNo = local.outTradeNo;
    const confirmed = await membership.confirmPayment({ callbackToken: config.callbackToken, ...confirmation,
      paymentProvider: 'virtual' }, origin);
    const safe = confirmed && confirmed.order;
    if (!safe || safe.status !== 'paid' || safe.transactionId !== confirmation.transactionId
      || safe.amountFen !== local.amountFen || safe.userId !== local.userId) {
      throw createHttpError('会员权益尚未确认，请稍后查询', 502, 50201);
    }
    let delivery = await recordVirtualDelivery(local.outTradeNo, attempt.outTradeNo, confirmation.transactionId);
    if (new Set(confirmations.map(result => result.confirmation.transactionId)).size > 1) {
      await recordDuplicateVirtualPayments(local.outTradeNo, confirmation.transactionId, confirmations);
      throw createHttpError('同一会员订单存在多笔虚拟支付，请联系工作人员复核重复付款', 409, 40908);
    }
    if (delivery.paymentReviewRequired === true) {
      if (delivery.reviewReason === 'payment_after_cancellation') {
        return { order: publicPaymentOrder(delivery), tradeState: 'SUCCESS' };
      }
      throw createHttpError('会员订单存在重复付款待复核，请联系工作人员', 409, 40908);
    }
    if (safe.fulfillmentStatus !== 'fulfilled') return { order: safe, tradeState: 'SUCCESS' };
    if (selected.providerStatus === 4) {
      // 已核实的平台已发货状态也能补齐本地确认记录（例如上次成功后记录写入失败）。
      delivery = await recordVirtualDelivery(local.outTradeNo, attempt.outTradeNo, confirmation.transactionId, 'confirmed');
    }
    if (delivery.virtualDeliveryStatus !== 'confirmed' || delivery.virtualDeliveryOrderNo !== attempt.outTradeNo) {
      await recordVirtualDelivery(local.outTradeNo, attempt.outTradeNo, confirmation.transactionId, 'pending');
      try {
        await virtualClient().notifyProvideGoods({ appSecret: config.appSecret, appKey: config.appKey,
          env: attempt.env, outTradeNo: attempt.outTradeNo });
        delivery = await recordVirtualDelivery(local.outTradeNo, attempt.outTradeNo, confirmation.transactionId, 'confirmed');
      } catch (_) {
        // 权益事务已经完成；平台确认失败必须保留 pending，后续查单或重推继续补偿。
        throw createHttpError('会员权益已发放，微信发货确认暂未完成，请稍后查询', 503, 50301);
      }
    }
    return { order: publicPaymentOrder(delivery), tradeState: 'SUCCESS' };
  }
  if (!results.length || results.every(result => !result.xpayOrder)) {
    if (!['pending', 'confirming'].includes(local.status)) {
      throw createHttpError('微信订单不存在与本地付款状态不一致，请联系工作人员', 409, 40907);
    }
    return { order: trusted.order, providerOrderAbsent: true };
  }
  if (results.some(result => result.xpayOrder && mapVirtualOrderState(result.xpayOrder) === 'NOTPAY')) {
    if (!['pending', 'confirming'].includes(local.status)) {
      throw createHttpError('微信未付款状态与已结束的会员订单不匹配', 409, 40907);
    }
    return { order: trusted.order, tradeState: 'NOTPAY' };
  }
  if (results.every(result => result.xpayOrder && mapVirtualOrderState(result.xpayOrder) === 'CLOSED')) {
    if (!['pending', 'confirming', 'closed'].includes(local.status)) {
      throw createHttpError('会员订单状态不可关闭，请查询最新状态', 409, 40905);
    }
    let proof;
    try {
      proof = buildVirtualCloseProof(local, identity);
    } catch (error) {
      throw createHttpError(error.message, Number(error.status) || 409, Number(error.code) || 40907);
    }
    const closed = await membership.closePayment({ callbackToken: config.callbackToken, ...proof,
      paymentProvider: 'virtual', observedVirtualPaymentAttempts: queried.order.virtualPaymentAttempts });
    const safe = closed && closed.order;
    if (!safe || safe.status !== 'closed' || safe.amountFen !== local.amountFen || safe.userId !== local.userId) {
      throw createHttpError('会员订单关闭状态尚未确认，请稍后查询', 502, 50201);
    }
    return { order: safe, tradeState: 'CLOSED' };
  }
  if (results.some(result => !result.xpayOrder)
    && results.every(result => !result.xpayOrder || mapVirtualOrderState(result.xpayOrder) === 'CLOSED')) {
    if (!['pending', 'confirming'].includes(local.status)) {
      throw createHttpError('微信订单不存在与本地付款状态不一致，请联系工作人员', 409, 40907);
    }
    return { order: trusted.order, providerOrderAbsent: true };
  }
  if (refundedResults.length) {
    throw createHttpError('微信退款状态与会员订单不匹配，请联系工作人员', 409, 40907);
  }
  throw createHttpError('微信交易状态暂不支持自动处理，请联系工作人员', 409, 40905);
}

async function recordVirtualPushHandled(orderNo, attemptNo, requestId) {
  const order = await uniquePaymentOrder(orderNo);
  if (!order) throw createHttpError('支付订单不存在', 404, 40400);
  return db.runTransaction(async transaction => {
    const ref = transaction.collection(C.paymentOrders).doc(order._id);
    const current = await optionalPaymentDocument(ref);
    if (!current || current.status !== 'paid' || current.fulfillmentStatus !== 'fulfilled'
      || current.virtualPaidAttemptNo !== attemptNo || current.virtualDeliveryOrderNo !== attemptNo
      || current.virtualDeliveryStatus !== 'confirmed') {
      throw createHttpError('推送履约记录与已发货订单不匹配', 409, 40908);
    }
    if (current.virtualPushHandledAt) return current;
    const patch = { virtualPushHandledAt: nowIso(), virtualPushRequestId: requestId, virtualPushOrderNo: attemptNo };
    await ref.update({ data: patch });
    return { ...current, ...patch };
  });
}

function isPaymentProbeOrder(order = {}) {
  return order.planCode === paymentTestPlan().planCode
    || order.paymentTestPlanCode === 'vip_week'
    || /^payment_probe_user_[1-9]\d*(?:_run_[a-z][a-z0-9_-]{0,31})?$/.test(String(order._id || ''));
}

function assertMembershipCheckoutMode(order) {
  assertPurchaseContract(order);
  paymentOrderProvider(order);
  if (RETIRED_MATCHMAKING_PLAN_CODES.includes(String(order.planCode || '').trim().toLowerCase())) {
    throw createHttpError('该牵线套餐已停售，请先查询并处理原订单，再选择当前套餐', 409, 40905);
  }
  if ((order.productType === 'vip' && order.paymentProvider !== 'virtual')
    || (order.productType === 'matchmaking' && order.paymentProvider !== 'virtual')
    || (order.productType === 'matchmaker' && order.paymentProvider !== 'virtual')) {
    throw createHttpError('订单商品与支付通道不匹配，请核查原订单', 409, 40907);
  }
  const integration = membershipPaymentIntegration(order.userId, order.productType);
  if (!integration.available) throw createHttpError('微信支付暂未开放', 503, 50301);
  if (integration.testMode) assertCurrentTestCheckout(order, process.env);
  else if (isPaymentProbeOrder(order)) {
    throw createHttpError('测试支付入口已关闭', 403, 40304);
  }
  return integration;
}

async function vipPublicTarget(actorId, targetId, transaction) {
  const target = await publicShowcaseTarget({ targetUserId: targetId });
  const states = await Promise.all([memberInteractionStateMap(actorId, [targetId]), memberInteractionStateMap(targetId, [actorId])]);
  if (states[0][String(targetId)]?.hide || states[1][String(actorId)]?.hide) {
    throw createHttpError('当前对象暂不可访问', 403, 40300);
  }
  if (transaction) {
    const lock = await optionalPaymentDocument(transaction.collection(VIP_COLLECTIONS.memberPrivacy)
      .doc(`visibility_pair_${[Number(actorId), Number(targetId)].sort((a, b) => a - b).join('_')}`));
    if (lock && Array.isArray(lock.hiddenBy) && lock.hiddenBy.length) throw createHttpError('当前对象暂不可访问', 403, 40300);
    const profile = await getOne(C.profiles, { userId: Number(targetId) });
    const current = profile ? await optionalPaymentDocument(transaction.collection(C.profiles).doc(profile._id)) : null;
    if (!current || !isTrue(current.displayEnabled)) throw createHttpError('当前资料暂不可访问', 404, 40400);
  }
  return target;
}

async function saveMemberHide(userId, targetId, active, existing) {
  return db.runTransaction(async transaction => {
    const lockId = `visibility_pair_${[Number(userId), Number(targetId)].sort((a, b) => a - b).join('_')}`;
    const lockRef = transaction.collection(VIP_COLLECTIONS.memberPrivacy).doc(lockId);
    const lock = await optionalPaymentDocument(lockRef);
    const documentId = existing?._id || `member_hide_${Number(userId)}_${Number(targetId)}`;
    const ref = transaction.collection(C.memberInteractions).doc(documentId);
    const current = await optionalPaymentDocument(ref);
    const hiddenBy = new Set((lock?.hiddenBy || []).map(Number));
    if (active) hiddenBy.add(Number(userId)); else hiddenBy.delete(Number(userId));
    const timestamp = nowIso();
    const row = { ...(current || existing || {}), id: current?.id || existing?.id
      || await allocateVipBusinessId(transaction, 'vipInteractionAtomic'), userId: Number(userId), targetUserId: Number(targetId),
      actionType: 'hide', active, status: active ? 'active' : 'inactive', createdAt: current?.createdAt || existing?.createdAt || timestamp,
      updatedAt: timestamp };
    delete row._id;
    await ref.set({ data: row });
    await lockRef.set({ data: { hiddenBy: [...hiddenBy], updatedAt: timestamp } });
    return { ...row, _id: documentId };
  });
}

async function vipServingMatchmaker(actorId, memberUserId, transaction) {
  const mm = await getCertifiedMatchmakerByUserIdOrThrow(actorId);
  const assignments = await getAll(C.members, { userId: Number(memberUserId), matchmakerId: Number(mm.id), status: 1 });
  if (!assignments.length) throw createHttpError('只能确认所属会员的牵线服务', 403, 40300);
  if (!transaction) return mm;
  const current = await optionalPaymentDocument(transaction.collection(C.matchmakers).doc(mm._id));
  const memberRow = await optionalPaymentDocument(transaction.collection(C.members).doc(assignments[0]._id));
  if (!isCertifiedActiveMatchmaker(current) || !memberRow || Number(memberRow.status) !== 1
    || Number(memberRow.matchmakerId) !== Number(mm.id) || Number(memberRow.userId) !== Number(memberUserId)) {
    throw createHttpError('主理人或会员服务关系已变化', 409, 40906);
  }
  return current;
}

async function allocateVipBusinessId(transaction, key) {
  const ref = transaction.collection(C.counters).doc(key);
  const previous = await optionalPaymentDocument(ref);
  if (previous && (!Number.isSafeInteger(previous.value) || previous.value < 0)) throw createHttpError('业务序号异常', 503, 50301);
  const id = Math.max(previous ? previous.value + 1 : 1, Date.now() * 1000);
  if (!Number.isSafeInteger(id)) throw createHttpError('业务序号不可用', 503, 50301);
  await ref.set({ data: { key, value: id, updatedAt: nowIso() } });
  return id;
}

async function vipConnectPair({ userAId, userBId, matchmakerId, requestId, transaction }) {
  const participants = [Number(userAId), Number(userBId)].sort((a, b) => a - b);
  const participantKey = chatParticipantKey(participants);
  const recordRef = transaction.collection(C.matchRecords).doc(`matchmaking_${requestId}`);
  const existingRecord = await optionalPaymentDocument(recordRef);
  if (existingRecord) return { matchRecordId: existingRecord.id, conversationId: existingRecord.conversationId };
  const conversationId = conversationDocumentId(participantKey, 'member_pair');
  const conversationRef = transaction.collection(C.conversations).doc(conversationId);
  const existingConversation = await optionalPaymentDocument(conversationRef);
  if (existingConversation?.matchRecordId) throw createHttpError('双方已建立正式牵线，请刷新后查看', 409, 40906);
  const id = await allocateVipBusinessId(transaction, 'vipMatchRecordAtomic');
  const numericConversationId = existingConversation?.id || await allocateVipBusinessId(transaction, 'vipConversationAtomic');
  const timestamp = nowIso();
  const record = { id, userAId: participants[0], userBId: participants[1], matchmakerId: Number(matchmakerId),
    matchType: 'paid_matchmaking', status: 'connected', matchmakingRequestId: requestId,
    conversationId: numericConversationId, createdAt: timestamp, updatedAt: timestamp };
  const conversation = { ...(existingConversation || {}), id: numericConversationId, conversationType: 'member_pair',
    participantIds: participants, participantKey, matchmakerId: Number(matchmakerId), matchRecordId: id,
    chatOpenReason: null, status: 'active', unreadBy: existingConversation?.unreadBy || Object.fromEntries(participants.map(value => [String(value), 0])),
    lastMessageContent: existingConversation?.lastMessageContent || '', lastMessageAt: existingConversation?.lastMessageAt || '',
    createdAt: existingConversation?.createdAt || timestamp, updatedAt: timestamp };
  delete conversation._id;
  await recordRef.set({ data: record });
  await conversationRef.set({ data: conversation });
  return { matchRecordId: id, conversationId: numericConversationId };
}

async function vipNotify({ senderId, receiverId, messageType, content, transaction }) {
  const operation = async tx => {
    const id = await allocateVipBusinessId(tx, 'vipMessageAtomic');
    const message = { id, senderId: Number(senderId), receiverId: Number(receiverId), messageType,
      contentType: 'system', content: String(content).slice(0, 500), isRead: 0, createdAt: nowIso(), updatedAt: nowIso() };
    await tx.collection(C.messages).doc(`vip_message_${id}`).set({ data: message });
    return message;
  };
  return transaction ? operation(transaction) : db.runTransaction(operation);
}

async function vipVisitorViews(viewerId, visitorIds) {
  const ids = [...new Set(visitorIds.map(Number).filter(id => Number.isSafeInteger(id) && id > 0 && id !== Number(viewerId)))];
  const [users, profiles, outgoing, incoming] = await Promise.all([
    getFirstRowsByNumericField(C.users, 'id', ids, [], { complete: true,
      fields: { id: true, nickname: true, avatarUrl: true, status: true, gender: true, mergedIntoUserId: true } }),
    getFirstRowsByNumericField(C.profiles, 'userId', ids, [], { complete: true,
      fields: { userId: true, realName: true, photos: true, displayEnabled: true } }),
    memberInteractionStateMap(viewerId, ids),
    getAll(C.memberInteractions, { targetUserId: Number(viewerId), actionType: 'hide' }, Infinity)
  ]);
  const hidden = new Set(latestMemberInteractionRows(incoming).filter(isActiveInteraction).map(row => Number(row.userId)));
  const result = new Map();
  for (const id of ids) {
    const user = users.get(id);
    const profile = profiles.get(id);
    if (!user || Number(user.status) !== 1 || user.mergedIntoUserId || !profile || !isTrue(profile.displayEnabled)
      || hidden.has(id) || outgoing[String(id)]?.hide) continue;
    result.set(id, { visitorUserId: id, ...salonAttendeeIdentity(user, profile) });
  }
  return result;
}

async function vipFormalPair(userId, targetId, transaction) {
  const a = Number(userId), b = Number(targetId);
  const records = await getAll(C.matchRecords, _.or([
    { userAId: _.in([a, String(a)]), userBId: _.in([b, String(b)]) },
    { userBId: _.in([a, String(a)]), userAId: _.in([b, String(b)]) }
  ]), Infinity);
  for (const snapshot of records) {
    const row = transaction ? await optionalPaymentDocument(transaction.collection(C.matchRecords).doc(snapshot._id)) : snapshot;
    if (row?.status === 'connected' && [Number(row.userAId), Number(row.userBId)].includes(a)
      && [Number(row.userAId), Number(row.userBId)].includes(b)) return true;
  }
  return false;
}

async function vipCanContact(userId, targetId, transaction) {
  const snapshots = await Promise.all([latestMemberInteraction(userId, targetId, 'favorite'), latestMemberInteraction(targetId, userId, 'favorite')]);
  const current = transaction ? await Promise.all(snapshots.map(row => row
    ? optionalPaymentDocument(transaction.collection(C.memberInteractions).doc(row._id)) : null)) : snapshots;
  if (current.every(isActiveInteraction)) return true;
  return vipFormalPair(userId, targetId, transaction);
}

const matchmakerActivation = createMatchmakerActivationService({ db });
const vipMembership = createVipMembershipService({ db, getAll, getOne, getById, nextId, addRow, updateRow,
  fulfillMatchmaker: (transaction, order, timestamp) => matchmakerActivation.fulfill(transaction, order, timestamp),
  refundMatchmaker: (transaction, order, timestamp) => matchmakerActivation.refund(transaction, order, timestamp),
  assertPublicTarget: vipPublicTarget, assertMatchmaker: vipServingMatchmaker, connectPair: vipConnectPair, notify: vipNotify,
  visitorViews: vipVisitorViews,
  resolveVisitorPage: async rows => (await resolveMemberMediaPage({ list: rows })).list,
  canContact: vipCanContact,
  hasFormalPair: vipFormalPair,
  getProfileCompletion: (user, profile) => profileCompletionFor({ ...profile, gender: profile.gender || user.gender,
    realName: profile.realName || user.nickname }).percent });

async function paidMatchmakerOverview(userId) {
  const [user, applications, unresolved] = await Promise.all([
    getUserOrThrow(userId), getAll(C.matchmakers, { userId: Number(userId) }, 2), unresolvedUserPaymentOrders(userId)
  ]);
  if (Number(user.status) !== 1 || user.mergedIntoUserId) throw createHttpError('账号状态已变化，请重新登录', 401, 40100);
  const row = applications.length === 1 ? applications[0] : null;
  const active = !!row && Number(row.status) === 1 && Number(row.certificationStatus) === 2;
  const plan = normalizeMembershipPlan(MATCHMAKER_LIFETIME_PLAN, { requireActive: true });
  let payment = membershipPaymentIntegration(userId, 'matchmaker');
  const reason = applications.length > 1 ? 'matchmaker_application_conflict' : active ? 'matchmaker_already_active'
    : !user.phone ? 'phone_required' : row && !matchmakerActivationEligibility(user, row).eligible
      ? 'matchmaker_application_unavailable' : '';
  if (reason) payment = { ...payment, available: false, reason };
  const pendingOrder = unresolved[0] || null;
  if (pendingOrder?.fulfillmentStatus === 'requires_review') payment = { ...payment, available: false, reason: 'payment_requires_review' };
  return {
    matchmaker: row ? { id: Number(row.id), matchmakerNo: row.matchmakerNo || '', status: Number(row.status),
      certificationStatus: Number(row.certificationStatus || 0), activationSource: row.activationSource || '',
      activationStatus: row.activationStatus || '', activationLifetime: row.activationLifetime === true } : null,
    active, activationSource: row?.activationSource || (active ? 'manual' : ''), lifetime: active,
    plan, payment, phoneBound: !!user.phone,
    pendingOrder: pendingOrder ? publicPaymentOrder(pendingOrder) : null,
    pendingOrderPayment: pendingOrder ? membershipOrderPaymentIntegration(userId, pendingOrder) : null
  };
}

function reusableTestOrder(order, requesterOpenid) {
  assertCurrentTestCheckout(order, process.env);
  trustedPaymentOrder(order, requesterOpenid);
  if (!['pending', 'confirming'].includes(order.status)) {
    throw createHttpError('本账号的支付测试已结束，请勿重复付款', 409, 40905);
  }
  return order;
}

function sameProbeArchive(archive, order) {
  const fields = new Set([...Object.keys(archive), ...Object.keys(order)]);
  fields.delete('_id');
  fields.delete('probeArchivedAt');
  return [...fields].every(field => JSON.stringify(archive[field]) === JSON.stringify(order[field]));
}

// Only a current virtual order with an explicitly empty attempt ledger proves
// that no signed cashier has been issued. Historical/missing ledgers fail closed.
function noIssuedVirtualPaymentAttempt(order) {
  return order.paymentProvider === 'virtual' && Array.isArray(order.virtualPaymentAttempts)
    && order.virtualPaymentAttempts.length === 0 && !order.virtualProviderOrderNo;
}

function assertMemberOrderCancellationState(order) {
  if (order.status === 'paid' || order.status === 'refunded' || order.transactionId || order.paidAt || order.refundedAt) {
    throw createHttpError('订单已支付或已退款，不能取消，请查看订单结果', 409, 40905);
  }
  if (order.paymentReviewRequired || order.fulfillmentStatus === 'requires_review') {
    throw createHttpError('订单仍待核查，暂不能取消，请联系工作人员', 409, 40906);
  }
  if (!['pending', 'confirming', 'closed', 'failed'].includes(order.status)) {
    throw createHttpError('订单状态尚未确认，暂不能取消，请稍后查询', 409, 40905);
  }
}

const membership = {
  async overview(userId) {
    const [user, assignment, normalPlans, unresolvedOrders, vipOverview] = await Promise.all([
      getUserOrThrow(userId),
      activeMemberAssignment(userId),
      activeMembershipPlans(),
      unresolvedUserPaymentOrders(userId),
      vipMembership.overview(userId)
    ]);
    let integration = membershipPaymentIntegration(userId);
    let plans = normalPlans.filter(plan => plan.planCode !== paymentTestPlan().planCode);
    if (integration.testMode) {
      const testPlan = paymentTestPlan(process.env);
      const testOrder = await getOne(C.paymentOrders, { _id: paymentTestDocumentId(process.env, userId) });
      const completed = testOrder && (testOrder.status === 'paid'
        || (testPlan.planCode === 'vip_week' && !['pending', 'confirming'].includes(testOrder.status)));
      plans = completed ? [] : [testPlan];
      if (completed) integration = { ...integration, available: false, createPath: '', reason: 'payment_test_completed' };
    }
    let payment = membershipPaymentAvailability({ config: integration, assignment, user,
      plans: plans.filter(plan => plan.productType !== 'matchmaking') });
    let matchmakingPayment = matchmakingPaymentIntegration();
    if (matchmakingPayment.available && (!user.phone || !plans.some(plan => plan.productType === 'matchmaking' && plan.active))) {
      matchmakingPayment = { ...matchmakingPayment, available: false,
        reason: !user.phone ? 'phone_required' : 'plans_not_configured' };
    }
    const pendingOrder = unresolvedOrders[0] || null;
    if (pendingOrder && pendingOrder.fulfillmentStatus === 'requires_review') {
      payment = { ...payment, available: false, createPath: '', reason: 'payment_requires_review' };
      matchmakingPayment = { ...matchmakingPayment, available: false, createPath: '', reason: 'payment_requires_review' };
    }
    const premium = vipOverview.isPremiumMember;
    return {
      isPremiumMember: premium,
      phoneBound: !!user.phone,
      phoneMasked: user.phone ? `${String(user.phone).slice(0, 3)}****${String(user.phone).slice(-4)}` : '',
      needsMatchmaker: !assignment,
      membership: premium || assignment ? { memberType: premium ? 'vip' : 'free',
        serviceLevel: assignment?.serviceLevel || '', expireAt: vipOverview.expireAt, lifetime: vipOverview.lifetime } : null,
      membershipTier: vipOverview.membershipTier,
      entitlements: vipOverview.entitlements,
      vipMembership: vipOverview.vipMembership,
      matchmakingPackages: vipOverview.matchmakingPackages,
      matchmakingReadiness: vipOverview.matchmakingReadiness,
      matchmakingProgress: vipOverview.matchmakingProgress,
      plans,
      pendingOrder: pendingOrder ? publicPaymentOrder(pendingOrder) : null,
      pendingOrderPayment: pendingOrder ? membershipOrderPaymentIntegration(userId, pendingOrder) : null,
      unresolvedOrderCount: unresolvedOrders.length,
      payment,
      matchmakingPayment
    };
  },

  async createOrder(userId, data = {}) {
    const planCode = String(data.planCode || '').trim().toLowerCase();
    const activationPurchase = planCode === MATCHMAKER_LIFETIME_PLAN.planCode;
    const canonicalPlan = activationPurchase ? MATCHMAKER_LIFETIME_PLAN : DEFAULT_MEMBERSHIP_PLANS.find(plan => plan.planCode === planCode);
    let integration = membershipPaymentIntegration(userId, canonicalPlan?.productType);
    if (!integration.available) throw createHttpError('微信支付尚未完成商户配置', 503, 50301);
    const [user, assignment, unresolvedOrders] = await Promise.all([
      getUserOrThrow(userId),
      activeMemberAssignment(userId),
      unresolvedUserPaymentOrders(userId)
    ]);
    const payerOpenid = String(user.openid || '').trim();
    if (!payerOpenid || /^(manual_|seed-|mock_)/.test(payerOpenid)) {
      throw createHttpError('当前账号不是可支付的微信登录账号', 409, 40904);
    }
    const testPlan = paymentTestPlan(process.env);
    if ((integration.testMode && planCode !== testPlan?.planCode)
      || (!integration.testMode && planCode === paymentTestPlan().planCode)) {
      throw createHttpError('该支付套餐未向当前账号开放', 403, 40304);
    }
    let application = null;
    if (activationPurchase && !unresolvedOrders.length) {
      if (!user.phone) throw createHttpError('付款前请先授权微信手机号', 400, 40003);
      const existingApplications = await getAll(C.matchmakers, { userId: Number(userId) }, 2);
      if (existingApplications.length > 1) throw createHttpError('主理人申请记录重复，请联系工作人员核查后再付款', 409, 40906);
      const existing = existingApplications[0];
      if (existing && !matchmakerActivationEligibility(user, existing).eligible) throw createHttpError('当前主理人状态不允许重复付费开通，请刷新查看', 409, 40906);
      application = existing || null;
    }
    const configuredPlan = integration.testMode || activationPurchase ? null : await getOne(C.membershipPlans, { planCode });
    const planRow = activationPurchase ? MATCHMAKER_LIFETIME_PLAN : integration.testMode ? testPlan : canonicalPlan
      ? canonicalMembershipPlan(canonicalPlan, configuredPlan) : configuredPlan;
    integration = membershipPaymentIntegration(userId, planRow?.productType);
    if (!integration.available) throw createHttpError('微信支付尚未完成商户配置', 503, 50301);
    let plan;
    let planError;
    if (planRow) {
      try { plan = normalizeMembershipPlan(planRow, { requireActive: true }); }
      catch (err) { planError = createHttpError(err.message || '会员套餐不可用', 400, 40001); }
    }

    const timestamp = nowIso();
    const result = await db.runTransaction(async transaction => {
      // The same user slot covers every plan and the controlled probe. Reading
      // and writing it in this transaction prevents concurrent new cashiers.
      const slotRef = transaction.collection(C.counters).doc(`paymentPendingUser_${Number(userId)}`);
      const slot = await optionalPaymentDocument(slotRef);
      const candidates = [...unresolvedOrders];
      if (slot && slot.blockedReviewDocumentId) {
        candidates.unshift({ _id: slot.blockedReviewDocumentId });
      }
      if (slot && slot.orderDocumentId && !candidates.some(row => row._id === slot.orderDocumentId)) {
        candidates.push({ _id: slot.orderDocumentId });
      }
      for (const candidate of candidates) {
        const current = await optionalPaymentDocument(transaction.collection(C.paymentOrders).doc(candidate._id));
        if (!current || !unresolvedPaymentOrder(current)) continue;
        if (Number(current.userId) !== Number(userId)) throw createHttpError('支付订单归属异常', 409, 40906);
        trustedPaymentOrder(current, payerOpenid);
        if (integration.testMode && isPaymentProbeOrder(current)) assertTestCheckout(current);
        await slotRef.set({ data: { key: `paymentPendingUser_${Number(userId)}`, userId: Number(userId),
          orderDocumentId: candidate._id,
          ...(current.fulfillmentStatus === 'requires_review' ? { blockedReviewDocumentId: candidate._id } : {}),
          updatedAt: timestamp } });
        return { order: { ...current, _id: candidate._id }, reused: true };
      }
      if (RETIRED_MATCHMAKING_PLAN_CODES.includes(planCode)) {
        throw createHttpError('该历史套餐已停止新购，请选择当前套餐', 409, 40905);
      }
      if (!planRow) throw createHttpError('会员套餐不存在', 404, 40400);
      if (vipCatalogReady() && !integration.testMode && !canonicalPlan) {
        throw createHttpError('该历史套餐已停止新购，请选择当前套餐', 409, 40905);
      }
      if (planError) throw planError;
      const directPurchase = !integration.testMode && !!canonicalPlan && ['vip', 'matchmaking', 'matchmaker'].includes(plan.productType);
      if (!assignment && plan.productType !== 'vip' && !directPurchase) throw createHttpError('请先绑定主理人后再开通会员', 409, 40903);
      const currentUser = await optionalPaymentDocument(transaction.collection(C.users).doc(user._id));
      if (!activePaymentUser({ userId, payerOpenid }, currentUser)) throw createHttpError('当前微信账号状态已变化，请重新登录', 403, 40304);
      if (!currentUser.phone) throw createHttpError('付款前请先授权微信手机号', 400, 40003);
      let currentApplication = null;
      let applicationDocumentId = '';
      if (activationPurchase) {
        applicationDocumentId = application?._id || `paid_matchmaker_user_${Number(userId)}`;
        const applicationRef = transaction.collection(C.matchmakers).doc(applicationDocumentId);
        currentApplication = await optionalPaymentDocument(applicationRef);
        if (!currentApplication && !application) {
          const applicationId = await allocateVipBusinessId(transaction, 'paidMatchmakerAtomic');
          currentApplication = { id: applicationId, userId: Number(userId), matchmakerNo: defaultMatchmakerNo(applicationId),
            inviteCode: `HLP${applicationId.toString(36).toUpperCase()}`, inviteCodeStatus: 'active', inviteCodeUpdatedAt: timestamp,
            level: 1, parentId: null, teamId: null, hasStore: 0, certificationStatus: 0, certificationRemark: '',
            totalPerformance: 0, status: 1, createdAt: timestamp, updatedAt: timestamp };
          await applicationRef.set({ data: currentApplication });
          await transaction.collection(C.users).doc(user._id).update({ data: { currentRole: 'matchmaker', updatedAt: timestamp } });
        }
        if (!matchmakerActivationEligibility(currentUser, currentApplication).eligible
          || application && Number(currentApplication.id) !== Number(application.id)) throw createHttpError('主理人申请已变化，请刷新后再付款', 409, 40906);
      }
      const member = assignment ? await optionalPaymentDocument(transaction.collection(C.members).doc(assignment._id)) : null;
      if (plan.productType !== 'vip' && !directPurchase && !activePaymentMember({ userId, memberRecordId: assignment.id, memberMatchmakerId: assignment.matchmakerId }, member)) {
        throw createHttpError('会员关系已变更，请先核查后再付款', 409, 40906);
      }
      if (plan.productType === 'matchmaking' && !directPurchase) await vipMembership.assertMatchmakingReady(userId, transaction);
      const probeDocumentId = integration.testMode ? paymentTestDocumentId(process.env, userId) : '';
      let probeArchive;
      if (integration.testMode) {
        const existingProbe = await optionalPaymentDocument(transaction.collection(C.paymentOrders).doc(probeDocumentId));
        if (existingProbe) {
          assertCurrentTestCheckout(existingProbe, process.env);
          trustedPaymentOrder(existingProbe, payerOpenid);
          // A weekly batch owns one business order even if it is closed. A
          // further test needs a separately authorized operator-owned run.
          if (testPlan.planCode === 'vip_week') {
            const existing = reusableTestOrder(existingProbe, payerOpenid);
            return { order: { ...existing, _id: probeDocumentId }, reused: true };
          }
          if (existingProbe.status !== 'closed') {
            const existing = reusableTestOrder(existingProbe, payerOpenid);
            return { order: { ...existing, _id: probeDocumentId }, reused: true };
          }
          // The protected close endpoint records CLOSED only after the bridge
          // has queried WeChat. A paid, failed, refunded or unresolved probe is
          // never replaced. Keep this closed cashier's evidence under its own
          // immutable history document before reusing the fixed test entry.
          if (existingProbe.tradeState !== 'CLOSED' || existingProbe.transactionId || existingProbe.paidAt
            || ['fulfilled', 'requires_review'].includes(existingProbe.fulfillmentStatus)
            || !Number.isSafeInteger(existingProbe.id) || existingProbe.id <= 0) {
            throw createHttpError('历史测试订单不可重新付款，请联系工作人员核查', 409, 40905);
          }
          const archiveRef = transaction.collection(C.paymentOrders).doc(`payment_order_${existingProbe.id}`);
          const archived = await optionalPaymentDocument(archiveRef);
          if (archived && !sameProbeArchive(archived, existingProbe)) {
            throw createHttpError('历史支付归档存在冲突，请联系工作人员核查', 409, 40908);
          }
          if (!archived) {
            const data = { ...existingProbe, probeArchivedAt: timestamp };
            delete data._id;
            probeArchive = { ref: archiveRef, data };
          }
        }
        if (!paymentTestAccess(process.env, userId)) throw createHttpError('支付测试入口已关闭', 403, 40304);
      }
      const id = await allocatePaymentOrderId(transaction);
      const documentId = integration.testMode ? probeDocumentId : `payment_order_${id}`;
      const ref = transaction.collection(C.paymentOrders).doc(documentId);
      if (!integration.testMode && await optionalPaymentDocument(ref)) {
        throw createHttpError('支付订单序号冲突，请联系工作人员', 409, 40908);
      }
      const order = createPendingPaymentOrder({ id, outTradeNo: paymentOrderNo(id), userId,
        memberRecordId: member?.id || 0, memberMatchmakerId: member?.matchmakerId, payerOpenid, plan, now: timestamp,
        ...(directPurchase ? { fulfillmentContract: DIRECT_PURCHASE_CONTRACT } : {}) });
      if (activationPurchase) Object.assign(order, { userDocumentId: user._id, matchmakerDocumentId: applicationDocumentId,
        matchmakerId: Number(currentApplication.id), matchmakerAuthorizationSnapshot: matchmakerActivationSnapshot({ ...currentApplication, _id: applicationDocumentId }) });
      if (plan.productType === 'matchmaking' && !matchmakingPaymentIntegration().available) {
        throw createHttpError('人工牵线收款暂未开放', 503, 50301);
      }
      const virtualConfig = virtualPaymentConfig(process.env);
      if (!virtualConfig.configured) throw createHttpError('虚拟支付配置已变化，请稍后重试', 503, 50301);
      Object.assign(order, { paymentProvider: 'virtual', virtualPaymentEnv: virtualConfig.env,
        virtualPaymentOfferId: virtualConfig.offerId, virtualPaymentAttempts: [] });
      if (integration.testMode && testPlan.planCode === 'vip_week') {
        Object.assign(order, { paymentTestPlanCode: 'vip_week', paymentTestRunId: paymentTestRunId(process.env) });
      }
      if (integration.testMode) {
        if (!paymentTestAccess(process.env, userId)) throw createHttpError('支付测试入口已关闭', 403, 40304);
        assertCurrentTestCheckout({ ...order, _id: documentId }, process.env);
      }
      if (probeArchive) await probeArchive.ref.set({ data: probeArchive.data });
      await ref.set({ data: order });
      await slotRef.set({ data: { key: `paymentPendingUser_${Number(userId)}`, userId: Number(userId),
        orderDocumentId: documentId, updatedAt: timestamp } });
      return { order: { ...order, _id: documentId }, reused: false };
    });
    return {
      order: publicPaymentOrder(result.order),
      payment: result.order.fulfillmentStatus === 'requires_review'
        ? { ...membershipOrderPaymentIntegration(userId, result.order), available: false,
          createPath: '', reason: 'payment_requires_review' }
        : membershipOrderPaymentIntegration(userId, result.order),
      reused: result.reused,
      recoveryRequired: result.reused
    };
  },

  async getOrder(userId, outTradeNo) {
    const row = await uniquePaymentOrder(outTradeNo, userId);
    if (!row) throw createHttpError('支付订单不存在', 404, 40400);
    return publicPaymentOrder(row);
  },

  async cancelOrder(userId, outTradeNo) {
    const orderNo = assertVirtualOrderNumber(String(outTradeNo || ''));
    const user = await getUserOrThrow(userId);
    const order = await uniquePaymentOrder(orderNo, userId);
    if (!order) throw createHttpError('支付订单不存在', 404, 40400);
    trustedPaymentOrder(order, user.openid);
    assertMemberOrderCancellationState(order);
    const locallyUnissued = noIssuedVirtualPaymentAttempt(order);
    if (!['closed', 'failed'].includes(order.status) && !locallyUnissued) {
      if (paymentOrderProvider(order) !== 'virtual') {
        throw createHttpError('原支付通道尚未确认关闭，暂不能取消，请先查询订单', 409, 40905);
      }
      // Query every issued attempt through the existing trusted settlement path.
      // NOTPAY and "not found" remain payable and never authorize local closure.
      const queried = await membership.virtualQuery(userId, { outTradeNo: orderNo });
      assertMemberOrderCancellationState(queried.order);
      if (queried.order.status !== 'closed') {
        throw createHttpError('微信尚未确认关闭该订单，暂不能取消。请稍后查询，勿重复付款', 409, 40905);
      }
    }
    return db.runTransaction(async transaction => {
      const ref = transaction.collection(C.paymentOrders).doc(order._id);
      const current = await optionalPaymentDocument(ref);
      if (!current || Number(current.userId) !== Number(userId) || current.outTradeNo !== orderNo) {
        throw createHttpError('支付订单不存在', 404, 40400);
      }
      trustedPaymentOrder(current, user.openid);
      assertMemberOrderCancellationState(current);
      if (current.cancelledAt && current.cancelReason === 'user_requested' && current.status === 'closed') {
        return publicPaymentOrder(current);
      }
      const terminal = ['closed', 'failed'].includes(current.status);
      // Allocation and cancellation update the same order document: a racing
      // newly issued attempt or paid callback makes this transaction refuse.
      if (!terminal && (!locallyUnissued || !noIssuedVirtualPaymentAttempt(current))) {
        throw createHttpError('支付尝试或订单状态已变化，请重新查询后再取消', 409, 40905);
      }
      const timestamp = nowIso();
      const patch = { status: 'closed', cancelledAt: timestamp, cancelReason: 'user_requested',
        cancellationProof: terminal ? 'verified_terminal_order' : 'no_payment_attempts',
        closedAt: current.closedAt || timestamp, updatedAt: timestamp };
      // Do not fabricate a platform CLOSED tradeState for an unissued order.
      await settlePaymentSlot(transaction, current, order._id, true);
      await ref.update({ data: patch });
      return publicPaymentOrder({ ...current, ...patch });
    });
  },

  async internalCheckout(data = {}) {
    assertPaymentCallbackToken(data.callbackToken);
    const order = await uniquePaymentOrder(data.outTradeNo);
    if (!order) throw createHttpError('支付订单不存在', 404, 40400);
    trustedPaymentOrder(order, data.requesterOpenid);
    assertMembershipCheckoutMode(order);
    if (data.paymentProvider !== 'virtual' || paymentOrderProvider(order) !== 'virtual') {
      throw createHttpError('历史微信支付订单仅支持查询，请勿重新付款', 403, 40304);
    }
    const member = await getById(C.members, order.memberRecordId);
    if (!member && order.productType !== 'vip' && !isDirectPurchaseOrder(order)) throw createHttpError('会员关系已变更，请联系工作人员', 409, 40906);
    const user = await getById(C.users, order.userId);
    if (!user) throw createHttpError('当前微信账号状态已变化，请重新登录', 403, 40304);
    const unresolvedOrders = await unresolvedUserPaymentOrders(order.userId);
    return db.runTransaction(async transaction => {
      const orderRef = transaction.collection(C.paymentOrders).doc(order._id);
      const snapshot = await orderRef.get();
      const currentOrder = snapshot && snapshot.data;
      if (!currentOrder) throw createHttpError('支付订单不存在', 404, 40400);
      trustedPaymentOrder(currentOrder, data.requesterOpenid);
      assertMembershipCheckoutMode(currentOrder);
      if (data.paymentProvider !== 'virtual' || paymentOrderProvider(currentOrder) !== 'virtual') {
        throw createHttpError('历史微信支付订单仅支持查询，请勿重新付款', 403, 40304);
      }
      if (!['pending', 'confirming'].includes(String(currentOrder.status))) {
        throw createHttpError('支付订单状态不可下单', 409, 40905);
      }
      if (currentOrder.productType !== 'vip' && !isDirectPurchaseOrder(currentOrder) && currentOrder.status === 'confirming' && currentOrder.memberMatchmakerId === undefined) {
        throw createHttpError('历史订单会员归属未留存，请先查单并联系工作人员核查', 409, 40906);
      }
      const currentMember = member ? await optionalPaymentDocument(transaction.collection(C.members).doc(member._id)) : null;
      if (currentOrder.productType !== 'vip' && !isDirectPurchaseOrder(currentOrder) && !activePaymentMember(currentOrder, currentMember)) {
        throw createHttpError('会员关系已变更，请联系工作人员后再付款', 409, 40906);
      }
      if (currentOrder.productType === 'matchmaking' && !isDirectPurchaseOrder(currentOrder)) await vipMembership.assertMatchmakingReady(currentOrder.userId, transaction);
      const currentUser = await optionalPaymentDocument(transaction.collection(C.users).doc(user._id));
      if (!activePaymentUser(currentOrder, currentUser, true)) {
        throw createHttpError('当前微信账号或手机号状态已变化，请重新登录核查', 403, 40304);
      }
      await reservePaymentCheckout(transaction, currentOrder, order._id, unresolvedOrders);
      const relationPatch = currentOrder.productType !== 'vip' && !isDirectPurchaseOrder(currentOrder) && currentOrder.memberMatchmakerId === undefined
        ? { memberMatchmakerId: Number(currentMember.matchmakerId) } : {};
      if (String(currentOrder.status) === 'pending') {
        const timestamp = nowIso();
        const patch = { ...relationPatch, status: 'confirming', checkoutAt: timestamp, updatedAt: timestamp };
        await orderRef.update({ data: patch });
        return trustedPaymentOrder({ ...currentOrder, ...patch }, data.requesterOpenid);
      }
      if (Object.keys(relationPatch).length) {
        await orderRef.update({ data: relationPatch });
        return trustedPaymentOrder({ ...currentOrder, ...relationPatch }, data.requesterOpenid);
      }
      return trustedPaymentOrder(currentOrder, data.requesterOpenid);
    });
  },

  async internalQuery(data = {}) {
    assertPaymentCallbackToken(data.callbackToken);
    const order = await uniquePaymentOrder(data.outTradeNo);
    if (!order) throw createHttpError('支付订单不存在', 404, 40400);
    assertPaymentProviderContract(order, data);
    return trustedPaymentOrder(order, data.requesterOpenid);
  },

  async confirmPayment(data = {}, origin = {}) {
    assertPaymentCallbackToken(data.callbackToken);
    const transactionId = String(data.transactionId || '').trim();
    if (!/^[a-zA-Z0-9_-]{8,64}$/.test(transactionId)) throw createHttpError('微信支付交易号无效');
    const existingOrder = await uniquePaymentOrder(data.outTradeNo);
    if (!existingOrder) throw createHttpError('支付订单不存在', 404, 40400);
    const existingMember = await getById(C.members, existingOrder.memberRecordId);
    const existingUser = await getById(C.users, existingOrder.userId);
    const result = await db.runTransaction(async transaction => {
      const orderRef = transaction.collection(C.paymentOrders).doc(existingOrder._id);
      const currentOrder = await optionalPaymentDocument(orderRef);
      if (!currentOrder) throw createHttpError('支付订单数据不存在', 409, 40906);
      assertPurchaseContract(currentOrder);
      assertPaymentProviderContract(currentOrder, data);
      const memberRef = existingMember ? transaction.collection(C.members).doc(existingMember._id) : null;
      const currentMember = memberRef ? await optionalPaymentDocument(memberRef) : null;
      const currentUser = existingUser
        ? await optionalPaymentDocument(transaction.collection(C.users).doc(existingUser._id)) : null;
      if (isPaymentProbeOrder(existingOrder) || isPaymentProbeOrder(currentOrder)) {
        // Recheck this order's fixed test promise at fulfillment. Current
        // selection and deadline cannot change a genuinely delayed payment.
        assertTestCheckout(currentOrder);
      }
      if (!paymentConfirmationMatches(currentOrder, data)) {
        throw createHttpError('支付回调与订单不匹配', 409, 40907);
      }
      if (String(currentOrder.status) === 'paid') {
        if (currentOrder.transactionId && currentOrder.transactionId !== transactionId) {
          throw createHttpError('支付订单交易号冲突', 409, 40908);
        }
        return { order: currentOrder, member: currentMember, idempotent: true };
      }
      const paidAfterCancellation = currentOrder.status === 'closed'
        && currentOrder.cancelReason === 'user_requested' && !!currentOrder.cancelledAt;
      if (!['pending', 'confirming'].includes(String(currentOrder.status)) && !paidAfterCancellation) {
        throw createHttpError('支付订单状态不可确认', 409, 40905);
      }

      const timestamp = nowIso();
      const successTime = new Date(data.successTime || '').getTime();
      // A verified payment is a money fact even after its original membership
      // was removed or reassigned. Keep it for review without resurrecting a
      // relationship, transferring rights, or issuing an unauthorized refund.
      let canFulfill = !paidAfterCancellation && activePaymentUser(currentOrder, currentUser)
        && (currentOrder.productType === 'vip' || isDirectPurchaseOrder(currentOrder) || (activePaymentMember(currentOrder, currentMember)
          && Number.isSafeInteger(Number(currentOrder.memberMatchmakerId)) && Number(currentOrder.memberMatchmakerId) > 0));
      let serviceChanged = false;
      if (canFulfill && currentOrder.productType === 'matchmaking' && !isDirectPurchaseOrder(currentOrder)) {
        try { await vipMembership.assertMatchmakingReady(currentOrder.userId, transaction); }
        catch (error) {
          if (![403, 404, 409].includes(error.status)) throw error;
          canFulfill = false;
          serviceChanged = true;
        }
      }
      let activationRights = null;
      if (canFulfill && currentOrder.productType === 'matchmaker') {
        activationRights = await vipMembership.fulfillOrder(transaction, currentOrder, timestamp);
        if (activationRights.requiresReview || activationRights.fulfilled !== true) canFulfill = false;
      }
      const reviewReason = canFulfill ? '' : paidAfterCancellation ? 'payment_after_cancellation' : activationRights?.reviewReason || (!activePaymentUser(currentOrder, currentUser) ? 'account_changed'
        : !currentMember ? 'membership_missing'
        : Number(currentMember.status) !== 1 ? 'membership_inactive'
          : serviceChanged ? 'service_readiness_changed'
            : currentOrder.memberMatchmakerId === undefined ? 'membership_snapshot_missing' : 'membership_changed');
      const orderPatch = {
        status: 'paid', transactionId,
        confirmationSource: ['wechat_push', 'virtual_query'].includes(origin && origin.source) ? origin.source : 'internal',
        confirmationRequestId: origin && typeof origin.requestId === 'string'
          && /^[a-zA-Z0-9_-]{1,128}$/.test(origin.requestId) ? origin.requestId : '',
        fulfillmentStatus: canFulfill ? 'fulfilled' : 'requires_review',
        ...(paidAfterCancellation ? { paymentReviewRequired: true } : {}),
        reviewReason,
        fulfillmentMessage: canFulfill ? '' : paidAfterCancellation
          ? '订单取消后确认收到付款，请联系工作人员核查权益或退款，请勿重复付款。'
          : currentOrder.productType === 'matchmaker'
          ? '已确认付款，主理人申请状态已变化，请联系工作人员核查开通或退款。'
          : '已确认付款，原会员关系已变更或无法核实，请联系工作人员核查权益或退款。',
        paidAt: Number.isFinite(successTime) ? new Date(successTime).toISOString() : timestamp,
        callbackReceivedAt: timestamp, updatedAt: timestamp
      };
      await settlePaymentSlot(transaction, currentOrder, existingOrder._id, canFulfill);
      if (!canFulfill) {
        await orderRef.update({ data: orderPatch });
        return { order: { ...currentOrder, ...orderPatch }, member: null, idempotent: false };
      }
      if (['vip', 'matchmaking', 'matchmaker'].includes(currentOrder.productType)) {
        const rights = activationRights || await vipMembership.fulfillOrder(transaction, currentOrder, timestamp);
        await orderRef.update({ data: orderPatch });
        return { order: { ...currentOrder, ...orderPatch }, member: null, rights, idempotent: false };
      }
      const entitlement = buildMembershipFulfillment({
        member: currentMember,
        durationDays: Number(currentOrder.durationDays),
        now: timestamp
      });
      // Outstanding legacy cashiers remain payable. Mirror their renewal into
      // the independent ledger before changing the old relationship fields.
      await vipMembership.fulfillOrder(transaction, { ...currentOrder, productType: 'vip' }, timestamp);
      const memberPatch = {
        ...entitlement,
        membershipPaidAt: timestamp,
        lastPaymentOrderNo: currentOrder.outTradeNo,
        updatedAt: timestamp
      };
      await memberRef.update({ data: memberPatch });
      await orderRef.update({ data: orderPatch });
      return {
        order: { ...currentOrder, ...orderPatch },
        member: { ...currentMember, ...memberPatch },
        idempotent: false
      };
    });

    return {
      order: publicPaymentOrder(result.order),
      membership: result.order.fulfillmentStatus === 'requires_review' || !result.member ? null : {
        memberType: result.member.memberType,
        expireAt: result.member.expireAt || null
      },
      idempotent: result.idempotent,
      rights: result.rights || null
    };
  },

  async closePayment(data = {}) {
    assertPaymentCallbackToken(data.callbackToken);
    const tradeState = String(data.tradeState || '').toUpperCase();
    if (!['CLOSED', 'PAYERROR'].includes(tradeState)) {
      throw createHttpError('微信订单尚未确认关闭或失败', 409, 40905);
    }
    const existingOrder = await uniquePaymentOrder(data.outTradeNo);
    if (!existingOrder) throw createHttpError('支付订单不存在', 404, 40400);
    return db.runTransaction(async transaction => {
      const orderRef = transaction.collection(C.paymentOrders).doc(existingOrder._id);
      const snapshot = await orderRef.get();
      const currentOrder = snapshot && snapshot.data;
      if (!currentOrder) throw createHttpError('支付订单不存在', 404, 40400);
      assertPurchaseContract(currentOrder);
      assertPaymentProviderContract(currentOrder, data);
      if (!paymentDetailsMatch(currentOrder, data)) {
        throw createHttpError('微信查询结果与订单不匹配', 409, 40907);
      }
      if (currentOrder.paymentProvider === 'virtual'
        && (!Array.isArray(data.observedVirtualPaymentAttempts)
          || !Array.isArray(currentOrder.virtualPaymentAttempts)
          || JSON.stringify(currentOrder.virtualPaymentAttempts) !== JSON.stringify(data.observedVirtualPaymentAttempts))) {
        // A new cashier can be issued while the earlier CLOSED query is in flight.
        // Its absence from the observed snapshot cannot prove that it is closed.
        throw createHttpError('支付尝试已变化，请重新查询订单后再确认关闭', 409, 40905);
      }
      const status = tradeState === 'CLOSED' ? 'closed' : 'failed';
      if (currentOrder.status === status) return { order: publicPaymentOrder(currentOrder), idempotent: true };
      if (!['pending', 'confirming'].includes(String(currentOrder.status))) {
        throw createHttpError('支付订单状态不可关闭', 409, 40905);
      }
      const timestamp = nowIso();
      const patch = { status, tradeState, closedAt: timestamp, updatedAt: timestamp };
      await settlePaymentSlot(transaction, currentOrder, existingOrder._id, true);
      await orderRef.update({ data: patch });
      return { order: publicPaymentOrder({ ...currentOrder, ...patch }), idempotent: false };
    });
  },

  async refundPayment(data = {}) {
    assertPaymentCallbackToken(data.callbackToken);
    if (data.providerVerified !== true || data.tradeState !== 'REFUND'
      || typeof data.refundId !== 'string' || !/^[a-zA-Z0-9_-]{8,96}$/.test(data.refundId)) {
      throw createHttpError('退款结果尚未可信确认', 409, 40907);
    }
    const order = await uniquePaymentOrder(data.outTradeNo);
    if (!order) throw createHttpError('支付订单不存在', 404, 40400);
    return db.runTransaction(async transaction => {
      const ref = transaction.collection(C.paymentOrders).doc(order._id);
      const current = await optionalPaymentDocument(ref);
      if (current) assertPurchaseContract(current);
      if (current) assertPaymentProviderContract(current, data);
      if (!current || !paymentDetailsMatch(current, data) || data.transactionId !== current.transactionId
        || !Number.isSafeInteger(data.refundAmountFen) || data.refundAmountFen !== current.amountFen) {
        throw createHttpError('退款凭据与原付款订单不匹配，部分退款请人工核查', 409, 40907);
      }
      if (current.status === 'refunded') {
        if (current.refundId !== data.refundId) throw createHttpError('退款凭据存在冲突，请人工核查', 409, 40908);
        return { order: publicPaymentOrder(current), idempotent: true };
      }
      if (current.status !== 'paid') throw createHttpError('未确认付款的订单不可自动回收权益', 409, 40905);
      if (current.duplicateVirtualPayments?.length || current.reviewReason === 'duplicate_payment') {
        throw createHttpError('重复付款尚待售后核查，不能用单笔退款解除复核', 409, 40908);
      }
      const timestamp = nowIso();
      let independent = ['vip', 'matchmaking', 'matchmaker'].includes(current.productType);
      const revocation = await vipMembership.refundOrder(transaction, { ...current,
        productType: current.productType || 'vip' }, timestamp);
      independent = independent || revocation.revoked === true;
      const patch = { status: 'refunded', refundId: data.refundId, refundAmountFen: data.refundAmountFen,
        refundedAt: timestamp, updatedAt: timestamp, refundSource: String(data.refundSource || 'verified_provider').slice(0, 64),
        ...(revocation.requiresReview ? { fulfillmentStatus: 'requires_review', reviewReason: revocation.reviewReason,
          fulfillmentMessage: '已确认退款，主理人权限状态需由工作人员核查。' } : {}),
        ...(!independent ? { fulfillmentStatus: 'requires_review', reviewReason: 'legacy_refund',
          fulfillmentMessage: '历史订单已退款，请由主理人核查剩余会员权益。' } : {}) };
      await settlePaymentSlot(transaction, current, order._id, independent);
      await ref.update({ data: patch });
      return { order: publicPaymentOrder({ ...current, ...patch }), idempotent: false };
    });
  },

  // 小程序虚拟支付：为已创建的会员订单生成 requestVirtualPayment 签名参数。
  // 订单归属、会员关系与金额全部来自 hlApi 内部可信快照；客户端只提交订单号。
  async virtualCheckout(userId, data = {}) {
    const config = virtualPaymentConfig(process.env);
    if (!config.configured) throw createHttpError('微信支付尚未完成商户配置', 503, 50301);
    const outTradeNo = assertVirtualOrderNumber(String(data.outTradeNo || ''));
    const loginCode = assertVirtualLoginCode(String(data.loginCode || ''));
    const user = await getUserOrThrow(userId);
    const payerOpenid = assertVirtualPayer(String(user.openid || '').trim());
    const order = await uniquePaymentOrder(outTradeNo, userId);
    if (!order) throw createHttpError('支付订单不存在', 404, 40400);
    trustedPaymentOrder(order, payerOpenid);
    assertVirtualOrderConfiguration(order, config);
    assertMembershipCheckoutMode(order);
    let login;
    try {
      login = await virtualClient().code2session(config.appSecret, loginCode);
    } catch (error) {
      throw createHttpError(error && error.message || '微信登录态校验失败，请重新进入小程序', 503, 50301);
    }
    if (login.openid !== payerOpenid) throw createHttpError('登录态与当前账号不一致，请重新登录', 403, 40304);
    const trusted = await membership.internalCheckout({
      callbackToken: config.callbackToken, outTradeNo, requesterOpenid: payerOpenid, paymentProvider: 'virtual'
    });
    const evidence = await queryVirtualPaymentAttempts(trusted, config);
    if (evidence.results.some(result => result.xpayOrder && mapVirtualOrderState(result.xpayOrder) === 'SUCCESS')) {
      if (!paymentTestPushOnly(process.env, evidence.order)) {
        await reconcileVirtualPaymentOrder(trusted, config, { source: 'virtual_query' });
      }
      throw createHttpError('已检测到付款，请查询原订单权益，勿再次支付', 409, 40905);
    }
    if (evidence.results.some(result => result.xpayOrder
      && !['NOTPAY', 'CLOSED'].includes(mapVirtualOrderState(result.xpayOrder)))) {
      throw createHttpError('原支付尝试状态尚未核实，请查询订单或联系工作人员', 409, 40905);
    }
    const allocated = await allocateVirtualPaymentAttempt(trusted, config,
      Array.isArray(evidence.order.virtualPaymentAttempts) ? evidence.order.virtualPaymentAttempts : []);
    const planCode = trusted.order && trusted.order.planCode;
    const signData = buildVirtualSignData({
      offerId: config.offerId, env: config.env, productId: planCode,
      goodsPrice: Number(trusted.amountFen), outTradeNo: allocated.paymentAttemptNo, attach: String(planCode)
    });
    const { paySig, signature } = clientPaymentSignatures({
      signData, sessionKey: login.sessionKey, appKey: config.appKey
    });
    return {
      order: allocated.order,
      paymentAttemptNo: allocated.paymentAttemptNo,
      virtualPayment: { mode: 'short_series_goods', signData, paySig, signature }
    };
  },

  // 小程序虚拟支付：前端查单。本地订单状态 + 微信服务端查单对账后履约。
  async virtualQuery(userId, data = {}) {
    const outTradeNo = assertVirtualOrderNumber(String(data.outTradeNo || ''));
    const cancelled = await uniquePaymentOrder(outTradeNo, userId);
    if (cancelled?.status === 'closed' && cancelled.cancelReason === 'user_requested' && cancelled.cancelledAt
      && ['no_payment_attempts', 'verified_terminal_order'].includes(cancelled.cancellationProof)
      && noIssuedVirtualPaymentAttempt(cancelled)) {
      const user = await getUserOrThrow(userId);
      trustedPaymentOrder(cancelled, user.openid);
      return { order: publicPaymentOrder(cancelled) };
    }
    const config = virtualPaymentConfig(process.env);
    if (!config.configured) throw createHttpError('微信支付尚未完成商户配置', 503, 50301);
    const user = await getUserOrThrow(userId);
    const payerOpenid = assertVirtualPayer(String(user.openid || '').trim());
    const trusted = await membership.internalQuery({
      callbackToken: config.callbackToken, outTradeNo, requesterOpenid: payerOpenid, paymentProvider: 'virtual'
    });
    const order = await uniquePaymentOrder(outTradeNo, userId);
    if (paymentTestPushOnly(process.env, order)) {
      trustedPaymentOrder(order, payerOpenid);
      assertVirtualOrderConfiguration(order, config);
      return { order: publicPaymentOrder(order),
        tradeState: order.status === 'paid' && order.fulfillmentStatus === 'fulfilled' ? 'SUCCESS' : 'NOTPAY' };
    }
    return reconcileVirtualPaymentOrder(trusted, config, { source: 'virtual_query' });
  },

  // 云开发消息推送入口（xpay_goods_deliver_notify 等）。
  // 推送只是触发器：先校验字段与归属，再向微信重新查单核实后才履约。
  async handleVirtualPaymentPush(rawEvent = {}, requestId = '') {
    const config = virtualPaymentConfig(process.env);
    const eventName = String(rawEvent.Event || '');
    if (!config.configured) {
      console.warn('virtual payment push received before configuration completed', eventName);
      return { ErrCode: -1, ErrMsg: 'not configured' };
    }
    if (eventName === 'xpay_refund_notify') {
      try {
        if (rawEvent.MsgType !== 'event' || Number(rawEvent.Env) !== config.env) throw new Error('invalid refund trigger');
        // Only the locator is used. Monetary fields, RetCode and refund IDs in
        // the incoming message never authorize entitlement revocation.
        const attemptNo = assertVirtualOrderNumber(rawEvent.MchOrderId);
        const payer = assertVirtualPayer(rawEvent.OpenId);
        const order = await virtualPaymentOrderForAttempt(attemptNo);
        if (!order || order.payerOpenid !== payer) throw new Error('refund owner mismatch');
        const result = await reconcileVirtualPaymentOrder(trustedPaymentOrder(order, payer), config, { source: 'wechat_refund_push', requestId });
        if (!result?.providerRefunded || result.order?.status !== 'refunded') throw new Error('refund not confirmed');
        return { ErrCode: 0, ErrMsg: 'success' };
      } catch (_) { return { ErrCode: -1, ErrMsg: 'refund processing requires verification' }; }
    }
    if (eventName !== 'xpay_goods_deliver_notify') return { ErrCode: 0, ErrMsg: 'ignored' };
    let push;
    let businessOrderId = null;
    try {
      push = validateGoodsDeliverPush(rawEvent, config.env);
    } catch (error) {
      console.warn('invalid virtual payment deliver push ignored', error.message);
      return { ErrCode: -1, ErrMsg: 'invalid delivery request' };
    }
    try {
      const order = await virtualPaymentOrderForAttempt(push.outTradeNo);
      if (!order) {
        console.warn('virtual payment push for unknown order', push.outTradeNo);
        return { ErrCode: -1, ErrMsg: 'unknown order' };
      }
      businessOrderId = order.id;
      if (String(order.payerOpenid || '') !== push.openid) {
        console.warn('virtual payment push payer mismatch', push.outTradeNo);
        return { ErrCode: -1, ErrMsg: 'payer mismatch' };
      }
      if (String(order.planCode || '') !== push.productId || push.quantity !== 1) {
        console.warn('virtual payment push goods mismatch', push.outTradeNo);
        return { ErrCode: -1, ErrMsg: 'goods mismatch' };
      }
      const trusted = trustedPaymentOrder(order, push.openid);
      const result = await reconcileVirtualPaymentOrder(trusted, config, { source: 'wechat_push', requestId });
      if (!result || result.tradeState !== 'SUCCESS' || result.providerRefunded === true || !result.order
        || result.order.status !== 'paid' || result.order.fulfillmentStatus !== 'fulfilled'
        || result.order.virtualPaidAttemptNo !== push.outTradeNo
        || result.order.virtualDeliveryOrderNo !== push.outTradeNo
        || result.order.virtualDeliveryStatus !== 'confirmed') {
        console.log(JSON.stringify({ event: eventName, orderId: businessOrderId, attempt: push.outTradeNo,
          env: config.env, requestId, ACK: -1 }));
        return { ErrCode: -1, ErrMsg: 'delivery not fulfilled' };
      }
      const handled = await recordVirtualPushHandled(order.outTradeNo, push.outTradeNo, requestId);
      console.log(JSON.stringify({ event: eventName, orderId: handled.id, attempt: push.outTradeNo,
        env: config.env, requestId, ACK: 0 }));
      return { ErrCode: 0, ErrMsg: 'success' };
    } catch (error) {
      // ErrCode 0 会将平台订单标为已发货；未履约及待人工复核均不能成功应答。
      console.log(JSON.stringify({ event: eventName, orderId: businessOrderId, attempt: push.outTradeNo,
        env: config.env, requestId, ACK: -1 }));
      return { ErrCode: -1, ErrMsg: 'processing failed' };
    }
  },

  async listPlansForAdmin(filters = {}) {
    let rows = await getAll(C.membershipPlans, null, 500);
    if (filters.active !== undefined && filters.active !== '') {
      rows = rows.filter(row => isTrue(row.active) === isTrue(filters.active));
    }
    return paginate(rows.map(stripInternal).sort((a, b) => Number(b.sortOrder || 0) - Number(a.sortOrder || 0)), filters.page, filters.pageSize);
  },

  async upsertPlan(planCode, data = {}) {
    const normalizedCode = String(planCode || '').trim().toLowerCase();
    const existing = await getOne(C.membershipPlans, { planCode: normalizedCode });
    let plan;
    try {
      plan = normalizeMembershipPlan({
        ...(existing || {}),
        ...data,
        planCode: normalizedCode,
        active: data.active !== undefined ? data.active : (existing ? existing.active : false)
      });
    } catch (err) {
      throw createHttpError(err.message || '会员套餐配置无效');
    }
    if (existing) return stripInternal(await updateRow(C.membershipPlans, existing, plan));
    return stripInternal(await addRow(C.membershipPlans, {
      id: await nextId('membershipPlan'),
      ...plan
    }));
  },

  async listOrdersForAdmin(filters = {}) {
    if (!filters || typeof filters !== 'object' || Array.isArray(filters)) throw createHttpError('订单筛选参数无效');
    const choice = (field, values) => {
      const value = filters[field];
      if (value === undefined || value === null || value === '') return '';
      if (typeof value !== 'string' || !values.includes(value)) throw createHttpError('订单筛选参数无效');
      return value;
    };
    const positiveInteger = (value, fallback, maximum = Number.MAX_SAFE_INTEGER) => {
      if (value === undefined || value === null || value === '') return fallback;
      if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value.trim()))) {
        throw createHttpError('订单筛选或分页参数无效');
      }
      const result = Number(value);
      if (!Number.isSafeInteger(result) || result <= 0 || result > maximum) throw createHttpError('订单筛选或分页参数无效');
      return result;
    };
    const status = choice('status', ['pending', 'confirming', 'paid', 'closed', 'failed', 'refunded']);
    const fulfillmentStatus = choice('fulfillmentStatus', ['fulfilled', 'requires_review']);
    const productType = choice('productType', ['vip', 'matchmaking', 'matchmaker', 'legacy']);
    const userId = positiveInteger(filters.userId, null);
    const page = positiveInteger(filters.page, 1), pageSize = positiveInteger(filters.pageSize, 20, 100);
    if (!Number.isSafeInteger((page - 1) * pageSize)) throw createHttpError('订单分页参数无效');
    if (filters.keyword !== undefined && filters.keyword !== null
      && (typeof filters.keyword !== 'string' || filters.keyword.length > 128 || /[\x00-\x1f\x7f]/.test(filters.keyword))) {
      throw createHttpError('订单检索关键词无效');
    }
    const keyword = String(filters.keyword || '').trim().toLowerCase();
    // Filtering and sorting a capped prefix can hide the latest or review-held
    // orders forever. Read every page before computing this administration view.
    let rows = await getAll(C.paymentOrders, null, Infinity);
    if (status) rows = rows.filter(row => String(row.status) === status);
    if (fulfillmentStatus) rows = rows.filter(row => (row.fulfillmentStatus || (row.status === 'paid' ? 'fulfilled' : '')) === fulfillmentStatus);
    if (productType) rows = rows.filter(row => productType === 'legacy' ? !row.productType : row.productType === productType);
    if (userId !== null) rows = rows.filter(row => Number(row.userId) === userId);
    if (keyword) rows = rows.filter(row => [row.outTradeNo, row.planTitle, row.planCode, row.transactionId]
      .some(value => String(value || '').toLowerCase().includes(keyword)));
    return paginate(rows.map(publicPaymentOrder).sort((a, b) => Number(b.id || 0) - Number(a.id || 0)), page, pageSize);
  }
};

const matchmaker = {
  async apply(userId, data = {}) {
    const user = await getUserOrThrow(userId);
    await assertUserText(user, [data.certificationRemark]);
    let row = await getOne(C.matchmakers, { userId: user.id });
    if (!row) {
      const id = await nextId('matchmaker');
      const certificationStatus = data.certificationStatus !== undefined ? Number(data.certificationStatus) : 0;
      row = await addRow(C.matchmakers, {
        id,
        userId: user.id,
        matchmakerNo: defaultMatchmakerNo(id),
        inviteCode: await uniqueInviteCode(id),
        inviteCodeStatus: 'active',
        inviteCodeUpdatedAt: nowIso(),
        level: data.level || 1,
        parentId: data.parentId || null,
        teamId: null,
        hasStore: 0,
        certificationStatus,
        certificationRemark: data.certificationRemark || '',
        totalPerformance: 0,
        status: 1
      });
    } else if (Number(row.certificationStatus) === 1) {
      row = await updateRow(C.matchmakers, row, { certificationStatus: 0, certificationRemark: '' });
    }
    row = await ensureMatchmakerIdentity(row);
    await updateRow(C.users, user, { currentRole: 'matchmaker' });
    return stripInternal(row);
  },

  async setCertification(matchmakerId, certificationStatus, remark = '') {
    const row = await getById(C.matchmakers, matchmakerId);
    if (!row) throw createHttpError('matchmaker not found', 404, 40400);
    const normalizedStatus = normalizeCertificationStatus(certificationStatus);
    const updated = await updateRow(C.matchmakers, row, {
      certificationStatus: normalizedStatus,
      certificationRemark: remark,
      activationSource: 'manual', activationStatus: normalizedStatus === 2 ? 'manual' : 'revoked'
    });
    return stripInternal(updated);
  },

  async status(userId) {
    const row = await getOne(C.matchmakers, { userId: Number(userId), status: 1 });
    if (!row) throw createHttpError('matchmaker not found', 404, 40400);
    return { matchmaker: {
      id: Number(row.id), userId: Number(row.userId), status: Number(row.status),
      matchmakerNo: row.matchmakerNo || '', level: row.level || 1,
      certificationStatus: Number(row.certificationStatus || 0),
      certificationRemark: row.certificationRemark || '', activationSource: row.activationSource || '',
      activationStatus: row.activationStatus || '', activationLifetime: row.activationLifetime === true
    } };
  },

  async dashboard(userId) {
    const row = await getMatchmakerByUserIdOrThrow(userId);
    if (process.env.DEMO_MEMBERS !== 'false' && Number(row.certificationStatus) === 2) {
      await ensureDemoMembersForMatchmaker(userId);
    }
    const profileFields = Object.fromEntries([
      'id', 'userId', 'displayEnabled', 'realName', 'age', 'height', 'city', 'nativePlace',
      'education', 'occupation', 'incomeRange', 'maritalStatus', 'houseStatus', 'carStatus',
      'selfIntro', 'partnerRequirement', 'photos'
    ].map(field => [field, true]));
    const [allMembers, salons, matchRecords, profiles] = await Promise.all([
      getAll(C.members, { status: 1 }, Infinity, { fields: { id: true, userId: true, matchmakerId: true, status: true } }),
      getAll(C.salonEvents, { organizerId: Number(userId) }, Infinity, { fields: { id: true, status: true } }),
      getAll(C.matchRecords, { matchmakerId: row.id }, Infinity, { fields: { createdAt: true, status: true } }),
      getAll(C.profiles, null, Infinity, { fields: profileFields })
    ]);
    const members = allMembers.filter(item => item.matchmakerId === row.id);
    const memberUserIds = new Set(allMembers.map(item => Number(item.userId)));
    const profileResources = profiles
      .filter(item => isTrue(item.displayEnabled))
      .filter(item => !memberUserIds.has(Number(item.userId)))
      .filter(item => Number(item.userId) !== Number(userId));
    const users = await rowsByFieldBatches(C.users, 'id', [...members, ...profileResources].map(item => Number(item.userId)), {
      fields: { id: true, nickname: true, gender: true, status: true }
    });
    const usersById = new Map();
    users.forEach(user => { if (!usersById.has(user.id)) usersById.set(user.id, user); });
    const profilesByUserId = new Map();
    profiles.forEach(profile => {
      if (typeof profile.userId === 'number' && !profilesByUserId.has(profile.userId)) profilesByUserId.set(profile.userId, profile);
    });
    const memberViews = members.map(memberRow => {
      const profile = profilesByUserId.get(Number(memberRow.userId)) || {};
      const user = usersById.get(Number(memberRow.userId)) || {};
      const completion = profileCompletionFor({
        ...profile, realName: profile.realName || user.nickname || '', gender: user.gender || 0,
        photos: normalizeMemberPhotos(profile.photos)
      });
      return { profileCompletion: completion };
    });
    const eventIds = salons.map(item => Number(item.id));
    const registrations = eventIds.length
      ? (await rowsByFieldBatches(C.registrations, 'eventId', eventIds.flatMap(id => [id, String(id)]), {
        fields: { eventId: true, status: true }
      })).filter(item => eventIds.includes(Number(item.eventId)) && item.status === 'registered')
      : [];
    const recentBoundary = Date.now() - 7 * 86400000;
    const recentRecommendationCount = matchRecords.filter(item => {
      const time = new Date(item.createdAt || 0).getTime();
      return time && time >= recentBoundary;
    }).length;
    const todoCounts = {
      incompleteMembers: memberViews.filter(item => Number((item.profileCompletion || {}).percent || 0) < 70).length,
      pendingRecommendations: matchRecords.filter(item => item.status === 'pending').length,
      upcomingSalons: salons.filter(item => item.status === 'upcoming').length,
      salonRegistrations: registrations.length
    };
    const resourceCount = allMembers.filter(item => item.matchmakerId !== row.id
      && isTrue((profilesByUserId.get(Number(item.userId)) || {}).displayEnabled)).length
      + profileResources.filter(profile => {
        const user = usersById.get(Number(profile.userId)) || {};
        return user.status === undefined || Number(user.status) === 1;
      }).length;
    const pendingMemberRequests = (await getAll(C.memberRequests, { matchmakerId: row.id, status: 'pending' }, Infinity, { fields: { id: true } })).length;
    return {
      matchmaker: { ...stripInternal(row), memberCount: members.length },
      earnings: { today: 0, month: 0, pendingWithdraw: 0 },
      wallet: { availableAmount: 0, frozenAmount: 0, totalEarned: 0, xiCoins: 0 },
      operations: {
        salonCount: salons.length,
        registrationCount: registrations.length,
        resourceCount,
        recentRecommendationCount,
        todoCounts: {
          ...todoCounts,
          pendingMemberRequests
        }
      },
      resourceCount,
      recentRecommendationCount,
      registrationCount: registrations.length,
      pendingMemberRequests,
      todoCounts: {
        ...todoCounts,
        pendingMemberRequests
      }
    };
  },

  async inviteCard(userId) {
    const row = await getCertifiedMatchmakerByUserIdOrThrow(userId);
    const user = await getUserOrThrow(userId);
    const qrCodeFileID = await ensureInviteQrCode(row);
    const sharePath = `/pages/user/matchmaker-invite?code=${encodeURIComponent(row.inviteCode)}&source=matchmakerShare`;
    return {
      matchmakerNo: row.matchmakerNo,
      inviteCode: row.inviteCode,
      inviteCodeStatus: row.inviteCodeStatus || 'active',
      inviteCodeUpdatedAt: row.inviteCodeUpdatedAt || row.updatedAt || '',
      sharePath,
      qrCodeFileID,
      matchmaker: {
        nickname: user.nickname || '主理人',
        avatarUrl: user.avatarUrl || '',
        level: row.level || 1
      }
    };
  },

  async resetInviteCode(userId) {
    const row = await getCertifiedMatchmakerByUserIdOrThrow(userId);
    const inviteCode = await uniqueInviteCode(row.id);
    await updateRow(C.matchmakers, row, {
      inviteCode,
      inviteCodeStatus: 'active',
      inviteCodeUpdatedAt: nowIso(),
      inviteQrFileID: '',
      inviteQrCodeFor: ''
    });
    return matchmaker.inviteCard(userId);
  },

  async listMemberRequests(matchmakerUserId, filters = {}) {
    const mm = await getCertifiedMatchmakerByUserIdOrThrow(matchmakerUserId);
    let rows = await getAll(C.memberRequests, { matchmakerId: mm.id });
    if (filters.status) rows = rows.filter(row => row.status === filters.status);
    const views = await Promise.all(rows.sort((a, b) => Number(b.id || 0) - Number(a.id || 0)).map(row => memberRequestView(row)));
    return paginate(views, filters.page, filters.pageSize);
  },

  async approveMemberRequest(matchmakerUserId, requestId) {
    return approveMemberMatchmakerRequest(matchmakerUserId, requestId);
  },

  async rejectMemberRequest(matchmakerUserId, requestId, remark = '') {
    return rejectMemberMatchmakerRequest(matchmakerUserId, requestId, remark);
  }
};

const PROFILE_MUTABLE_FIELDS = [
  'realName',
  'age',
  'height',
  'education',
  'occupation',
  'incomeRange',
  'province',
  'city',
  'nativePlace',
  'maritalStatus',
  'houseStatus',
  'carStatus',
  'selfIntro',
  'partnerRequirement'
];

const PROFILE_TEXT_FIELDS = PROFILE_MUTABLE_FIELDS.filter(field => !['age', 'height'].includes(field));

function profileTextValues(data = {}) {
  for (const field of ['age', 'height']) {
    const value = data[field];
    if (value === undefined || value === null || value === '') continue;
    const decimal = typeof value === 'string' ? value.trim() : '';
    if (typeof value === 'string' && !decimal) continue;
    const valid = typeof value === 'number'
      ? Number.isFinite(value) && value >= 0
      : typeof value === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(decimal)
        && Number.isFinite(Number(decimal)) && Number(decimal) >= 0;
    if (!valid) throw createHttpError('年龄和身高须填写有效数字', 400, 40001);
  }
  return [...PROFILE_TEXT_FIELDS, 'nickname'].map(field => data[field]);
}

function editableProfilePatch(data = {}, options = {}) {
  const patch = {};
  PROFILE_MUTABLE_FIELDS.forEach(field => {
    if (Object.prototype.hasOwnProperty.call(data, field)) patch[field] = data[field];
  });
  if (Object.prototype.hasOwnProperty.call(data, 'photos')) {
    patch.photos = normalizeMemberPhotos(data.photos);
  }
  if (Object.prototype.hasOwnProperty.call(data, 'displayEnabled')) {
    patch.displayEnabled = isTrue(data.displayEnabled);
    patch.displayUpdatedAt = nowIso();
  }
  if (options.allowAssetPreferences !== false) Object.assign(patch, assetPreferencePatch(data));
  return patch;
}

function intakeProfilePatch(intake) {
  const personal = intake.personalProfile;
  const partner = intake.partnerPreferences;
  const introParts = [
    personal.personalitySummary,
    personal.hobbies ? `爱好：${personal.hobbies}` : '',
    personal.dailyRoutine ? `作息：${personal.dailyRoutine}` : ''
  ].filter(Boolean);
  const partnerParts = [
    `${partner.ageMin}-${partner.ageMax}岁`,
    partner.heightRequirement,
    `${partner.educationMinimum}学历`,
    partner.regionRequirement,
    partner.incomeAssetExpectation,
    partner.relationshipMode
  ].filter(Boolean);
  return {
    realName: intake.realName,
    age: intake.age,
    height: intake.height,
    education: intake.education,
    occupation: intake.occupation,
    city: intake.city,
    maritalStatus: intake.maritalStatus,
    selfIntro: introParts.join('；'),
    partnerRequirement: partnerParts.join('；')
  };
}

function memberTypeForIntake(intake) {
  return intake.businessRegistration.packageType === 'unpaid' ? 'no_consumption' : 'paid';
}

function privateArchivePayload(memberRow, intake, recordedByUserId) {
  return {
    memberId: Number(memberRow.id),
    matchmakerId: Number(memberRow.matchmakerId),
    userId: Number(memberRow.userId),
    intakeVersion: intake.intakeVersion,
    basic: {
      realName: intake.realName,
      gender: intake.gender,
      age: intake.age,
      birthDate: intake.birthDate,
      phone: intake.phone,
      city: intake.city,
      height: intake.height,
      weightKg: intake.weightKg,
      education: intake.education,
      graduateSchool: intake.graduateSchool,
      maritalStatus: intake.maritalStatus,
      hasChildren: intake.hasChildren,
      childrenCount: intake.childrenCount
    },
    career: {
      occupation: intake.occupation,
      companyName: intake.companyName,
      jobTitle: intake.jobTitle,
      annualIncomePreTax: intake.annualIncomePreTax,
      incomeSources: intake.incomeSources,
      otherIncomeSource: intake.otherIncomeSource,
      verificationEvidenceTypes: intake.verificationEvidenceTypes,
      verificationCredentialLocation: intake.verificationCredentialLocation
    },
    assetVerification: intake.assetVerification,
    personalProfile: intake.personalProfile,
    partnerPreferences: intake.partnerPreferences,
    businessRegistration: intake.businessRegistration,
    compliance: {
      partialVerificationConfirmed: intake.compliance.partialVerificationConfirmed,
      voluntarySubmissionConfirmed: intake.compliance.voluntarySubmissionConfirmed,
      confirmedAt: nowIso(),
      recordedByUserId: Number(recordedByUserId)
    }
  };
}

async function upsertMemberPrivateArchive(memberRow, intake, recordedByUserId, options = {}) {
  const existing = Object.hasOwn(options, 'existing') ? options.existing
    : await getOne(C.memberPrivateArchives, { memberId: Number(memberRow.id) });
  const payload = privateArchivePayload(memberRow, intake, recordedByUserId);
  const database = options.transaction || db;
  if (existing) {
    if (!options.transaction) return updateRow(C.memberPrivateArchives, existing, payload);
    const patch = { ...payload, updatedAt: nowIso() };
    const result = await database.collection(C.memberPrivateArchives).doc(existing._id).update({ data: patch });
    if (result && (result.code || result.errCode)) throw createHttpError('member private archive write failed', 503, 50301);
    return { ...existing, ...patch };
  }
  const archive = {
    id: options.archiveId || await nextId('memberPrivateArchive'),
    ...payload,
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
  const result = await database.collection(C.memberPrivateArchives).doc(`member_${Number(memberRow.id)}`).set({ data: archive });
  if (result && (result.code || result.errCode)) throw createHttpError('member private archive write failed', 503, 50301);
  return archive;
}

function privateArchiveView(row) {
  if (!row) return null;
  const compliance = row.compliance || {};
  return {
    intakeVersion: Number(row.intakeVersion || 1),
    basic: clone(row.basic || {}),
    career: clone(row.career || {}),
    assetVerification: clone(row.assetVerification || {}),
    personalProfile: clone(row.personalProfile || {}),
    partnerPreferences: clone(row.partnerPreferences || {}),
    businessRegistration: clone(row.businessRegistration || {}),
    compliance: {
      partialVerificationConfirmed: compliance.partialVerificationConfirmed === true,
      voluntarySubmissionConfirmed: compliance.voluntarySubmissionConfirmed === true,
      confirmedAt: compliance.confirmedAt || ''
    }
  };
}

async function privateArchiveViewWithMedia(row) {
  const view = privateArchiveView(row);
  if (!view) return null;
  const photos = Array.isArray(view.personalProfile.lifePhotos)
    ? view.personalProfile.lifePhotos.filter(isCloudFileID)
    : [];
  const urlMap = await memberMediaURLMap(photos);
  view.personalProfile.lifePhotos = photos.map(fileID => urlMap[fileID]).filter(Boolean);
  return view;
}

const member = {
  async resolveMatchmakerInvite(userId, data = {}) {
    await getUserOrThrow(userId);
    const preview = await matchmakerInvitePreview(data);
    const assignment = await activeMemberAssignment(userId);
    let existingRequest = null;
    if (!assignment) {
      const matchmakerRow = await resolveMatchmakerForRequest(data);
      const rows = await getAll(C.memberRequests, { userId: Number(userId), matchmakerId: Number(matchmakerRow.id) });
      existingRequest = rows.sort((a, b) => Number(b.id || 0) - Number(a.id || 0))[0] || null;
    }
    return {
      ...preview,
      alreadyAssigned: !!assignment,
      assignedMatchmakerId: assignment ? assignment.matchmakerId : null,
      existingRequest: existingRequest ? stripInternal(existingRequest) : null
    };
  },

  async requestMatchmaker(userId, data = {}) {
    return createMemberMatchmakerRequest(userId, data);
  },

  async acceptMatchmakerInvite(userId, data = {}) {
    return acceptMemberMatchmakerInvite(userId, data);
  },

  async referralCard(userId) {
    const assignment = await activeMemberAssignment(userId);
    if (!assignment) {
      return { canShare: false, reason: 'no_matchmaker' };
    }
    const matchmakerRow = await getById(C.matchmakers, assignment.matchmakerId);
    if (!matchmakerRow || Number(matchmakerRow.status) !== 1 || Number(matchmakerRow.certificationStatus) !== 2) {
      return { canShare: false, reason: 'matchmaker_unavailable' };
    }
    const matchmakerWithIdentity = await ensureMatchmakerIdentity(matchmakerRow);
    const matchmakerUser = await getById(C.users, matchmakerWithIdentity.userId);
    const sharePath = `/pages/user/matchmaker-invite?code=${encodeURIComponent(matchmakerWithIdentity.inviteCode)}&source=memberShare`;
    return {
      canShare: true,
      inviteCode: matchmakerWithIdentity.inviteCode,
      sharePath,
      matchmaker: {
        matchmakerNo: matchmakerWithIdentity.matchmakerNo,
        nickname: (matchmakerUser && matchmakerUser.nickname) || '主理人',
        avatarUrl: (matchmakerUser && matchmakerUser.avatarUrl) || '',
        level: matchmakerWithIdentity.level || 1
      }
    };
  },

  async createIdentityClaimInvite(matchmakerUserId, memberId) {
    return createMemberIdentityClaimInvite(matchmakerUserId, memberId);
  },

  async addManual(matchmakerUserId, data = {}, options = {}) {
    const mm = await getCertifiedMatchmakerByUserIdOrThrow(matchmakerUserId);
    const principalUser = await memberAssignmentUserOrThrow(matchmakerUserId);
    const requireCompleteIntake = options.requireCompleteIntake === true;
    let intake = null;
    if (requireCompleteIntake) {
      const result = validateMemberIntake(data, new Date(), {
        privatePhotoOwnerKey: String(matchmakerUserId)
      });
      if (!result.valid) {
        const validationError = createHttpError(result.firstError.message, 422, 42201);
        validationError.details = result.errors;
        throw validationError;
      }
      intake = result.data;
      data = intake;
    }

    await assertUserText(principalUser, requireCompleteIntake
      ? profileTextValues(intakeProfilePatch(intake))
      : [...profileTextValues(data), data.remark, data.serviceLevel]);
    if (!requireCompleteIntake && Object.prototype.hasOwnProperty.call(data, 'photos')) {
      data = { ...data, photos: await contentSecurity.assertImages({ images: data.photos }) };
    }

    const media = withMemberMedia(requireCompleteIntake
      ? { realName: data.realName, gender: data.gender, photos: [] }
      : data);
    let user = data.phone
      ? await uniqueActiveUser({ phone: data.phone }, '该手机号对应多条账号，请联系平台人工核验')
      : null;
    if (user) {
      user = await memberAssignmentUserOrThrow(user.id);
      const assignment = await activeMemberAssignment(user.id);
      if (assignment && Number(assignment.matchmakerId) !== Number(mm.id)) {
        throw createHttpError('member already has another matchmaker', 409, 40901);
      }
    }
    if (!user) {
      const userId = await nextId('user');
      user = await addRow(C.users, {
        id: userId,
        openid: `manual_${userId}`,
        phone: data.phone || '',
        nickname: data.realName || data.nickname || `会员${userId}`,
        avatarUrl: media.avatarUrl,
        gender: Number(data.gender || 0),
        currentRole: 'user',
        isVerified: 1,
        authVersion: 1,
        identitySource: 'matchmaker_manual',
        identityStatus: 'pending',
        status: 1
      });
    } else {
      user = await updateRow(C.users, user, {
        nickname: data.realName || data.nickname || user.nickname,
        gender: Number(data.gender || user.gender || 0),
        avatarUrl: requireCompleteIntake ? (user.avatarUrl || media.avatarUrl) : (media.avatarUrl || user.avatarUrl)
      });
    }

    const profilePatch = requireCompleteIntake
      ? { userId: user.id, ...intakeProfilePatch(intake) }
      : {
        userId: user.id,
        realName: data.realName || data.nickname || user.nickname,
        age: data.age ? Number(data.age) : null,
        height: data.height ? Number(data.height) : null,
        education: data.education || '',
        occupation: data.occupation || '',
        incomeRange: data.incomeRange || '',
        province: data.province || '',
        city: data.city || '',
        nativePlace: data.nativePlace || '',
        maritalStatus: data.maritalStatus || '',
        houseStatus: data.houseStatus || '',
        carStatus: data.carStatus || '',
        selfIntro: data.selfIntro || '',
        partnerRequirement: data.partnerRequirement || '',
        photos: media.photos
      };
    const profile = await getOne(C.profiles, { userId: user.id });
    if (!requireCompleteIntake && data.displayEnabled !== undefined) {
      profilePatch.displayEnabled = isTrue(data.displayEnabled);
      profilePatch.displayUpdatedAt = nowIso();
    } else if (!profile) {
      profilePatch.displayEnabled = false;
      profilePatch.displayUpdatedAt = nowIso();
      profilePatch.photos = [];
    }
    if (profile) await updateRow(C.profiles, profile, profilePatch);
    else await addRow(C.profiles, { id: await nextId('profile'), ...profilePatch });

    user = await memberAssignmentUserOrThrow(user.id);
    const snapshot = await memberAssignments.prepare(user.id, [
      { collection: C.matchmakers, row: mm }, { collection: C.users, row: user }, { collection: C.users, row: principalUser }
    ]);
    let row = snapshot.members.find(item => Number(item.status) === 1 && Number(item.matchmakerId) === Number(mm.id))
      || snapshot.members.find(item => Number(item.matchmakerId) === Number(mm.id));
    if (requireCompleteIntake) await vipMembership.ensureIndependentEntitlement(user.id);
    else if (row) await vipMembership.preserveLegacyEntitlement(user.id);
    const reserved = await memberAssignments.mutate(snapshot, { matchmakerId: mm.id,
      ...(row ? { memberDocumentId: row._id } : {}),
      create: memberId => ({
        memberNo: defaultMemberNo(memberId),
        memberType: requireCompleteIntake ? memberTypeForIntake(intake) : (data.memberType || 'no_consumption'),
        serviceLevel: requireCompleteIntake ? '' : (data.serviceLevel || ''),
        expireAt: requireCompleteIntake ? (intake.businessRegistration.expiryDate || null) : (data.expireAt || null),
        remark: requireCompleteIntake ? '' : (data.remark || ''),
        ...(requireCompleteIntake ? { intakeStatus: 'pending' } : {}),
        status: requireCompleteIntake ? 0 : 1
      }),
      patch: current => ({ memberNo: current.memberNo || defaultMemberNo(current.id, current.createdAt || new Date()),
        ...(!requireCompleteIntake ? { memberType: data.memberType || current.memberType,
          serviceLevel: data.serviceLevel !== undefined ? data.serviceLevel : current.serviceLevel,
          expireAt: data.expireAt !== undefined ? data.expireAt : current.expireAt,
          remark: data.remark !== undefined ? data.remark : current.remark, status: 1 } : {}) }) });
    row = reserved.member;
    if (requireCompleteIntake) {
      const archive = await getOne(C.memberPrivateArchives, { memberId: Number(row.id) });
      if (archive && (Number(archive.userId) !== Number(user.id) || Number(archive.matchmakerId) !== Number(mm.id))) {
        throw createHttpError('member private archive owner changed', 409, 40901);
      }
      const archiveId = archive?.id || await nextId('memberPrivateArchive');
      const activated = await memberAssignments.mutate(reserved.snapshot, { matchmakerId: mm.id, memberDocumentId: row._id,
        extraDocuments: [{ collection: C.memberPrivateArchives, documentId: archive?._id || `member_${Number(row.id)}`, expected: archive }],
        beforeSave: transaction => upsertMemberPrivateArchive(row, intake, matchmakerUserId, { transaction, existing: archive, archiveId }),
        patch: current => ({ memberNo: current.memberNo || defaultMemberNo(current.id, current.createdAt || new Date()),
          memberType: memberTypeForIntake(intake), serviceLevel: current.serviceLevel || '',
          expireAt: intake.businessRegistration.expiryDate || null, remark: current.remark || '', intakeStatus: 'complete', status: 1 })
      });
      row = activated.member;
    }
    await ensureMemberMatchmakerConversation(row, mm);
    return memberView(row);
  },

  async detailOwn(matchmakerUserId, memberId) {
    const mm = await getCertifiedMatchmakerByUserIdOrThrow(matchmakerUserId);
    const row = await getById(C.members, memberId);
    if (!row || Number(row.status) !== 1 || Number(row.matchmakerId) !== Number(mm.id)) {
      throw createHttpError('member not found', 404, 40400);
    }
    const activeAssignments = await getAll(C.members, { userId: Number(row.userId), status: 1 });
    if (activeAssignments.length !== 1 || Number(activeAssignments[0].id) !== Number(row.id)) {
      throw createHttpError('member not found', 404, 40400);
    }
    const archive = await getOne(C.memberPrivateArchives, { memberId: Number(row.id) });
    const view = {
      ...await memberView(row),
      privateArchive: await privateArchiveViewWithMedia(archive)
    };
    const page = await resolveMemberMediaPage({ total: 1, page: 1, pageSize: 1, list: [view] });
    return page.list[0];
  },

  async listOwn(matchmakerUserId, filters = {}) {
    const mm = await getCertifiedMatchmakerByUserIdOrThrow(matchmakerUserId);
    const views = await filteredOwnMemberViews(mm, filters);
    return resolveMemberMediaPage(paginate(views, filters.page, filters.pageSize));
  },

  async inviteOptions(matchmakerUserId, filters = {}) {
    const mm = await getOne(C.matchmakers, { userId: Number(matchmakerUserId), status: 1 });
    if (!mm) throw createHttpError('matchmaker not found', 404, 40400);
    if (Number(mm.certificationStatus) !== 2) throw createHttpError('主理人认证通过后可使用', 403, 40301);
    const rows = (await getAll(C.members, { matchmakerId: mm.id }, Infinity, { fields: {
      id: true, userId: true, status: true, memberType: true, serviceLevel: true
    } })).filter(row => Number(row.status) === 1);
    const userIds = rows.map(row => row.userId);
    const [usersById, profilesByUserId] = await Promise.all([
      getFirstRowsByNumericField(C.users, 'id', userIds, [], { complete: true, fields: { id: true, nickname: true, phone: true, gender: true } }),
      getFirstRowsByNumericField(C.profiles, 'userId', userIds, [], { complete: true, fields: {
        userId: true, realName: true, city: true, occupation: true, age: true, education: true, maritalStatus: true, incomeRange: true
      } })
    ]);
    const views = await Promise.all(rows.map(row => memberView(row, { usersById, profilesByUserId })));
    const filtered = views.filter(row => matchesMemberFilters(row, { ...filters, status: 1 })).sort((a, b) => b.id - a.id);
    return paginate(filtered.map(row => ({ id: row.id, userId: row.userId, realName: row.realName, nickname: row.nickname })), filters.page, Math.min(Number(filters.pageSize) || 100, 100));
  },

  async resources(matchmakerUserId, filters = {}) {
    const mm = await getCertifiedMatchmakerByUserIdOrThrow(matchmakerUserId);
    const rows = await getAll(C.members, { status: 1 }, Infinity);
    const matchRecords = await getAll(C.matchRecords, { matchmakerId: mm.id }, Infinity);
    const memberUserIds = new Set(rows.map(row => Number(row.userId)));
    const profiles = await getAll(C.profiles, null, Infinity);
    const profileRows = profiles
      .filter(row => row.relationshipStatus !== 'coupled' && isTrue(row.displayEnabled))
        .filter(row => !memberUserIds.has(Number(row.userId)))
        .filter(row => Number(row.userId) !== Number(matchmakerUserId));
    const context = await memberReadContext([...rows, ...profileRows], matchRecords, profiles);
    const memberViews = await Promise.all(
      rows
        .filter(row => row.matchmakerId !== mm.id)
        .map(row => publicMemberView(row, context, { keepUserId: true }))
    );
    const profileViews = await Promise.all(
      profileRows.map(async row => sanitizePublicMemberRow(
        await profileMemberView(row, context),
        { keepUserId: true }
      ))
    );
    const views = [...memberViews.filter(Boolean), ...profileViews];
    return resolveMemberMediaPage(paginate(
      views
      .filter(row => Number(row.status) === 1 && matchesMemberFilters(row, filters))
        .sort(sortMemberRowsDesc),
      filters.page,
      filters.pageSize
    ));
  },

  async showcase(userId, filters = {}) {
    await assertVipDiscoveryAccess(userId, filters);
    const [page, favoriteQuota] = await Promise.all([
      publicShowcasePage(userId, filters).then(resolveMemberMediaPage),
      memberFavoriteQuota(userId)
    ]);
    return {
      ...await withMemberDistances(await withVipBadges(page), userId),
      category: normalizeShowcaseCategory(filters.category),
      favoriteQuota
    };
  },

  async showcaseDetail(userId, publicId) {
    const id = String(publicId || '');
    const profileMatch = /^profile_(\d+)$/.exec(id);
    const source = profileMatch
      ? await getById(C.profiles, profileMatch[1]) || await getOne(C.profiles, { userId: Number(profileMatch[1]) })
      : /^\d+$/.test(id) ? await getById(C.members, id) : null;
    if (!source || Number(source.userId) === Number(userId)) throw createHttpError('member not found', 404, 40400);
    const target = await publicShowcaseTarget({ targetUserId: source.userId });
    const targetUser = await getById(C.users, target.userId);
    const states = await memberInteractionStateMap(userId, [target.userId]);
    const state = states[String(target.userId)] || {};
    if (String(target.id) !== id || !targetUser || Number(targetUser.status) !== 1
      || targetUser.mergedIntoUserId || state.hide) throw createHttpError('member not found', 404, 40400);
    let chatAccess = 'unavailable';
    try {
      await resolveChatAccess(userId, target.userId);
      chatAccess = 'allowed';
    } catch (error) {
      if (error.code === 40302) chatAccess = 'membership_required';
      else if (error.status !== 403) throw error;
    }
    const page = await resolveMemberMediaPage({ list: [{ ...target,
      viewerState: { isFavorite: !!state.favorite, isHidden: false, chatAccess } }] });
    return (await withMemberDistances(await withVipBadges(page), userId)).list[0];
  },

  async hidden(userId, filters = {}) {
    const rows = latestMemberInteractionRows(await getAll(C.memberInteractions,
      { userId: Number(userId), actionType: 'hide' }, Infinity)).filter(isActiveInteraction);
    const page = paginate(rows, filters.page, Math.min(Number(filters.pageSize) || 20, 20));
    const list = await Promise.all(page.list.map(async row => {
      let target = null;
      try {
        const user = await getById(C.users, row.targetUserId);
        if (user && Number(user.status) === 1 && !user.mergedIntoUserId) {
          target = await publicShowcaseTarget({ targetUserId: row.targetUserId });
        }
      }
      catch (error) { if (error.status !== 404) throw error; }
      // The list contains only the caller's own choices. Do not disclose a withdrawn profile.
      return { targetUserId: Number(row.targetUserId),
        displayName: target ? String(target.realName || target.nickname || '会员') : '暂未公开资料的会员',
        available: !!target };
    }));
    return { ...page, list };
  },

  async relationships(userId, filters = {}) {
    const selectedType = relationshipType(filters.type);
    const [groups, isPremiumMember, publicRows] = await Promise.all([
      favoriteRelationshipGroups(userId),
      hasPremiumMemberEntitlement(userId),
      publicShowcaseRows({ keepUserId: true })
    ]);
    const rowsByUserId = publicRows.reduce((map, row) => {
      map[String(row.userId)] = row;
      return map;
    }, {});
    const visibleGroups = {
      incoming: groups.incoming.filter(item => rowsByUserId[String(item.userId)]),
      mutual: groups.mutual.filter(item => rowsByUserId[String(item.userId)])
    };
    const selectedRows = visibleGroups[selectedType];
    const counts = {
      incoming: visibleGroups.incoming.length,
      mutual: visibleGroups.mutual.length
    };

    if (!isPremiumMember) {
      const previewRows = selectedRows.slice(0, RELATIONSHIP_LOCKED_PREVIEW_LIMIT);
      return {
        type: selectedType,
        counts,
        total: selectedRows.length,
        page: 1,
        pageSize: RELATIONSHIP_LOCKED_PREVIEW_LIMIT,
        list: previewRows.map((_item, index) => createLockedRelationshipPreview({
          kind: selectedType,
          index
        })),
        isPremiumMember: false,
        unlockRequired: true,
        unlockText: '联系主理人开通会员',
        previewCount: previewRows.length
      };
    }

    const visibleRows = selectedRows.map(item => ({
      ...rowsByUserId[String(item.userId)],
      relationshipType: selectedType,
      relationshipAt: item.relationshipAt,
      likedAt: item.incomingInteraction.updatedAt || item.incomingInteraction.createdAt || '',
      locked: false,
      blurred: false,
      canViewDetail: true,
      canRespond: selectedType === 'incoming',
      canChat: selectedType === 'mutual'
    }));
    const page = await resolveMemberMediaPage(paginate(visibleRows, filters.page, filters.pageSize || 12));
    return {
      ...page,
      type: selectedType,
      counts,
      isPremiumMember: true,
      unlockRequired: false,
      unlockText: '',
      previewCount: page.list.length
    };
  },

  async likedMe(userId, filters = {}) {
    const [groups, isPremiumMember, publicRows] = await Promise.all([
      favoriteRelationshipGroups(userId),
      hasPremiumMemberEntitlement(userId),
      publicShowcaseRows({ keepUserId: true })
    ]);
    const rowsByUserId = publicRows.reduce((map, row) => {
      map[String(row.userId)] = row;
      return map;
    }, {});
    const favoriteRows = [...groups.incoming, ...groups.mutual]
      .filter(item => rowsByUserId[String(item.userId)])
      .sort((a, b) => new Date(b.relationshipAt || 0).getTime() - new Date(a.relationshipAt || 0).getTime());
    const total = favoriteRows.length;

    if (!isPremiumMember) {
      const previewRows = favoriteRows.slice(0, LIKED_ME_LOCKED_PREVIEW_LIMIT);
      return {
        total,
        page: 1,
        pageSize: LIKED_ME_LOCKED_PREVIEW_LIMIT,
        list: previewRows.map((_item, index) => createLockedRelationshipPreview({ kind: 'incoming', index })),
        isPremiumMember: false,
        unlockRequired: true,
        unlockText: '开通会员查看完整资料',
        previewCount: previewRows.length
      };
    }

    const visibleRows = favoriteRows
      .map(item => {
        const row = rowsByUserId[String(item.userId)];
        if (!row) return null;
        return {
          ...row,
          likedAt: item.incomingInteraction.updatedAt || item.incomingInteraction.createdAt || '',
          locked: false,
          blurred: false,
          canViewDetail: true
        };
      })
      .filter(Boolean);
    const page = await resolveMemberMediaPage(paginate(visibleRows, filters.page, filters.pageSize));
    return {
      ...page,
      total,
      isPremiumMember: true,
      unlockRequired: false,
      unlockText: '',
      previewCount: page.list.length
    };
  },

  async gifts() {
    return GIFT_CATALOG.map(giftCatalogView);
  },

  async interact(userId, data = {}) {
    const actionType = String(data.actionType || '').trim();
    if (!['favorite', 'hide'].includes(actionType)) {
      throw createHttpError('unsupported interaction action');
    }
    const active = data.active === undefined ? true : isTrue(data.active);
    // Withdrawal only changes the caller's own interaction; a target may have
    // stopped sharing their profile since the original heart was sent.
    const target = !active
      ? { userId: interactionTargetUserId(data) }
      : await publicShowcaseTarget(data);
    if (Number(target.userId) === Number(userId)) {
      throw createHttpError('cannot interact with yourself');
    }

    if (actionType === 'favorite' && active && await memberRelationships.isUnmatched(userId, target.userId)) throw createHttpError('已解除匹配，无法再次发起互动', 403, 40300);
    if (actionType === 'favorite') {
      const existingFavorite = await latestMemberInteraction(userId, target.userId, 'favorite');
      const wasFavoriteActive = isActiveInteraction(existingFavorite);
      const premium = await hasPremiumMemberEntitlement(userId);
      let favoriteQuota = await memberFavoriteQuota(userId, target.userId);
      const extra = {};
      if (active && !wasFavoriteActive && !premium) {
        const beforeUse = await assertDailyFreeFavoriteQuota(userId, target.userId);
        favoriteQuota = quotaAfterFreeFavoriteUse(beforeUse);
        Object.assign(extra, {
          favoriteSource: 'free_heart',
          freeFavoriteDate: beforeUse.dateKey,
          freeFavoriteLimit: DAILY_FREE_FAVORITE_LIMIT
        });
      }
      if (active && !wasFavoriteActive && premium) Object.assign(extra, { favoriteSource: 'vip_heart' });
      const interaction = !active && !existingFavorite
        ? null : await upsertMemberInteraction(userId, target.userId, 'favorite', active, extra);
      return favoriteActionResponse(userId, target, interaction, active, wasFavoriteActive, favoriteQuota);
    }

    const existingHide = await latestMemberInteraction(userId, target.userId, 'hide');
    const interaction = !active && !existingHide ? null
      : await saveMemberHide(userId, target.userId, active, existingHide);
    const stateMap = await memberInteractionStateMap(userId, [target.userId]);
    const viewerState = stateMap[String(target.userId)] || {};
    return {
      interaction: stripInternal(interaction),
      targetUserId: Number(target.userId),
      actionType,
      active,
      mutualFavorite: false,
      canChat: false,
      conversation: null,
      notification: null,
      viewerState: {
        isFavorite: !!viewerState.favorite,
        isHidden: !!viewerState.hide
      }
    };
  },

  async sendGift(userId, data = {}) {
    const gift = giftById(data.giftId);
    if (!gift) throw createHttpError('gift not found', 404, 40400);

    const target = await publicShowcaseTarget(data);
    if (Number(target.userId) === Number(userId)) {
      throw createHttpError('cannot send gift to yourself');
    }

    if (await memberRelationships.isUnmatched(userId, target.userId)) throw createHttpError('已解除匹配，无法发送礼物', 403, 40300);
    const record = await addRow(C.giftRecords, {
      id: await nextId('giftRecord'),
      senderId: Number(userId),
      receiverId: Number(target.userId),
      targetUserId: Number(target.userId),
      targetMemberId: String(data.targetMemberId || data.memberId || target.id || ''),
      giftId: gift.id,
      giftName: gift.name,
      status: 'sent'
    });
    const existingFavorite = await getOne(C.memberInteractions, {
      userId: Number(userId),
      targetUserId: Number(target.userId),
      actionType: 'favorite'
    });
    const wasFavoriteActive = isActiveInteraction(existingFavorite);
    const favoriteInteraction = await upsertMemberInteraction(userId, target.userId, 'favorite', true, {
      favoriteSource: 'gift',
      giftRecordId: Number(record.id)
    });
    const favorite = await favoriteActionResponse(
      userId,
      target,
      favoriteInteraction,
      true,
      wasFavoriteActive,
      await dailyFreeFavoriteStats(userId, target.userId)
    );
    return {
      record: stripInternal(record),
      gift: giftCatalogView(gift),
      favorite,
      target: {
        userId: Number(target.userId),
        displayName: target.realName || target.nickname || '会员'
      }
    };
  },

  async update(matchmakerUserId, memberId, data = {}) {
    const mm = await getCertifiedMatchmakerByUserIdOrThrow(matchmakerUserId);
    const row = await getById(C.members, memberId);
    if (!row || row.matchmakerId !== mm.id) {
      throw createHttpError('member not found', 404, 40400);
    }
    let user = await getById(C.users, row.userId);
    const profile = await getOne(C.profiles, { userId: row.userId });
    const checkedProfile = isTrue(data.displayEnabled)
      ? { ...(profile || {}), nickname: user?.nickname, ...data } : data;
    await assertUserText(matchmakerUserId, [...profileTextValues(checkedProfile), data.remark, data.serviceLevel]);
    const hasNewPhotos = Object.prototype.hasOwnProperty.call(data, 'photos');
    if (hasNewPhotos || isTrue(data.displayEnabled)) {
      const images = hasNewPhotos ? data.photos : (profile?.photos?.length ? profile.photos : (user?.avatarUrl ? [user.avatarUrl] : []));
      data = { ...data, photos: await contentSecurity.assertImages({ images, skipSystem: !hasNewPhotos }) };
    }
    await vipMembership.ensureIndependentEntitlement(row.userId);
    let normalizedPhone = null;
    if (Object.prototype.hasOwnProperty.call(data, 'phone')) {
      if (!user || !isManualIdentity(user.openid)) {
        throw createHttpError('已绑定微信的会员手机号需由本人授权更新', 409, 40930);
      }
      normalizedPhone = normalizeMainlandPhone(data.phone);
      if (!normalizedPhone) throw createHttpError('请输入有效的中国大陆手机号', 422, 42220);
      const phoneOwner = await uniqueActiveUser(
        { phone: normalizedPhone },
        '该手机号对应多条账号，请联系平台人工核验'
      );
      if (phoneOwner && Number(phoneOwner.id) !== Number(user.id)) {
        throw createHttpError('该手机号已被其他账号使用，请联系平台人工核验', 409, 40920);
      }
    }
    const updated = await updateRow(C.members, row, {
      memberType: data.memberType || row.memberType,
      serviceLevel: data.serviceLevel !== undefined ? data.serviceLevel : row.serviceLevel,
      expireAt: data.expireAt !== undefined ? data.expireAt : row.expireAt,
      remark: data.remark !== undefined ? data.remark : row.remark
    });
    if (user) {
      const userPatch = {};
      if (data.realName || data.nickname) userPatch.nickname = data.realName || data.nickname;
      if (data.gender !== undefined) userPatch.gender = Number(data.gender);
      if (normalizedPhone) userPatch.phone = normalizedPhone;
      if (Object.prototype.hasOwnProperty.call(data, 'photos')) userPatch.avatarUrl = data.photos[0] || '';
      if (Object.keys(userPatch).length) user = await updateRow(C.users, user, userPatch);
    }
    if (normalizedPhone) {
      const archive = await getOne(C.memberPrivateArchives, { memberId: Number(row.id) });
      if (archive) {
        await updateRow(C.memberPrivateArchives, archive, {
          basic: { ...(archive.basic || {}), phone: normalizedPhone }
        });
      }
    }
    const profilePatch = editableProfilePatch(data, { allowAssetPreferences: false });
    if (profile && Object.keys(profilePatch).length) await updateRow(C.profiles, profile, profilePatch);
    else if (!profile) await addRow(C.profiles, { id: await nextId('profile'), userId: row.userId, displayEnabled: false, ...profilePatch });
    return memberView(updated);
  },

  async remove(matchmakerUserId, memberId) {
    const mm = await getCertifiedMatchmakerByUserIdOrThrow(matchmakerUserId);
    const principalUser = await memberAssignmentUserOrThrow(matchmakerUserId);
    const row = await getById(C.members, memberId);
    if (!row || row.matchmakerId !== mm.id) {
      throw createHttpError('member not found', 404, 40400);
    }
    await vipMembership.preserveLegacyEntitlement(row.userId);
    const snapshot = await memberAssignments.prepare(row.userId, [{ collection: C.matchmakers, row: mm }, { collection: C.users, row: principalUser }]);
    const changed = await memberAssignments.mutate(snapshot, { matchmakerId: mm.id, memberDocumentId: row._id,
      patch: { status: 0 } });
    return memberView(changed.member);
  },

  async recommend(matchmakerUserId, data = {}) {
    const mm = await getCertifiedMatchmakerByUserIdOrThrow(matchmakerUserId);
    const own = await getById(C.members, data.myMemberId);
    if (!own || Number(own.matchmakerId) !== Number(mm.id) || Number(own.status) !== 1) {
      throw createHttpError('own member not found');
    }
    await assertUserText(matchmakerUserId, [data.note], 2);
    if (data.mode === 'internal') {
      const target = await getById(C.members, data.targetMemberId);
      if (!target || Number(target.matchmakerId) !== Number(mm.id) || Number(target.status) !== 1) {
        throw createHttpError('target member not found');
      }
      if (Number(own.id) === Number(target.id) || Number(own.userId) === Number(target.userId)) {
        throw createHttpError('cannot recommend to self');
      }

      const [userAId, userBId] = Number(own.userId) < Number(target.userId)
        ? [Number(own.userId), Number(target.userId)]
        : [Number(target.userId), Number(own.userId)];
      const pending = (await getAll(C.matchRecords, { matchmakerId: mm.id, status: 'pending' }))
        .find(record => record.matchType === 'internal_recommend'
          && Number(record.userAId) === Number(userAId)
          && Number(record.userBId) === Number(userBId));
      if (pending) {
        await ensureMemberPairConversation(pending);
        return { matchRecord: stripInternal(pending), messages: [], duplicated: true };
      }

      const ownUser = await getById(C.users, own.userId);
      const targetUser = await getById(C.users, target.userId);
      const ownName = (ownUser && ownUser.nickname) || `会员${own.userId}`;
      const targetName = (targetUser && targetUser.nickname) || `会员${target.userId}`;
      const matchRecord = await addRow(C.matchRecords, {
        id: await nextId('matchRecord'),
        userAId,
        userBId,
        sourceMemberId: Number(own.id),
        targetMemberId: Number(target.id),
        matchmakerId: mm.id,
        matchType: 'internal_recommend',
        compatibilityScore: null,
        note: data.note || '',
        status: 'pending'
      });
      await ensureMemberPairConversation(matchRecord);
      const messages = await Promise.all([
        addRow(C.messages, {
          id: await nextId('message'),
          senderId: Number(matchmakerUserId),
          receiverId: Number(own.userId),
          contentType: 'text',
          content: data.note || `主理人为你推荐了会员 ${targetName}，请等待后续跟进。`,
          isRead: 0
        }),
        addRow(C.messages, {
          id: await nextId('message'),
          senderId: Number(matchmakerUserId),
          receiverId: Number(target.userId),
          contentType: 'text',
          content: data.note || `主理人为你推荐了会员 ${ownName}，请等待后续跟进。`,
          isRead: 0
        })
      ]);
      return { matchRecord: stripInternal(matchRecord), messages: messages.map(message => stripInternal(message)) };
    }

    const resourceUser = await getById(C.users, data.resourceUserId);
    if (!resourceUser || Number(resourceUser.status) !== 1 || resourceUser.mergedIntoUserId) {
      throw createHttpError('resource user not found', 404, 40400);
    }
    await publicShowcaseTarget({ targetUserId: resourceUser.id });
    if (Number(own.userId) === Number(resourceUser.id)) throw createHttpError('cannot recommend to self');

    const targetIds = _.in([Number(resourceUser.id), String(resourceUser.id)]);
    const [targetProfiles, targetMembers, principalUser] = await Promise.all([
      getAll(C.profiles, { userId: targetIds }, Infinity),
      getAll(C.members, { userId: targetIds, status: 1 }, Infinity),
      getById(C.users, matchmakerUserId)
    ]);
    // Keep publicShowcaseTarget's active-assignment precedence: an assigned
    // account uses its canonical numeric profile, otherwise any public profile.
    const targetProfile = targetMembers.length
      ? targetProfiles.find(profile => profile.userId === Number(resourceUser.id))
      : targetProfiles.find(profile => isTrue(profile.displayEnabled));
    if (!targetProfile || !principalUser) throw createHttpError('resource user not found', 404, 40400);

    const [userAId, userBId] = Number(own.userId) < Number(resourceUser.id)
      ? [Number(own.userId), Number(resourceUser.id)]
      : [Number(resourceUser.id), Number(own.userId)];
    const proposedId = await nextId('matchRecord');
    await ensureCollection(C.matchRecords);
    const matchRecord = await db.runTransaction(async transaction => {
      const [currentTarget, currentProfile, currentOwn, currentMatchmaker, currentPrincipal] = await Promise.all([
        salonTransactionDocument(transaction, C.users, resourceUser._id),
        salonTransactionDocument(transaction, C.profiles, targetProfile._id),
        salonTransactionDocument(transaction, C.members, own._id),
        salonTransactionDocument(transaction, C.matchmakers, mm._id),
        salonTransactionDocument(transaction, C.users, principalUser._id)
      ]);
      if (!currentTarget || Number(currentTarget.id) !== Number(resourceUser.id)
        || Number(currentTarget.status) !== 1 || currentTarget.mergedIntoUserId
        || !currentProfile || Number(currentProfile.userId) !== Number(resourceUser.id)
        || !isTrue(currentProfile.displayEnabled)) {
        throw createHttpError('resource user not found', 404, 40400);
      }
      if (!currentOwn || Number(currentOwn.id) !== Number(own.id) || Number(currentOwn.status) !== 1
        || Number(currentOwn.userId) !== Number(own.userId) || Number(currentOwn.matchmakerId) !== Number(mm.id)
        || !isCertifiedActiveMatchmaker(currentMatchmaker) || Number(currentMatchmaker.id) !== Number(mm.id)
        || Number(currentMatchmaker.userId) !== Number(matchmakerUserId)
        || !currentPrincipal || Number(currentPrincipal.id) !== Number(matchmakerUserId)
        || Number(currentPrincipal.status) !== 1 || currentPrincipal.mergedIntoUserId) {
        throw createHttpError('会员归属或主理人资格已变化，请刷新后重试', 403, 40301);
      }
      const documentId = `recommend_${proposedId}`;
      const existing = await salonTransactionDocument(transaction, C.matchRecords, documentId);
      if (existing) throw createHttpError('推荐记录编号冲突，请重试', 409, 40940);
      const timestamp = nowIso();
      const payload = { id: proposedId, userAId, userBId, matchmakerId: mm.id,
        matchType: 'recommend', compatibilityScore: null, status: 'pending', createdAt: timestamp, updatedAt: timestamp };
      await transaction.collection(C.matchRecords).doc(documentId).set({ data: payload });
      return payload;
    });
    await ensureMemberPairConversation(matchRecord);
    const ownUser = await getById(C.users, own.userId);
    const message = await addRow(C.messages, {
      id: await nextId('message'),
      senderId: Number(matchmakerUserId),
      receiverId: resourceUser.id,
      contentType: 'text',
      content: data.note || `主理人为您推荐了会员 ${(ownUser && ownUser.nickname) || ''}`,
      isRead: 0
    });
    return { matchRecord: stripInternal(matchRecord), message: stripInternal(message) };
  }
};

function salonRegistrationView(row, idempotent = false) {
  return { id: row.id, eventId: Number(row.eventId), userId: Number(row.userId), status: row.status,
    participantProfileVisible: row.participantProfileVisible === true, checkedInAt: row.checkedInAt || null,
    createdAt: row.createdAt || '', updatedAt: row.updatedAt || '', idempotent };
}

function assertSalonOpen(event, participantCount = null, checkSeats = true) {
  const availability = salonAvailability(event, participantCount);
  const reason = availability.registrationBlockedReason;
  if (!reason || (!checkSeats && reason === 'full')) return;
  const labels = { expired: '活动已过报名时间', cancelled: '活动已取消', ended: '活动已结束',
    full: '活动名额已满', invalid_date: '活动时间无效，暂不能报名', not_open: '活动尚未开放报名' };
  const error = createHttpError(labels[reason] || '活动暂不能报名', 409, 40940);
  error.details = [{ field: 'event', code: reason }];
  throw error;
}

async function salonTransactionDocument(transaction, collectionName, documentId) {
  try {
    const result = await transaction.collection(collectionName).doc(documentId).get();
    return result.data ? { ...result.data, _id: documentId } : null;
  } catch (err) {
    if (/DOCUMENT_NOT_EXIST|document(?:\s+does)?\s+not\s+(?:exist|found)|document[^\n]*does not exist/i.test(String(err?.errCode || err?.code || '') + ' ' + String(err?.errMsg || err?.message || ''))) return null;
    throw err;
  }
}

function salonCountSignature(event) {
  return JSON.stringify([event.registrationCountVersion || 0, event.registrationRevision || 0,
    event.status, event.eventDate, event.maxParticipants, event.currentParticipants, event.updatedAt || '']);
}

async function salonMutationRows(event, userId) {
  const eventIds = _.in([Number(event.id), String(event.id)]);
  if (event.registrationCountVersion !== 1) return getAll(C.registrations, { eventId: eventIds }, Infinity);
  return getAll(C.registrations, _.and([{ eventId: eventIds }, _.or([
    { userId: _.in([Number(userId), String(userId)]) }, { userId: db.RegExp({ regexp: '^' }) }
  ])]), Infinity);
}

async function getSalonRegistrationContext(eventId, userId) {
  const event = await getById(C.salonEvents, eventId);
  if (!event) throw createHttpError('活动不存在', 404, 40400);
  const registrations = await getAll(C.registrations, { eventId: _.in([Number(event.id), String(event.id)]) }, Infinity);
  const active = activeAttendance(registrations);
  const isOrganizer = Number(event.organizerId) === Number(userId);
  const isAttendee = active.some(row => Number(row.userId) === Number(userId));
  if (!['upcoming', 'ended', 'cancelled'].includes(event.status) && !isOrganizer && !isAttendee) {
    throw createHttpError('活动不存在或尚未公开', 404, 40400);
  }
  return { event, registrations, active, canViewProfiles: isOrganizer || isAttendee };
}

async function getSalonCreator(userId) {
  const [user, matchmakerRow] = await Promise.all([getUserOrThrow(userId), getOne(C.matchmakers, { userId: Number(userId), status: 1 })]);
  if (Number(user.status) !== 1 || user.mergedIntoUserId || !matchmakerRow || Number(matchmakerRow.certificationStatus) !== 2) {
    throw createHttpError('主理人或合伙人审核通过后可发起活动', 403, 40301);
  }
  // A claimed parent/level/currentRole never grants publishing authority. Both
  // certified principals and certified partners must pass this eligibility gate.
  const parentId = Number(matchmakerRow.parentId || 0);
  if (matchmakerRow.parentId && (!Number.isSafeInteger(parentId) || parentId <= 0 || parentId === Number(matchmakerRow.id))) {
    throw createHttpError('合伙人所属主理人关系无效，请联系平台核验', 403, 40301);
  }
  const parent = parentId > 0 ? await getById(C.matchmakers, parentId) : null;
  if (parentId > 0 && !isCertifiedActiveMatchmaker(parent)) throw createHttpError('所属主理人未通过审核或已停用，暂不能发起活动', 403, 40301);
  return { user, parent, matchmaker: matchmakerRow,
    role: isCertifiedActiveMatchmaker(parent) ? 'partner' : 'matchmaker' };
}

async function assertSalonOwner(event, userId) {
  if (Number(event.organizerId) !== Number(userId)) throw createHttpError('仅活动发起人可管理此活动', 403, 40300);
  return getSalonCreator(userId);
}

function salonPublicationSignature(event) {
  return JSON.stringify([salonCountSignature(event), event.organizerId, event.organizerMatchmakerId,
    event.organizerRole, event.title, event.description, event.coverImage, event.location, event.price, event.reviewRemark]);
}

async function saveSalonPublication(creator, data, event = null) {
  if (typeof db.runTransaction !== 'function') throw createHttpError('活动发布暂不可用，请稍后重试', 503, 50301);
  return db.runTransaction(async transaction => {
    const [user, matchmaker, parent] = await Promise.all([
      salonTransactionDocument(transaction, C.users, creator.user._id),
      salonTransactionDocument(transaction, C.matchmakers, creator.matchmaker._id),
      creator.parent ? salonTransactionDocument(transaction, C.matchmakers, creator.parent._id) : null
    ]);
    if (!user || Number(user.id) !== Number(creator.user.id) || Number(user.status) !== 1 || user.mergedIntoUserId
      || !isCertifiedActiveMatchmaker(matchmaker) || Number(matchmaker.userId) !== Number(user.id)
      || Number(matchmaker.id) !== Number(creator.matchmaker.id)
      || Number(matchmaker.parentId || 0) !== Number(creator.matchmaker.parentId || 0)
      || creator.parent && (!isCertifiedActiveMatchmaker(parent) || Number(parent.id) !== Number(creator.parent.id))) {
      throw createHttpError('主理人或合伙人资格已变化，请重新确认后发布', 403, 40301);
    }
    const timestamp = nowIso();
    let saved, documentId;
    if (event) {
      const current = await salonTransactionDocument(transaction, C.salonEvents, event._id);
      if (!current || salonPublicationSignature(current) !== salonPublicationSignature(event)) {
        throw createHttpError('活动信息已变化，请刷新后重试', 409, 40942);
      }
      saved = { ...current, ...data, updatedAt: timestamp };
      documentId = event._id;
    } else {
      const counter = await salonTransactionDocument(transaction, C.counters, 'salon');
      const id = Number(counter?.value || 0) + 1;
      if (!Number.isSafeInteger(id) || id <= 0) throw createHttpError('活动编号暂不可用，请稍后重试', 503, 50301);
      const result = await transaction.collection(C.counters).doc('salon').set({ data: { key: 'salon', value: id, updatedAt: timestamp } });
      if (result && (result.errCode || result.code)) throw createHttpError('活动发布失败，请稍后重试', 503, 50301);
      saved = { ...data, id, createdAt: timestamp, updatedAt: timestamp };
      documentId = `salon_${crypto.randomUUID()}`;
    }
    const { _id, _openid, ...payload } = saved;
    const result = await transaction.collection(C.salonEvents).doc(documentId)[event ? 'update' : 'set']({ data: payload });
    if (result && (result.errCode || result.code)) throw createHttpError('活动发布失败，请稍后重试', 503, 50301);
    return stripInternal(saved);
  });
}

async function mutateSalonRegistration(eventId, userId, options = {}) {
  // Only doc() is supported inside CloudBase transactions. Legacy discovery is
  // outside the transaction, with a revision check for its one-time count repair.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const event = await getById(C.salonEvents, eventId);
    if (!event) throw createHttpError('活动不存在', 404, 40400);
    const rows = await salonMutationRows(event, userId);
    const own = rows.filter(row => Number(row.userId) === Number(userId));
    if (own.length > 40) throw createHttpError('报名记录重复过多，请联系平台核验', 409, 40941);
    const canonicalId = `salon_${Number(event.id)}_user_${Number(userId)}`;
    const documentIds = Array.from(new Set([canonicalId, ...own.map(row => row._id).filter(Boolean)]));
    try {
      return await db.runTransaction(async transaction => {
        const [currentEvent, currentRows, currentUser, currentProfile] = await Promise.all([
          salonTransactionDocument(transaction, C.salonEvents, event._id),
          Promise.all(documentIds.map(id => salonTransactionDocument(transaction, C.registrations, id))),
          options.user ? salonTransactionDocument(transaction, C.users, options.user._id) : Promise.resolve(null),
          options.profile?._id ? salonTransactionDocument(transaction, C.profiles, options.profile._id) : Promise.resolve(null)
        ]);
        if (!currentEvent) throw createHttpError('活动不存在', 404, 40400);
        if (event.registrationCountVersion !== 1 && salonCountSignature(currentEvent) !== salonCountSignature(event)) {
          const error = new Error('salon registration context changed');
          error.code = 'SALON_CONTEXT_CHANGED';
          throw error;
        }
        const currentOwn = currentRows.filter(row => row && Number(row.eventId) === Number(event.id) && Number(row.userId) === Number(userId));
        const active = activeAttendance(currentOwn)[0];
        const count = currentEvent.registrationCountVersion === 1
          ? Math.max(Number(currentEvent.currentParticipants) || 0, 0) : activeAttendance(rows).length;
        const eventRef = transaction.collection(C.salonEvents).doc(event._id);
        const timestamp = nowIso();
        const revision = Number(currentEvent.registrationRevision || 0) + 1;
        if (options.cancel) {
          const registered = currentOwn.filter(row => row.status === 'registered');
          if (!registered.length) {
            if (currentOwn.length) return salonRegistrationView(currentOwn[0], true);
            throw createHttpError('报名记录不存在', 404, 40400);
          }
          const update = { status: 'cancelled', participantProfileVisible: false, registrationRevision: revision, updatedAt: timestamp };
          await Promise.all(registered.map(row => transaction.collection(C.registrations).doc(row._id).update({ data: update })));
          await eventRef.update({ data: { currentParticipants: Math.max(0, count - (active ? 1 : 0)),
            registrationCountVersion: 1, registrationRevision: revision, updatedAt: timestamp } });
          return salonRegistrationView({ ...registered[0], ...update }, !active);
        }
        assertSalonOpen(currentEvent, null, false);
        if (!currentUser || Number(currentUser.status) !== 1 || currentUser.mergedIntoUserId) throw createHttpError('登录状态已失效，请重新登录', 401, 40100);
        if (!minimumRegistrationStatus(currentUser, currentProfile || {}).complete
          || registrationPhotos(currentUser, currentProfile || {}).some(photo => !options.validatedPhotos.includes(photo))) {
          throw createHttpError('报名资料已变化，请重新确认', 422, 42230);
        }
        if (active) {
          let result = active;
          if (options.participantProfileVisible === true && active.participantProfileVisible !== true) {
            const update = { participantProfileVisible: true, registrationRevision: revision, updatedAt: timestamp };
            await transaction.collection(C.registrations).doc(active._id).update({ data: update });
            result = { ...active, ...update };
          }
          if (currentEvent.registrationCountVersion !== 1) await eventRef.update({ data: {
            currentParticipants: count, registrationCountVersion: 1, registrationRevision: revision, updatedAt: timestamp
          } });
          return salonRegistrationView(result, true);
        }
        assertSalonOpen(currentEvent, count);
        const inactive = currentOwn.find(row => row._id === canonicalId) || currentOwn[0];
        let id = inactive?.id;
        if (!inactive) {
          const counter = await salonTransactionDocument(transaction, C.counters, 'registration');
          id = (Number(counter?.value) || 0) + 1;
          await transaction.collection(C.counters).doc('registration').set({ data: { key: 'registration', value: id, updatedAt: timestamp } });
        }
        const record = { id, eventId: Number(currentEvent.id), userId: Number(userId), status: 'registered',
          participantProfileVisible: options.participantProfileVisible === true, registrationRevision: revision,
          checkedInAt: null, createdAt: inactive?.createdAt || timestamp, updatedAt: timestamp };
        if (inactive) await transaction.collection(C.registrations).doc(inactive._id).update({ data: record });
        else await transaction.collection(C.registrations).doc(canonicalId).set({ data: record });
        assertSalonOpen(currentEvent, count);
        await eventRef.update({ data: { currentParticipants: count + 1, registrationCountVersion: 1,
          registrationRevision: revision, updatedAt: timestamp } });
        return salonRegistrationView(record);
      });
    } catch (err) {
      if (err.code !== 'SALON_CONTEXT_CHANGED') throw err;
    }
  }
  throw createHttpError('报名人数正在更新，请稍后重试', 409, 40942);
}

const salon = {
  async createEvent(organizerUserId, data = {}) {
    const creator = await getSalonCreator(organizerUserId);
    if (!data.title || !data.eventDate) throw createHttpError('title and eventDate are required');
    const eventDate = new Date(data.eventDate);
    if (!Number.isFinite(eventDate.getTime()) || eventDate.getTime() <= Date.now()) throw createHttpError('请选择未来的活动时间', 422, 42240);
    const maxParticipants = Number(data.maxParticipants || 0);
    const price = Number(data.price || 0);
    if (!Number.isSafeInteger(maxParticipants) || maxParticipants < 0 || !Number.isFinite(price) || price < 0) throw createHttpError('活动名额和价格无效', 422, 42240);
    await assertUserText(creator.user, [data.title, data.description, data.location], 3);
    const checkedCover = await contentSecurity.assertImages({ images: data.coverImage ? [data.coverImage] : [] });
    return saveSalonPublication(creator, {
      title: data.title,
      description: data.description || '',
      coverImage: checkedCover[0] || '',
      location: data.location || '',
      eventDate: eventDate.toISOString(),
      maxParticipants,
      currentParticipants: 0,
      registrationCountVersion: 1,
      registrationRevision: 0,
      price,
      organizerId: Number(organizerUserId),
      organizerMatchmakerId: Number(creator.matchmaker.id),
      organizerRole: creator.role,
      status: 'upcoming',
      reviewRemark: ''
    });
  },

  async listEvents(filters = {}, currentUserId = null) {
    const period = ['upcoming', 'past'].includes(filters.period) ? filters.period : '';
    const publicStatus = ['upcoming', 'ended', 'cancelled'].includes(filters.status) ? filters.status : 'upcoming';
    const statuses = period === 'past' ? _.in(['upcoming', 'ended', 'cancelled']) : (period ? 'upcoming' : publicStatus);
    let rows = await getAll(C.salonEvents, { status: statuses }, Infinity);
    if (period) {
      const now = Date.now();
      rows = rows.filter(row => {
        const startsAt = new Date(row.eventDate).getTime();
        const past = row.status === 'ended' || row.status === 'cancelled' || (Number.isFinite(startsAt) && startsAt <= now);
        return period === 'past' ? past : !past;
      });
    }
    rows = rows.sort((a, b) => period === 'past' ? new Date(b.eventDate) - new Date(a.eventDate) : new Date(a.eventDate) - new Date(b.eventDate));
    const page = paginate(rows, filters.page, filters.pageSize);
    const context = await eventViewContext(page.list, currentUserId);
    return { ...page, list: await Promise.all(page.list.map(row => eventView(row, currentUserId, context))) };
  },

  async getEventDetail(eventId, currentUserId = null) {
    const event = await getById(C.salonEvents, eventId);
    if (!event) return null;
    await getSalonRegistrationContext(event.id, currentUserId);
    return eventView(event, currentUserId);
  },

  async shareCard(eventId, userId) {
    const event = await getById(C.salonEvents, eventId);
    if (!event) throw createHttpError('event not found', 404, 40400);
    const eventSummary = {
      id: event.id,
      title: event.title || '精选沙龙',
      eventDate: event.eventDate || '',
      location: event.location || '',
      status: event.status || ''
    };
    const initialAvailability = salonAvailability(event, 0);
    if (!initialAvailability.canRegister) return { canShare: false, reason: initialAvailability.registrationBlockedReason, event: eventSummary };
    const access = await getSalonRegistrationContext(event.id, userId);
    const availability = salonAvailability(event, access.active.length);
    if (!availability.canRegister) {
      return { canShare: false, reason: availability.registrationBlockedReason, event: eventSummary };
    }
    if (!access.canViewProfiles) {
      return { canShare: false, reason: 'not_registered', event: eventSummary };
    }
    const sharePath = `/pages/user/salon-detail?id=${encodeURIComponent(String(event.id))}&source=memberSalonShare`;
    return {
      canShare: true,
      title: `邀请你报名沙龙《${eventSummary.title}》`,
      sharePath,
      event: eventSummary
    };
  },

  async register(eventId, userId, options = {}) {
    const event = await getById(C.salonEvents, eventId);
    if (!event) throw createHttpError('活动不存在', 404, 40400);
    assertSalonOpen(event, null, false);
    const [user, profile] = await Promise.all([getUserOrThrow(userId), getOne(C.profiles, { userId: Number(userId) })]);
    const requirements = minimumRegistrationStatus(user, profile || {});
    if (!requirements.complete) {
      const error = createHttpError('请先完善手机号、称呼和本人照片', 422, 42230);
      error.details = requirements.missingFields.map(field => ({ field, code: 'required' }));
      throw error;
    }
    const validatedPhotos = registrationPhotos(user, profile || {});
    await validateRegistrationPhotos(validatedPhotos);
    await Promise.all([ensureCollection(C.registrations), ensureCollection(C.counters)]);
    return mutateSalonRegistration(event.id, userId, { participantProfileVisible: options.participantProfileVisible === true,
      user, profile, validatedPhotos });
  },

  async cancelRegistration(eventId, userId) {
    return mutateSalonRegistration(eventId, userId, { cancel: true });
  },

  async participants(eventId, viewerUserId, filters = {}) {
    const access = await getSalonRegistrationContext(eventId, viewerUserId);
    const hidden = await salonHiddenUserIds(viewerUserId, access.active.map(row => row.userId));
    const targetIds = access.active.map(row => Number(row.userId)).filter(id => !hidden.has(id));
    const [users, profiles] = await Promise.all([
      getFirstRowsByNumericField(C.users, 'id', targetIds, [], { complete: true, fields: { id: true, nickname: true, avatarUrl: true, status: true, gender: true } }),
      getFirstRowsByNumericField(C.profiles, 'userId', targetIds, [], { complete: true, fields: { userId: true, realName: true, photos: true, displayEnabled: true } })
    ]);
    const list = access.active.filter(row => !hidden.has(Number(row.userId))).map(row => {
      const targetId = Number(row.userId);
      const user = users.get(targetId);
      if (!user || Number(user.status) !== 1) return null;
      const profile = profiles.get(targetId) || {};
      return { id: `participant_${targetId}`, userId: targetId, ...salonAttendeeIdentity(user, profile),
        isSelf: targetId === Number(viewerUserId),
        canViewProfile: access.canViewProfiles && salonProfileConsent(row, profile) };
    }).filter(Boolean);
    const page = paginate(list, filters.page, Math.min(Math.max(Number(filters.pageSize) || 20, 1), 50));
    const resolved = await resolveMemberMediaPage(page);
    return { ...resolved, canViewProfiles: access.canViewProfiles,
      visibilityNote: '名单向已登录用户展示；资料仅本场报名者及组织者可查看，手机号和内部档案不公开。' };
  },

  async participantProfile(eventId, viewerUserId, targetUserId) {
    const access = await getSalonRegistrationContext(eventId, viewerUserId);
    if (!access.canViewProfiles) throw createHttpError('报名本场活动后可查看参与者公开资料', 403, 40340);
    const targetId = Number(targetUserId);
    const registration = access.active.find(row => Number(row.userId) === targetId);
    if (!registration) throw createHttpError('该参与者已取消报名或不存在', 404, 40400);
    const hidden = await salonHiddenUserIds(viewerUserId, [targetId]);
    if (hidden.has(targetId)) throw createHttpError('该参与者资料不可查看', 404, 40400);
    const [user, sourceProfile] = await Promise.all([
      getOne(C.users, { id: targetId }, { fields: { id: true, nickname: true, gender: true, isVerified: true, status: true } }),
      getOne(C.profiles, { userId: targetId }, { fields: SHOWCASE_PROFILE_FIELDS })
    ]);
    if (!user || Number(user.status) !== 1) throw createHttpError('该参与者资料不可查看', 404, 40400);
    const profile = sourceProfile || { id: targetId, userId: targetId };
    if (!salonProfileConsent(registration, profile)) throw createHttpError('该参与者未同意展示活动资料', 403, 40341);
    const publicProfile = { ...profile, photos: salonPublicPhotos(profile) };
    const view = sanitizePublicMemberRow(await profileMemberView(publicProfile, { usersById: new Map([[targetId, user]]) }), { keepUserId: true });
    const resolved = await resolveMemberMediaPage({ total: 1, page: 1, pageSize: 1, list: [view] });
    // URL resolution is asynchronous. Recheck the activity-scoped grant after it,
    // so a cancellation or hide during enrichment cannot release a stale DTO.
    const currentAccess = await getSalonRegistrationContext(eventId, viewerUserId);
    const currentRegistration = currentAccess.active.find(row => Number(row.userId) === targetId);
    if (!currentAccess.canViewProfiles) throw createHttpError('报名本场活动后可查看参与者公开资料', 403, 40340);
    if (!currentRegistration) throw createHttpError('该参与者已取消报名或不存在', 404, 40400);
    const [currentHidden, currentTarget, currentViewer, currentVisibility] = await Promise.all([
      salonHiddenUserIds(viewerUserId, [targetId]),
      getOne(C.users, { id: targetId }, { fields: { status: true } }),
      getOne(C.users, { id: Number(viewerUserId) }, { fields: { status: true } }),
      getOne(C.profiles, { userId: targetId }, { fields: { displayEnabled: true } })
    ]);
    if (currentHidden.has(targetId) || Number(currentTarget?.status) !== 1 || Number(currentViewer?.status) !== 1) throw createHttpError('该参与者资料不可查看', 404, 40400);
    if (!salonProfileConsent(currentRegistration, currentVisibility || {})) throw createHttpError('该参与者未同意展示活动资料', 403, 40341);
    return { ...resolved.list[0], eventId: Number(access.event.id), profileDisclosure: currentRegistration.participantProfileVisible === true ? 'event' : 'public' };
  },

  async myRegistrations(userId, filters = {}) {
    const rows = (await getAll(C.registrations, { userId: Number(userId) }, Infinity))
      .filter(reg => reg.status !== 'cancelled')
      .sort((a, b) => b.id - a.id);
    const page = paginate(rows, filters.page, filters.pageSize);
    const eventIds = page.list.map(reg => Number(reg.eventId));
    const eventsById = await getFirstRowsByNumericField(C.salonEvents, 'id', eventIds, [], { complete: true });
    const events = Array.from(eventsById.values()).filter(Boolean);
    const context = await eventViewContext(events);
    const views = await Promise.all(page.list.map(async reg => ({
      ...stripInternal(reg),
      event: await eventView(eventsById.get(Number(reg.eventId)) || await getById(C.salonEvents, reg.eventId), null, context)
    })));
    return { ...page, list: views };
  },

  async myEvents(organizerUserId, filters = {}) {
    const rows = (await getAll(C.salonEvents, { organizerId: Number(organizerUserId) }, Infinity))
      .sort((a, b) => b.id - a.id);
    const page = paginate(rows, filters.page, filters.pageSize);
    const context = await eventViewContext(page.list);
    return { ...page, list: await Promise.all(page.list.map(row => eventView(row, null, context))) };
  },

  async updateEvent(eventId, organizerUserId, data = {}) {
    const event = await getById(C.salonEvents, eventId);
    if (!event) throw createHttpError('event not found', 404, 40400);
    const creator = await assertSalonOwner(event, organizerUserId);
    if (['ended', 'cancelled'].includes(event.status) || salonAvailability(event).isExpired) throw createHttpError('已结束或已取消的活动不能修改');
    const patch = {};
    ['title', 'description', 'coverImage', 'location'].forEach(key => {
      if (data[key] !== undefined) patch[key] = data[key];
    });
    if (data.eventDate !== undefined) {
      const eventDate = new Date(data.eventDate);
      if (!Number.isFinite(eventDate.getTime()) || eventDate.getTime() <= Date.now()) throw createHttpError('请选择未来的活动时间', 422, 42240);
      patch.eventDate = eventDate.toISOString();
    }
    if (data.maxParticipants !== undefined) {
      const maxParticipants = Number(data.maxParticipants);
      if (!Number.isSafeInteger(maxParticipants) || maxParticipants < 0) throw createHttpError('活动名额无效', 422, 42240);
      const count = activeAttendance(await getAll(C.registrations, { eventId: _.in([Number(event.id), String(event.id)]) }, Infinity)).length;
      if (maxParticipants > 0 && maxParticipants < count) throw createHttpError('活动名额不能少于当前已报名人数', 409, 40940);
      patch.maxParticipants = maxParticipants;
    }
    if (data.price !== undefined) {
      const price = Number(data.price);
      if (!Number.isFinite(price) || price < 0) throw createHttpError('活动价格无效', 422, 42240);
      patch.price = price;
    }
    if (['upcoming', 'pending', 'rejected'].includes(event.status) && Object.keys(patch).length) {
      const nextTitle = patch.title === undefined ? event.title : patch.title;
      const nextDate = new Date(patch.eventDate || event.eventDate);
      if (!String(nextTitle || '').trim() || !Number.isFinite(nextDate.getTime()) || nextDate.getTime() <= Date.now()) {
        throw createHttpError('请填写活动标题并选择未来的活动时间', 422, 42240);
      }
      patch.status = 'upcoming';
      patch.reviewRemark = '';
    }
    await assertUserText(creator.user, ['title', 'description', 'location'].map(key =>
      patch[key] === undefined ? event[key] : patch[key]), 3);
    const cover = patch.coverImage === undefined ? event.coverImage : patch.coverImage;
    const checkedCover = await contentSecurity.assertImages({ images: cover ? [cover] : [] });
    patch.coverImage = checkedCover[0] || '';
    return saveSalonPublication(creator, patch, event);
  },

  async cancelEvent(eventId, organizerUserId) {
    const event = await getById(C.salonEvents, eventId);
    if (!event) throw createHttpError('event not found', 404, 40400);
    await assertSalonOwner(event, organizerUserId);
    return stripInternal(await updateRow(C.salonEvents, event, { status: 'cancelled' }));
  },

  async inviteMembers(eventId, organizerUserId, userIds = [], options = {}) {
    const event = await getById(C.salonEvents, eventId);
    if (!event) throw createHttpError('event not found', 404, 40400);
    const creator = await assertSalonOwner(event, organizerUserId);
    assertSalonOpen(event);
    const mm = creator.matchmaker;
    const targetIds = userIds.map(Number);
    const validMembers = (await getAll(C.members, { matchmakerId: mm.id, status: 1 }))
      .filter(row => options.all === true || targetIds.includes(Number(row.userId)));
    const result = { invited: 0, alreadyRegistered: 0, failed: 0 };
    for (const row of validMembers) {
      const registered = await getOne(C.registrations, { eventId: event.id, userId: row.userId, status: 'registered' });
      if (registered) {
        result.alreadyRegistered += 1;
        continue;
      }
      await addRow(C.messages, {
        id: await nextId('message'),
        senderId: Number(organizerUserId),
        receiverId: row.userId,
        contentType: 'system',
        content: `您被邀请参加沙龙活动《${event.title}》。`,
        isRead: 0
      });
      result.invited += 1;
    }
    return result;
  }
};

function certificationOwnerRecord(record, userId) {
  if (record && Number(record.userId) !== Number(userId)) {
    throw createHttpError('认证申请归属不一致，请联系工作人员', 409, 40940);
  }
  return record || {};
}

function certificationRecordData(record, patch = {}) {
  const { _id: _documentId, _openid: _databaseOwner, ...data } = record;
  return { ...data, ...patch };
}

function certificationSecrets() {
  return { encryptionKey: process.env.MEMBER_CERTIFICATION_ENCRYPTION_KEY, jwtSecret: process.env.JWT_SECRET,
    jwtDerivedKey: process.env.MEMBER_CERTIFICATION_JWT_DERIVED_KEY };
}

function certificationAdminCredentialFingerprint() {
  const configuredCode = process.env.ADMIN_CODE;
  if (typeof configuredCode !== 'string' || !configuredCode.trim() || configuredCode.trim().toUpperCase() === 'HLADMIN') {
    throw createHttpError('管理员认证核验暂未正确配置，请联系管理员', 503, 50340);
  }
  const jwtSecret = process.env.JWT_SECRET;
  if (typeof jwtSecret !== 'string' || jwtSecret.length < 32) throw createHttpError('管理员认证核验暂未正确配置，请联系管理员', 503, 50340);
  return crypto.createHmac('sha256', jwtSecret).update(JSON.stringify(['hl.member-certification.admin-access.v1', configuredCode])).digest('hex');
}

function requireCertificationAdminAccess(session) {
  const current = certificationAdminCredentialFingerprint();
  if (session.certificationAdminVersion !== 1 || typeof session.certificationCredentialFingerprint !== 'string'
    || !/^[a-f0-9]{64}$/.test(session.certificationCredentialFingerprint)
    || !crypto.timingSafeEqual(Buffer.from(current, 'hex'), Buffer.from(session.certificationCredentialFingerprint, 'hex'))) {
    throw createHttpError('请重新管理员登录后核验认证申请', 401, 40102);
  }
}

function certificationMaterialMetadata(material) {
  return { id: material.id, kind: material.kind, mimeType: material.mimeType, size: material.size, createdAt: material.createdAt };
}

function certificationMaterialIsBound(record, id) {
  return !!record.materials?.[id]?.applicationId || Object.values(record.applications || {}).some(application => application.materialIds?.includes(id))
    || (record.applicationHistory || []).some(application => application.materialIds?.includes(id));
}

function certificationUploadReplay(record, clientRequestId, fingerprint) {
  if (!clientRequestId) return null;
  const existing = Object.values(record.materials || {}).find(material => material.clientRequestId === clientRequestId);
  if (!existing) return null;
  if (existing.requestFingerprint !== fingerprint) throw createHttpError('上传请求与原材料不一致，请重新选择材料', 409, 40940);
  if (existing.status === 'deleting' || (!certificationMaterialIsBound(record, existing.id)
    && new Date(existing.expiresAt).getTime() <= Date.now())) {
    throw createHttpError('此材料已移除或过期，请重新选择材料', 409, 40940);
  }
  return existing;
}

async function certificationDeleteStorage(fileID) {
  if (!fileID) return;
  try {
    const result = await cloud.deleteFile({ fileList: [fileID] });
    if (!result || !Array.isArray(result.fileList) || result.fileList.some(file => Number(file.status) !== 0)) {
      throw createHttpError('认证材料删除未完成，请稍后再试', 503, 50340);
    }
  } catch (_error) {
    throw createHttpError('认证材料删除未完成，请稍后再试', 503, 50340);
  }
}

async function certificationRemoveMetadata(userId, id, fileID) {
  const documentId = `user_${Number(userId)}`;
  return db.runTransaction(async transaction => {
    const previous = certificationOwnerRecord(await salonTransactionDocument(transaction, C.memberCertifications, documentId), userId);
    const material = previous.materials?.[id];
    if (!material || material.fileID !== fileID || material.status !== 'deleting' || certificationMaterialIsBound(previous, id)) return;
    const materials = { ...previous.materials }; delete materials[id];
    await transaction.collection(C.memberCertifications).doc(documentId).set({
      data: certificationRecordData(previous, { materials, updatedAt: nowIso() })
    });
  });
}

async function certificationCleanupStaging(userId) {
  const documentId = `user_${Number(userId)}`;
  const expired = await db.runTransaction(async transaction => {
    const previous = certificationOwnerRecord(await salonTransactionDocument(transaction, C.memberCertifications, documentId), userId);
    const materials = { ...(previous.materials || {}) };
    const removals = Object.values(materials).filter(material => !material.applicationId && !certificationMaterialIsBound(previous, material.id)
      && (material.status === 'deleting' || (material.status === 'staging' && new Date(material.expiresAt).getTime() <= Date.now())));
    if (removals.some(material => material.status !== 'deleting')) {
      removals.forEach(material => { materials[material.id] = { ...material, status: 'deleting' }; });
      await transaction.collection(C.memberCertifications).doc(documentId).set({
        data: certificationRecordData(previous, { materials, updatedAt: nowIso() })
      });
    }
    return removals;
  });
  for (const material of expired) {
    try {
      await certificationDeleteStorage(material.fileID);
      await certificationRemoveMetadata(userId, material.id, material.fileID);
    } catch (_error) {
      // The deleting state prevents submission/read and is retried on the next
      // owner upload. Log only an operational event, never evidence or file IDs.
      console.warn('certification staging cleanup deferred');
    }
  }
}

function certificationAdminProjection(record) {
  const safeApplication = application => {
    const { sealedVerification: _sealedVerification, ...safe } = application;
    return safe;
  };
  return { ...stripInternal(record),
    applications: Object.fromEntries(Object.entries(record.applications || {}).map(([kind, application]) => [kind, safeApplication(application)])),
    applicationHistory: (record.applicationHistory || []).map(safeApplication),
    materials: Object.fromEntries(Object.values(record.materials || {}).map(material => [material.id, certificationMaterialMetadata(material)]))
  };
}

const certifications = {
  async overview(userId) {
    const record = await salonTransactionDocument(db, C.memberCertifications, `user_${Number(userId)}`);
    return ownCertificationOverview(certificationOwnerRecord(record, userId));
  },

  async stagingMaterials(userId, kind) {
    if (!['identity', 'education', 'vehicle', 'property', 'assets'].includes(kind)) {
      throw createHttpError('请选择有效认证类型', 422, 42240);
    }
    const record = certificationOwnerRecord(await salonTransactionDocument(db, C.memberCertifications, `user_${Number(userId)}`), userId);
    return { materials: Object.values(record.materials || {})
      .filter(material => material.kind === kind && material.status === 'staging' && !certificationMaterialIsBound(record, material.id)
        && new Date(material.expiresAt).getTime() > Date.now())
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
      .map(material => ({ ...certificationMaterialMetadata(material), expiresAt: material.expiresAt,
        ...(material.clientRequestId ? { clientRequestId: material.clientRequestId } : {}) })) };
  },

  async uploadMaterial(userId, data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)
      || Object.keys(data).some(key => !['kind', 'mimeType', 'contentBase64', 'clientRequestId'].includes(key))
      || (data.clientRequestId !== undefined && (typeof data.clientRequestId !== 'string' || !/^[a-zA-Z0-9_-]{16,80}$/.test(data.clientRequestId)))
      || !['identity', 'education', 'vehicle', 'property', 'assets'].includes(data.kind)) {
      throw createHttpError('请选择有效认证类型并上传支持的材料', 422, 42240);
    }
    const validated = validateMaterialInput({ mimeType: data.mimeType, base64: data.contentBase64 });
    const [user, profile] = await Promise.all([getUserOrThrow(userId), getOne(C.profiles, { userId: Number(userId) })]);
    if (!profile || !profile._id) throw createHttpError('请先保存我的资料，再上传认证材料', 422, 42240);
    const documentId = `user_${Number(userId)}`;
    const requestFingerprint = crypto.createHash('sha256').update(JSON.stringify([Number(userId), data.kind, validated.mimeType]))
      .update(validated.buffer).digest('hex');
    const beforeUpload = certificationOwnerRecord(await salonTransactionDocument(db, C.memberCertifications, documentId), userId);
    const replay = certificationUploadReplay(beforeUpload, data.clientRequestId, requestFingerprint);
    if (replay) return { material: certificationMaterialMetadata(replay) };
    await certificationCleanupStaging(userId);
    const id = crypto.randomUUID(), createdAt = nowIso();
    const encrypted = sealMaterial(validated.buffer, { userId: Number(userId), kind: data.kind, id }, certificationSecrets());
    let fileID = '';
    try {
      const uploaded = await cloud.uploadFile({
        cloudPath: `hl_uploads/member-certification-encrypted/${id}.enc`, fileContent: encrypted
      });
      if (!uploaded || typeof uploaded.fileID !== 'string' || !uploaded.fileID) throw createHttpError('认证材料上传失败，请稍后重试', 503, 50340);
      fileID = uploaded.fileID;
      const material = { id, kind: data.kind, mimeType: validated.mimeType, size: validated.size, createdAt,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), status: 'staging', fileID,
        ...(data.clientRequestId ? { clientRequestId: data.clientRequestId, requestFingerprint } : {}) };
      const saved = await db.runTransaction(async transaction => {
        const [currentUser, currentProfile, certification] = await Promise.all([
          salonTransactionDocument(transaction, C.users, user._id), salonTransactionDocument(transaction, C.profiles, profile._id),
          salonTransactionDocument(transaction, C.memberCertifications, `user_${Number(userId)}`)
        ]);
        if (!currentUser || Number(currentUser.id) !== Number(userId) || Number(currentUser.status) !== 1 || currentUser.mergedIntoUserId
          || Number(currentUser.authVersion || 1) !== Number(user.authVersion || 1) || !currentProfile || Number(currentProfile.userId) !== Number(userId)) {
          throw createHttpError('本人资料已变化，请重新登录后上传', 409, 40940);
        }
        const previous = certificationOwnerRecord(certification, userId);
        const concurrentReplay = certificationUploadReplay(previous, data.clientRequestId, requestFingerprint);
        if (concurrentReplay) return concurrentReplay;
        if (previous.applications?.[data.kind]?.status === 'pending') throw createHttpError('此项认证正在审核，请等待结果后再上传', 409, 40940);
        if (Object.values(previous.materials || {}).filter(row => row.kind === data.kind && row.status === 'staging').length >= 3) {
          throw createHttpError('每项认证最多上传3份材料，请先移除不需要的材料', 422, 42240);
        }
        await transaction.collection(C.memberCertifications).doc(`user_${Number(userId)}`).set({
          data: certificationRecordData(previous, { userId: Number(userId), materials: { ...(previous.materials || {}), [id]: material },
            createdAt: previous.createdAt || createdAt, updatedAt: createdAt })
        });
        return material;
      });
      if (saved.id !== id) await certificationDeleteStorage(fileID);
      return { material: certificationMaterialMetadata(saved) };
    } catch (error) {
      // A transaction can commit even when its acknowledgement is lost. Never
      // delete ciphertext unless a fresh owner record confirms it is unbound.
      if (fileID) {
        let confirmed;
        try { confirmed = certificationOwnerRecord(await salonTransactionDocument(db, C.memberCertifications, documentId), userId); }
        catch (_readError) { throw createHttpError('上传结果暂未确认，请重新读取材料列表后重试', 503, 50340); }
        if (confirmed.materials?.[id]?.fileID === fileID) {
          const committed = certificationUploadReplay(confirmed, data.clientRequestId, requestFingerprint);
          if (committed) return { material: certificationMaterialMetadata(committed) };
        } else await certificationDeleteStorage(fileID);
      }
      throw error && error.status ? error : createHttpError('认证材料上传失败，请稍后重试', 503, 50340);
    }
  },

  async removeMaterial(userId, id) {
    const documentId = `user_${Number(userId)}`;
    const material = await db.runTransaction(async transaction => {
      const previous = certificationOwnerRecord(await salonTransactionDocument(transaction, C.memberCertifications, documentId), userId);
      const found = previous.materials?.[id];
      if (!found) throw createHttpError('认证材料不存在', 404, 40400);
      if (found.applicationId || certificationMaterialIsBound(previous, id) || found.status === 'bound') {
        throw createHttpError('已提交申请的认证材料不能移除', 409, 40940);
      }
      await transaction.collection(C.memberCertifications).doc(documentId).set({
        data: certificationRecordData(previous, { materials: { ...previous.materials, [id]: { ...found, status: 'deleting' } }, updatedAt: nowIso() })
      });
      return found;
    });
    await certificationDeleteStorage(material.fileID);
    await certificationRemoveMetadata(userId, id, material.fileID);
    return { removed: true };
  },

  async readMaterial(userId, id, administrator = false) {
    const record = certificationOwnerRecord(await salonTransactionDocument(db, C.memberCertifications, `user_${Number(userId)}`), userId);
    const material = record.materials?.[id];
    const bound = material && certificationMaterialIsBound(record, id);
    if (!material || material.status === 'deleting' || (administrator && !bound)
      || (!bound && (material.status !== 'staging' || new Date(material.expiresAt).getTime() <= Date.now()))) {
      throw createHttpError('认证材料不存在或已过期', 404, 40400);
    }
    let downloaded;
    try { downloaded = await cloud.downloadFile({ fileID: material.fileID }); }
    catch (_error) { throw createHttpError('认证材料读取失败，请稍后重试', 503, 50340); }
    const decrypted = openMaterial(downloaded.fileContent, { userId: Number(userId), kind: material.kind, id }, certificationSecrets());
    const contentBase64 = decrypted.toString('base64');
    const validated = validateMaterialInput({ mimeType: material.mimeType, base64: contentBase64 });
    if (validated.size !== material.size) throw createHttpError('认证材料记录与文件不一致，请联系工作人员', 422, 42240);
    return { material: certificationMaterialMetadata(material), contentBase64 };
  },

  async request(userId, data) {
    const application = normalizeCertificationRequest(data);
    const [user, profile] = await Promise.all([
      getUserOrThrow(userId), getOne(C.profiles, { userId: Number(userId) })
    ]);
    if (!profile || !profile._id) throw createHttpError('请先保存我的资料，再申请认证', 422, 42240);
    const documentId = `user_${Number(userId)}`;
    const timestamp = nowIso();
    const { verificationCode, certificateNumber, declaredFinancialAssetRange, ...applicationFields } = application;
    const requestId = crypto.randomUUID();
    const privateVerification = { ...(verificationCode ? { verificationCode } : {}), ...(certificateNumber ? { certificateNumber } : {}),
      ...(declaredFinancialAssetRange ? { declaredFinancialAssetRange } : {}) };
    const submitted = { ...applicationFields, requestId, status: 'pending', submittedAt: timestamp,
      ...(Object.keys(privateVerification).length ? { sealedVerification: sealVerification(privateVerification,
        { userId: Number(userId), kind: application.kind, id: requestId }, certificationSecrets()) } : {}) };
    return db.runTransaction(async transaction => {
      const [currentUser, currentProfile, certification] = await Promise.all([
        salonTransactionDocument(transaction, C.users, user._id),
        salonTransactionDocument(transaction, C.profiles, profile._id),
        salonTransactionDocument(transaction, C.memberCertifications, documentId)
      ]);
      if (!currentUser || Number(currentUser.id) !== Number(userId) || Number(currentUser.status) !== 1
        || currentUser.mergedIntoUserId || Number(currentUser.authVersion || 1) !== Number(user.authVersion || 1)
        || !currentProfile || Number(currentProfile.userId) !== Number(userId)) {
        throw createHttpError('本人资料已变化，请刷新后重新申请', 409, 40940);
      }
      const previous = certificationOwnerRecord(certification, userId);
      const oldApplication = previous.applications?.[application.kind];
      // A repeated pending request has no second write, history entry or new date.
      if (oldApplication && oldApplication.status === 'pending') return ownCertificationOverview(previous);
      const materials = { ...(previous.materials || {}) };
      application.materialIds.forEach(id => {
        const material = materials[id];
        if (!material || material.kind !== application.kind || material.status !== 'staging' || material.applicationId
          || certificationMaterialIsBound(previous, id) || new Date(material.expiresAt).getTime() <= Date.now()) {
          throw createHttpError('认证材料不属于本人当前类型、已过期或已提交，请重新选择', 422, 42240);
        }
        materials[id] = { ...material, status: 'bound', applicationId: requestId };
      });
      const record = { ...certificationRecordData(previous), userId: Number(userId), current: previous.current || {}, reviews: previous.reviews || [], materials,
        applications: { ...(previous.applications || {}), [application.kind]: submitted },
        applicationHistory: [...(previous.applicationHistory || []), ...(oldApplication ? [oldApplication] : [])].slice(-25),
        createdAt: previous.createdAt || timestamp, updatedAt: timestamp };
      await transaction.collection(C.memberCertifications).doc(documentId).set({ data: record });
      // Submission records intent only. Approved results and owner-controlled
      // profile preferences are untouched until the administrator reviews it.
      return ownCertificationOverview(record);
    });
  }
};

function adminListParameters(filters) {
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) throw createHttpError('后台筛选参数无效', 422, 42240);
  const integer = (value, fallback, maximum = Number.MAX_SAFE_INTEGER) => {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value.trim()))) {
      throw createHttpError('后台分页参数无效', 422, 42240);
    }
    const result = Number(value);
    if (!Number.isSafeInteger(result) || result <= 0 || result > maximum) throw createHttpError('后台分页参数无效', 422, 42240);
    return result;
  };
  if (filters.keyword !== undefined && filters.keyword !== null
    && (typeof filters.keyword !== 'string' || filters.keyword.length > 80)) throw createHttpError('搜索词须为80字以内文本', 422, 42240);
  return { page: integer(filters.page, 1), pageSize: integer(filters.pageSize, 20, 100),
    keyword: String(filters.keyword || '').trim().toLowerCase() };
}

const admin = {
  async login(code) {
    const adminCode = process.env.ADMIN_CODE;
    if (typeof adminCode !== 'string' || !adminCode.trim() || adminCode.trim().toUpperCase() === 'HLADMIN') {
      throw createHttpError('管理员登录暂未正确配置，请联系管理员', 503, 50340);
    }
    if (!code || String(code) !== String(adminCode)) {
      throw createHttpError('管理员码不正确', 401, 40102);
    }
    return {
      token: tokenService.sign({ role: 'admin', adminSessionId: crypto.randomUUID(), certificationAdminVersion: 1,
        certificationCredentialFingerprint: certificationAdminCredentialFingerprint() }, { type: TOKEN_TYPES.ADMIN }),
      admin: { role: 'admin', name: 'HL 管理员' }
    };
  },

  async listMemberCertifications(filters = {}) {
    const rawUserId = filters.userId;
    const userId = Number(rawUserId);
    if (rawUserId !== undefined && (!Number.isSafeInteger(userId) || userId <= 0)) {
      throw createHttpError('userId is required', 422, 42240);
    }
    const rows = await getAll(C.memberCertifications, rawUserId === undefined ? null : { userId }, Infinity);
    return paginate(rows.map(certificationAdminProjection).sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))),
      filters.page, filters.pageSize);
  },

  async memberCertificationEvidence(rawUserId, kind, filters = {}) {
    const userId = Number(rawUserId);
    if (!Number.isSafeInteger(userId) || userId <= 0) throw createHttpError('请选择有效会员', 422, 42240);
    const record = certificationOwnerRecord(await salonTransactionDocument(db, C.memberCertifications, `user_${userId}`), userId);
    const application = record.applications?.[kind];
    if (!application) throw createHttpError('当前认证申请不存在', 404, 40400);
    if (filters.applicationId && filters.applicationId !== application.requestId) throw createHttpError('认证申请已变化，请重新读取', 409, 40940);
    const verification = application.sealedVerification ? openVerification(application.sealedVerification,
      { userId, kind, id: application.requestId }, certificationSecrets()) : {};
    const materials = (application.materialIds || []).map(id => {
      const material = record.materials?.[id];
      if (!material || material.kind !== kind || material.applicationId !== application.requestId || material.status !== 'bound') {
        throw createHttpError('申请关联材料已变化，请重新核对', 409, 40940);
      }
      return certificationMaterialMetadata(material);
    });
    return { userId, applicationId: application.requestId, kind, status: application.status, source: application.source,
      ...(application.method ? { method: application.method } : {}), ...(application.educationLevel ? { educationLevel: application.educationLevel } : {}),
      ...(application.institutionName ? { institutionName: application.institutionName } : {}),
      ...(typeof verification.verificationCode === 'string' ? { verificationCode: verification.verificationCode } : {}),
      ...(typeof verification.certificateNumber === 'string' ? { certificateNumber: verification.certificateNumber } : {}),
      ...(typeof verification.declaredFinancialAssetRange === 'string' ? { declaredFinancialAssetRange: verification.declaredFinancialAssetRange } : {}), materials };
  },

  async reviewMemberCertification(rawUserId, data, session) {
    const userId = Number(rawUserId);
    if (!Number.isSafeInteger(userId) || userId <= 0) throw createHttpError('userId is required', 422, 42240);
    const review = normalizeCertificationReview(data);
    const [user, profile] = await Promise.all([
      getById(C.users, userId), getOne(C.profiles, { userId })
    ]);
    if (!user || Number(user.status) !== 1 || user.mergedIntoUserId || !profile || !profile._id) {
      throw createHttpError('待核验会员资料不存在或已失效', 404, 40400);
    }
    const timestamp = nowIso();
    const reviewRecord = { ...review, reviewId: crypto.randomUUID(), reviewedAt: timestamp,
      ...(review.kind === 'assets' && review.status === 'approved'
        ? { expiresAt: assetCertificationExpiresAt({ reviewedAt: timestamp }) } : {}),
      reviewedBy: { role: 'admin', account: 'shared-admin',
        sessionId: String(session.adminSessionId || `legacy-issued-${session.iat}`) } };
    const documentId = `user_${userId}`;
    return db.runTransaction(async transaction => {
      const profileRef = transaction.collection(C.profiles).doc(profile._id);
      const userRef = transaction.collection(C.users).doc(user._id);
      const [profileSnapshot, userSnapshot, certificationSnapshot] = await Promise.all([
        profileRef.get(), userRef.get(), salonTransactionDocument(transaction, C.memberCertifications, documentId)
      ]);
      const currentProfile = profileSnapshot.data;
      const currentUser = userSnapshot.data;
      const previous = certificationOwnerRecord(certificationSnapshot, userId);
      if (!currentProfile || Number(currentProfile.userId) !== userId || !currentUser
        || Number(currentUser.id) !== userId || Number(currentUser.status) !== 1 || currentUser.mergedIntoUserId) {
        throw createHttpError('会员资料已变化，请重新核验', 409, 40940);
      }
      const { kind } = review;
      const oldApplication = previous.applications?.[kind];
      if (oldApplication && oldApplication.status === 'pending' && !review.applicationId) {
        throw createHttpError('待审认证必须提供当前申请ID，请先重新读取申请', 422, 42240);
      }
      if (review.applicationId && review.applicationId !== oldApplication?.requestId) {
        throw createHttpError('认证申请已变化，请重新读取并核对当前申请', 409, 40940);
      }
      if (review.applicationId && review.status !== 'revoked' && oldApplication.status !== 'pending') {
        throw createHttpError('此申请已完成审核，请勿重复审核；更新认证需提交新申请', 409, 40940);
      }
      const oldSummary = currentProfile.showcaseCertification || {};
      const previousApproval = previous.current?.[kind]?.status === 'approved' ? previous.current[kind]
        : oldSummary[kind]?.status === 'approved' ? oldSummary[kind] : null;
      const reviewed = { ...reviewRecord, ...(oldApplication ? { applicationId: oldApplication.requestId } : {}) };
      const conclusion = review.status === 'rejected' && previousApproval ? previousApproval : reviewed;
      // Keep the effective conclusion separate from the new application's decision.
      // The profile receives only a controlled projection, never private audit fields.
      const summary = { ...oldSummary, policyVersion: 1, [kind]: {
        status: conclusion.status, source: conclusion.source || '',
        ...(kind === 'education' ? { level: conclusion.level || '' } : {}),
        ...(kind === 'assets' ? { financialAssetRange: conclusion.financialAssetRange || '',
          ...(conclusion.reviewedAt ? { reviewedAt: conclusion.reviewedAt } : {}),
          ...(assetCertificationExpiresAt(conclusion) ? { expiresAt: assetCertificationExpiresAt(conclusion) } : {}) } : {})
      } };
      const record = { ...certificationRecordData(previous), userId,
        current: { ...(previous.current || {}), [kind]: conclusion },
        reviews: [...(previous.reviews || []), reviewed],
        applications: { ...(previous.applications || {}), ...(oldApplication ? {
          [kind]: { ...oldApplication, status: review.status, reviewedAt: timestamp, feedback: review.feedback }
        } : {}) },
        applicationHistory: previous.applicationHistory || [],
        createdAt: previous.createdAt || timestamp, updatedAt: timestamp };
      await transaction.collection(C.memberCertifications).doc(documentId).set({ data: record });
      // Update only the controlled summary. Intake and the member's own consent
      // preferences remain separate fields and cannot be overwritten by this review.
      await profileRef.update({ data: { showcaseCertification: summary, updatedAt: timestamp } });
      return { userId, kind, status: review.status, ...publicCertificationFields({ ...currentProfile, showcaseCertification: summary }) };
    });
  },

  async dashboard() {
    const [matchmakers, members, salons] = await Promise.all([
      getAll(C.matchmakers, { status: 1 }, Infinity, { fields: { certificationStatus: true } }),
      getAll(C.members, { status: 1 }, Infinity, { fields: { id: true } }),
      getAll(C.salonEvents, null, Infinity, { fields: { status: true } })
    ]);
    return {
      pendingMatchmakers: matchmakers.filter(row => Number(row.certificationStatus) === 0).length,
      approvedMatchmakers: matchmakers.filter(row => Number(row.certificationStatus) === 2).length,
      rejectedMatchmakers: matchmakers.filter(row => Number(row.certificationStatus) === 1).length,
      memberCount: members.length,
      salonCount: salons.length,
      pendingSalonCount: salons.filter(row => row.status === 'pending').length,
      activeSalonCount: salons.filter(row => row.status === 'upcoming').length
    };
  },

  async listMatchmakers(filters = {}) {
    const pagination = adminListParameters(filters);
    let rows = await getAll(C.matchmakers, { status: 1 }, Infinity);
    if (filters.status !== undefined && filters.status !== '') {
      rows = rows.filter(row => String(row.certificationStatus) === String(filters.status));
    }
    if (pagination.keyword) {
      const names = await getFirstRowsByNumericField(C.users, 'id', rows.map(row => row.userId), [], {
        complete: true, fields: { id: true, nickname: true }
      });
      rows = rows.filter(row => [row.id, row.matchmakerNo, row.inviteCode, names.get(Number(row.userId))?.nickname]
        .some(value => String(value || '').toLowerCase().includes(pagination.keyword)));
    }
    const page = paginate(rows.sort((a, b) => Number(b.id) - Number(a.id)), pagination.page, pagination.pageSize);
    const matchmakerIds = page.list.map(row => Number(row.id));
    const userIds = page.list.map(row => Number(row.userId));
    const [users, members, salons] = await Promise.all([
      getFirstRowsByNumericField(C.users, 'id', userIds, [], { complete: true }),
      matchmakerIds.length ? getAll(C.members, { matchmakerId: _.in(matchmakerIds.flatMap(id => [id, String(id)])), status: 1 }, Infinity,
        { fields: { matchmakerId: true } }) : [],
      userIds.length ? getAll(C.salonEvents, { organizerId: _.in(userIds.flatMap(id => [id, String(id)])) }, Infinity,
        { fields: { organizerId: true } }) : []
    ]);
    const counts = (items, key) => items.reduce((map, item) => {
      const id = Number(item[key]);
      map.set(id, (map.get(id) || 0) + 1);
      return map;
    }, new Map());
    const memberCounts = counts(members, 'matchmakerId');
    const salonCounts = counts(salons, 'organizerId');
    return { ...page, list: page.list.map(row => ({
        ...stripInternal(row),
        user: publicUser(users.get(Number(row.userId)) || {}),
        memberCount: memberCounts.get(Number(row.id)) || 0,
        salonCount: salonCounts.get(Number(row.userId)) || 0
      })) };
  },

  async listSalons(filters = {}) {
    const pagination = adminListParameters(filters);
    let rows = await getAll(C.salonEvents, null, Infinity);
    if (filters.status) rows = rows.filter(row => row.status === filters.status);
    if (pagination.keyword) {
      const names = await getFirstRowsByNumericField(C.users, 'id', rows.map(row => row.organizerId), [], {
        complete: true, fields: { id: true, nickname: true }
      });
      rows = rows.filter(row => [row.id, row.title, row.location, names.get(Number(row.organizerId))?.nickname]
        .some(value => String(value || '').toLowerCase().includes(pagination.keyword)));
    }
    const page = paginate(rows.sort((a, b) => Number(b.id) - Number(a.id)), pagination.page, pagination.pageSize);
    const context = await eventViewContext(page.list);
    return { ...page, list: await Promise.all(page.list.map(row => eventView(row, null, context))) };
  },

  async cancelSalon(eventId) {
    const event = await getById(C.salonEvents, eventId);
    if (!event) throw createHttpError('event not found', 404, 40400);
    return eventView(await updateRow(C.salonEvents, event, { status: 'cancelled' }));
  },

  async reviewSalon(eventId, status, remark = '') {
    const event = await getById(C.salonEvents, eventId);
    if (!event) throw createHttpError('event not found', 404, 40400);
    const reviewStatus = String(status || '');
    if (!SALON_REVIEW_STATUSES.has(reviewStatus)) {
      throw createHttpError('invalid salon review status');
    }
    const reviewed = await db.runTransaction(async transaction => {
      const ref = transaction.collection(C.salonEvents).doc(event._id);
      const current = await salonTransactionDocument(transaction, C.salonEvents, event._id);
      if (!current || Number(current.id) !== Number(event.id)) throw createHttpError('活动记录已变化，请刷新后重试', 409, 40940);
      const allowed = reviewStatus === 'upcoming' ? current.status === 'pending'
        : ['pending', 'upcoming'].includes(current.status);
      if (!allowed) throw createHttpError('活动状态已变化，已取消或结束的活动不能重新审核开放', 409, 40940);
      const startsAt = new Date(current.eventDate || '').getTime();
      if (reviewStatus === 'upcoming' && (!Number.isFinite(startsAt) || startsAt <= Date.now())) {
        throw createHttpError('活动时间已过或无效，不能审核开放', 409, 40940);
      }
      const patch = { status: reviewStatus, reviewRemark: remark || '', reviewedAt: nowIso(), updatedAt: nowIso() };
      await ref.update({ data: patch });
      return { ...current, ...patch };
    });
    return eventView(reviewed);
  }
};

async function addMembersToMatchmaker(matchmakerUserId, rows) {
  for (const row of rows) {
    await member.addManual(matchmakerUserId, {
      ...row,
      displayEnabled: row.displayEnabled !== undefined ? row.displayEnabled : true,
      remark: row.remark || '虚拟演示会员'
    });
  }
}

async function ensureDemoMembersForMatchmaker(matchmakerUserId) {
  const mm = await getMatchmakerByUserIdOrThrow(matchmakerUserId);
  const hasAnyMember = (await getAll(C.members, { matchmakerId: mm.id })).length > 0;
  if (hasAnyMember) return;
  await addMembersToMatchmaker(matchmakerUserId, NEW_MATCHMAKER_DEMO_MEMBERS);
}

async function createSeedUser(openid, nickname) {
  let user = await getOne(C.users, { openid });
  if (user) return user;
  return addRow(C.users, {
    id: await nextId('user'),
    openid,
    phone: '',
    nickname,
    avatarUrl: '',
    gender: 0,
    currentRole: 'matchmaker',
    isVerified: 1,
    status: 1
  });
}

async function ensureSeed() {
  if (process.env.SEED_DATA !== 'true') return;
  if (!seedReady) {
    seedReady = (async () => {
      await ensureCollections();
      const existingMatchmakers = await getAll(C.matchmakers, null, 1);
      if (existingMatchmakers.length) return;

      const mm1User = await createSeedUser('seed-mm-1', '王主理人');
      const mm2User = await createSeedUser('seed-mm-2', '李主理人');
      const mm1 = await matchmaker.apply(mm1User.id, { certificationStatus: 2 });
      const mm2 = await matchmaker.apply(mm2User.id, { certificationStatus: 2 });
      await matchmaker.setCertification(mm1.id, 2);
      await matchmaker.setCertification(mm2.id, 2);
      await addMembersToMatchmaker(mm1User.id, SEEDED_MEMBER_GROUPS[0]);
      await addMembersToMatchmaker(mm2User.id, SEEDED_MEMBER_GROUPS[1]);
      const seedSalon = await salon.createEvent(mm1User.id, {
        title: '周末轻社交沙龙',
        description: '小范围线下交流，主理人现场协助破冰。',
        location: '杭州 城西会客厅',
        eventDate: new Date(Date.now() + 7 * 86400000).toISOString(),
        maxParticipants: 12,
        price: 99
      });
      await admin.reviewSalon(seedSalon.id, 'upcoming');
    })();
  }
  return seedReady;
}

exports.main = async (event = {}, context = {}) => {
  try {
    const method = String(event.method || 'GET').toUpperCase();
    const path = String(event.path || '/');
    let data = event.data || {};
    const apiToken = event.token || '';

    if (method === 'GET' && path === '/health') return ok({ status: 'ok' });

    // Guests can browse published content without creating an account or
    // initializing collections/seed data. All existing business routes below
    // retain their original authentication and authorization requirements.
    if (path === '/public' || path.startsWith('/public/')) {
      return ok(await publicBrowse.handle(method, path, data));
    }

    // These read-only routes bypass collection/seed initialization entirely.
    if (path === '/member/orders' || path.startsWith('/member/orders/')) {
      const userId = await memberOrders.authorize(apiToken);
      if (method !== 'GET') throw memberOrderUnavailable();
      if (path === '/member/orders') return ok(await memberOrders.list(userId, data));
      const orderMatch = /^\/member\/orders\/([a-zA-Z0-9_-]+)$/.exec(path);
      if (!orderMatch) throw memberOrderUnavailable();
      return ok(await memberOrders.detail(userId, orderMatch[1]));
    }

    // 云开发消息推送（虚拟支付发货/退款通知）不是 API 请求，直接接管。
    if (event && event.MsgType === 'event' && typeof event.Event === 'string' && event.Event.startsWith('xpay_')) {
      const requestId = context && typeof context.request_id === 'string'
        && /^[a-zA-Z0-9_-]{1,128}$/.test(context.request_id) ? context.request_id : '';
      return membership.handleVirtualPaymentPush(event, requestId);
    }

    if (path !== '/user/admin-entry' && path !== '/user/admin/operations') {
      await ensureCollectionsForPath(path);
      await ensureSeed();
    }
    if (method === 'POST' && path === '/auth/wx-login') return ok(await auth.wxLogin(data));
    if (method === 'POST' && path === '/auth/member-claim/preview') {
      return ok(await auth.previewMemberIdentityClaim(data.token));
    }
    if (method === 'POST' && path === '/admin/login') return ok(await admin.login(data.code));
    if (method === 'POST' && path === '/internal/payment-orders/checkout') {
      return ok(await membership.internalCheckout(data));
    }
    if (method === 'POST' && path === '/internal/payment-orders/query') {
      return ok(await membership.internalQuery(data));
    }
    if (method === 'POST' && path === '/internal/payment-orders/confirm') {
      return ok(await membership.confirmPayment(data));
    }
    if (method === 'POST' && path === '/internal/payment-orders/close') {
      return ok(await membership.closePayment(data));
    }
    if (method === 'POST' && path === '/internal/payment-orders/refund') {
      return ok(await membership.refundPayment(data));
    }

    if (path.startsWith('/admin/')) {
      const adminSession = requireAdmin(apiToken);
      const creditRestoreMatch = path.match(/^\/admin\/matchmaking\/requests\/(request_[a-f0-9]{32})\/restore$/);
      if (method === 'POST' && creditRestoreMatch) {
        return ok(await vipMembership.restoreCredit(creditRestoreMatch[1], data, 'admin'));
      }
      if (path.startsWith('/admin/member-certifications')) requireCertificationAdminAccess(adminSession);
      if (method === 'GET' && path === '/admin/member-certifications') {
        return ok(await admin.listMemberCertifications(data));
      }
      const adminCertificationEvidenceMatch = path.match(/^\/admin\/member-certifications\/(\d+)\/applications\/(identity|education|vehicle|property|assets)\/evidence$/);
      if (method === 'GET' && adminCertificationEvidenceMatch) {
        return ok(await admin.memberCertificationEvidence(adminCertificationEvidenceMatch[1], adminCertificationEvidenceMatch[2], data));
      }
      const adminCertificationMaterialMatch = path.match(/^\/admin\/member-certifications\/(\d+)\/materials\/([a-zA-Z0-9_-]{1,80})$/);
      if (method === 'GET' && adminCertificationMaterialMatch) {
        return ok(await certifications.readMaterial(Number(adminCertificationMaterialMatch[1]), adminCertificationMaterialMatch[2], true));
      }
      const adminCertificationMatch = path.match(/^\/admin\/member-certifications\/(\d+)$/);
      if (adminCertificationMatch && method === 'PUT') {
        return ok(await admin.reviewMemberCertification(adminCertificationMatch[1], data, adminSession));
      }
      if (method === 'GET' && path === '/admin/dashboard') return ok(await admin.dashboard());
      if (method === 'GET' && path === '/admin/matchmakers') return ok(await admin.listMatchmakers(data));
      const adminMatchmakerMatch = path.match(/^\/admin\/matchmakers\/(\d+)\/certification$/);
      if (adminMatchmakerMatch && method === 'PUT') {
        return ok(await matchmaker.setCertification(adminMatchmakerMatch[1], data.certificationStatus, data.remark || ''));
      }
      if (method === 'GET' && path === '/admin/salons') return ok(await admin.listSalons(data));
      const adminSalonReviewMatch = path.match(/^\/admin\/salons\/(\d+)\/review$/);
      if (adminSalonReviewMatch && method === 'POST') return ok(await admin.reviewSalon(adminSalonReviewMatch[1], data.status, data.remark || ''));
      const adminSalonCancelMatch = path.match(/^\/admin\/salons\/(\d+)\/cancel$/);
      if (adminSalonCancelMatch && method === 'PUT') return ok(await admin.cancelSalon(adminSalonCancelMatch[1]));
      if (method === 'GET' && path === '/admin/membership-plans') return ok(await membership.listPlansForAdmin(data));
      const adminMembershipPlanMatch = path.match(/^\/admin\/membership-plans\/([a-zA-Z0-9_-]+)$/);
      if (adminMembershipPlanMatch && method === 'PUT') {
        return ok(await membership.upsertPlan(adminMembershipPlanMatch[1], data));
      }
      if (method === 'GET' && path === '/admin/payment-orders') return ok(await membership.listOrdersForAdmin(data));
      throw createHttpError('not found', 404, 40400);
    }

    const session = await requireUser(apiToken);
    if (method === 'GET' && path === '/user/admin-entry') {
      const user = await getById(C.users, session.userId);
      return ok(miniprogramAdminEntry(user, session, process.env));
    }
    if (method === 'POST' && path === '/user/admin/operations') {
      const user = await getById(C.users, session.userId);
      const { authorizeNativeAdmin, executeNativeAdmin } = require('./native-admin.bundle');
      const actor = authorizeNativeAdmin(user, session, process.env);
      const result = await executeNativeAdmin(data, actor);
      return { code: 0, message: 'success', data: result.data, requestId: result.requestId };
    }
    if (path.startsWith('/member/vip/') || path.startsWith('/member/matchmaking/')) {
      if (method === 'POST' && path === '/member/matchmaking/requests') {
        await assertUserText(session.userId, [data.note], 2);
      }
      const result = await vipMembership.handleRoute(session.userId, method, path, data);
      if (result !== undefined) return ok(result);
    }

    if (method === 'POST' && path === '/auth/wechat-phone') {
      return ok(await auth.bindWechatPhone(session.userId, data.code));
    }
    if (method === 'POST' && path === '/auth/member-claim/confirm') {
      return ok(await auth.confirmMemberIdentityClaim(session.userId, data.token, data.code));
    }
    if (path === '/user/location' && ['GET', 'PUT'].includes(method)) {
      const profile = method === 'PUT' ? await saveOwnProfileFields(session.userId, { privateLocation: normalizeMemberLocation(data) })
        : await getOne(C.profiles, { userId: Number(session.userId) });
      return ok({ enabled: currentLocation(profile?.privateLocation), updatedAt: profile?.privateLocation?.updatedAt || null });
    }
    if (path === '/user/matching-preferences' && ['GET', 'PUT'].includes(method)) {
      let profile = await getOne(C.profiles, { userId: Number(session.userId) });
      if (method === 'PUT') {
        const preferences = normalizeMatchingPreferences(data.preferences);
        await assertUserText(session.userId, [preferences.city], 2);
        profile = await saveOwnProfileFields(session.userId, { matchingPreferences: preferences, matchingPreferencesUpdatedAt: nowIso() });
      }
      return ok({ preferences: normalizeMatchingPreferences(profile?.matchingPreferences || {}), updatedAt: profile?.matchingPreferencesUpdatedAt || null });
    }
    if (method === 'GET' && path === '/member/relationship-status') return ok(await memberRelationships.overview(session.userId));
    if (method === 'POST' && path === '/member/relationship-status') return ok(await memberRelationships.setStatus(session.userId, data));
    if (method === 'POST' && path === '/member/relationship-invitations') return ok(await memberRelationships.invite(session.userId, data));
    const coupleInvitationMatch = path.match(/^\/member\/relationship-invitations\/(\d+)\/respond$/);
    if (method === 'POST' && coupleInvitationMatch) return ok(await memberRelationships.respond(session.userId, coupleInvitationMatch[1], data));
    if (method === 'POST' && path === '/member/unmatch') return ok(await memberRelationships.unmatch(session.userId, data));
    if (method === 'GET' && path === '/user/profile') {
      const user = await getUserOrThrow(session.userId);
      const profile = await getOne(C.profiles, { userId: Number(session.userId) });
      return ok(await ownProfileResponse(user, profile));
    }
    if (method === 'GET' && path === '/user/certifications') return ok(await certifications.overview(session.userId));
    if (method === 'POST' && path === '/user/certification-requests') return ok(await certifications.request(session.userId, data));
    if (method === 'GET' && path === '/user/certification-materials') return ok(await certifications.stagingMaterials(session.userId, data.kind));
    if (method === 'POST' && path === '/user/certification-materials') return ok(await certifications.uploadMaterial(session.userId, data));
    const ownCertificationMaterialMatch = path.match(/^\/user\/certification-materials\/([a-zA-Z0-9_-]{1,80})$/);
    if (method === 'GET' && ownCertificationMaterialMatch) return ok(await certifications.readMaterial(session.userId, ownCertificationMaterialMatch[1]));
    if (method === 'DELETE' && ownCertificationMaterialMatch) return ok(await certifications.removeMaterial(session.userId, ownCertificationMaterialMatch[1]));
    if (method === 'GET' && path === '/user/minimum-registration') return ok(await minimumRegistrationView(session.userId));
    if (method === 'PUT' && path === '/user/minimum-registration') return ok(await saveMinimumRegistration(session.userId, data));
    if (method === 'PUT' && path === '/user/profile') {
      const user = await getUserOrThrow(session.userId);
      let profile = await getOne(C.profiles, { userId: Number(session.userId) });
      const checkedProfile = isTrue(data.displayEnabled)
        ? { ...(profile || {}), nickname: user.nickname, ...data } : data;
      await assertUserText(user, profileTextValues(checkedProfile));
      const hasNewPhotos = Object.prototype.hasOwnProperty.call(data, 'photos');
      if (hasNewPhotos || isTrue(data.displayEnabled)) {
        const images = hasNewPhotos ? data.photos : (profile?.photos?.length ? profile.photos : (user.avatarUrl ? [user.avatarUrl] : []));
        data = { ...data, photos: await contentSecurity.assertImages({ images, skipSystem: !hasNewPhotos }) };
      }
      const userPatch = {};
      if (data.realName || data.nickname) userPatch.nickname = data.realName || data.nickname;
      if (data.gender !== undefined) userPatch.gender = Number(data.gender);
      if (Object.prototype.hasOwnProperty.call(data, 'photos')) userPatch.avatarUrl = data.photos[0] || '';
      const updatedUser = Object.keys(userPatch).length ? await updateRow(C.users, user, userPatch) : user;
      const profilePatch = editableProfilePatch(data);
      if (profile?.relationshipStatus === 'coupled') profilePatch.displayEnabled = false;
      if (!profile && data.displayEnabled === undefined) {
        profilePatch.displayEnabled = false;
      }
      if (profile) profile = await updateRow(C.profiles, profile, profilePatch);
      else profile = await addRow(C.profiles, { id: await nextId('profile'), userId: Number(session.userId), ...profilePatch });
      return ok(await ownProfileResponse(updatedUser, profile));
    }

    if (method === 'GET' && path === '/matchmaker/activation') return ok(await paidMatchmakerOverview(session.userId));
    if (method === 'POST' && path === '/matchmaker/activation/orders') return ok(await membership.createOrder(session.userId, { planCode: MATCHMAKER_LIFETIME_PLAN.planCode }));
    if (method === 'POST' && path === '/matchmaker/apply') return ok(await matchmaker.apply(session.userId, {
      ...data, certificationStatus: 0, level: 1, parentId: null, status: 1
    }));
    if (method === 'GET' && path === '/matchmaker/status') return ok(await matchmaker.status(session.userId));
    if (method === 'GET' && path === '/matchmaker/dashboard') return ok(await matchmaker.dashboard(session.userId));
    if (method === 'GET' && path === '/matchmaker/invite-card') return ok(await matchmaker.inviteCard(session.userId));
    if (method === 'POST' && path === '/matchmaker/invite-code/reset') return ok(await matchmaker.resetInviteCode(session.userId));
    if (method === 'GET' && path === '/matchmaker/member-requests') return ok(await matchmaker.listMemberRequests(session.userId, data));
    const matchmakerRequestApproveMatch = path.match(/^\/matchmaker\/member-requests\/(\d+)\/approve$/);
    if (matchmakerRequestApproveMatch && method === 'POST') return ok(await matchmaker.approveMemberRequest(session.userId, matchmakerRequestApproveMatch[1]));
    const matchmakerRequestRejectMatch = path.match(/^\/matchmaker\/member-requests\/(\d+)\/reject$/);
    if (matchmakerRequestRejectMatch && method === 'POST') return ok(await matchmaker.rejectMemberRequest(session.userId, matchmakerRequestRejectMatch[1], data.remark || ''));

    if (method === 'GET' && path === '/chat/conversations') return ok(await chat.listConversations(session.userId, data));
    if (method === 'POST' && path === '/chat/conversations') return ok(await chat.getOrCreateConversation(session.userId, data));
    const chatMessagesMatch = path.match(/^\/chat\/conversations\/(\d+)\/messages$/);
    if (chatMessagesMatch && method === 'GET') return ok(await chat.listMessages(session.userId, chatMessagesMatch[1], data));
    if (chatMessagesMatch && method === 'POST') return ok(await chat.sendMessage(session.userId, chatMessagesMatch[1], data));
    const chatReadMatch = path.match(/^\/chat\/conversations\/(\d+)\/read$/);
    if (chatReadMatch && method === 'POST') return ok(await chat.markRead(session.userId, chatReadMatch[1]));

    if (method === 'GET' && path === '/messages') return ok(await messages.list(session.userId, data));
    const messageReadMatch = path.match(/^\/messages\/(\d+)\/read$/);
    if (messageReadMatch && method === 'POST') return ok(await messages.markRead(session.userId, messageReadMatch[1]));

    if (method === 'GET' && path === '/member/invite-options') return ok(await member.inviteOptions(session.userId, data));
    if (method === 'GET' && path === '/member/list') return ok(await member.listOwn(session.userId, data));
    if (method === 'GET' && path === '/member/resources') return ok(await member.resources(session.userId, data));
    if (method === 'GET' && path === '/member/showcase') return ok(await member.showcase(session.userId, data));
    const publicMemberMatch = path.match(/^\/member\/showcase\/(\d+|profile_\d+)$/);
    if (method === 'GET' && publicMemberMatch) return ok(await member.showcaseDetail(session.userId, publicMemberMatch[1]));
    if (method === 'GET' && path === '/member/gifts') return ok(await member.gifts());
    if (method === 'GET' && path === '/member/membership-plans') return ok(await membership.overview(session.userId));
    if (method === 'POST' && path === '/member/payment-orders') return ok(await membership.createOrder(session.userId, data));
    if (method === 'POST' && path === '/member/payment-virtual/checkout') {
      return ok(await membership.virtualCheckout(session.userId, data));
    }
    if (method === 'POST' && path === '/member/payment-virtual/query') {
      return ok(await membership.virtualQuery(session.userId, data));
    }
    const paymentOrderCancelMatch = path.match(/^\/member\/payment-orders\/([a-zA-Z0-9_-]+)\/cancel$/);
    if (paymentOrderCancelMatch && method === 'POST') {
      return ok(await membership.cancelOrder(session.userId, paymentOrderCancelMatch[1]));
    }
    const paymentOrderMatch = path.match(/^\/member\/payment-orders\/([a-zA-Z0-9_-]+)$/);
    if (paymentOrderMatch && method === 'GET') {
      return ok(await membership.getOrder(session.userId, paymentOrderMatch[1]));
    }
    if (method === 'GET' && path === '/member/relationships') return ok(await member.relationships(session.userId, data));
    if (method === 'GET' && path === '/member/liked-me') return ok(await member.likedMe(session.userId, data));
    if (method === 'GET' && path === '/member/hidden') return ok(await member.hidden(session.userId, data));
    if (method === 'POST' && path === '/member/interactions') return ok(await member.interact(session.userId, data));
    if (method === 'POST' && path === '/member/gifts/send') return ok(await member.sendGift(session.userId, data));
    if (method === 'GET' && path === '/member/matchmaker-invite/resolve') return ok(await member.resolveMatchmakerInvite(session.userId, data));
    if (method === 'POST' && path === '/member/matchmaker-requests') return ok(await member.requestMatchmaker(session.userId, data));
    if (method === 'POST' && path === '/member/matchmaker-invite/accept') return ok(await member.acceptMatchmakerInvite(session.userId, data));
    if (method === 'GET' && path === '/member/referral-card') return ok(await member.referralCard(session.userId));
    const identityClaimInviteMatch = path.match(/^\/member\/(\d+)\/identity-claim-invite$/);
    if (identityClaimInviteMatch && method === 'POST') {
      return ok(await member.createIdentityClaimInvite(session.userId, identityClaimInviteMatch[1]));
    }
    if (method === 'POST' && path === '/member/manual') {
      return ok(await member.addManual(session.userId, data, { requireCompleteIntake: true }));
    }
    if (method === 'POST' && path === '/member/recommend') return ok(await member.recommend(session.userId, data));
    const memberMatch = path.match(/^\/member\/(\d+)$/);
    if (memberMatch && method === 'GET') return ok(await member.detailOwn(session.userId, memberMatch[1]));
    if (memberMatch && method === 'PUT') return ok(await member.update(session.userId, memberMatch[1], data));
    if (memberMatch && method === 'DELETE') return ok(await member.remove(session.userId, memberMatch[1]));

    if (method === 'GET' && path === '/salon/events') return ok(await salon.listEvents(data, session.userId));
    if (method === 'POST' && path === '/salon/events') return ok(await salon.createEvent(session.userId, data));
    if (method === 'GET' && path === '/salon/my-events') return ok(await salon.myEvents(session.userId, data));
    if (method === 'GET' && path === '/salon/my-registrations') return ok(await salon.myRegistrations(session.userId, data));
    const shareCardMatch = path.match(/^\/salon\/events\/(\d+)\/share-card$/);
    if (shareCardMatch && method === 'GET') return ok(await salon.shareCard(shareCardMatch[1], session.userId));
    const participantsMatch = path.match(/^\/salon\/events\/(\d+)\/participants$/);
    if (participantsMatch && method === 'GET') return ok(await salon.participants(participantsMatch[1], session.userId, data));
    const participantProfileMatch = path.match(/^\/salon\/events\/(\d+)\/participants\/(\d+)$/);
    if (participantProfileMatch && method === 'GET') return ok(await salon.participantProfile(participantProfileMatch[1], session.userId, participantProfileMatch[2]));
    const salonMatch = path.match(/^\/salon\/events\/(\d+)$/);
    if (salonMatch && method === 'GET') {
      const detail = await salon.getEventDetail(salonMatch[1], session.userId);
      if (!detail) throw createHttpError('event not found', 404, 40400);
      return ok(detail);
    }
    if (salonMatch && method === 'PUT') return ok(await salon.updateEvent(salonMatch[1], session.userId, data));
    const registerMatch = path.match(/^\/salon\/events\/(\d+)\/register$/);
    if (registerMatch && method === 'POST') return ok(await salon.register(registerMatch[1], session.userId, data), 'registered');
    if (registerMatch && method === 'DELETE') return ok(await salon.cancelRegistration(registerMatch[1], session.userId), 'cancelled');
    const cancelMatch = path.match(/^\/salon\/events\/(\d+)\/cancel$/);
    if (cancelMatch && method === 'PUT') return ok(await salon.cancelEvent(cancelMatch[1], session.userId), 'event cancelled');
    const inviteMatch = path.match(/^\/salon\/events\/(\d+)\/invite$/);
    if (inviteMatch && method === 'POST') return ok(await salon.inviteMembers(inviteMatch[1], session.userId, data.userIds || [], { all: data.all === true }));

    throw createHttpError('not found', 404, 40400);
  } catch (err) {
    const failedPath = String(event.path || '/');
    if (failedPath === '/user/admin/operations') {
      const requestedCode = Number(err?.code);
      const nativeCode = [40100, 40360, 40361, 42250, 42260, 40940, 40960, 40400, 40460, 50340, 50350, 50351, 50360].includes(requestedCode)
        ? requestedCode : 50360;
      const message = nativeCode === 40100 ? '登录状态已失效，请重新登录'
        : [40360, 40361].includes(nativeCode) ? '当前账号没有管理权限'
          : [42250, 42260].includes(nativeCode) ? '填写内容或操作参数无效，请检查后重试'
            : [40940, 40960].includes(nativeCode) ? '记录已变化，请刷新详情后重新确认'
              : [40400, 40460].includes(nativeCode) ? '记录不存在或操作未开放'
                : '管理操作暂时无法完成，请稍后重试';
      const requestId = crypto.randomUUID();
      console.warn('native_admin_request_failed', { code: nativeCode, requestId });
      return { code: nativeCode, message, requestId };
    }
    if (failedPath === '/public' || failedPath.startsWith('/public/')) {
      const safeError = [40001, 40400, 40500, 50301].includes(err?.code)
        ? err : createHttpError('公开内容暂时无法加载，请稍后重试', 503, 50301);
      console.error('public browse request failed', safeError.code);
      return fail(safeError);
    }
    if (failedPath === '/user/admin-entry') {
      const safeError = err?.status === 401 && err?.code === 40100
        ? createHttpError('登录状态已失效，请重新登录', 401, 40100)
        : err?.status === 404 && err?.code === 40400
          ? createHttpError('not found', 404, 40400)
          : createHttpError('管理入口暂不可用，请稍后重试', 503, 50340);
      console.error('admin entry request failed', safeError.code);
      return fail(safeError);
    }
    if (failedPath.startsWith('/member/vip/') || failedPath.startsWith('/member/matchmaking/')) {
      const safeError = Number.isInteger(err?.status) && Number.isInteger(err?.code)
        ? err : createHttpError('会员功能暂不可用，请稍后重试', 503, 50301);
      console.error('vip request failed', safeError.code);
      return fail(safeError);
    }
    if (failedPath.startsWith('/user/certification') || failedPath.startsWith('/admin/member-certifications')) {
      const safeError = Number.isInteger(err?.status) && Number.isInteger(err?.code)
        ? err : createHttpError('认证操作暂不可用，请稍后重试', 503, 50340);
      // Certification SDK diagnostics can include request bodies or storage IDs.
      // Keep operational error codes while withholding raw errors from logs/DTOs.
      console.error('certification request failed', safeError.code);
      return fail(safeError);
    }
    console.error(err);
    return fail(err);
  }
};
