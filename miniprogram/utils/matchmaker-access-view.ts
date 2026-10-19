type MatchmakerAccess = {
  certificationStatus?: number | string
  certificationRemark?: string
  activationSource?: string
  status?: number | string
}

// Operational access and document/identity verification are separate records.
// Existing manually approved principals retain their previous workbench access.
export function matchmakerAccessView(matchmaker: MatchmakerAccess | null | undefined, activeNote: string) {
  const status = Number(matchmaker?.certificationStatus || 0)
  const remark = matchmaker?.certificationRemark || ''
  if (matchmaker && matchmaker.status !== undefined && Number(matchmaker.status) !== 1) {
    return { canOperate: false, statusText: '已停用', statusTagClass: 'rose', statusNote: '主理人账号已停用，请联系平台确认。' }
  }
  if (status === 2) {
    return { canOperate: true, statusText: matchmaker?.activationSource === 'paid' ? '已开通' : '已认证',
      statusTagClass: 'gold', statusNote: activeNote }
  }
  if (status === 1) {
    return { canOperate: false, statusText: '已拒绝', statusTagClass: 'rose',
      statusNote: remark || '本次申请暂未通过，请联系平台确认开通资格。' }
  }
  return { canOperate: false, statusText: '待开通', statusTagClass: '',
    statusNote: '主理人一次性开通费 ¥6980，长期有效。付款确认后自动开通，无需管理员审批。' }
}
