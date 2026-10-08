"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.invokeMatchmakerController = exports.instantiateMatchmakerController = exports.isMatchmakerWorkspaceTab = exports.MATCHMAKER_WORKSPACE_TABS = exports.defineMatchmakerController = void 0;
const matchmaker_page_cache_1 = require("./matchmaker-page-cache");
// Keep the same contextual `this` inference as the native Page constructor.
function defineMatchmakerController(definition) {
    return definition;
}
exports.defineMatchmakerController = defineMatchmakerController;
exports.MATCHMAKER_WORKSPACE_TABS = ['dashboard', 'members', 'messages', 'salon', 'mine'];
function isMatchmakerWorkspaceTab(value) {
    return typeof value === 'string' && exports.MATCHMAKER_WORKSPACE_TABS.some(tab => tab === value);
}
exports.isMatchmakerWorkspaceTab = isMatchmakerWorkspaceTab;
function cloneInitial(value) {
    if (value === undefined || value === null || typeof value !== 'object')
        return value;
    return JSON.parse(JSON.stringify(value));
}
function applyDataPath(data, path, value) {
    const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
    let target = data;
    for (let index = 0; index < parts.length - 1; index += 1) {
        const part = parts[index];
        const record = target;
        if (record[part] === null || typeof record[part] !== 'object') {
            record[part] = /^\d+$/.test(parts[index + 1]) ? [] : {};
        }
        target = record[part];
    }
    ;
    target[parts[parts.length - 1]] = value;
}
function safeDataPaths(patch) {
    const safePatch = (0, matchmaker_page_cache_1.sanitizeMatchmakerPageData)(patch);
    const result = {};
    Object.keys(safePatch).forEach(path => {
        const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
        if (!parts.length || parts.some(part => ['__proto__', 'prototype', 'constructor'].includes(part)))
            return;
        const allowed = (0, matchmaker_page_cache_1.sanitizeMatchmakerPageData)(Object.fromEntries(parts.map(part => [part, true])));
        if (parts.every(part => Object.prototype.hasOwnProperty.call(allowed, part)))
            result[path] = safePatch[path];
    });
    return result;
}
// Each retained panel owns its state and methods; only the host owns rendering.
function instantiateMatchmakerController(definition, tab, onDataChange) {
    const instance = {};
    Object.keys(definition).forEach(key => {
        instance[key] = typeof definition[key] === 'function' ? definition[key] : cloneInitial(definition[key]);
    });
    instance.route = `pages/matchmaker/${tab}`;
    instance.is = instance.route;
    instance.options = {};
    instance.data = (0, matchmaker_page_cache_1.sanitizeMatchmakerPageData)(instance.data);
    instance.setData = (patch, callback) => {
        const safePatch = safeDataPaths(patch);
        Object.keys(safePatch).forEach(path => applyDataPath(instance.data, path, safePatch[path]));
        onDataChange(instance, safePatch, callback);
    };
    return instance;
}
exports.instantiateMatchmakerController = instantiateMatchmakerController;
function invokeMatchmakerController(instance, method, args = []) {
    const handler = instance[method];
    return typeof handler === 'function' ? handler.apply(instance, args) : undefined;
}
exports.invokeMatchmakerController = invokeMatchmakerController;
