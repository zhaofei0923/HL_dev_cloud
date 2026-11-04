import { request } from './api'

export type AdminResource = 'matchmakers' | 'certifications' | 'salons' | 'plans' | 'orders' | 'services'
export type CertificationKind = 'identity' | 'education' | 'vehicle' | 'property' | 'assets'
export type AdminArgs = Record<string, unknown>
export type AdminAction = 'overview' | 'operations.prepare' | `${AdminResource}.list` | `${AdminResource}.detail`
  | 'matchmakers.review' | 'certifications.review' | 'certifications.evidence' | 'certifications.material'
  | 'salons.review' | 'salons.cancel' | 'plans.update' | 'services.assign' | 'services.extend'
export type ServicePrincipal = { id: number; nickname: string; matchmakerNo: string }
export type ServicePackage = { id: string; planTitle: string; orderNo: string; expireAt: string; originalExpireAt: string; totalCount: number; usedCount: number; remainingCount: number | null; status: string; canExtend: boolean }
export type AdminUser = { id?: number; nickname?: string; phone?: string; gender?: number; status?: number; createdAt?: string }
export type CertificationMaterial = { id: string; kind: CertificationKind; mimeType: string; size: number; createdAt?: string }
export type CertificationConclusion = { status?: string; source?: string; level?: string; financialAssetRange?: string; reviewedAt?: string; expiresAt?: string; feedback?: string }
export interface AdminRecord {
  id?: number; userId?: number; user?: AdminUser; organizer?: AdminUser; organizerId?: number
  version?: string; status?: string | number; createdAt?: string; updatedAt?: string; reviewedAt?: string
  title?: string; description?: string; city?: string; profile?: { city?: string; province?: string }
  matchmakerNo?: string; level?: number; parentId?: number; teamId?: number; hasStore?: boolean
  certificationStatus?: number; certificationRemark?: string; memberCount?: number; salonCount?: number; canReview?: boolean
  kind?: CertificationKind; applicationId?: string; applicationStatus?: string; effectiveStatus?: string; verified?: boolean
  source?: string; method?: string; educationLevel?: string; institutionName?: string; submittedAt?: string
  feedback?: string; expiresAt?: string; current?: CertificationConclusion; materialCount?: number | null
  canView?: boolean; canRevoke?: boolean; materialIds?: string[]; materials?: CertificationMaterial[]
  location?: string; eventDate?: string; maxParticipants?: number; currentParticipants?: number; price?: number
  reviewRemark?: string; canApprove?: boolean; canReject?: boolean; canCancel?: boolean; statusText?: string
  planCode?: string; code?: string; amountFen?: number; active?: boolean; productType?: string
  durationDays?: number; serviceCount?: number; badge?: string; configured?: boolean; canUpdate?: boolean
  readOnly?: boolean; retired?: boolean; priceLockedReason?: string
  outTradeNo?: string; planTitle?: string; currency?: string; fulfillmentStatus?: string; fulfillmentMessage?: string
  transactionId?: string; paidAt?: string; paymentProvider?: string; virtualPaymentEnv?: number; confirmationSource?: string
  reviewReason?: string; paymentReviewRequired?: boolean; refundId?: string; refundAmountFen?: number
  refundedAt?: string; refundSource?: string; isTest?: boolean; isSandbox?: boolean
  cancelledAt?: string; cancelReason?: string
  requestedAt?: string; contactProgress?: string; packageCount?: number; remainingCount?: number; canAssign?: boolean
  hasExistingAssignment?: boolean; assignment?: { memberRecordId: number; matchmakerId: number; nickname: string; matchmakerNo: string } | null
  principals?: ServicePrincipal[]; packages?: ServicePackage[]
}
export type AdminList = { list: AdminRecord[]; total: number; page: number; pageSize: number }
export type MutationResult = { action: string; target: AdminArgs; status: string | number; version: string; updatedAt: string; requestId: string }
export type AdminEvidence = { userId: number; kind: CertificationKind; applicationId: string; verificationCode?: string; certificateNumber?: string; declaredFinancialAssetRange?: string }
export type AdminMaterial = { id: string; mimeType: 'image/jpeg' | 'image/png' | 'application/pdf'; size: number; contentBase64: string }
export type CountValue = number | null
type Quality = { warnings?: string[]; productsComplete?: boolean }
export type Overview = {
  asOf?: string; period?: { days?: number }; quality?: Quality
  members: { total: CountValue; newCount: CountValue; vip?: CountValue; ordinary?: CountValue; verified?: CountValue; publicCount?: CountValue; quality?: Quality; trend?: { date: string; newCount: CountValue; cumulative: CountValue }[] }
  matchmakers: { approved: CountValue; pending: CountValue; active30d?: CountValue; ranking?: { name: string; city?: string; memberCount: CountValue; newAssignments: CountValue }[] }
  revenue: { paidFen: CountValue; refundFen: CountValue; netFen: CountValue; quality?: Quality
    products?: { code: string; title: string; paidFen: CountValue }[]; trend?: { date: string; paidFen: CountValue; refundFen: CountValue; netFen: CountValue }[] }
}
export type LabelValue = { label: string; value: string }
export type FilterOption = { label: string; value: string }
export type ListCard = { rowKey: string; key: AdminArgs; title: string; subtitle: string; status: string; lines: LabelValue[]; canOpen: boolean }
export const RESOURCE_TITLES: Record<AdminResource, string> = { matchmakers: '主理人审核', certifications: '会员认证', salons: '沙龙管理', plans: '套餐管理', orders: '支付订单', services: '已购服务接入' }
export const KIND_LABELS: Record<CertificationKind, string> = { identity: '身份认证', education: '学历认证', vehicle: '车辆认证', property: '房产认证', assets: '资产认证' }
export const SOURCE_LABELS: Record<string, string> = { identity_document: '身份证明', chsi: '学信网', cscse: '留服认证', vehicle_license: '车辆行驶证', property_certificate: '房产证明', bank_statement: '银行证明', securities_statement: '证券证明', insurance_statement: '保险现金价值', combined_financial_statement: '综合证明' }
export const ASSET_LABELS: Record<string, string> = { under_500k: '50万元以下', '500k_2m': '50万至200万元', '2m_5m': '200万至500万元', '5m_10m': '500万至1000万元', over_10m: '1000万元以上' }
const STATUS: Record<string, string> = { pending: '待审核', approved: '已通过', rejected: '已拒绝', revoked: '已撤销', expired: '已过期', unsubmitted: '未提交', upcoming: '待举办', cancelled: '已取消', ended: '已结束', confirming: '确认中', paid: '已支付', closed: '已关闭', failed: '失败', refunded: '已退款', fulfilled: '已履约', requires_review: '待核查' }
export const isResource = (value: unknown): value is AdminResource => typeof value === 'string' && Object.prototype.hasOwnProperty.call(RESOURCE_TITLES, value)
export const isKind = (value: unknown): value is CertificationKind => typeof value === 'string' && Object.prototype.hasOwnProperty.call(KIND_LABELS, value)
export const shown = (value: unknown): string => value === null || value === undefined || value === '' ? '—' : String(value)
export const money = (value: unknown): string => typeof value === 'number' && Number.isSafeInteger(value) ? (value / 100).toFixed(2) + ' 元' : '—'
export const stateText = (value: unknown): string => typeof value === 'string' ? ({ pending_assignment: '待分配主理人', pending_contact: '待主理人联系', in_progress: '服务准备已确认', needs_review: '待核查', exhausted: '次数已用完', active: '有效' } as Record<string, string>)[value] || STATUS[value] || shown(value) : shown(value)
function hasUserCancellation(row: AdminRecord) {
  return row.cancelReason === 'user_requested' && typeof row.cancelledAt === 'string'
    && !!row.cancelledAt && Number.isFinite(Date.parse(row.cancelledAt))
}
function orderStatus(row: AdminRecord) {
  const label = row.status === 'pending' ? '待支付' : stateText(row.status)
  if (row.paymentReviewRequired === true || row.fulfillmentStatus === 'requires_review' || row.reviewReason === 'payment_after_cancellation') return label + ' · 待核查'
  if (row.status === 'closed' && hasUserCancellation(row) && !row.paidAt && !row.transactionId && row.fulfillmentStatus !== 'fulfilled') return '用户已取消'
  return label
}
export const countText = (value: unknown): string => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : '—'
export const apiCode = (failure: unknown): number => failure && typeof failure === 'object' && 'code' in failure ? Number(failure.code) : 0
export function errorMessage(failure: unknown): string {
  const code = apiCode(failure)
  if ([401, 40100, 40102].includes(code)) return '登录已失效，请重新登录。'
  if ([403, 40360, 40350].includes(code)) return '当前账号没有管理权限。'
  if (code >= 40000 && code < 50000 && failure instanceof Error) return failure.message.slice(0, 160)
  return '暂时无法完成，请稍后重试。'
}
export function operate<T>(action: AdminAction, args: AdminArgs = {}, requestId?: string): Promise<T> {
  return request<T>('/user/admin/operations', { method: 'POST', showError: false,
    data: { action, args, ...(requestId ? { requestId } : {}) } })
}
export function recordKey(resource: AdminResource, row: AdminRecord): AdminArgs | null {
  if (resource === 'services') return Number.isSafeInteger(row.userId) && Number(row.userId) > 0 ? { userId: row.userId } : null
  if (resource === 'certifications') return Number.isSafeInteger(row.userId) && Number(row.userId) > 0 && isKind(row.kind)
    && typeof row.applicationId === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(row.applicationId)
    ? { userId: row.userId, kind: row.kind, applicationId: row.applicationId } : null
  if (resource === 'plans') { const code = row.planCode || row.code; return code && /^[a-z0-9][a-z0-9_-]{1,31}$/.test(code) ? { planCode: code } : null }
  if (resource === 'orders') return row.outTradeNo && /^[a-zA-Z0-9_-]{1,80}$/.test(row.outTradeNo) ? { outTradeNo: row.outTradeNo } : null
  return Number.isSafeInteger(row.id) && Number(row.id) > 0 ? { id: row.id } : null
}
export function detailRoute(resource: AdminResource, key: AdminArgs): string {
  return '/admin-console/detail/index?resource=' + resource + Object.entries(key).map(([name, value]) => '&' + name + '=' + encodeURIComponent(String(value))).join('')
}
export function filterOptions(resource: AdminResource): FilterOption[] {
  if (resource === 'services') return [{ label: '全部状态', value: '' }, ...['pending_assignment', 'pending_contact', 'in_progress', 'expired', 'exhausted', 'refunded', 'needs_review'].map(value => ({ value, label: stateText(value) }))]
  const values = resource === 'matchmakers' ? ['0', '1', '2'] : resource === 'certifications'
    ? ['pending', 'approved', 'rejected', 'revoked', 'expired', 'unsubmitted'] : resource === 'salons'
      ? ['pending', 'upcoming', 'rejected', 'cancelled', 'ended'] : resource === 'plans' ? ['true', 'false']
        : ['pending', 'confirming', 'paid', 'closed', 'failed', 'refunded']
  const matchmakerLabels: Record<string, string> = { '0': '待审核', '1': '已拒绝', '2': '已认证' }
  return [{ label: '全部状态', value: '' }, ...values.map(value => ({ value, label: resource === 'matchmakers'
    ? matchmakerLabels[value] || value : resource === 'plans' ? value === 'true' ? '启用' : '停用'
      : resource === 'orders' && value === 'pending' ? '待支付' : stateText(value) }))]
}
export function listCard(resource: AdminResource, row: AdminRecord): ListCard {
  const key = recordKey(resource, row)
  const rowKey = resource + ':' + (key ? JSON.stringify(key) : String(row.userId || row.id || '') + ':' + (row.kind || ''))
  const fields = (pairs: [string, unknown][]): LabelValue[] => pairs.map(([label, value]) => ({ label, value: shown(value) }))
  if (resource === 'services') return { rowKey, key: key || {}, title: row.user?.nickname || '会员 ' + shown(row.userId), subtitle: '会员 ' + shown(row.userId), status: stateText(row.status), canOpen: !!key,
    lines: fields([['接入时间', row.requestedAt], ['服务进展', row.contactProgress], ['负责主理人', row.assignment?.nickname], ['剩余次数', countText(row.remainingCount)]]) }
  const matchmakerStatus: Record<number, string> = { 0: '待审核', 1: '已拒绝', 2: '已认证' }
  if (resource === 'matchmakers') return { rowKey, key: key || {}, title: row.user?.nickname || '未命名主理人', subtitle: row.matchmakerNo || '编号 ' + shown(row.id), status: matchmakerStatus[row.certificationStatus ?? -1] || '—', canOpen: !!key,
    lines: fields([['所在地', row.city], ['会员 / 沙龙', countText(row.memberCount) + ' / ' + countText(row.salonCount)], ['申请时间', row.createdAt]]) }
  if (resource === 'certifications') return { rowKey, key: key || {}, title: row.user?.nickname || '会员 ' + shown(row.userId), subtitle: row.kind ? KIND_LABELS[row.kind] : '认证申请', status: stateText(row.status) + (row.verified ? ' · 当前有效' : ''), canOpen: !!key && row.canView === true,
    lines: fields([['提交时间', row.submittedAt], ['材料数量', countText(row.materialCount)], ['申请编号', row.applicationId]]) }
  if (resource === 'salons') return { rowKey, key: key || {}, title: row.title || '未命名沙龙', subtitle: row.organizer?.nickname || '组织人 ' + shown(row.organizerId), status: stateText(row.status), canOpen: !!key,
    lines: fields([['活动时间', row.eventDate], ['地点', row.location], ['报名人数', countText(row.currentParticipants) + ' / ' + countText(row.maxParticipants)]]) }
  if (resource === 'plans') return { rowKey, key: key || {}, title: row.title || '套餐', subtitle: row.planCode || row.code || '—', status: row.active ? '启用' : '停用', canOpen: !!key,
    lines: fields([['价格', money(row.amountFen)], ['期限', row.durationDays === undefined ? '—' : row.durationDays + ' 天'], ['服务次数', countText(row.serviceCount)]]) }
  return { rowKey, key: key || {}, title: row.planTitle || row.planCode || '支付订单', subtitle: row.outTradeNo || '—', status: orderStatus(row), canOpen: !!key,
    lines: fields([['金额', money(row.amountFen)], ['履约', stateText(row.fulfillmentStatus)], ['创建时间', row.createdAt], ['环境', row.isTest ? '测试订单' : row.isSandbox ? '沙箱订单' : '正式订单']]) }
}
export function detailFields(resource: AdminResource, row: AdminRecord): LabelValue[] {
  if (resource === 'services') return ([['会员', row.user?.nickname], ['会员编号', row.userId], ['接入状态', stateText(row.status)], ['接入时间', row.requestedAt], ['服务进展', row.contactProgress], ['负责主理人', row.assignment ? row.assignment.nickname + ' · ' + shown(row.assignment.matchmakerNo || row.assignment.matchmakerId) : '待平台分配'], ['已购套餐数', countText(row.packageCount)], ['剩余总次数', countText(row.remainingCount)], ['更新时间', row.updatedAt]] as [string, unknown][]).map(([label, value]) => ({ label, value: shown(value) }))
  const matchmakerStatus: Record<number, string> = { 0: '待审核', 1: '已拒绝', 2: '已认证' }
  const methods: Record<string, string> = { chsi_code: '学信网验证码', diploma_photo: '毕业证明照片', study_proof: '在读证明', cscse_number: '留服认证编号', cscse_photo: '留服认证照片' }
  const degrees: Record<string, string> = { bachelors: '本科', master: '硕士', doctor: '博士' }
  let pairs: [string, unknown][]
  if (resource === 'matchmakers') pairs = [['主理人', row.user?.nickname], ['编号', row.matchmakerNo || row.id], ['手机号', row.user?.phone], ['所在城市', row.city], ['等级', row.level], ['会员数', countText(row.memberCount)], ['沙龙数', countText(row.salonCount)], ['上级编号', row.parentId], ['团队编号', row.teamId], ['门店', row.hasStore ? '有' : '无'], ['审核状态', matchmakerStatus[row.certificationStatus ?? -1]], ['审核备注', row.certificationRemark], ['申请时间', row.createdAt]]
  else if (resource === 'certifications') pairs = [['会员', row.user?.nickname], ['会员编号', row.userId], ['手机号', row.user?.phone], ['认证类型', row.kind ? KIND_LABELS[row.kind] : ''], ['申请编号', row.applicationId], ['申请状态', stateText(row.status)], ['当前效力', stateText(row.effectiveStatus)], ['核验来源', SOURCE_LABELS[row.source || '']], ['认证方式', methods[row.method || '']], ['学校', row.institutionName], ['申报学历', degrees[row.educationLevel || ''] || row.educationLevel], ['提交时间', row.submittedAt], ['审核时间', row.reviewedAt], ['本人可见反馈', row.feedback], ['当前学历结论', row.current?.level], ['当前资产档位', ASSET_LABELS[row.current?.financialAssetRange || '']], ['认证有效期', row.current?.expiresAt]]
  else if (resource === 'salons') pairs = [['活动', row.title], ['组织人', row.organizer?.nickname], ['状态', stateText(row.status)], ['活动时间', row.eventDate], ['地点', row.location], ['人数', countText(row.currentParticipants) + ' / ' + countText(row.maxParticipants)], ['费用', row.price === undefined ? '—' : row.price + ' 元'], ['介绍', row.description], ['审核备注', row.reviewRemark], ['审核时间', row.reviewedAt]]
  else if (resource === 'plans') pairs = [['套餐', row.title], ['编码', row.planCode || row.code], ['状态', row.active ? '启用' : '停用'], ['固定价格', money(row.amountFen)], ['类型', row.productType === 'vip' ? '会员服务' : '婚恋服务'], ['期限', row.durationDays === undefined ? '—' : row.durationDays + ' 天'], ['服务次数', countText(row.serviceCount)], ['说明', row.description], ['价格规则', row.priceLockedReason], ['历史套餐', row.retired ? '是，只读' : '否']]
  else {
    pairs = [['订单号', row.outTradeNo], ['会员', row.user?.nickname || row.userId], ['套餐', row.planTitle || row.planCode], ['金额', money(row.amountFen)], ['支付状态', orderStatus(row)], ['履约状态', stateText(row.fulfillmentStatus)], ['履约说明', row.fulfillmentMessage], ['支付渠道', row.paymentProvider], ['支付单号', row.transactionId], ['支付时间', row.paidAt], ['确认来源', row.confirmationSource], ['人工核查', row.paymentReviewRequired ? '需要' : '无需'], ['核查原因', row.reviewReason], ['退款单号', row.refundId], ['退款金额', money(row.refundAmountFen)], ['退款时间', row.refundedAt], ['退款来源', row.refundSource], ['环境', row.isTest ? '测试订单' : row.isSandbox ? '沙箱订单' : '正式订单']]
    if (hasUserCancellation(row)) pairs.splice(5, 0, ['取消时间', row.cancelledAt], ['取消原因', '用户主动取消'])
  }
  return [...pairs, ['创建时间', row.createdAt] as [string, unknown], ['更新时间', row.updatedAt] as [string, unknown]].map(([label, value]) => ({ label, value: shown(value) }))
}
