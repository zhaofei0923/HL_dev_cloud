import { matchingPreferencesApi } from '../../services/matching-preferences'
import { pageSessionScope } from '../../utils/page-session'
import { invalidateShowcaseCategory } from '../../utils/showcase-cache'
import { AGE_STAGES, HEIGHT_PREFERENCES, PREFERENCE_OCCUPATIONS, PREFERENCE_OPTIONS,
  emptyPreferenceForm, preferenceForm, preferencePayload, preferenceRows,
  type PreferenceForm, type PreferenceSelectField } from '../../utils/matching-preferences-form'

function formView(form: PreferenceForm) {
  return { form,
    educationRows: preferenceRows(form, ['education']),
    familyRows: preferenceRows(form, ['maritalStatus', 'marriageTimeline', 'hasChildren', 'wantsChildren']),
    habitRows: preferenceRows(form, ['zodiac', 'constellation', 'smoking', 'drinking', 'pets']),
    occupations: PREFERENCE_OCCUPATIONS.map(value => ({ value, selected: form.occupations.includes(value) })),
    ageStages: AGE_STAGES.map(item => ({ ...item, selected: item.min === form.ageMin && item.max === form.ageMax })),
    heightIndex: Math.max(0, HEIGHT_PREFERENCES.indexOf(form.heightMin)),
    heightText: form.heightMin ? `${form.heightMin}cm以上` : '不限' }
}

Page({
  _scope: '', _serial: 0, _visible: false,
  _pendingSaveScopes: {} as Record<string, boolean>,
  _refreshPreferenceScopes: {} as Record<string, boolean>,
  data: {
    ...formView(emptyPreferenceForm()),
    heightOptions: HEIGHT_PREFERENCES.map(value => value ? `${value}cm以上` : '不限'),
    loading: false, saving: false, ready: false, dirty: false, error: '', saveMessage: ''
  },
  onShow() {
    this._visible = true
    const scope = pageSessionScope()
    if (scope !== this._scope) {
      this._scope = scope; this._serial += 1
      this.setData({ ...formView(emptyPreferenceForm()), ready: false, dirty: false, error: '', saveMessage: '', saving: false, loading: false })
    }
    if (!scope) { wx.redirectTo({ url: '/pages/index/index' }); return Promise.resolve() }
    this.setData({ saving: !!this._pendingSaveScopes[scope] })
    if (this._pendingSaveScopes[scope]) return Promise.resolve()
    if (this._refreshPreferenceScopes[scope]) {
      delete this._refreshPreferenceScopes[scope]
      this.setData({ ready: false })
      return this.loadPreferences()
    }
    if (!this.data.ready) return this.loadPreferences()
    return Promise.resolve()
  },
  onHide() { this._visible = false; this._serial += 1; this.setData({ loading: false }) },
  onUnload() { this.onHide() },
  current(scope: string, serial: number) {
    return this._visible && this._scope === scope && pageSessionScope() === scope && this._serial === serial
  },
  async loadPreferences() {
    const scope = this._scope
    if (!scope || this.data.loading || this._pendingSaveScopes[scope] || !this._visible) return
    const serial = ++this._serial
    this.setData({ loading: true, error: '' })
    try {
      const result = await matchingPreferencesApi.get()
      if (!this.current(scope, serial)) return
      if (!result || !result.preferences) throw new Error('匹配偏好暂时无法读取')
      this.setData({ ...formView(preferenceForm(result.preferences)), ready: true, dirty: false })
    } catch (error) {
      if (this.current(scope, serial)) this.setData({ error: error instanceof Error ? error.message : '读取失败，请重试' })
    } finally { if (this.current(scope, serial)) this.setData({ loading: false }) }
  },
  changeForm(patch: Partial<PreferenceForm>) {
    if (!this._visible || !this._scope || pageSessionScope() !== this._scope || !this.data.ready || this.data.saving) return
    this.setData({ ...formView({ ...this.data.form, ...patch }), dirty: true, saveMessage: '', error: '' })
  },
  onInput(event: WechatMiniprogram.Input) {
    const field = String(event.currentTarget.dataset.field || '')
    if (!['ageMin', 'ageMax', 'weightMin', 'weightMax', 'city'].includes(field)) return
    this.changeForm({ [field]: event.detail.value })
  },
  onAgeStage(event: WechatMiniprogram.TouchEvent) {
    const stage = AGE_STAGES[Number(event.currentTarget.dataset.index)]
    if (stage) this.changeForm({ ageMin: stage.min, ageMax: stage.max })
  },
  onHeight(event: WechatMiniprogram.PickerChange) {
    const value = HEIGHT_PREFERENCES[Number(event.detail.value)]
    if (value !== undefined) this.changeForm({ heightMin: value })
  },
  onSelect(event: WechatMiniprogram.PickerChange) {
    const field = String(event.currentTarget.dataset.field || '')
    if (!Object.prototype.hasOwnProperty.call(PREFERENCE_OPTIONS, field)) return
    const key = field as PreferenceSelectField
    const options = ['', ...PREFERENCE_OPTIONS[key]]
    const value = options[Number(event.detail.value)]
    if (value !== undefined) this.changeForm({ [key]: value })
  },
  onOccupation(event: WechatMiniprogram.TouchEvent) {
    const value = String(event.currentTarget.dataset.value || '')
    if (!value) { this.changeForm({ occupations: [] }); return }
    if (!PREFERENCE_OCCUPATIONS.includes(value)) return
    const occupations = this.data.form.occupations.includes(value)
      ? this.data.form.occupations.filter(item => item !== value) : [...this.data.form.occupations, value]
    this.changeForm({ occupations })
  },
  resetPreferences() {
    if (this.data.saving || !this.data.ready) return
    this.changeForm(emptyPreferenceForm())
  },
  async savePreferences() {
    const scope = this._scope
    if (!this._visible || !scope || pageSessionScope() !== scope || !this.data.ready
      || this._pendingSaveScopes[scope] || this.data.saving || !this.data.dirty) return
    let payload
    try { payload = preferencePayload(this.data.form) }
    catch (error) { this.setData({ error: error instanceof Error ? error.message : '请检查填写内容' }); return }
    this._serial += 1
    this._pendingSaveScopes[scope] = true
    const canRender = () => this._visible && this._scope === scope && pageSessionScope() === scope
    this.setData({ saving: true, error: '', saveMessage: '' })
    try {
      const result = await matchingPreferencesApi.save(payload)
      if (!result || !result.preferences) throw new Error('保存结果暂未确认，请重试')
      // A save can finish after navigation. Refresh this account's recommendations
      // on return, without touching a replacement account or rendering a hidden page.
      if (pageSessionScope() === scope) invalidateShowcaseCategory(scope, 'recommend')
      if (!canRender()) { this._refreshPreferenceScopes[scope] = true; return }
      this.setData({ ...formView(preferenceForm(result.preferences)), ready: true, dirty: false, saveMessage: '匹配偏好已保存' })
    } catch (error) {
      if (canRender()) this.setData({ error: error instanceof Error ? error.message : '保存失败，请重试' })
    } finally {
      delete this._pendingSaveScopes[scope]
      if (canRender()) this.setData({ saving: false })
    }
  }
})
