const cloud = require('wx-server-sdk');
const crypto = require('node:crypto');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const _ = db.command;

const C = {
  users: 'hl_users',
  profiles: 'hl_profiles',
  matchmakers: 'hl_matchmakers',
  members: 'hl_members',
  salonEvents: 'hl_salon_events',
  registrations: 'hl_registrations',
  matchRecords: 'hl_match_records',
  memberRequests: 'hl_member_matchmaker_requests',
  messages: 'hl_messages',
  counters: 'hl_counters'
};

const MATCHMAKER_CERTIFICATION_STATUSES = new Set([0, 1, 2]);
const SALON_REVIEW_STATUSES = new Set(['upcoming', 'rejected']);
const MEMBER_PHOTO_LIMIT = 3;

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

function ok(data = null, message = 'success') {
  return { code: 0, message, data };
}

function fail(err) {
  const status = err.status || 500;
  const code = err.code || (status >= 500 ? 50000 : 40000);
  return { code, message: err.message || 'server error', data: null };
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
    avatarUrl: data.avatarUrl || defaults.avatarUrl,
    photos: photos.length ? photos : defaults.photos
  };
}

function createTokenService(secret = process.env.JWT_SECRET || 'hl-dev-secret') {
  function sign(payload) {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
    return `${body}.${sig}`;
  }

  function verify(token) {
    if (!token || typeof token !== 'string' || !token.includes('.')) {
      throw createHttpError('invalid token', 401, 40100);
    }
    const [body, sig] = token.split('.');
    const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      throw createHttpError('invalid token', 401, 40100);
    }
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  }

  return { sign, verify };
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

function collectionsForPath(path) {
  const common = [C.users, C.profiles, C.counters];
  if (path.startsWith('/admin/')) return Object.values(C);
  if (path.startsWith('/matchmaker')) {
    return [...common, C.matchmakers, C.members, C.memberRequests, C.salonEvents, C.registrations, C.matchRecords, C.messages];
  }
  if (path.startsWith('/member')) {
    return [...common, C.matchmakers, C.members, C.memberRequests, C.matchRecords, C.salonEvents, C.messages];
  }
  if (path.startsWith('/salon')) {
    return [...common, C.matchmakers, C.members, C.salonEvents, C.registrations, C.messages];
  }
  return common;
}

async function ensureCollectionsForPath(path) {
  if (!shouldAutoCreateCollections()) return;
  const names = Array.from(new Set(collectionsForPath(path)));
  return Promise.all(names.map(name => ensureCollection(name)));
}

async function getAll(collectionName, query = null, maxRows = 1000) {
  const rows = [];
  const pageSize = 100;
  for (let offset = 0; offset < maxRows; offset += pageSize) {
    const ref = query ? db.collection(collectionName).where(query) : db.collection(collectionName);
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

async function getOne(collectionName, query) {
  let res;
  try {
    res = await db.collection(collectionName).where(query).limit(1).get();
  } catch (err) {
    if (!isMissingCollectionError(err)) throw err;
    await ensureCollection(collectionName);
    try {
      res = await db.collection(collectionName).where(query).limit(1).get();
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
    + (Array.isArray(row.photos) && row.photos.length ? 1 : 0)
    + (row.avatarUrl ? 1 : 0);
  const total = fields.length + 2;
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

function sortMemberRowsDesc(a, b) {
  return Number(b.sortId || b.id || 0) - Number(a.sortId || a.id || 0);
}

async function memberView(member, context = {}) {
  const user = await getById(C.users, member.userId) || {};
  const profile = await getOne(C.profiles, { userId: Number(member.userId) }) || {};
  const row = {
    ...stripInternal(member),
    nickname: user.nickname || profile.realName || '',
    phone: user.phone || '',
    avatarUrl: user.avatarUrl || '',
    gender: user.gender || 0,
    isVerified: user.isVerified || 0,
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
    photos: Array.isArray(profile.photos) ? clone(profile.photos) : [],
    displayEnabled: isTrue(profile.displayEnabled),
    displayUpdatedAt: profile.displayUpdatedAt || ''
  };
  const completion = profileCompletionFor(row);
  return {
    ...row,
    profileCompletion: completion,
    displayStatus: displayStatusForMember(row, completion),
    lastRecommendStatus: lastRecommendationStatusForUser(row.userId, context.matchRecords || [])
  };
}

async function profileMemberView(profile, context = {}) {
  const user = await getById(C.users, profile.userId) || {};
  const profileId = Number(profile.id || profile.userId || 0);
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
    avatarUrl: user.avatarUrl || profile.avatarUrl || '',
    gender: user.gender || profile.gender || 0,
    isVerified: user.isVerified || 0,
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
    photos: Array.isArray(profile.photos) ? clone(profile.photos) : [],
    displayEnabled: isTrue(profile.displayEnabled),
    displayUpdatedAt: profile.displayUpdatedAt || ''
  };
  const completion = profileCompletionFor(row);
  return {
    ...row,
    profileCompletion: completion,
    displayStatus: displayStatusForMember(row, completion),
    lastRecommendStatus: lastRecommendationStatusForUser(row.userId, context.matchRecords || [])
  };
}

function sanitizePublicMemberRow(row, options = {}) {
  const safe = { ...row };
  delete safe.phone;
  delete safe.matchmakerId;
  if (!options.keepUserId) delete safe.userId;
  delete safe.displayEnabled;
  delete safe.displayUpdatedAt;
  delete safe.serviceLevel;
  delete safe.expireAt;
  delete safe.remark;
  return safe;
}

async function publicMemberView(member, context = {}) {
  const row = await memberView(member, context);
  if (!row.displayEnabled) return null;
  return sanitizePublicMemberRow(row);
}

async function eventView(event, currentUserId = null) {
  const organizer = await getById(C.users, event.organizerId);
  const allRegistrations = await getAll(C.registrations, { eventId: event.id });
  const registrations = allRegistrations.filter(reg => reg.status === 'registered');
  const registrationViews = await Promise.all(registrations.map(async reg => {
    const user = await getById(C.users, reg.userId);
    return {
      ...stripInternal(reg),
      user: user ? publicUser(user) : null
    };
  }));
  const currentRegistration = currentUserId
    ? allRegistrations.find(reg => Number(reg.userId) === Number(currentUserId))
    : null;
  const maxParticipants = Number(event.maxParticipants || 0);
  return {
    ...stripInternal(event),
    organizer: organizer ? {
      id: organizer.id,
      nickname: organizer.nickname,
      avatarUrl: organizer.avatarUrl || ''
    } : null,
    registrations: registrationViews,
    registrationStatus: currentRegistration ? currentRegistration.status : 'none',
    isRegistered: !!currentRegistration && currentRegistration.status === 'registered',
    isFull: maxParticipants > 0 && registrations.length >= maxParticipants
  };
}

async function getUserOrThrow(userId) {
  const user = await getById(C.users, userId);
  if (!user || user.status === 0) {
    throw createHttpError('user not found', 404, 40400);
  }
  return user;
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
    throw createHttpError('红娘认证通过后可使用', 403, 40301);
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
    nickname: (user && user.nickname) || '红娘顾问',
    avatarUrl: (user && user.avatarUrl) || '',
    level: matchmaker.level || 1,
    memberCount: members.length,
    certificationStatus: matchmaker.certificationStatus,
    applySource: requestApplySource(data)
  };
}

async function activeMemberAssignment(userId) {
  const rows = await getAll(C.members, { userId: Number(userId), status: 1 });
  return rows[0] || null;
}

async function memberRequestView(row) {
  const user = await getById(C.users, row.userId);
  const profile = await getOne(C.profiles, { userId: Number(row.userId) }) || {};
  const matchmaker = await getById(C.matchmakers, row.matchmakerId);
  const matchmakerUser = matchmaker ? await getById(C.users, matchmaker.userId) : null;
  const profileView = stripInternal(profile) || {};
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
  await getUserOrThrow(userId);
  const matchmaker = await resolveMatchmakerForRequest(data);
  if (!matchmaker || Number(matchmaker.status) !== 1) {
    throw createHttpError('matchmaker not found', 404, 40400);
  }
  if (Number(matchmaker.certificationStatus) !== 2) {
    throw createHttpError('matchmaker is not certified', 403, 40301);
  }

  const assignment = await activeMemberAssignment(userId);
  if (assignment && Number(assignment.matchmakerId) === Number(matchmaker.id)) {
    return {
      status: 'approved',
      member: await memberView(assignment),
      request: null
    };
  }
  if (assignment) {
    throw createHttpError('member already has a matchmaker', 409, 40901);
  }

  const existingRows = (await getAll(C.memberRequests, { userId: Number(userId), matchmakerId: Number(matchmaker.id) }))
    .sort((a, b) => Number(b.id || 0) - Number(a.id || 0));
  const pending = existingRows.find(row => row.status === 'pending');
  if (pending) return memberRequestView(pending);

  const reusable = existingRows.find(row => ['rejected', 'cancelled'].includes(row.status));
  const requestPatch = {
    status: 'pending',
    applySource: requestApplySource(data),
    applyMessage: data.message || '',
    reviewRemark: '',
    reviewedAt: null,
    reviewerId: null
  };
  const row = reusable
    ? await updateRow(C.memberRequests, reusable, requestPatch)
    : await addRow(C.memberRequests, {
      id: await nextId('memberRequest'),
      userId: Number(userId),
      matchmakerId: Number(matchmaker.id),
      ...requestPatch
    });
  return memberRequestView(row);
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

  let memberRow = await getOne(C.members, { matchmakerId: mm.id, userId: Number(request.userId) });
  if (memberRow) {
    memberRow = await updateRow(C.members, memberRow, { status: 1 });
  } else {
    memberRow = await addRow(C.members, {
      id: await nextId('member'),
      matchmakerId: mm.id,
      userId: Number(request.userId),
      memberType: 'free',
      serviceLevel: '',
      expireAt: null,
      remark: 'member request approved',
      status: 1
    });
  }

  const reviewed = await updateRow(C.memberRequests, request, {
    status: 'approved',
    reviewRemark: '',
    reviewedAt: nowIso(),
    reviewerId: Number(matchmakerUserId)
  });
  await addRow(C.messages, {
    id: await nextId('message'),
    senderId: Number(matchmakerUserId),
    receiverId: Number(request.userId),
    contentType: 'system',
    content: '红娘已通过您的添加申请。',
    isRead: 0
  });
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

async function acceptMemberMatchmakerInvite(userId, data = {}) {
  await getUserOrThrow(userId);
  const matchmaker = await resolveMatchmakerForRequest(data);
  if (!matchmaker || Number(matchmaker.status) !== 1) {
    throw createHttpError('matchmaker not found', 404, 40400);
  }
  if (Number(matchmaker.certificationStatus) !== 2) {
    throw createHttpError('matchmaker is not certified', 403, 40301);
  }
  if (!isShareInviteSource(data)) {
    throw createHttpError('share invite source is required');
  }

  const event = await validateInviteEventForMatchmaker(data.eventId, matchmaker);
  const assignment = await activeMemberAssignment(userId);
  if (assignment && Number(assignment.matchmakerId) !== Number(matchmaker.id)) {
    throw createHttpError('member already has another matchmaker', 409, 40901);
  }

  const existingRows = (await getAll(C.memberRequests, { userId: Number(userId), matchmakerId: Number(matchmaker.id) }))
    .sort((a, b) => Number(b.id || 0) - Number(a.id || 0));
  let request = existingRows[0] || null;
  let memberRow = assignment || await getOne(C.members, { matchmakerId: matchmaker.id, userId: Number(userId) });
  const isNewAssignment = !memberRow || Number(memberRow.status) !== 1;

  if (memberRow) {
    memberRow = await updateRow(C.members, memberRow, {
      memberType: memberRow.memberType || 'free',
      status: 1
    });
  } else {
    memberRow = await addRow(C.members, {
      id: await nextId('member'),
      matchmakerId: Number(matchmaker.id),
      userId: Number(userId),
      memberType: 'free',
      serviceLevel: '',
      expireAt: null,
      remark: 'share invite accepted',
      status: 1
    });
  }

  const requestPatch = {
    status: 'approved',
    applySource: requestApplySource(data),
    applyMessage: data.message || '',
    reviewRemark: 'share invite accepted',
    reviewedAt: nowIso(),
    reviewerId: Number(matchmaker.userId)
  };
  request = request
    ? await updateRow(C.memberRequests, request, requestPatch)
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
      content: '你已通过微信邀请成为红娘名下会员。',
      isRead: 0
    });
  }

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
    content: remark ? `红娘暂未通过您的添加申请：${remark}` : '红娘暂未通过您的添加申请。',
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
  if (filters.education && row.education !== filters.education) return false;
  if (filters.maritalStatus && row.maritalStatus !== filters.maritalStatus) return false;
  if (filters.incomeRange && row.incomeRange !== filters.incomeRange) return false;
  if (filters.city && !String(row.city || '').includes(String(filters.city))) return false;
  return true;
}

function requireUser(token) {
  const session = tokenService.verify(token);
  if (!session.userId) throw createHttpError('unauthorized', 401, 40100);
  return session;
}

function requireAdmin(token) {
  const session = tokenService.verify(token);
  if (session.role !== 'admin' || session.type !== 'admin') {
    throw createHttpError('仅管理员可访问', 403, 40303);
  }
  return session;
}

const auth = {
  async wxLogin(payload = {}) {
    const wxContext = cloud.getWXContext();
    const { code, nickname, avatarUrl, role, inviteCode } = payload;
    const openid = wxContext.OPENID || `wx_${code || Date.now()}`;
    let user = await getOne(C.users, { openid });

    if (!user) {
      const id = await nextId('user');
      user = await addRow(C.users, {
        id,
        openid,
        phone: '',
        nickname: nickname || `用户${String(id).padStart(4, '0')}`,
        avatarUrl: avatarUrl || '',
        gender: 0,
        currentRole: role === 'matchmaker' ? 'matchmaker' : 'user',
        isVerified: 0,
        status: 1
      });
    } else {
      const patch = {
        currentRole: role === 'matchmaker' ? 'matchmaker' : user.currentRole || 'user'
      };
      if (nickname) patch.nickname = nickname;
      if (avatarUrl) patch.avatarUrl = avatarUrl;
      user = await updateRow(C.users, user, patch);
    }

    if (inviteCode) {
      try {
        await createMemberMatchmakerRequest(user.id, { inviteCode, source: 'share' });
      } catch (err) {
        console.warn('login invite request failed', err);
      }
    }

    return {
      token: tokenService.sign({ userId: user.id, currentRole: user.currentRole }),
      refreshToken: tokenService.sign({ userId: user.id, type: 'refresh' }),
      user: publicUser(user)
    };
  },

  async bindPhone(userId, phone) {
    const user = await getUserOrThrow(userId);
    if (!phone) throw createHttpError('phone is required');
    const existing = await getOne(C.users, { phone });
    if (existing && existing.id !== user.id) {
      throw createHttpError('phone already bound', 400, 40002);
    }
    const updated = await updateRow(C.users, user, { phone });
    return publicUser(updated);
  }
};

const matchmaker = {
  async apply(userId, data = {}) {
    const user = await getUserOrThrow(userId);
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
      certificationRemark: remark
    });
    return stripInternal(updated);
  },

  async dashboard(userId) {
    const row = await getMatchmakerByUserIdOrThrow(userId);
    if (process.env.DEMO_MEMBERS !== 'false' && Number(row.certificationStatus) === 2) {
      await ensureDemoMembersForMatchmaker(userId);
    }
    const members = await getAll(C.members, { matchmakerId: row.id, status: 1 });
    const salons = await getAll(C.salonEvents, { organizerId: Number(userId) });
    const allMembers = await getAll(C.members, { status: 1 });
    const matchRecords = await getAll(C.matchRecords, { matchmakerId: row.id });
    const memberUserIds = new Set(allMembers.map(item => Number(item.userId)));
    const profileResources = (await getAll(C.profiles))
      .filter(item => isTrue(item.displayEnabled))
      .filter(item => !memberUserIds.has(Number(item.userId)))
      .filter(item => Number(item.userId) !== Number(userId));
    const memberViews = await Promise.all(members.map(memberRow => memberView(memberRow, { matchRecords })));
    const resourceViews = await Promise.all(
      allMembers
        .filter(item => item.matchmakerId !== row.id)
        .map(memberRow => memberView(memberRow, { matchRecords }))
    );
    const profileResourceViews = await Promise.all(profileResources.map(profileRow => profileMemberView(profileRow, { matchRecords })));
    const eventIds = salons.map(item => Number(item.id));
    const registrations = eventIds.length
      ? (await getAll(C.registrations)).filter(item => eventIds.includes(Number(item.eventId)) && item.status === 'registered')
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
    const resourceCount = [...resourceViews, ...profileResourceViews].filter(item => Number(item.status) === 1 && item.displayEnabled).length;
    const pendingMemberRequests = (await getAll(C.memberRequests, { matchmakerId: row.id, status: 'pending' })).length;
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
        nickname: user.nickname || '红娘顾问',
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
        nickname: (matchmakerUser && matchmakerUser.nickname) || '红娘顾问',
        avatarUrl: (matchmakerUser && matchmakerUser.avatarUrl) || '',
        level: matchmakerWithIdentity.level || 1
      }
    };
  },

  async addManual(matchmakerUserId, data = {}) {
    const mm = await getCertifiedMatchmakerByUserIdOrThrow(matchmakerUserId);
    const media = withMemberMedia(data);
    let user = data.phone ? await getOne(C.users, { phone: data.phone }) : null;
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
        status: 1
      });
    } else {
      user = await updateRow(C.users, user, {
        nickname: data.realName || data.nickname || user.nickname,
        gender: Number(data.gender || user.gender || 0),
        avatarUrl: media.avatarUrl || user.avatarUrl
      });
    }

    const profilePatch = {
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
    if (data.displayEnabled !== undefined) {
      profilePatch.displayEnabled = isTrue(data.displayEnabled);
      profilePatch.displayUpdatedAt = nowIso();
    }
    const profile = await getOne(C.profiles, { userId: user.id });
    if (profile) await updateRow(C.profiles, profile, profilePatch);
    else await addRow(C.profiles, { id: await nextId('profile'), ...profilePatch });

    let row = await getOne(C.members, { matchmakerId: mm.id, userId: user.id });
    if (!row) {
      row = await addRow(C.members, {
        id: await nextId('member'),
        matchmakerId: mm.id,
        userId: user.id,
        memberType: data.memberType || 'no_consumption',
        serviceLevel: data.serviceLevel || '',
        expireAt: data.expireAt || null,
        remark: data.remark || '',
        status: 1
      });
    } else {
      row = await updateRow(C.members, row, {
        memberType: data.memberType || row.memberType,
        serviceLevel: data.serviceLevel !== undefined ? data.serviceLevel : row.serviceLevel,
        expireAt: data.expireAt !== undefined ? data.expireAt : row.expireAt,
        remark: data.remark !== undefined ? data.remark : row.remark,
        status: 1
      });
    }
    return memberView(row);
  },

  async listOwn(matchmakerUserId, filters = {}) {
    const mm = await getCertifiedMatchmakerByUserIdOrThrow(matchmakerUserId);
    let rows = await getAll(C.members, { matchmakerId: mm.id });
    if (filters.status === undefined || filters.status === '') {
      rows = rows.filter(row => Number(row.status) === 1);
    }
    const matchRecords = await getAll(C.matchRecords, { matchmakerId: mm.id });
    const views = await Promise.all(rows.map(row => memberView(row, { matchRecords })));
    return resolveMemberMediaPage(
      paginate(views.filter(row => matchesMemberFilters(row, filters)).sort((a, b) => b.id - a.id), filters.page, filters.pageSize)
    );
  },

  async resources(matchmakerUserId, filters = {}) {
    const mm = await getCertifiedMatchmakerByUserIdOrThrow(matchmakerUserId);
    const rows = await getAll(C.members, { status: 1 });
    const matchRecords = await getAll(C.matchRecords, { matchmakerId: mm.id });
    const memberUserIds = new Set(rows.map(row => Number(row.userId)));
    const profileRows = (await getAll(C.profiles))
      .filter(row => isTrue(row.displayEnabled))
      .filter(row => !memberUserIds.has(Number(row.userId)))
      .filter(row => Number(row.userId) !== Number(matchmakerUserId));
    const memberViews = await Promise.all(rows.filter(row => row.matchmakerId !== mm.id).map(row => memberView(row, { matchRecords })));
    const profileViews = await Promise.all(profileRows.map(row => profileMemberView(row, { matchRecords })));
    const views = [...memberViews, ...profileViews];
    return resolveMemberMediaPage(paginate(
      views
        .filter(row => Number(row.status) === 1 && row.displayEnabled && matchesMemberFilters(row, filters))
        .sort(sortMemberRowsDesc),
      filters.page,
      filters.pageSize
    ));
  },

  async showcase(filters = {}) {
    const rows = await getAll(C.members, { status: 1 });
    const matchRecords = await getAll(C.matchRecords);
    const memberUserIds = new Set(rows.map(row => Number(row.userId)));
    const profileRows = (await getAll(C.profiles))
      .filter(row => isTrue(row.displayEnabled))
      .filter(row => !memberUserIds.has(Number(row.userId)));
    const memberViews = await Promise.all(rows.map(row => publicMemberView(row, { matchRecords })));
    const profileViews = await Promise.all(profileRows.map(async row => {
      const view = await profileMemberView(row, { matchRecords });
      if (!view.displayEnabled) return null;
      return sanitizePublicMemberRow(view);
    }));
    return resolveMemberMediaPage(paginate(
      [...memberViews, ...profileViews]
        .filter(row => row && Number(row.status) === 1 && matchesMemberFilters(row, filters))
        .sort(sortMemberRowsDesc),
      filters.page,
      filters.pageSize
    ));
  },

  async update(matchmakerUserId, memberId, data = {}) {
    const mm = await getCertifiedMatchmakerByUserIdOrThrow(matchmakerUserId);
    const row = await getById(C.members, memberId);
    if (!row || row.matchmakerId !== mm.id) {
      throw createHttpError('member not found', 404, 40400);
    }
    const updated = await updateRow(C.members, row, {
      memberType: data.memberType || row.memberType,
      serviceLevel: data.serviceLevel !== undefined ? data.serviceLevel : row.serviceLevel,
      expireAt: data.expireAt !== undefined ? data.expireAt : row.expireAt,
      remark: data.remark !== undefined ? data.remark : row.remark
    });
    const user = await getById(C.users, row.userId);
    if (user) {
      const userPatch = {};
      if (data.realName || data.nickname) userPatch.nickname = data.realName || data.nickname;
      if (data.gender !== undefined) userPatch.gender = Number(data.gender);
      if (data.avatarUrl !== undefined) userPatch.avatarUrl = data.avatarUrl;
      if (Object.keys(userPatch).length) await updateRow(C.users, user, userPatch);
    }
    const profile = await getOne(C.profiles, { userId: row.userId });
    const profilePatch = { ...data };
    if (data.photos !== undefined) profilePatch.photos = normalizeMemberPhotos(data.photos);
    if (data.displayEnabled !== undefined) {
      profilePatch.displayEnabled = isTrue(data.displayEnabled);
      profilePatch.displayUpdatedAt = nowIso();
    }
    if (profile) await updateRow(C.profiles, profile, profilePatch);
    else await addRow(C.profiles, { id: await nextId('profile'), userId: row.userId, displayEnabled: false, ...profilePatch });
    return memberView(updated);
  },

  async remove(matchmakerUserId, memberId) {
    const mm = await getCertifiedMatchmakerByUserIdOrThrow(matchmakerUserId);
    const row = await getById(C.members, memberId);
    if (!row || row.matchmakerId !== mm.id) {
      throw createHttpError('member not found', 404, 40400);
    }
    const updated = await updateRow(C.members, row, { status: 0 });
    return memberView(updated);
  },

  async recommend(matchmakerUserId, data = {}) {
    const mm = await getCertifiedMatchmakerByUserIdOrThrow(matchmakerUserId);
    const own = await getById(C.members, data.myMemberId);
    if (!own || Number(own.matchmakerId) !== Number(mm.id) || Number(own.status) !== 1) {
      throw createHttpError('own member not found');
    }
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
      const messages = await Promise.all([
        addRow(C.messages, {
          id: await nextId('message'),
          senderId: Number(matchmakerUserId),
          receiverId: Number(own.userId),
          contentType: 'text',
          content: data.note || `红娘为你推荐了会员 ${targetName}，请等待后续跟进。`,
          isRead: 0
        }),
        addRow(C.messages, {
          id: await nextId('message'),
          senderId: Number(matchmakerUserId),
          receiverId: Number(target.userId),
          contentType: 'text',
          content: data.note || `红娘为你推荐了会员 ${ownName}，请等待后续跟进。`,
          isRead: 0
        })
      ]);
      return { matchRecord: stripInternal(matchRecord), messages: messages.map(message => stripInternal(message)) };
    }

    const resourceUser = await getById(C.users, data.resourceUserId);
    if (!resourceUser) throw createHttpError('resource user not found', 404, 40400);
    if (own.userId === resourceUser.id) throw createHttpError('cannot recommend to self');

    const [userAId, userBId] = own.userId < resourceUser.id
      ? [own.userId, resourceUser.id]
      : [resourceUser.id, own.userId];
    const matchRecord = await addRow(C.matchRecords, {
      id: await nextId('matchRecord'),
      userAId,
      userBId,
      matchmakerId: mm.id,
      matchType: 'recommend',
      compatibilityScore: null,
      status: 'pending'
    });
    const ownUser = await getById(C.users, own.userId);
    const message = await addRow(C.messages, {
      id: await nextId('message'),
      senderId: Number(matchmakerUserId),
      receiverId: resourceUser.id,
      contentType: 'text',
      content: data.note || `红娘为您推荐了会员 ${(ownUser && ownUser.nickname) || ''}`,
      isRead: 0
    });
    return { matchRecord: stripInternal(matchRecord), message: stripInternal(message) };
  }
};

const salon = {
  async createEvent(organizerUserId, data = {}) {
    await getCertifiedMatchmakerByUserIdOrThrow(organizerUserId);
    if (!data.title || !data.eventDate) throw createHttpError('title and eventDate are required');
    return stripInternal(await addRow(C.salonEvents, {
      id: await nextId('salon'),
      title: data.title,
      description: data.description || '',
      coverImage: data.coverImage || '',
      location: data.location || '',
      eventDate: new Date(data.eventDate).toISOString(),
      maxParticipants: Number(data.maxParticipants || 0),
      currentParticipants: 0,
      price: Number(data.price || 0),
      organizerId: Number(organizerUserId),
      status: 'pending',
      reviewRemark: ''
    }));
  },

  async listEvents(filters = {}) {
    let rows = await getAll(C.salonEvents);
    if (filters.status) rows = rows.filter(row => row.status === filters.status);
    else rows = rows.filter(row => row.status === 'upcoming');
    rows = rows.sort((a, b) => new Date(a.eventDate) - new Date(b.eventDate));
    const views = await Promise.all(rows.map(row => eventView(row)));
    return paginate(views, filters.page, filters.pageSize);
  },

  async getEventDetail(eventId, currentUserId = null) {
    const event = await getById(C.salonEvents, eventId);
    if (event && event.status !== 'upcoming' && Number(event.organizerId) !== Number(currentUserId)) {
      return null;
    }
    return event ? eventView(event, currentUserId) : null;
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
    if (event.status !== 'upcoming') {
      return { canShare: false, reason: 'event_unavailable', event: eventSummary };
    }
    const registration = await getOne(C.registrations, { eventId: event.id, userId: Number(userId), status: 'registered' });
    if (!registration) {
      return { canShare: false, reason: 'not_registered', event: eventSummary };
    }
    const matchmakerRow = await getOne(C.matchmakers, { userId: Number(event.organizerId), status: 1 });
    if (!matchmakerRow || Number(matchmakerRow.certificationStatus) !== 2) {
      return { canShare: false, reason: 'matchmaker_unavailable', event: eventSummary };
    }
    const matchmakerWithIdentity = await ensureMatchmakerIdentity(matchmakerRow);
    const sharePath = `/pages/user/matchmaker-invite?code=${encodeURIComponent(matchmakerWithIdentity.inviteCode)}&source=memberSalonShare&eventId=${encodeURIComponent(String(event.id))}&autoRegister=1`;
    return {
      canShare: true,
      title: `邀请你报名沙龙《${eventSummary.title}》`,
      sharePath,
      event: eventSummary
    };
  },

  async register(eventId, userId) {
    let event = await getById(C.salonEvents, eventId);
    if (!event) throw createHttpError('event not found', 404, 40400);
    if (event.status !== 'upcoming') throw createHttpError('event is not registerable');
    const existing = await getOne(C.registrations, { eventId: event.id, userId: Number(userId) });
    if (existing && existing.status === 'registered') throw createHttpError('already registered');
    if (event.maxParticipants > 0 && event.currentParticipants >= event.maxParticipants) {
      throw createHttpError('event is full');
    }
    event = await updateRow(C.salonEvents, event, { currentParticipants: Number(event.currentParticipants || 0) + 1 });
    if (existing) {
      return stripInternal(await updateRow(C.registrations, existing, { status: 'registered' }));
    }
    return stripInternal(await addRow(C.registrations, {
      id: await nextId('registration'),
      eventId: event.id,
      userId: Number(userId),
      status: 'registered',
      checkedInAt: null
    }));
  },

  async cancelRegistration(eventId, userId) {
    const event = await getById(C.salonEvents, eventId);
    const registration = await getOne(C.registrations, { eventId: Number(eventId), userId: Number(userId), status: 'registered' });
    if (!event || !registration) throw createHttpError('registration not found', 404, 40400);
    await updateRow(C.salonEvents, event, { currentParticipants: Math.max(0, Number(event.currentParticipants || 0) - 1) });
    return stripInternal(await updateRow(C.registrations, registration, { status: 'cancelled' }));
  },

  async myRegistrations(userId, filters = {}) {
    const rows = (await getAll(C.registrations, { userId: Number(userId) }))
      .filter(reg => reg.status !== 'cancelled')
      .sort((a, b) => b.id - a.id);
    const views = await Promise.all(rows.map(async reg => ({
      ...stripInternal(reg),
      event: await eventView(await getById(C.salonEvents, reg.eventId))
    })));
    return paginate(views, filters.page, filters.pageSize);
  },

  async myEvents(organizerUserId, filters = {}) {
    const rows = (await getAll(C.salonEvents, { organizerId: Number(organizerUserId) }))
      .sort((a, b) => b.id - a.id);
    const views = await Promise.all(rows.map(row => eventView(row)));
    return paginate(views, filters.page, filters.pageSize);
  },

  async updateEvent(eventId, organizerUserId, data = {}) {
    const event = await getById(C.salonEvents, eventId);
    if (!event) throw createHttpError('event not found', 404, 40400);
    if (event.organizerId !== Number(organizerUserId)) throw createHttpError('forbidden', 403, 40300);
    if (['ended', 'cancelled'].includes(event.status)) throw createHttpError('event cannot be updated');
    const patch = {};
    ['title', 'description', 'coverImage', 'location'].forEach(key => {
      if (data[key] !== undefined) patch[key] = data[key];
    });
    if (data.eventDate !== undefined) patch.eventDate = new Date(data.eventDate).toISOString();
    if (data.maxParticipants !== undefined) patch.maxParticipants = Number(data.maxParticipants);
    if (data.price !== undefined) patch.price = Number(data.price);
    if (event.status === 'upcoming' && Object.keys(patch).length) {
      patch.status = 'pending';
      patch.reviewRemark = '';
    }
    return stripInternal(await updateRow(C.salonEvents, event, patch));
  },

  async cancelEvent(eventId, organizerUserId) {
    const event = await getById(C.salonEvents, eventId);
    if (!event) throw createHttpError('event not found', 404, 40400);
    if (event.organizerId !== Number(organizerUserId)) throw createHttpError('forbidden', 403, 40300);
    return stripInternal(await updateRow(C.salonEvents, event, { status: 'cancelled' }));
  },

  async inviteMembers(eventId, organizerUserId, userIds = [], options = {}) {
    const event = await getById(C.salonEvents, eventId);
    if (!event) throw createHttpError('event not found', 404, 40400);
    if (event.organizerId !== Number(organizerUserId)) throw createHttpError('forbidden', 403, 40300);
    if (event.status !== 'upcoming') throw createHttpError('event is not inviteable');
    const mm = await getMatchmakerByUserIdOrThrow(organizerUserId);
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

const admin = {
  async login(code) {
    const adminCode = process.env.ADMIN_CODE || 'HLADMIN';
    if (!code || String(code) !== String(adminCode)) {
      throw createHttpError('管理员码不正确', 401, 40102);
    }
    return {
      token: tokenService.sign({ role: 'admin', type: 'admin', issuedAt: nowIso() }),
      admin: { role: 'admin', name: 'HL 管理员' }
    };
  },

  async dashboard() {
    const matchmakers = (await getAll(C.matchmakers)).filter(row => row.status === 1);
    const members = (await getAll(C.members)).filter(row => row.status === 1);
    const salons = await getAll(C.salonEvents);
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
    let rows = (await getAll(C.matchmakers)).filter(row => row.status === 1);
    if (filters.status !== undefined && filters.status !== '') {
      rows = rows.filter(row => String(row.certificationStatus) === String(filters.status));
    }
    const views = await Promise.all(rows.map(async row => {
      const user = await getById(C.users, row.userId) || {};
      const members = await getAll(C.members, { matchmakerId: row.id, status: 1 });
      const salons = await getAll(C.salonEvents, { organizerId: row.userId });
      return {
        ...stripInternal(row),
        user: publicUser(user),
        memberCount: members.length,
        salonCount: salons.length
      };
    }));
    return paginate(views.sort((a, b) => b.id - a.id), filters.page, filters.pageSize);
  },

  async listSalons(filters = {}) {
    let rows = await getAll(C.salonEvents);
    if (filters.status) rows = rows.filter(row => row.status === filters.status);
    const views = await Promise.all(rows.sort((a, b) => b.id - a.id).map(row => eventView(row)));
    return paginate(views, filters.page, filters.pageSize);
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
    return eventView(await updateRow(C.salonEvents, event, {
      status: reviewStatus,
      reviewRemark: remark || '',
      reviewedAt: nowIso()
    }));
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

      const mm1User = await createSeedUser('seed-mm-1', '王红娘');
      const mm2User = await createSeedUser('seed-mm-2', '李月老');
      const mm1 = await matchmaker.apply(mm1User.id, { certificationStatus: 2 });
      const mm2 = await matchmaker.apply(mm2User.id, { certificationStatus: 2 });
      await matchmaker.setCertification(mm1.id, 2);
      await matchmaker.setCertification(mm2.id, 2);
      await addMembersToMatchmaker(mm1User.id, SEEDED_MEMBER_GROUPS[0]);
      await addMembersToMatchmaker(mm2User.id, SEEDED_MEMBER_GROUPS[1]);
      const seedSalon = await salon.createEvent(mm1User.id, {
        title: '周末轻社交沙龙',
        description: '小范围线下交流，红娘现场协助破冰。',
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

exports.main = async (event = {}) => {
  try {
    const method = String(event.method || 'GET').toUpperCase();
    const path = String(event.path || '/');
    const data = event.data || {};
    const apiToken = event.token || '';

    if (method === 'GET' && path === '/health') return ok({ status: 'ok' });

    await ensureCollectionsForPath(path);
    await ensureSeed();
    if (method === 'POST' && path === '/auth/wx-login') return ok(await auth.wxLogin(data));
    if (method === 'POST' && path === '/admin/login') return ok(await admin.login(data.code));

    if (path.startsWith('/admin/')) {
      requireAdmin(apiToken);
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
      throw createHttpError('not found', 404, 40400);
    }

    const session = requireUser(apiToken);

    if (method === 'POST' && path === '/auth/bind-phone') return ok(await auth.bindPhone(session.userId, data.phone));
    if (method === 'GET' && path === '/user/profile') {
      const user = await getUserOrThrow(session.userId);
      const profile = await getOne(C.profiles, { userId: Number(session.userId) });
      return ok({ ...publicUser(user), profile: profile ? stripInternal(profile) : null });
    }
    if (method === 'PUT' && path === '/user/profile') {
      const user = await getUserOrThrow(session.userId);
      const userPatch = {};
      if (data.realName || data.nickname) userPatch.nickname = data.realName || data.nickname;
      if (data.avatarUrl !== undefined) userPatch.avatarUrl = data.avatarUrl;
      if (data.gender !== undefined) userPatch.gender = Number(data.gender);
      const updatedUser = Object.keys(userPatch).length ? await updateRow(C.users, user, userPatch) : user;
      let profile = await getOne(C.profiles, { userId: Number(session.userId) });
      const profilePatch = { ...data, userId: Number(session.userId) };
      if (data.photos !== undefined) profilePatch.photos = normalizeMemberPhotos(data.photos);
      if (data.displayEnabled !== undefined) {
        profilePatch.displayEnabled = isTrue(data.displayEnabled);
        profilePatch.displayUpdatedAt = nowIso();
      } else if (!profile) {
        profilePatch.displayEnabled = false;
      }
      if (profile) profile = await updateRow(C.profiles, profile, profilePatch);
      else profile = await addRow(C.profiles, { id: await nextId('profile'), ...profilePatch });
      return ok({ ...publicUser(updatedUser), profile: stripInternal(profile) });
    }

    if (method === 'POST' && path === '/matchmaker/apply') return ok(await matchmaker.apply(session.userId, data));
    if (method === 'GET' && path === '/matchmaker/dashboard') return ok(await matchmaker.dashboard(session.userId));
    if (method === 'GET' && path === '/matchmaker/invite-card') return ok(await matchmaker.inviteCard(session.userId));
    if (method === 'POST' && path === '/matchmaker/invite-code/reset') return ok(await matchmaker.resetInviteCode(session.userId));
    if (method === 'GET' && path === '/matchmaker/member-requests') return ok(await matchmaker.listMemberRequests(session.userId, data));
    const matchmakerRequestApproveMatch = path.match(/^\/matchmaker\/member-requests\/(\d+)\/approve$/);
    if (matchmakerRequestApproveMatch && method === 'POST') return ok(await matchmaker.approveMemberRequest(session.userId, matchmakerRequestApproveMatch[1]));
    const matchmakerRequestRejectMatch = path.match(/^\/matchmaker\/member-requests\/(\d+)\/reject$/);
    if (matchmakerRequestRejectMatch && method === 'POST') return ok(await matchmaker.rejectMemberRequest(session.userId, matchmakerRequestRejectMatch[1], data.remark || ''));

    if (method === 'GET' && path === '/member/list') return ok(await member.listOwn(session.userId, data));
    if (method === 'GET' && path === '/member/resources') return ok(await member.resources(session.userId, data));
    if (method === 'GET' && path === '/member/showcase') return ok(await member.showcase(data));
    if (method === 'GET' && path === '/member/matchmaker-invite/resolve') return ok(await member.resolveMatchmakerInvite(session.userId, data));
    if (method === 'POST' && path === '/member/matchmaker-requests') return ok(await member.requestMatchmaker(session.userId, data));
    if (method === 'POST' && path === '/member/matchmaker-invite/accept') return ok(await member.acceptMatchmakerInvite(session.userId, data));
    if (method === 'GET' && path === '/member/referral-card') return ok(await member.referralCard(session.userId));
    if (method === 'POST' && path === '/member/manual') return ok(await member.addManual(session.userId, data));
    if (method === 'POST' && path === '/member/recommend') return ok(await member.recommend(session.userId, data));
    const memberMatch = path.match(/^\/member\/(\d+)$/);
    if (memberMatch && method === 'PUT') return ok(await member.update(session.userId, memberMatch[1], data));
    if (memberMatch && method === 'DELETE') return ok(await member.remove(session.userId, memberMatch[1]));

    if (method === 'GET' && path === '/salon/events') return ok(await salon.listEvents(data));
    if (method === 'POST' && path === '/salon/events') return ok(await salon.createEvent(session.userId, data));
    if (method === 'GET' && path === '/salon/my-events') return ok(await salon.myEvents(session.userId, data));
    if (method === 'GET' && path === '/salon/my-registrations') return ok(await salon.myRegistrations(session.userId, data));
    const shareCardMatch = path.match(/^\/salon\/events\/(\d+)\/share-card$/);
    if (shareCardMatch && method === 'GET') return ok(await salon.shareCard(shareCardMatch[1], session.userId));
    const salonMatch = path.match(/^\/salon\/events\/(\d+)$/);
    if (salonMatch && method === 'GET') {
      const detail = await salon.getEventDetail(salonMatch[1], session.userId);
      if (!detail) throw createHttpError('event not found', 404, 40400);
      return ok(detail);
    }
    if (salonMatch && method === 'PUT') return ok(await salon.updateEvent(salonMatch[1], session.userId, data));
    const registerMatch = path.match(/^\/salon\/events\/(\d+)\/register$/);
    if (registerMatch && method === 'POST') return ok(await salon.register(registerMatch[1], session.userId), 'registered');
    if (registerMatch && method === 'DELETE') return ok(await salon.cancelRegistration(registerMatch[1], session.userId), 'cancelled');
    const cancelMatch = path.match(/^\/salon\/events\/(\d+)\/cancel$/);
    if (cancelMatch && method === 'PUT') return ok(await salon.cancelEvent(cancelMatch[1], session.userId), 'event cancelled');
    const inviteMatch = path.match(/^\/salon\/events\/(\d+)\/invite$/);
    if (inviteMatch && method === 'POST') return ok(await salon.inviteMembers(inviteMatch[1], session.userId, data.userIds || [], { all: data.all === true }));

    throw createHttpError('not found', 404, 40400);
  } catch (err) {
    console.error(err);
    return fail(err);
  }
};
