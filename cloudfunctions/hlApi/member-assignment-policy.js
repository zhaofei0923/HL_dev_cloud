'use strict';

const { randomUUID } = require('node:crypto');

const MEMBER_ASSIGNMENT_COUNTER = 'memberAdminAtomic';
const memberAssignmentAnchorId = userId => `memberAssignmentUser_${Number(userId)}`;
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).filter(key => key !== '_openid').sort().map(key => [key, canonical(value[key])])) : value;
const signature = value => JSON.stringify(canonical(value));
const positiveId = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const dataOnly = row => Object.fromEntries(Object.entries(row).filter(([key]) => !['_id', '_openid'].includes(key)));

async function memberAssignmentDocument(database, collection, id) {
  try {
    const result = await database.collection(collection).doc(id).get();
    if (!result || result.errCode || result.code) throw result || new Error('assignment document read failed');
    return result.data ? { ...result.data, _id: id } : null;
  } catch (error) {
    if (/DOCUMENT_NOT_EXIST|document(?:\s+does)?\s+not\s+(?:exist|found)|document[^\n]*does not exist/i.test(
      String(error && (error.errCode || error.code || '')) + ' ' + String(error && (error.errMsg || error.message || '')))) return null;
    throw error;
  }
}

function createMemberAssignmentService({ db, listMembers, error, now = Date.now, read = memberAssignmentDocument,
  write = (ref, method, data) => ref[method]({ data }), membersCollection = 'hl_members', countersCollection = 'hl_counters',
  readinessCollection = 'hl_matchmaking_readiness' } = {}) {
  const fail = (message = 'member assignment changed; retry', code = 40901, status = 409) => error
    ? error(message, status, code) : Object.assign(new Error(message), { status, code });
  if (!db || typeof listMembers !== 'function') throw fail('assignment storage unavailable', 50301, 503);
  async function persist(ref, method, data) {
    const result = await write(ref, method, data);
    if (result && (result.code || result.errCode)) throw fail('member assignment write failed', 50301, 503);
  }

  function consistent(userId, members, anchor) {
    if (!Array.isArray(members) || members.length > 70 || members.some(row => !row || typeof row._id !== 'string' || !row._id
      || Number(row.userId) !== userId || !positiveId(row.id) || !positiveId(row.matchmakerId))
      || new Set(members.map(row => row._id)).size !== members.length
      || new Set(members.map(row => Number(row.id))).size !== members.length) throw fail('member assignment records conflict');
    const active = members.filter(row => Number(row.status) === 1);
    if (active.length > 1) throw fail('duplicate active member assignments');
    if (anchor) {
      const pointed = members.find(row => row._id === anchor.memberDocumentId);
      if (Number(anchor.userId) !== userId || !Number.isSafeInteger(anchor.revision) || anchor.revision <= 0
        || !Number.isSafeInteger(anchor.revision + 1) || !positiveId(anchor.memberRecordId) || !positiveId(anchor.matchmakerId)
        || !pointed || Number(pointed.id) !== Number(anchor.memberRecordId) || Number(pointed.matchmakerId) !== Number(anchor.matchmakerId)
        || active[0] && active[0]._id !== pointed._id) throw fail('member assignment anchor conflict');
    }
    return active[0] || null;
  }

  async function prepare(userId, dependencies = []) {
    if (!positiveId(userId)) throw fail('invalid member assignment owner');
    userId = Number(userId);
    // Read the shared anchor before discovery. Every relationship writer advances
    // it, so an insert absent from this query is still detected at commit time.
    const anchor = await read(db, countersCollection, memberAssignmentAnchorId(userId));
    const members = await listMembers(userId);
    consistent(userId, members, anchor);
    if (dependencies.some(item => !item || !item.collection || !item.row || !item.row._id)) throw fail('assignment dependency unavailable');
    return { userId, anchor, members, dependencies };
  }

  async function mutate(snapshot, options = {}) {
    if (typeof db.runTransaction !== 'function') throw fail('assignment transactions unavailable', 50301, 503);
    if (!snapshot || !positiveId(snapshot.userId) || !positiveId(options.matchmakerId)) throw fail('invalid member assignment');
    const userId = Number(snapshot.userId), matchmakerId = Number(options.matchmakerId);
    const documentId = `member_api_${randomUUID()}`;
    return db.runTransaction(async transaction => {
      const anchor = await read(transaction, countersCollection, memberAssignmentAnchorId(userId));
      if (signature(anchor) !== signature(snapshot.anchor)) throw fail();
      const members = await Promise.all(snapshot.members.map(row => read(transaction, membersCollection, row._id)));
      if (signature(members) !== signature(snapshot.members)) throw fail();
      const active = consistent(userId, members, anchor);
      const dependencies = snapshot.dependencies || [];
      const currentDependencies = await Promise.all(dependencies.map(item => read(transaction, item.collection, item.row._id)));
      if (dependencies.some((item, index) => signature(item.row) !== signature(currentDependencies[index]))) throw fail();
      for (const extra of options.extraDocuments || []) {
        const current = await read(transaction, extra.collection, extra.documentId);
        if (signature(current) !== signature(extra.expected || null)) throw fail();
      }
      const readinessId = `readiness_user_${userId}`;
      const readiness = await read(transaction, readinessCollection, readinessId);
      if (readiness && Number(readiness.userId) !== userId) throw fail('member service preparation owner conflict');
      if (active && Number(active.matchmakerId) !== matchmakerId) throw fail('member already has another matchmaker');
      let member = options.memberDocumentId ? members.find(row => row._id === options.memberDocumentId)
        : active || members.find(row => Number(row.matchmakerId) === matchmakerId);
      if (options.memberDocumentId && !member || member && (Number(member.matchmakerId) !== matchmakerId
        || active && member._id !== active._id)) throw fail('member assignment target changed');
      if (typeof options.verify === 'function') options.verify({ members, anchor, member, dependencies: currentDependencies });
      const timestamp = new Date(now()).toISOString();
      const wasActive = !!member && Number(member.status) === 1;
      let saved;
      if (!member) {
        if (typeof options.create !== 'function') throw fail('member assignment target missing');
        const counter = await read(transaction, countersCollection, MEMBER_ASSIGNMENT_COUNTER);
        if (counter && (!Number.isSafeInteger(counter.value) || counter.value < 0)) throw fail('member sequence unavailable', 50301, 503);
        const id = Math.max(counter ? counter.value + 1 : 1, Date.parse(timestamp) * 1000);
        if (!positiveId(id)) throw fail('member sequence unavailable', 50301, 503);
        saved = { ...options.create(id), _id: documentId, id, userId, matchmakerId, createdAt: timestamp, updatedAt: timestamp };
        member = saved;
        await persist(transaction.collection(countersCollection).doc(MEMBER_ASSIGNMENT_COUNTER), 'set',
          { key: MEMBER_ASSIGNMENT_COUNTER, value: id, updatedAt: timestamp });
      } else {
        const patch = typeof options.patch === 'function' ? options.patch(member) : options.patch || {};
        if (Object.hasOwn(patch, 'userId') || Object.hasOwn(patch, 'matchmakerId') || Object.hasOwn(patch, 'id') || Object.hasOwn(patch, '_id')) throw fail('assignment identity cannot be overwritten');
        saved = { ...member, ...patch, updatedAt: timestamp };
      }
      if (![0, 1].includes(Number(saved.status))) throw fail('invalid assignment status');
      // Keep inactive pointers complete as a tombstone: delete/recreate must
      // invalidate snapshots just as activation or reassignment does.
      const nextAnchor = { _id: memberAssignmentAnchorId(userId), userId, memberDocumentId: saved._id,
        memberRecordId: Number(saved.id), matchmakerId, revision: (anchor?.revision || 0) + 1, updatedAt: timestamp };
      if (typeof options.beforeSave === 'function') await options.beforeSave(transaction, saved);
      await persist(transaction.collection(membersCollection).doc(saved._id), wasActive || snapshot.members.some(row => row._id === saved._id) ? 'update' : 'set', dataOnly(saved));
      if (!wasActive || Number(saved.status) !== 1) {
        await persist(transaction.collection(readinessCollection).doc(readinessId), 'set', { ...dataOnly(readiness || {}), userId,
          memberRecordId: Number(saved.id), matchmakerId, confirmed: false,
          invalidatedReason: 'member_assignment_changed', invalidatedAt: timestamp, updatedAt: timestamp });
      }
      for (const update of options.updates || []) {
        if (!dependencies.some(item => item.collection === update.collection && item.row._id === update.documentId)) throw fail('assignment update dependency missing');
        await persist(transaction.collection(update.collection).doc(update.documentId), 'update', { ...update.patch, updatedAt: timestamp });
      }
      await persist(transaction.collection(countersCollection).doc(nextAnchor._id), 'set', dataOnly(nextAnchor));
      const nextMembers = members.some(row => row._id === saved._id) ? members.map(row => row._id === saved._id ? saved : row) : [...members, saved];
      const nextDependencies = dependencies.map(item => {
        const update = (options.updates || []).find(change => change.collection === item.collection && change.documentId === item.row._id);
        return update ? { ...item, row: { ...item.row, ...update.patch, updatedAt: timestamp } } : item;
      });
      return { member: saved, wasActive, snapshot: { userId, anchor: nextAnchor, members: nextMembers, dependencies: nextDependencies } };
    });
  }

  return { prepare, mutate };
}

module.exports = { createMemberAssignmentService, memberAssignmentAnchorId, memberAssignmentDocument, MEMBER_ASSIGNMENT_COUNTER };
