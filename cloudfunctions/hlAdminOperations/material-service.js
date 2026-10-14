'use strict';

const { randomUUID } = require('node:crypto');
const { versionFor, allowed, positiveId, identifier, KINDS, error } = require('./contracts');
const { openMaterial, openVerification, validateMaterialInput } = require('../hlApi/certification-material-policy');
const AUDIT = 'hl_admin_audit_logs';

function createMaterialService({ db, downloadFile, secrets, now = () => new Date().toISOString() }) {
  async function bound(args, materialRequired) {
    allowed(args, ['userId', 'kind', 'applicationId', 'expectedVersion', ...(materialRequired ? ['materialId'] : [])]);
    const userId = positiveId(args.userId), applicationId = identifier(args.applicationId);
    if (!KINDS.includes(args.kind) || typeof args.expectedVersion !== 'string' || !/^v1_[a-f0-9]{64}$/.test(args.expectedVersion)) throw error('认证类型或版本无效');
    if (materialRequired) identifier(args.materialId);
    const result = await db.collection('hl_member_certifications').doc(`user_${userId}`)
      .field({ userId: true, updatedAt: true, [`applications.${args.kind}`]: true, [`current.${args.kind}`]: true, materials: true }).get();
    if (result?.code) throw error('认证申请读取失败', 50360);
    const record = Array.isArray(result?.data) ? (result.data.length === 1 ? result.data[0] : null) : result?.data;
    if (!record || Number(record.userId) !== userId) throw error('认证申请不存在', 40460);
    if (versionFor('certifications', record, args.kind) !== args.expectedVersion) throw error('认证申请已变化，请重新选择记录', 40960);
    const application = record.applications?.[args.kind];
    if (!application || application.requestId !== applicationId) throw error('认证申请已变化，请重新选择记录', 40960);
    const ownerIds = [userId, String(userId)];
    const snapshots = await Promise.all(ownerIds.map(id => db.collection('hl_users').where({ id })
      .field({ _id: true, id: true, status: true, mergedIntoUserId: true }).limit(2).get()));
    const owners = new Map();
    snapshots.forEach((snapshot, index) => {
      if (snapshot?.code || snapshot?.errCode || !Array.isArray(snapshot?.data) || snapshot.data.length > 2) throw error('会员账号读取失败', 50360);
      for (const owner of snapshot.data) {
        if (!owner || typeof owner._id !== 'string' || !owner._id || owner.id !== ownerIds[index]) throw error('会员账号记录无效', 40960);
        owners.set(owner._id, owner);
      }
    });
    const owner = [...owners.values()][0];
    if (owners.size !== 1 || Number(owner.status) !== 1 || owner.mergedIntoUserId) throw error('会员账号已失效或存在重复记录', 40960);
    let material;
    if (materialRequired) {
      material = record.materials?.[args.materialId];
      if (!Array.isArray(application.materialIds) || !application.materialIds.includes(args.materialId)
        || !material || material.id !== args.materialId || material.kind !== args.kind
        || material.status !== 'bound' || material.applicationId !== applicationId
        || typeof material.fileID !== 'string' || !material.fileID.startsWith('cloud://')) throw error('申请关联材料已变化', 40960);
    }
    return { userId, application, material };
  }
  async function audit(action, args, actor) {
    const id = 'read_' + randomUUID().replaceAll('-', '');
    // Audit persistence is a precondition for returning sensitive plaintext.
    const saved = await db.collection(AUDIT).doc(id).set({ action,
      target: { userId: Number(args.userId), kind: args.kind, applicationId: args.applicationId,
        ...(args.materialId ? { materialId: args.materialId } : {}) },
      actor: { uid: actor.uid }, serverRequestId: actor.serverRequestId, createdAt: now(), status: 'read_authorized' });
    if (!saved || saved.code) throw error('材料访问记录保存失败', 50360);
  }
  return {
    async evidence(args, actor) {
      const current = await bound(args, false);
      const verification = current.application.sealedVerification
        ? openVerification(current.application.sealedVerification, { userId: current.userId, kind: args.kind, id: args.applicationId }, secrets) : {};
      await bound(args, false);
      await audit('certifications.evidence', args, actor);
      return { userId: current.userId, kind: args.kind, applicationId: args.applicationId,
        ...Object.fromEntries(['verificationCode', 'certificateNumber', 'declaredFinancialAssetRange']
          .filter(key => typeof verification[key] === 'string').map(key => [key, verification[key]])) };
    },
    async material(args, actor) {
      const current = await bound(args, true);
      const downloaded = await downloadFile({ fileID: current.material.fileID });
      const plaintext = openMaterial(downloaded.fileContent, { userId: current.userId, kind: args.kind, id: args.materialId }, secrets);
      const contentBase64 = plaintext.toString('base64');
      const checked = validateMaterialInput({ mimeType: current.material.mimeType, base64: contentBase64 });
      if (checked.size !== current.material.size) throw error('认证材料大小与记录不一致', 40960);
      await bound(args, true);
      await audit('certifications.material', args, actor);
      return { id: args.materialId, mimeType: checked.mimeType, size: checked.size, contentBase64 };
    }
  };
}
module.exports = { createMaterialService, AUDIT };
