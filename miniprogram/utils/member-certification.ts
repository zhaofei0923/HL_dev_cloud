const FINANCIAL_ASSET_LABELS: Record<string, string> = {
  under_500k: '50万元以下',
  '500k_2m': '50万—200万元',
  '2m_5m': '200万—500万元',
  '5m_10m': '500万—1000万元',
  over_10m: '1000万元以上'
}

export type PublicCertificationRow = { label: string; value: string }

export function financialAssetRangeText(value: unknown): string {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(FINANCIAL_ASSET_LABELS, value)
    ? FINANCIAL_ASSET_LABELS[value]
    : ''
}

export function publicCertificationRows(member: Record<string, unknown>): PublicCertificationRow[] {
  const rows: PublicCertificationRow[] = []
  if (member.identityVerified === true) rows.push({ label: '实名核验', value: '实名已认证' })
  if (member.educationVerified === true) {
    const level = member.verifiedEducation
    if (level === '本科' || level === '硕士' || level === '博士') {
      rows.push({ label: '学历核验', value: `${level} · 学历已认证` })
    }
  }
  if (member.vehicleVerified === true) rows.push({ label: '车辆核验', value: '车辆已认证' })
  if (member.propertyVerified === true) rows.push({ label: '房产核验', value: '房产已认证' })
  if (member.assetVerified === true) {
    rows.push({ label: '资产核验', value: '资产已认证' })
    const range = financialAssetRangeText(member.financialAssetRange)
    if (range) rows.push({ label: '已核验金融资产', value: range })
  }
  return rows
}
