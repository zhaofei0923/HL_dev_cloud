"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.salonAvailability = void 0;
function salonAvailability(event, now = Date.now()) {
    const startsAt = event.eventDate ? new Date(event.eventDate).getTime() : NaN;
    const invalidDate = !Number.isFinite(startsAt);
    const expired = event.isExpired === true || (!invalidDate && startsAt <= now);
    const full = event.isFull === true || (Number(event.maxParticipants) > 0
        && Number(event.currentParticipants || 0) >= Number(event.maxParticipants));
    const status = event.status || '';
    let statusText = '报名中';
    let blockedReason = '';
    if (status === 'cancelled') {
        statusText = '活动已取消';
        blockedReason = 'cancelled';
    }
    else if (expired) {
        statusText = '已过期，无法报名';
        blockedReason = 'expired';
    }
    else if (status === 'ended') {
        statusText = '活动已结束';
        blockedReason = 'ended';
    }
    else if (status !== 'upcoming') {
        statusText = status === 'pending' ? '待审核' : status === 'rejected' ? '未通过审核' : '暂未开放报名';
        blockedReason = 'not_open';
    }
    else if (invalidDate) {
        statusText = '时间待确认，无法报名';
        blockedReason = 'invalid_date';
    }
    else if (full) {
        statusText = '席位已满';
        blockedReason = 'full';
    }
    else if (event.canRegister === false) {
        statusText = '暂时无法报名';
        blockedReason = event.registrationBlockedReason || 'not_open';
    }
    return { expired, full, statusText, blockedReason, canRegister: !blockedReason };
}
exports.salonAvailability = salonAvailability;
