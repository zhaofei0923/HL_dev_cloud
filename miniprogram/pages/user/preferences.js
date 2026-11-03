"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const matching_preferences_1 = require("../../services/matching-preferences");
const page_session_1 = require("../../utils/page-session");
const showcase_cache_1 = require("../../utils/showcase-cache");
const matching_preferences_form_1 = require("../../utils/matching-preferences-form");
function formView(form) {
    return { form,
        educationRows: (0, matching_preferences_form_1.preferenceRows)(form, ['education']),
        familyRows: (0, matching_preferences_form_1.preferenceRows)(form, ['maritalStatus', 'marriageTimeline', 'hasChildren', 'wantsChildren']),
        habitRows: (0, matching_preferences_form_1.preferenceRows)(form, ['zodiac', 'constellation', 'smoking', 'drinking', 'pets']),
        occupations: matching_preferences_form_1.PREFERENCE_OCCUPATIONS.map(value => ({ value, selected: form.occupations.includes(value) })),
        ageStages: matching_preferences_form_1.AGE_STAGES.map(item => ({ ...item, selected: item.min === form.ageMin && item.max === form.ageMax })),
        heightIndex: Math.max(0, matching_preferences_form_1.HEIGHT_PREFERENCES.indexOf(form.heightMin)),
        heightText: form.heightMin ? `${form.heightMin}cm以上` : '不限' };
}
Page({
    _scope: '', _serial: 0, _visible: false,
    _pendingSaveScopes: {},
    _refreshPreferenceScopes: {},
    data: {
        ...formView((0, matching_preferences_form_1.emptyPreferenceForm)()),
        heightOptions: matching_preferences_form_1.HEIGHT_PREFERENCES.map(value => value ? `${value}cm以上` : '不限'),
        loading: false, saving: false, ready: false, dirty: false, error: '', saveMessage: ''
    },
    onShow() {
        this._visible = true;
        const scope = (0, page_session_1.pageSessionScope)();
        if (scope !== this._scope) {
            this._scope = scope;
            this._serial += 1;
            this.setData({ ...formView((0, matching_preferences_form_1.emptyPreferenceForm)()), ready: false, dirty: false, error: '', saveMessage: '', saving: false, loading: false });
        }
        if (!scope) {
            wx.redirectTo({ url: '/pages/index/index' });
            return Promise.resolve();
        }
        this.setData({ saving: !!this._pendingSaveScopes[scope] });
        if (this._pendingSaveScopes[scope])
            return Promise.resolve();
        if (this._refreshPreferenceScopes[scope]) {
            delete this._refreshPreferenceScopes[scope];
            this.setData({ ready: false });
            return this.loadPreferences();
        }
        if (!this.data.ready)
            return this.loadPreferences();
        return Promise.resolve();
    },
    onHide() { this._visible = false; this._serial += 1; this.setData({ loading: false }); },
    onUnload() { this.onHide(); },
    current(scope, serial) {
        return this._visible && this._scope === scope && (0, page_session_1.pageSessionScope)() === scope && this._serial === serial;
    },
    async loadPreferences() {
        const scope = this._scope;
        if (!scope || this.data.loading || this._pendingSaveScopes[scope] || !this._visible)
            return;
        const serial = ++this._serial;
        this.setData({ loading: true, error: '' });
        try {
            const result = await matching_preferences_1.matchingPreferencesApi.get();
            if (!this.current(scope, serial))
                return;
            if (!result || !result.preferences)
                throw new Error('匹配偏好暂时无法读取');
            this.setData({ ...formView((0, matching_preferences_form_1.preferenceForm)(result.preferences)), ready: true, dirty: false });
        }
        catch (error) {
            if (this.current(scope, serial))
                this.setData({ error: error instanceof Error ? error.message : '读取失败，请重试' });
        }
        finally {
            if (this.current(scope, serial))
                this.setData({ loading: false });
        }
    },
    changeForm(patch) {
        if (!this._visible || !this._scope || (0, page_session_1.pageSessionScope)() !== this._scope || !this.data.ready || this.data.saving)
            return;
        this.setData({ ...formView({ ...this.data.form, ...patch }), dirty: true, saveMessage: '', error: '' });
    },
    onInput(event) {
        const field = String(event.currentTarget.dataset.field || '');
        if (!['ageMin', 'ageMax', 'weightMin', 'weightMax', 'city'].includes(field))
            return;
        this.changeForm({ [field]: event.detail.value });
    },
    onAgeStage(event) {
        const stage = matching_preferences_form_1.AGE_STAGES[Number(event.currentTarget.dataset.index)];
        if (stage)
            this.changeForm({ ageMin: stage.min, ageMax: stage.max });
    },
    onHeight(event) {
        const value = matching_preferences_form_1.HEIGHT_PREFERENCES[Number(event.detail.value)];
        if (value !== undefined)
            this.changeForm({ heightMin: value });
    },
    onSelect(event) {
        const field = String(event.currentTarget.dataset.field || '');
        if (!Object.prototype.hasOwnProperty.call(matching_preferences_form_1.PREFERENCE_OPTIONS, field))
            return;
        const key = field;
        const options = ['', ...matching_preferences_form_1.PREFERENCE_OPTIONS[key]];
        const value = options[Number(event.detail.value)];
        if (value !== undefined)
            this.changeForm({ [key]: value });
    },
    onOccupation(event) {
        const value = String(event.currentTarget.dataset.value || '');
        if (!value) {
            this.changeForm({ occupations: [] });
            return;
        }
        if (!matching_preferences_form_1.PREFERENCE_OCCUPATIONS.includes(value))
            return;
        const occupations = this.data.form.occupations.includes(value)
            ? this.data.form.occupations.filter(item => item !== value) : [...this.data.form.occupations, value];
        this.changeForm({ occupations });
    },
    resetPreferences() {
        if (this.data.saving || !this.data.ready)
            return;
        this.changeForm((0, matching_preferences_form_1.emptyPreferenceForm)());
    },
    async savePreferences() {
        const scope = this._scope;
        if (!this._visible || !scope || (0, page_session_1.pageSessionScope)() !== scope || !this.data.ready
            || this._pendingSaveScopes[scope] || this.data.saving || !this.data.dirty)
            return;
        let payload;
        try {
            payload = (0, matching_preferences_form_1.preferencePayload)(this.data.form);
        }
        catch (error) {
            this.setData({ error: error instanceof Error ? error.message : '请检查填写内容' });
            return;
        }
        this._serial += 1;
        this._pendingSaveScopes[scope] = true;
        const canRender = () => this._visible && this._scope === scope && (0, page_session_1.pageSessionScope)() === scope;
        this.setData({ saving: true, error: '', saveMessage: '' });
        try {
            const result = await matching_preferences_1.matchingPreferencesApi.save(payload);
            if (!result || !result.preferences)
                throw new Error('保存结果暂未确认，请重试');
            // A save can finish after navigation. Refresh this account's recommendations
            // on return, without touching a replacement account or rendering a hidden page.
            if ((0, page_session_1.pageSessionScope)() === scope)
                (0, showcase_cache_1.invalidateShowcaseCategory)(scope, 'recommend');
            if (!canRender()) {
                this._refreshPreferenceScopes[scope] = true;
                return;
            }
            this.setData({ ...formView((0, matching_preferences_form_1.preferenceForm)(result.preferences)), ready: true, dirty: false, saveMessage: '匹配偏好已保存' });
        }
        catch (error) {
            if (canRender())
                this.setData({ error: error instanceof Error ? error.message : '保存失败，请重试' });
        }
        finally {
            delete this._pendingSaveScopes[scope];
            if (canRender())
                this.setData({ saving: false });
        }
    }
});
