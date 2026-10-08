import type { CertificationEntry, CertificationOverview, MemberCertificationKind } from '../services/member'

export type CertificationDefinition = {
  kind: MemberCertificationKind
  title: string
  note: string
  materials: string
}

export const CERTIFICATION_DEFINITIONS: CertificationDefinition[] = [
  { kind: 'identity', title: '实名认证', note: '核验本人身份信息', materials: '请上传本人有效身份证件的核验材料，由后台核验本人身份信息。请遮挡与核验无关的证件号码。' },
  { kind: 'education', title: '学历认证', note: '支持国内、海外及港澳台学历', materials: '国内学历依据学信网可查验的验证或认证报告审核；海外及港澳台学历，以及中外合作办学取得的境外学历学位，依据教育部留学服务中心的认证结果审核。' },
  { kind: 'vehicle', title: '车辆认证', note: '核验本人名下车辆', materials: '请上传本人名下车辆的有效权属证明，由后台核验。' },
  { kind: 'property', title: '房产认证', note: '核验本人名下房产', materials: '请上传本人名下房产的有效权属证明，由后台核验。' },
  { kind: 'assets', title: '资产认证', note: '核验通过后有效期6个月', materials: '请上传银行等机构出具的有效金融资产证明。核验通过后有效期6个月，到期需重新核验。核验采用金融资产口径，房产数量、车辆数量和年收入不直接换算为总资产。' }
]

export const EDUCATION_SOURCE_OPTIONS = ['国内学历 · 学信网', '海外及港澳台学历 · 留服中心']
export const EDUCATION_SOURCES = ['chsi', 'cscse'] as const
export const CERTIFICATION_EDUCATION_OPTIONS = ['本科', '硕士', '博士'] as const
export const CERTIFICATION_EDUCATION_VALUES = ['bachelors', 'master', 'doctor'] as const

export type EducationCertificationMethod = 'chsi_code' | 'diploma_photo' | 'study_proof' | 'cscse_number'
export const EDUCATION_CERTIFICATION_METHODS: Array<{ value: EducationCertificationMethod; title: string; note: string }> = [
  { value: 'chsi_code', title: '学信网在线验证码', note: '提交可查验报告的在线验证码' },
  { value: 'diploma_photo', title: '毕业证书或学位证书照片', note: '上传图片或 PDF 文件' },
  { value: 'study_proof', title: '在读证明等辅助材料照片', note: '仅作辅助，学历以已取得结果核验' },
  { value: 'cscse_number', title: '教育部留服认证书编号', note: '海外及港澳台学历认证' }
]

export const CERTIFICATION_MATERIAL_LIMIT = 3
export const CERTIFICATION_MATERIAL_MAX_BYTES = 500 * 1024
export const DECLARED_FINANCIAL_ASSET_RANGES = ['under_500k', '500k_2m', '2m_5m', '5m_10m', 'over_10m'] as const
export const DECLARED_FINANCIAL_ASSET_RANGE_OPTIONS = ['50万元以下', '50万—200万元', '200万—500万元', '500万—1000万元', '1000万元以上']

export function safeEducationMethod(value: unknown): EducationCertificationMethod | '' {
  return EDUCATION_CERTIFICATION_METHODS.some(item => item.value === value) ? value as EducationCertificationMethod : ''
}

export function methodRequiresMaterials(kind: MemberCertificationKind, method: EducationCertificationMethod | ''): boolean {
  return kind !== 'education' || method === 'diploma_photo' || method === 'study_proof'
}

export function certificationMaterialMime(contentBase64: string): 'image/jpeg' | 'image/png' | 'application/pdf' | '' {
  if (contentBase64.startsWith('/9j/')) return 'image/jpeg'
  if (contentBase64.startsWith('iVBORw0KGgo')) return 'image/png'
  if (contentBase64.startsWith('JVBERi0')) return 'application/pdf'
  return ''
}

export type CertificationMenuRow = {
  kind: MemberCertificationKind
  title: string
  note: string
  state: string
  verified: boolean
}

export function certificationDefinition(value: unknown): CertificationDefinition | undefined {
  return CERTIFICATION_DEFINITIONS.find(item => item.kind === value)
}

export function hasPendingCertification(entry: CertificationEntry): boolean {
  return entry.status === 'pending' || !!entry.application && entry.application.status === 'pending'
}

export function isApprovedCertification(entry: CertificationEntry): boolean {
  return entry.verified === true
}

export function certificationStateText(entry: CertificationEntry): string {
  const states = { unsubmitted: '未认证', pending: '待审核', approved: '已认证', rejected: '未通过', revoked: '已撤销', expired: '已到期 · 请重新核验' }
  const verified = isApprovedCertification(entry)
  if (hasPendingCertification(entry)) return verified ? '已认证 · 更新待审核' : '待审核'
  if (entry.status === 'approved' && !verified) return '结果待核实'
  if (verified && entry.status === 'rejected') return '已认证 · 更新未通过'
  return states[entry.status]
}

export function certificationMenuRows(entries?: CertificationEntry[]): CertificationMenuRow[] {
  return CERTIFICATION_DEFINITIONS.map(item => {
    const entry = entries && entries.find(candidate => candidate.kind === item.kind)
    return {
      kind: item.kind, title: item.title, note: item.note,
      state: entry ? certificationStateText(entry) : '读取中',
      verified: !!entry && isApprovedCertification(entry)
    }
  })
}

export function validCertificationOverview(value: unknown): value is CertificationOverview {
  if (!value || typeof value !== 'object' || !('entries' in value) || !Array.isArray(value.entries)) return false
  const entries: unknown[] = value.entries
  return CERTIFICATION_DEFINITIONS.every(item => entries.some(entry => {
    if (!entry || typeof entry !== 'object' || !('kind' in entry) || !('status' in entry) || !('verified' in entry)) return false
    return entry.kind === item.kind && typeof entry.verified === 'boolean'
      && ['unsubmitted', 'pending', 'approved', 'rejected', 'revoked', 'expired'].includes(String(entry.status))
  }))
}

export function certificationTimeText(value: unknown): string {
  if (typeof value !== 'string' || !value) return ''
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return ''
  const local = new Date(timestamp + 8 * 60 * 60 * 1000)
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())} ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`
}
