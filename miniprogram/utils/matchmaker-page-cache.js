"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requestMatchmakerPageSnapshot = exports.MatchmakerPageRequestDiscarded = exports.matchmakerPageSnapshotRevision = exports.invalidateMatchmakerPageSnapshots = exports.writeMatchmakerPageSnapshot = exports.readMatchmakerPageSnapshot = exports.matchmakerPageSessionScope = exports.sanitizeMatchmakerPageData = exports.MATCHMAKER_PAGE_TTL_MS = void 0;
const api_1 = require("../services/api");
const page_session_1 = require("./page-session");
exports.MATCHMAKER_PAGE_TTL_MS = 30 * 1000;
const snapshots = new Map();
const pendingReads = new Map();
let activeScope = '';
let revision = 0;
// Only renderable, session-scoped data belongs in these in-memory snapshots.
const sensitiveFields = new Set([
    'privatearchive', 'privatephotos', 'assetverification', 'personalprofile',
    'businessregistration', 'riskassessment', 'lifephotos', 'authversion',
    'idcard', 'idcardfront', 'idcardback', 'idcardnumber', 'identitynumber',
    'identitymaterials', 'verificationmaterials', 'verificationfiles',
    'educationcertificate', 'vehiclecertificate', 'propertycertificate',
    'assetcertificate', 'phone', 'mobile', 'remark'
]);
function cloneForSnapshot(value) {
    const encoded = JSON.stringify(value, (key, item) => {
        const normalized = key.toLowerCase().replace(/[_-]/g, '');
        if (sensitiveFields.has(normalized) || /token|credential|password|secret|openid|authorization|jwt/i.test(key))
            return undefined;
        return item;
    });
    return JSON.parse(encoded);
}
function sanitizeMatchmakerPageData(value) {
    return cloneForSnapshot(value);
}
exports.sanitizeMatchmakerPageData = sanitizeMatchmakerPageData;
function matchmakerPageSessionScope() {
    const session = (0, page_session_1.pageSessionScope)();
    const user = (0, api_1.currentUser)();
    const scope = session ? JSON.stringify([session, 'matchmaker', (user && (user.currentRole || user.role)) || '']) : '';
    if (scope !== activeScope) {
        activeScope = scope;
        revision += 1;
        snapshots.clear();
        pendingReads.clear();
    }
    return scope;
}
exports.matchmakerPageSessionScope = matchmakerPageSessionScope;
function readMatchmakerPageSnapshot(route) {
    if (!matchmakerPageSessionScope())
        return null;
    const cached = snapshots.get(route);
    return cached ? cloneForSnapshot(cached) : null;
}
exports.readMatchmakerPageSnapshot = readMatchmakerPageSnapshot;
function writeMatchmakerPageSnapshot(route, data, loadedAt = Date.now()) {
    if (!matchmakerPageSessionScope() || !Number.isFinite(loadedAt))
        return;
    snapshots.set(route, cloneForSnapshot({ data, loadedAt }));
}
exports.writeMatchmakerPageSnapshot = writeMatchmakerPageSnapshot;
function invalidateMatchmakerPageSnapshots() {
    matchmakerPageSessionScope();
    revision += 1;
    snapshots.clear();
    pendingReads.clear();
}
exports.invalidateMatchmakerPageSnapshots = invalidateMatchmakerPageSnapshots;
function matchmakerPageSnapshotRevision() {
    matchmakerPageSessionScope();
    return revision;
}
exports.matchmakerPageSnapshotRevision = matchmakerPageSnapshotRevision;
class MatchmakerPageRequestDiscarded extends Error {
    constructor() {
        super('matchmaker page request superseded');
        this.name = 'MatchmakerPageRequestDiscarded';
    }
}
exports.MatchmakerPageRequestDiscarded = MatchmakerPageRequestDiscarded;
// Dashboard and mine share one read. Force refresh supersedes only this route.
function requestMatchmakerPageSnapshot(route, fetcher, force = false, isCurrent = () => true) {
    const scope = matchmakerPageSessionScope();
    if (!scope || !isCurrent())
        return Promise.reject(new MatchmakerPageRequestDiscarded());
    const cached = snapshots.get(route);
    if (!force && cached && Date.now() - cached.loadedAt < exports.MATCHMAKER_PAGE_TTL_MS) {
        return Promise.resolve(cloneForSnapshot(cached));
    }
    const existing = pendingReads.get(route);
    if (!force && existing) {
        existing.consumers.push(isCurrent);
        return existing.promise.then(snapshot => cloneForSnapshot(snapshot));
    }
    const startedRevision = revision;
    const read = { promise: Promise.resolve({ data: undefined, loadedAt: 0 }), consumers: [isCurrent] };
    const promise = Promise.resolve().then(fetcher).then(data => {
        if (matchmakerPageSessionScope() !== scope || revision !== startedRevision
            || pendingReads.get(route) !== read || !read.consumers.some(consumer => consumer())) {
            throw new MatchmakerPageRequestDiscarded();
        }
        const snapshot = cloneForSnapshot({ data, loadedAt: Date.now() });
        snapshots.set(route, snapshot);
        return cloneForSnapshot(snapshot);
    }).catch((err) => {
        if (matchmakerPageSessionScope() === scope && revision === startedRevision && pendingReads.get(route) === read) {
            const previous = snapshots.get(route);
            if (previous)
                snapshots.set(route, { ...previous, loadedAt: Date.now() - exports.MATCHMAKER_PAGE_TTL_MS });
        }
        throw err;
    }).finally(() => {
        if (pendingReads.get(route) === read)
            pendingReads.delete(route);
    });
    read.promise = promise;
    pendingReads.set(route, read);
    return promise;
}
exports.requestMatchmakerPageSnapshot = requestMatchmakerPageSnapshot;
