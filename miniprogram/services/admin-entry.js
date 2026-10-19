"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.readAdminEntry = void 0;
const api_1 = require("./api");
async function readAdminEntry() {
    const response = await (0, api_1.request)('/user/admin-entry', { showError: false });
    if (!response || typeof response !== 'object' || Array.isArray(response))
        return { allowed: false, ready: false };
    const entry = response;
    if (entry.allowed !== true)
        return { allowed: false, ready: false };
    if (entry.ready !== true || entry.mode !== 'native')
        return { allowed: true, ready: false };
    return { allowed: true, ready: true, mode: 'native' };
}
exports.readAdminEntry = readAdminEntry;
