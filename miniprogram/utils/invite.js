"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.invitePath = exports.extractInviteCode = exports.normalizeInviteCode = void 0;
function normalizeInviteCode(value) {
    return String(value || '').trim().replace(/\s+/g, '').toUpperCase();
}
exports.normalizeInviteCode = normalizeInviteCode;
function queryValue(raw, key) {
    const match = raw.match(new RegExp(`[?&#]${key}=([^&#]+)`, 'i'));
    return match ? decodeURIComponent(match[1] || '') : '';
}
function extractInviteCode(input) {
    const raw = String(input || '').trim();
    if (!raw)
        return '';
    const direct = normalizeInviteCode(raw);
    if (/^(HL[A-Z0-9]{4,}|MM\d+|MBR\d+|\d+)$/i.test(direct))
        return direct;
    const fromCode = queryValue(raw, 'code') || queryValue(raw, 'inviteCode') || queryValue(raw, 'matchmakerNo');
    if (fromCode)
        return normalizeInviteCode(fromCode);
    const scene = queryValue(raw, 'scene');
    if (scene && scene !== raw) {
        return extractInviteCode(scene);
    }
    const codeLike = raw.match(/\b(HL[A-Z0-9]{4,}|MM\d{2,}|MBR\d+)\b/i);
    return codeLike ? normalizeInviteCode(codeLike[1]) : '';
}
exports.extractInviteCode = extractInviteCode;
function invitePath(code, source = 'share') {
    return `/pages/user/matchmaker-invite?code=${encodeURIComponent(normalizeInviteCode(code))}&source=${encodeURIComponent(source)}`;
}
exports.invitePath = invitePath;
