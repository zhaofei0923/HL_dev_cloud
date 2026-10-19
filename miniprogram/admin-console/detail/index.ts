import { pageSessionScope } from '../../utils/page-session'
import { CERTIFICATION_MATERIAL_MAX_BYTES, certificationMaterialMime } from '../../utils/certification-form'
import { operate, isResource, isKind, recordKey, detailFields, RESOURCE_TITLES, KIND_LABELS, SOURCE_LABELS, ASSET_LABELS,
  errorMessage, apiCode, shown, type AdminResource, type AdminRecord, type AdminArgs, type AdminAction,
  type LabelValue, type FilterOption, type AdminMaterial, type AdminEvidence, type MutationResult, type CertificationMaterial, type ServicePackage } from '../../services/admin-console'

type WriteDraft = { action: AdminAction; args: AdminArgs; label: string; summary: string }
type PendingWrite = WriteDraft & { requestId: string; scope: string }
const VERSION = /^v1_[a-f0-9]{64}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SOURCE_OPTIONS: Record<string, string[]> = { identity: ['identity_document'], education: ['chsi', 'cscse'],
  vehicle: ['vehicle_license'], property: ['property_certificate'], assets: ['bank_statement', 'securities_statement', 'insurance_statement', 'combined_financial_statement'] }

Page({
  _visible: false, _generation: 0, _scope: '', _valid: false, _key: {} as AdminArgs,
  _detail: null as AdminRecord | null, _pending: null as PendingWrite | null,
  _paths: [] as string[], _materialSequence: 0, _evidenceSequence: 0,
  data: {
    resource: 'matchmakers' as AdminResource, title: '', recordTitle: '', fields: [] as LabelValue[],
    loading: false, preparing: false, writing: false, previewing: false, evidenceLoading: false,
    ready: false, error: '', notice: '', pendingRetry: false, remark: '', feedback: '', evidenceReference: '',
    canAssign: false, hasExistingAssignment: false, principalIndex: 0, principalOptions: [{ id: 0, label: '请选择负责主理人' }],
    servicePackages: [] as (ServicePackage & { statusLabel: string })[], extendPackages: [] as (ServicePackage & { label: string })[],
    packageIndex: 0, extensionDays: '', serviceReason: '',
    sources: [] as FilterOption[], sourceIndex: 0, educationOptions: ['请选择核验学历', '本科', '硕士', '博士'], educationIndex: 0,
    assetOptions: [{ label: '请选择核验资产区间', value: '' }, ...Object.entries(ASSET_LABELS).map(([value, label]) => ({ value, label }))], assetIndex: 0,
    kind: '', materials: [] as { id: string; label: string }[], materialPath: '', materialLabel: '', evidenceFields: [] as LabelValue[],
    canApprove: false, canReject: false, canRevoke: false, canCancel: false, canToggle: false, active: false
  },
  onLoad(options: Record<string, string | undefined>) {
    wx.hideShareMenu({ menus: ['shareAppMessage', 'shareTimeline'] })
    if (!isResource(options.resource)) return
    const resource = options.resource
    const row: AdminRecord = resource === 'certifications' ? { userId: Number(options.userId),
      kind: isKind(options.kind) ? options.kind : undefined, applicationId: options.applicationId }
      : resource === 'plans' ? { planCode: options.planCode } : resource === 'orders' ? { outTradeNo: options.outTradeNo }
        : resource === 'services' ? { userId: Number(options.userId) } : { id: Number(options.id) }
    const key = recordKey(resource, row)
    this._valid = !!key
    this._key = key || {}
    this.setData({ resource, title: RESOURCE_TITLES[resource] })
    wx.setNavigationBarTitle({ title: RESOURCE_TITLES[resource] + '详情' })
    this.cleanOrphanFiles()
  },
  onShow() {
    this.clearPrivate()
    this._visible = true
    this._scope = pageSessionScope()
    return this.loadDetail()
  },
  onHide() { this.clearPrivate() },
  onUnload() { this.clearPrivate() },
  clearFiles() {
    const paths: string[] = this._paths.splice(0)
    this._materialSequence += 1
    this.setData({ materialPath: '', materialLabel: '', previewing: false })
    paths.forEach(filePath => wx.getFileSystemManager().unlink({ filePath, fail: () => undefined }))
  },
  cleanOrphanFiles() {
    const fs = wx.getFileSystemManager()
    if (typeof fs.readdir !== 'function') return
    fs.readdir({ dirPath: wx.env.USER_DATA_PATH,
      success: result => result.files.filter(name => /^admin-material-\d+-\d+\.(pdf|png|jpg)$/.test(name))
        .forEach(name => fs.unlink({ filePath: `${wx.env.USER_DATA_PATH}/${name}`, fail: () => undefined })), fail: () => undefined })
  },
  clearPrivate() {
    this._visible = false; this._generation += 1; this._evidenceSequence += 1; this._scope = ''
    this._detail = null; this._pending = null
    this.clearFiles()
    this.setData({ fields: [], ready: false, recordTitle: '', loading: false, preparing: false, writing: false,
      evidenceLoading: false, evidenceFields: [], materials: [], pendingRetry: false,
      remark: '', feedback: '', evidenceReference: '', sources: [], sourceIndex: 0, educationIndex: 0, assetIndex: 0,
      kind: '', error: '', notice: '', canApprove: false, canReject: false, canRevoke: false, canCancel: false, canToggle: false, active: false })
    this.setData({ canAssign: false, hasExistingAssignment: false, principalIndex: 0, principalOptions: [{ id: 0, label: '请选择负责主理人' }],
      servicePackages: [], extendPackages: [], packageIndex: 0, extensionDays: '', serviceReason: '' })
  },
  current(generation: number, scope: string) {
    if (!this._visible || generation !== this._generation || scope !== this._scope) return false
    if (this._visible && scope !== pageSessionScope()) { this.clearPrivate(); return false }
    return this._visible && !!scope && this._scope === scope && this._generation === generation
  },
  reportFailure(failure: unknown) {
    const code = apiCode(failure)
    if (code === 401 || code === 403 || Math.floor(code / 100) === 401 || Math.floor(code / 100) === 403) this.clearPrivate()
    this.setData({ error: errorMessage(failure) })
  },
  editable() { return this.current(this._generation, this._scope) && this.data.ready && !this.data.loading
    && !this.data.preparing && !this.data.writing && !this._pending },
  applyDetail(row: AdminRecord) {
    const key = recordKey(this.data.resource, row)
    if (!key || Object.entries(this._key).some(([name, value]) => key[name] !== value)
      || this.data.resource !== 'orders' && !VERSION.test(row.version || '')) throw new Error('INVALID_DETAIL')
    this._detail = row
    this._evidenceSequence += 1
    this.clearFiles()
    const sources = (SOURCE_OPTIONS[row.kind || ''] || []).map(value => ({ value, label: SOURCE_LABELS[value] }))
    this.setData({ canAssign: this.data.resource === 'services' && row.canAssign === true,
      hasExistingAssignment: row.hasExistingAssignment === true, principalIndex: 0,
      principalOptions: [{ id: 0, label: '请选择负责主理人' }, ...(row.principals || []).map(item => ({ id: item.id, label: item.nickname + ' · ' + (item.matchmakerNo || item.id) }))],
      servicePackages: (row.packages || []).map(item => ({ ...item, statusLabel: item.status === 'active' ? '有效' : item.status === 'exhausted' ? '次数已用完' : item.status === 'expired' ? '已过期' : item.status === 'refunded' ? '已退款' : '待核查' })),
      extendPackages: (row.packages || []).filter(item => item.canExtend).map(item => ({ ...item, label: item.planTitle + ' · 剩余' + item.remainingCount + '次 · ' + item.expireAt })),
      packageIndex: 0, extensionDays: '', serviceReason: '' })
    this.setData({ fields: detailFields(this.data.resource, row), ready: true, loading: false,
      recordTitle: row.user?.nickname || row.title || row.planTitle || row.outTradeNo || '记录详情', kind: row.kind || '',
      sources, sourceIndex: Math.max(0, sources.findIndex(item => item.value === row.source)),
      educationIndex: 0, assetIndex: 0, remark: '', feedback: '', evidenceReference: '', evidenceFields: [], evidenceLoading: false,
      materials: (row.materials || []).map((item, index) => ({ id: item.id,
        label: '材料 ' + (index + 1) + ' · ' + (item.mimeType === 'application/pdf' ? 'PDF' : '图片') + ' · ' + Math.ceil(item.size / 1024) + ' KB' })),
      canApprove: this.data.resource === 'salons' ? row.canApprove === true : ['matchmakers', 'certifications'].includes(this.data.resource) && row.canReview === true,
      canReject: this.data.resource === 'salons' ? row.canReject === true : ['matchmakers', 'certifications'].includes(this.data.resource) && row.canReview === true,
      canRevoke: this.data.resource === 'certifications' && row.canRevoke === true,
      canCancel: this.data.resource === 'salons' && row.canCancel === true,
      canToggle: this.data.resource === 'plans' && row.canUpdate === true && typeof row.active === 'boolean', active: row.active === true })
  },
  async loadDetail() {
    if (!this._visible || this.data.loading || this.data.writing || this.data.preparing) return
    if (!this._scope || !this._valid) { this.setData({ error: this._valid ? '请先登录管理员账号。' : '记录编号无效，请返回列表重新选择。' }); return }
    const scope = this._scope, generation = ++this._generation
    this._detail = null; this._pending = null; this._evidenceSequence += 1
    this.clearFiles()
    this.setData({ loading: true, ready: false, error: '', notice: '', fields: [], materials: [], evidenceFields: [],
      remark: '', feedback: '', evidenceReference: '', pendingRetry: false, evidenceLoading: false })
    try {
      // The detail operation authenticates and authorizes before reading records.
      const row = await operate<AdminRecord>(`${this.data.resource}.detail`, this._key)
      if (this.current(generation, scope)) this.applyDetail(row)
    } catch (failure) {
      if (this.current(generation, scope)) { this.setData({ loading: false, ready: false }); this.reportFailure(failure) }
    }
  },
  onFieldInput(event: WechatMiniprogram.Input) {
    if (!this.editable()) return
    const value = event.detail.value, field: unknown = event.currentTarget.dataset.field
    if (field === 'remark') this.setData({ remark: value.slice(0, 1000) })
    else if (field === 'feedback') this.setData({ feedback: value.slice(0, 500) })
    else if (field === 'evidenceReference') this.setData({ evidenceReference: value.slice(0, 1000) })
    else if (field === 'extensionDays') this.setData({ extensionDays: value.slice(0, 2) })
    else if (field === 'serviceReason') this.setData({ serviceReason: value.slice(0, 500) })
  },
  onChoice(event: WechatMiniprogram.PickerChange) {
    if (!this.editable()) return
    const field: unknown = event.currentTarget.dataset.field, value = Number(event.detail.value)
    if (!Number.isInteger(value) || value < 0) return
    if (field === 'sourceIndex' && this.data.sources[value]) this.setData({ sourceIndex: value })
    else if (field === 'educationIndex' && this.data.educationOptions[value]) this.setData({ educationIndex: value })
    else if (field === 'assetIndex' && this.data.assetOptions[value]) this.setData({ assetIndex: value })
    else if (field === 'principalIndex' && this.data.principalOptions[value]) this.setData({ principalIndex: value })
    else if (field === 'packageIndex' && this.data.extendPackages[value]) this.setData({ packageIndex: value })
  },
  buildWrite(command: string): WriteDraft | null {
    const row: AdminRecord | null = this._detail
    if (!row?.version) return null
    const resource = this.data.resource, remark = this.data.remark.trim(), feedback = this.data.feedback.trim()
    const args: AdminArgs = { ...this._key, expectedVersion: row.version }
    let action: AdminAction, label: string
    if (resource === 'services') {
      const reason = this.data.serviceReason.trim()
      if (!reason) { this.setData({ error: '请填写处理原因。' }); return null }
      if (command === 'assign' && this.data.canAssign) {
        const principal = this.data.principalOptions[this.data.principalIndex]
        if (!principal?.id) { this.setData({ error: '请选择负责主理人。' }); return null }
        if (principal.id === row.assignment?.matchmakerId) { this.setData({ error: '当前已由此主理人负责。' }); return null }
        return { action: 'services.assign', args: { ...args, matchmakerId: principal.id, reason, confirmReassign: this.data.hasExistingAssignment },
          label: this.data.hasExistingAssignment ? '确认更换负责主理人' : '确认分配主理人',
          summary: `会员 ${row.userId} · ${this.data.recordTitle}\n${this.data.hasExistingAssignment ? '将更换已有服务关系，原主理人不再负责此会员。\n' : ''}新主理人：${principal.label}\n处理原因：${reason}\n主理人联系后，仍需按现有流程确认服务准备情况。` }
      }
      if (command === 'extend') {
        const selected = this.data.extendPackages[this.data.packageIndex], days = Number(this.data.extensionDays)
        if (!selected || !/^([1-9]|[12]\d|30)$/.test(this.data.extensionDays) || !Number.isSafeInteger(days)) { this.setData({ error: '请选择可延期权益，并填写1至30整数天。' }); return null }
        const expiry = new Date(Date.parse(selected.expireAt) + days * 86400000).toISOString()
        return { action: 'services.extend', args: { ...args, packageId: selected.id, days, reason }, label: '确认平台延误延期',
          summary: `会员 ${row.userId} · ${selected.planTitle}\n订单：${selected.orderNo}\n原到期：${selected.expireAt}\n延长${days}天后：${expiry}\n按现有到期日累加，已过期权益可能仍未恢复有效。\n平台延误原因：${reason}\n购买天数、次数与实付金额保持原记录。` }
      }
      return null
    }
    if (command === 'approve' && this.data.canApprove) {
      action = resource === 'matchmakers' ? 'matchmakers.review' : resource === 'salons' ? 'salons.review' : 'certifications.review'
      label = '审核通过'
      if (resource === 'matchmakers') Object.assign(args, { certificationStatus: 2, remark })
      else if (resource === 'salons') Object.assign(args, { status: 'upcoming', remark })
      else {
        const source = this.data.sources[this.data.sourceIndex]?.value, evidenceReference = this.data.evidenceReference.trim()
        if (!source || !evidenceReference || row.kind === 'education' && !this.data.educationIndex || row.kind === 'assets' && !this.data.assetIndex) {
          this.setData({ error: '请填写核验来源、内部凭据引用及该类型要求的学历或资产区间。' }); return null
        }
        Object.assign(args, { status: 'approved', source, evidenceReference, remark, feedback,
          ...(row.kind === 'education' ? { educationLevel: this.data.educationOptions[this.data.educationIndex] } : {}),
          ...(row.kind === 'assets' ? { financialAssetRange: this.data.assetOptions[this.data.assetIndex].value } : {}) })
      }
    } else if (command === 'reject' && this.data.canReject) {
      if (!(resource === 'certifications' ? feedback : remark)) { this.setData({ error: resource === 'certifications' ? '请填写申请人可见的拒绝原因。' : '请填写拒绝原因。' }); return null }
      action = resource === 'matchmakers' ? 'matchmakers.review' : resource === 'salons' ? 'salons.review' : 'certifications.review'; label = '拒绝申请'
      Object.assign(args, resource === 'matchmakers' ? { certificationStatus: 1, remark } : resource === 'salons' ? { status: 'rejected', remark } : { status: 'rejected', remark, feedback })
    } else if (command === 'revoke' && this.data.canRevoke) {
      if (!feedback) { this.setData({ error: '请填写申请人可见的撤销原因。' }); return null }
      action = 'certifications.review'; label = '撤销认证'; Object.assign(args, { status: 'revoked', remark, feedback })
    } else if (command === 'cancel' && this.data.canCancel) {
      if (!remark) { this.setData({ error: '请填写取消原因。' }); return null }
      action = 'salons.cancel'; label = '取消沙龙'; Object.assign(args, { reason: remark })
    } else if (command === 'toggle' && this.data.canToggle) {
      action = 'plans.update'; label = row.active ? '停用套餐' : '启用套餐'; Object.assign(args, { active: !row.active })
    } else return null
    const impact = command === 'toggle' ? '仅改变后续购买入口，已有订单和已购买权益保持不变。'
      : command === 'cancel' ? '活动将取消，后续报名按更新后的状态处理。' : command === 'revoke' ? '认证将撤销，申请人会看到反馈原因。' : '审核结论将记录到当前申请。'
    const identity = resource === 'certifications' && row.kind ? `${KIND_LABELS[row.kind]} · 会员 ${row.userId} · 申请 ${row.applicationId}`
      : resource === 'plans' ? '套餐 ' + shown(row.planCode || row.code) : '记录编号 ' + shown(row.id)
    const summary = `${label}：${this.data.recordTitle}\n${identity}\n${impact}\n内部备注：${remark || '未填写'}`
      + (resource === 'certifications' ? `\n本人可见反馈：${feedback || '未填写'}\n核验来源：${SOURCE_LABELS[String(args.source || '')] || '不适用'}\n核验引用：${shown(args.evidenceReference)}${args.educationLevel ? '\n学历：' + args.educationLevel : ''}${args.financialAssetRange ? '\n资产区间：' + ASSET_LABELS[String(args.financialAssetRange)] : ''}` : '')
    return { action, args, label, summary }
  },
  async prepareWrite(event: WechatMiniprogram.TouchEvent) {
    if (!this.editable()) return
    const command = String(event.currentTarget.dataset.command || ''), draft = this.buildWrite(command)
    if (!draft || !this._detail) return
    const generation = this._generation, scope = this._scope, version = this._detail.version
    this.clearFiles(); this._evidenceSequence += 1
    this.setData({ preparing: true, error: '', evidenceFields: [], evidenceLoading: false, notice: '' })
    try {
      const fresh = await operate<AdminRecord>(`${this.data.resource}.detail`, this._key)
      if (!this.current(generation, scope)) return
      const freshKey = recordKey(this.data.resource, fresh)
      if (!freshKey || Object.entries(this._key).some(([key, value]) => freshKey[key] !== value)) throw new Error('INVALID_DETAIL')
      if (fresh.version !== version) { this.applyDetail(fresh); this.setData({ error: '记录已更新，已刷新详情；请重新核对后再操作。' }); return }
      const prepared = await operate<{ requestId: string }>('operations.prepare', {})
      if (!this.current(generation, scope)) return
      if (!UUID.test(prepared?.requestId || '')) throw new Error('INVALID_REQUEST_ID')
      const confirmed = await new Promise<boolean>(resolve => wx.showModal({ title: draft.label, content: draft.summary,
        confirmText: '确认提交', confirmColor: '#a35d45', success: result => resolve(result.confirm), fail: () => resolve(false) }))
      if (!this.current(generation, scope) || !confirmed) return
      this._pending = { ...draft, requestId: prepared.requestId, scope }
      await this.submitPending()
    } catch (failure) {
      if (this.current(generation, scope)) this.reportFailure(failure)
    } finally { if (this.current(generation, scope)) this.setData({ preparing: false }) }
  },
  async submitPending() {
    const pending = this._pending, generation = this._generation, scope = this._scope
    if (!pending || pending.scope !== scope || !this.current(generation, scope) || this.data.writing) return
    this.setData({ writing: true, error: '', notice: '', pendingRetry: false })
    try {
      const result = await operate<MutationResult>(pending.action, pending.args, pending.requestId)
      if (!this.current(generation, scope)) return
      if (!result || result.requestId !== pending.requestId || result.action !== pending.action || !VERSION.test(result.version || '')
        || !result.target || Object.entries(this._key).some(([key, value]) => result.target[key] !== value)) throw new Error('UNCONFIRMED_RESULT')
      this._pending = null
      this.setData({ writing: false, preparing: false, pendingRetry: false })
      await this.loadDetail()
      if (this._visible && scope === pageSessionScope()) this.setData({ notice: '操作已完成，已读取最新详情。' })
    } catch (failure) {
      if (!this.current(generation, scope)) return
      const code = apiCode(failure)
      if (code === 409 || Math.floor(code / 100) === 409) {
        this._pending = null
        this.setData({ writing: false, preparing: false, pendingRetry: false })
        await this.loadDetail()
        if (this._visible && scope === pageSessionScope()) this.setData({ error: '记录已变化，已刷新详情。请核对后重新确认，未自动重放操作。' })
      } else if (code >= 40000 && code < 50000) {
        this._pending = null
        this.setData({ pendingRetry: false }); this.reportFailure(failure)
      } else if (code === 401 || code === 403) {
        this.reportFailure(failure)
      } else this.setData({ error: '结果暂未确认。重试将使用原操作编号和原内容，不会新建操作。', pendingRetry: true })
    } finally { if (this.current(generation, scope)) this.setData({ writing: false }) }
  },
  async retryWrite() {
    const pending = this._pending, generation = this._generation, scope = this._scope
    if (!pending || !this.current(generation, scope) || this.data.writing || this.data.preparing) return
    this.setData({ preparing: true })
    try {
      const confirmed = await new Promise<boolean>(resolve => wx.showModal({ title: '重试原操作', content: pending.summary + '\n\n上次结果未确认，此次复用原操作编号。',
        confirmText: '确认重试', success: result => resolve(result.confirm), fail: () => resolve(false) }))
      if (confirmed && this.current(generation, scope) && this._pending === pending) await this.submitPending()
    } finally { if (this.current(generation, scope)) this.setData({ preparing: false }) }
  },
  async viewEvidence() {
    if (!this.editable() || this.data.evidenceLoading || this.data.resource !== 'certifications' || !this._detail?.version) return
    const generation = this._generation, scope = this._scope, sequence = ++this._evidenceSequence
    this.setData({ evidenceLoading: true, evidenceFields: [], error: '' })
    try {
      const value = await operate<AdminEvidence>('certifications.evidence', { ...this._key, expectedVersion: this._detail.version })
      if (!this.current(generation, scope) || sequence !== this._evidenceSequence) return
      if (Object.entries(this._key).some(([key, expected]) => (value as unknown as AdminArgs)[key] !== expected)) throw new Error('INVALID_EVIDENCE')
      this.setData({ evidenceFields: [{ label: '核验码', value: shown(value.verificationCode) }, { label: '认证书编号', value: shown(value.certificateNumber) },
        { label: '申报资产区间', value: ASSET_LABELS[value.declaredFinancialAssetRange || ''] || '—' }] })
    } catch (failure) { if (this.current(generation, scope) && sequence === this._evidenceSequence) { this.setData({ evidenceFields: [] }); this.reportFailure(failure) } }
    finally { if (this.current(generation, scope) && sequence === this._evidenceSequence) this.setData({ evidenceLoading: false }) }
  },
  clearEvidence() { this._evidenceSequence += 1; this.setData({ evidenceFields: [], evidenceLoading: false }) },
  async viewMaterial(event: WechatMiniprogram.TouchEvent) {
    if (!this.editable() || this.data.previewing || this.data.resource !== 'certifications' || !this._detail?.version) return
    const materialId = String(event.currentTarget.dataset.id || ''), metadata = this._detail.materials?.find((row: CertificationMaterial) => row.id === materialId)
    if (!metadata) return
    this.clearFiles()
    const generation = this._generation, scope = this._scope, sequence = ++this._materialSequence
    this.setData({ previewing: true, error: '' })
    const valid = () => this.current(generation, scope) && this._materialSequence === sequence
    let filePath = ''
    try {
      const material = await operate<AdminMaterial>('certifications.material', { ...this._key, expectedVersion: this._detail.version, materialId })
      if (!valid()) return
      const content = material?.contentBase64, padding = typeof content === 'string' ? (content.endsWith('==') ? 2 : content.endsWith('=') ? 1 : 0) : 0
      if (material.id !== materialId || typeof content !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(content) || content.length % 4 !== 0
        || material.mimeType !== metadata.mimeType || certificationMaterialMime(content) !== material.mimeType || material.size !== metadata.size
        || material.size <= 0 || material.size > CERTIFICATION_MATERIAL_MAX_BYTES || content.length * 3 / 4 - padding !== material.size) throw new Error('INVALID_MATERIAL')
      const extension = material.mimeType === 'application/pdf' ? 'pdf' : material.mimeType === 'image/png' ? 'png' : 'jpg'
      filePath = `${wx.env.USER_DATA_PATH}/admin-material-${Date.now()}-${sequence}.${extension}`
      this._paths.push(filePath)
      await new Promise<void>((resolve, reject) => wx.getFileSystemManager().writeFile({ filePath, data: content, encoding: 'base64', success: () => resolve(), fail: reject }))
      if (!valid()) { wx.getFileSystemManager().unlink({ filePath, fail: () => undefined }); return }
      if (extension === 'pdf') await new Promise<void>((resolve, reject) => wx.openDocument({ filePath, fileType: 'pdf', showMenu: false, success: () => resolve(), fail: reject }))
      else this.setData({ materialPath: filePath, materialLabel: '认证材料 · 仅供当前审核查看' })
    } catch (failure) {
      if (filePath) wx.getFileSystemManager().unlink({ filePath, fail: () => undefined })
      if (valid()) this.reportFailure(failure)
    } finally { if (valid()) this.setData({ previewing: false }) }
  },
  onMaterialError() { this.clearFiles(); this.setData({ error: '材料图片暂时无法显示，请重新读取。' }) },
  goBack() { wx.navigateBack({ delta: 1 }) }
})
