function rangeStrings(start: number, end: number) {
  const values: string[] = []
  for (let value = start; value <= end; value += 1) values.push(String(value))
  return values
}

function cleanText(value: string | number | undefined | null) {
  return String(value || '').trim()
}

function hasUnit(value: string, unit: string) {
  return value.indexOf(unit) >= 0
}

export const AGE_OPTIONS = rangeStrings(18, 60)

export const HEIGHT_OPTIONS = rangeStrings(145, 210)

export const EDUCATION_OPTIONS = ['高中/中专', '大专', '本科', '硕士', '博士', '其他']

export const INCOME_OPTIONS = ['10万以下', '10-20万', '20-30万', '30-50万', '50-100万', '100万以上']

export const OCCUPATION_OPTIONS = [
  '互联网/科技',
  '金融',
  '教育/培训',
  '医疗/健康',
  '法律/咨询',
  '文化传媒',
  '设计/艺术',
  '公务员/事业单位',
  '企业管理',
  '创业/个体',
  '自由职业',
  '其他'
]

export function pickerText(value: string | number | undefined | null, placeholder: string) {
  return cleanText(value) || placeholder
}

export function agePickerText(value: string | number | undefined | null) {
  const text = cleanText(value)
  if (!text) return '请选择年龄'
  return hasUnit(text, '岁') ? text : `${text} 岁`
}

export function heightPickerText(value: string | number | undefined | null) {
  const text = cleanText(value)
  if (!text) return '请选择身高'
  return hasUnit(text, 'cm') ? text : `${text}cm`
}

export function regionPickerText(value: string | undefined | null, placeholder: string) {
  return cleanText(value) || placeholder
}

export function regionValueText(region: string[] | undefined) {
  if (!Array.isArray(region)) return ''
  const province = cleanText(region[0])
  const city = cleanText(region[1])
  return [province, city].filter(Boolean).join(' ')
}
