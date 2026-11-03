import { type MatchingPreferences } from '../services/matching-preferences'
import { EDUCATION_OPTIONS, OCCUPATION_OPTIONS } from './profile-options'

export const PREFERENCE_OCCUPATIONS = ['金融', '国企', '央企', '政府', '政企单位', 'AI行业', '医生', '军人',
  ...OCCUPATION_OPTIONS.filter(item => !['金融', '国企', '央企', '政府', '政企单位', 'AI行业', '医生', '军人'].includes(item))]

export const PREFERENCE_OPTIONS = {
  education: EDUCATION_OPTIONS,
  marriageTimeline: ['一年内', '两年内', '三年内', '顺其自然'],
  hasChildren: ['有', '无'], wantsChildren: ['想要', '不想要', '可以商量'],
  zodiac: ['鼠', '牛', '虎', '兔', '龙', '蛇', '马', '羊', '猴', '鸡', '狗', '猪'],
  constellation: ['白羊座', '金牛座', '双子座', '巨蟹座', '狮子座', '处女座', '天秤座', '天蝎座', '射手座', '摩羯座', '水瓶座', '双鱼座'],
  smoking: ['不吸烟', '偶尔吸烟', '吸烟'], drinking: ['不喝酒', '偶尔喝酒', '经常喝酒'],
  pets: ['养宠物', '不养宠物'], maritalStatus: ['未婚', '离异', '丧偶']
}
export type PreferenceSelectField = keyof typeof PREFERENCE_OPTIONS
export type PreferenceNumberField = 'ageMin' | 'ageMax' | 'heightMin' | 'weightMin' | 'weightMax'
export type PreferenceForm = Omit<MatchingPreferences, PreferenceNumberField> & Record<PreferenceNumberField, string>
export const HEIGHT_PREFERENCES = ['', '160', '165', '170', '175', '180', '185', '190']
export const AGE_STAGES = [
  { label: '不限', min: '', max: '' }, { label: '18–24岁', min: '18', max: '24' },
  { label: '25–29岁', min: '25', max: '29' }, { label: '30–34岁', min: '30', max: '34' },
  { label: '35–39岁', min: '35', max: '39' }, { label: '40岁以上', min: '40', max: '' }
]

export function emptyPreferenceForm(): PreferenceForm {
  return { ageMin: '', ageMax: '', heightMin: '', occupations: [], education: '', city: '',
    marriageTimeline: '', hasChildren: '', wantsChildren: '', weightMin: '', weightMax: '',
    zodiac: '', constellation: '', smoking: '', drinking: '', pets: '', maritalStatus: '' }
}

export function preferenceForm(value: MatchingPreferences): PreferenceForm {
  const form: PreferenceForm = { ...emptyPreferenceForm(), ...value,
    ageMin: '', ageMax: '', heightMin: '', weightMin: '', weightMax: '' }
  for (const field of ['ageMin', 'ageMax', 'heightMin', 'weightMin', 'weightMax'] as PreferenceNumberField[]) {
    form[field] = value[field] === null || value[field] === undefined ? '' : String(value[field])
  }
  form.occupations = Array.isArray(value.occupations) ? value.occupations.slice() : []
  return form
}

export function preferencePayload(form: PreferenceForm): MatchingPreferences {
  const numeric = (field: PreferenceNumberField, label: string, min: number, max: number) => {
    const raw = form[field].trim()
    if (!raw) return null
    const value = Number(raw)
    if (!/^\d+$/.test(raw) || !Number.isInteger(value) || value < min || value > max) {
      throw new Error(`${label}须为${min}至${max}之间的整数`)
    }
    return value
  }
  const payload: MatchingPreferences = { ...form,
    ageMin: numeric('ageMin', '最低年龄', 18, 100), ageMax: numeric('ageMax', '最高年龄', 18, 100),
    heightMin: numeric('heightMin', '最低身高', 100, 250),
    weightMin: numeric('weightMin', '最低体重', 20, 300), weightMax: numeric('weightMax', '最高体重', 20, 300),
    city: form.city.trim(), occupations: form.occupations.slice() }
  if (payload.ageMin !== null && payload.ageMax !== null && payload.ageMin > payload.ageMax) throw new Error('年龄下限不能高于上限')
  if (payload.weightMin !== null && payload.weightMax !== null && payload.weightMin > payload.weightMax) throw new Error('体重下限不能高于上限')
  if (payload.city.length > 60) throw new Error('现居住地不能超过60字')
  return payload
}

const LABELS: Record<PreferenceSelectField, string> = { education: '学历', marriageTimeline: '何时结婚', hasChildren: '有无孩子',
  wantsChildren: '是否想要孩子', zodiac: '生肖', constellation: '星座', smoking: '是否吸烟', drinking: '是否喝酒', pets: '是否养宠物', maritalStatus: '婚况' }

export function preferenceRows(form: PreferenceForm, fields: PreferenceSelectField[]) {
  return fields.map(key => ({ key, label: LABELS[key], options: ['不限', ...PREFERENCE_OPTIONS[key]],
    index: Math.max(0, PREFERENCE_OPTIONS[key].indexOf(form[key]) + 1), value: form[key] || '不限' }))
}
