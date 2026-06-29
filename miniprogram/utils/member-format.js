"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeMemberProfile = exports.mergePhotoLists = exports.normalizePhotoList = exports.photosFromText = exports.defaultPhotos = exports.defaultAvatar = exports.memberTypeText = exports.genderText = exports.PHOTO_WALL_LIMIT = void 0;
const ASSET_ROOT = '/assets/members/';
const MALE_AVATARS = [
    `${ASSET_ROOT}avatar-male-1.png`,
    `${ASSET_ROOT}avatar-male-2.png`
];
const FEMALE_AVATARS = [
    `${ASSET_ROOT}avatar-female-1.png`,
    `${ASSET_ROOT}avatar-female-2.png`
];
const LIFESTYLE_PHOTOS = [
    `${ASSET_ROOT}lifestyle-gallery.png`,
    `${ASSET_ROOT}lifestyle-cafe.png`,
    `${ASSET_ROOT}lifestyle-city.png`,
    `${ASSET_ROOT}lifestyle-travel.png`,
    `${ASSET_ROOT}lifestyle-reading.png`,
    `${ASSET_ROOT}lifestyle-sport.png`
];
exports.PHOTO_WALL_LIMIT = 3;
function hashKey(value) {
    let hash = 0;
    for (let index = 0; index < value.length; index += 1) {
        hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
    }
    return hash;
}
function memberKey(row) {
    return String(row.id || row.userId || row.realName || row.nickname || row.city || 'hl');
}
function compactList(values) {
    return values.map(value => String(value || '').trim()).filter(Boolean);
}
function valueWithUnit(value, unit, fallback) {
    const text = String(value || '').trim();
    if (!text)
        return fallback;
    return text.indexOf(unit) >= 0 ? text : `${text}${unit}`;
}
function completionFor(row) {
    if (row.profileCompletion && typeof row.profileCompletion === 'object')
        return row.profileCompletion;
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
function photoSet(key) {
    const start = hashKey(key) % LIFESTYLE_PHOTOS.length;
    return [0, 1, 2].map(offset => LIFESTYLE_PHOTOS[(start + offset) % LIFESTYLE_PHOTOS.length]);
}
function genderText(gender) {
    if (Number(gender) === 1)
        return '男士';
    if (Number(gender) === 2)
        return '女士';
    return '';
}
exports.genderText = genderText;
function memberTypeText(type) {
    if (type === 'free')
        return '免费会员';
    if (type === 'paid')
        return '付费会员';
    if (type === 'vip')
        return 'VIP会员';
    return '待消费会员';
}
exports.memberTypeText = memberTypeText;
function defaultAvatar(row) {
    const pool = Number(row.gender) === 1 ? MALE_AVATARS : FEMALE_AVATARS;
    return pool[hashKey(memberKey(row)) % pool.length];
}
exports.defaultAvatar = defaultAvatar;
function defaultPhotos(row) {
    return photoSet(memberKey(row));
}
exports.defaultPhotos = defaultPhotos;
function photosFromText(value) {
    return normalizePhotoList(value
        .split(/\r?\n/)
        .map(item => item.trim())
        .filter(Boolean));
}
exports.photosFromText = photosFromText;
function normalizePhotoList(values) {
    const seen = new Set();
    const photos = [];
    values.forEach(value => {
        const photo = String(value || '').trim();
        if (!photo || seen.has(photo) || photos.length >= exports.PHOTO_WALL_LIMIT)
            return;
        seen.add(photo);
        photos.push(photo);
    });
    return photos;
}
exports.normalizePhotoList = normalizePhotoList;
function mergePhotoLists(existing, next) {
    return normalizePhotoList([...existing, ...next]);
}
exports.mergePhotoLists = mergePhotoLists;
function normalizeMemberProfile(row, internal = false) {
    const memberPhotos = Array.isArray(row.photos) && row.photos.length ? normalizePhotoList(row.photos) : [];
    const avatarUrl = memberPhotos[0] || defaultAvatar(row);
    const photos = memberPhotos.length ? memberPhotos : defaultPhotos(row);
    const profileCompletion = completionFor({ ...row, photos: memberPhotos });
    const city = row.city || row.province || '城市待确认';
    const age = valueWithUnit(row.age, '岁', '年龄保密');
    const height = valueWithUnit(row.height, 'cm', '身高保密');
    const education = row.education || '学历保密';
    const occupation = row.occupation || '职业保密';
    const income = row.incomeRange || '收入保密';
    const displayName = row.realName || row.nickname || '优质会员';
    const profileTags = compactList([
        genderText(row.gender),
        row.maritalStatus,
        row.houseStatus,
        row.carStatus
    ]);
    const highlightTags = compactList([
        city,
        education,
        occupation,
        row.incomeRange
    ]);
    const baseRows = [
        { label: '年龄', value: age },
        { label: '身高', value: height },
        { label: '城市', value: city },
        { label: '籍贯', value: row.nativePlace || '籍贯保密' }
    ];
    const careerRows = [
        { label: '学历', value: education },
        { label: '职业', value: occupation },
        { label: '收入', value: income },
        { label: '婚况', value: row.maritalStatus || '婚况保密' }
    ];
    const lifeRows = [
        { label: '房产', value: row.houseStatus || '房产情况保密' },
        { label: '车辆', value: row.carStatus || '车辆情况保密' }
    ];
    if (row.memberType) {
        lifeRows.push({ label: '会员类型', value: memberTypeText(row.memberType || '') });
    }
    if (internal) {
        lifeRows.push({ label: '服务等级', value: row.serviceLevel ? `${row.serviceLevel}级` : '未分级' });
    }
    return {
        ...row,
        avatarUrl,
        photos,
        coverUrl: memberPhotos[0] || avatarUrl,
        displayName,
        metaText: `${age} · ${height} · ${city}`,
        workText: `${education} · ${occupation}`,
        occupationText: occupation,
        incomeText: income,
        cityText: city,
        memberLevel: row.memberType === 'vip' ? 'VIP' : '会员',
        memberTypeText: memberTypeText(row.memberType || ''),
        profileCompletion,
        profileCompletionText: profileCompletion.text || `${profileCompletion.percent || 0}%`,
        displayStatusText: row.displayStatus || (profileCompletion.percent >= 70 ? '可展示' : '待完善'),
        lastRecommendStatusText: row.lastRecommendStatus || '暂无推荐',
        serviceLevelText: row.serviceLevel ? `${row.serviceLevel}级服务` : '未分级',
        introText: row.selfIntro || '暂未补充自我介绍，红娘会在服务沟通中继续完善。',
        partnerText: row.partnerRequirement || '期待在红娘沟通后进一步了解。',
        remarkText: internal ? row.remark || '暂无红娘备注' : '',
        profileTags,
        highlightTags,
        baseRows,
        careerRows,
        lifeRows
    };
}
exports.normalizeMemberProfile = normalizeMemberProfile;
