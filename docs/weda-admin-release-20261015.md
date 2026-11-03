# 微搭管理后台发布准备核验（2026-10-15）

## 最新进展：权限发布完成，预览资源已验证

本应用范围内的权限发布已完成：`ReleaseResourcePermissions` 任务 `5f0fb9fa-42fe-4ccb-967d-7802365b4854` 实时回读为 `SUCCESS`。随后新读取的 V3 `verify-pre`／`verify-prod` 均通过。这里的生产页保障来自本应用权限发布任务成功及当前角色目录核验，**尚未独立读取生产页面权限，也未完成真实会话的访问验收**。

当前实际角色目录共有6个角色：`administrator`、`allUser`、`anonymousUser`、`hl_operator`、`internalUser`、`registerUser`。管理员保持 `allPages=true`；其余5个实际角色在编辑态页面接口中的六个管理页全部为拒绝。应用关联摘要仍显示内置 `externalUser/-3`，但该 ID 不在实际角色目录内；其旧接口读值仍为 `allPages=false`、六页 `AccessAble=true`，原值完整保留，展示含义尚未解决，不能声称该旧角色六页已经拒绝。

精确范围保护仅允许已观察的匿名角色单应用覆盖项；原有 `app/*`、`apis/*` 和其他角色策略均保留。证据：`output/admin-release-20261015/app-access-release.json`、`app-access-verify-pre-1792050320825.json`、`app-access-verify-prod-1792050448785.json`；这些证据不替代后台真实登录和业务验收。

北京时间 15:48:40，现有草稿 `6776440` 的原生微搭预览构建回读为 `success`，平台返回的入口实际访问为 HTTP 200，部署证据状态为 `preview_assets_verified`。仅发出**一次** `Mode=preview、BuildType=web` 请求，BuildId 为 `0b409aa2-fd12-4db7-927f-defd1005e0ac`。实际测试入口：[后台网页预览](https://cloud1-d2gza7q9c8d69c721-1441337122.tcloudbaseapp.com/app-pq2auygx/preview/)。证据：`output/admin-entry-20261015/weda-preview/deployment.json`，采集时间 `2026-10-15T07:48:40.041Z`。

以上仅确认预览资源可访问。浏览器自动化的页面读取和截图连续超时，当前仅标签列表出现标题“运营总览”及 `/preview/overview` 路径，不足以证明后台登录、页面授权或真实数据加载通过。管理员与非管理员真实会话、业务动作和手机 web-view 仍未验收；部署证据中的 `browserLoginVerified=false`、`productionActive=false` 均保留。

用户确认暂无正式域名；`hlApi.WEDA_ADMIN_URL` 未配置，手机入口继续显示“尚未开放”。默认域名仅用于网页预览测试，未请求 `Mode=upload` 正式发布，也未启用小程序正式后台地址。后台内部登录、未授权拒绝、真实手机 web-view 和业务动作仍待验收。

最新完整 `npm run check` 为 **1392/1392**，日志：`output/admin-entry-20261015/check-final-weda.log`。本地检查不替代真实登录、正式发布或手机完整链路验收。

## 15:31 阶段记录（历史，后续状态以上文为准）

用户已确认目前没有正式域名。继续使用平台默认地址准备网页预览；不会把默认地址配置为小程序正式后台 URL。小程序“管理后台”页面已在用户手机上显示，当前“尚未开放”对应后台 URL 尚未配置，不构成正式发布完成。

现有后台内置 `externalUser` 应用关联按照官方编辑器规则保留，页面权限可单独撤销；管理员保留全部管理页。已备份原应用和角色权限，按计划开始撤销匿名应用访问。首次精确字符串 RoleId 被 API 明确拒绝后，使用无精度损失的 int64 编码成功执行，未重放结果不明的请求。

首次成功操作的回读发现：匿名角色在 pre/prod 应用列表中同时消失，角色策略仅新增本应用 `app-pq2auygx` 的 `IsBindAllAccess=false` 覆盖项，原 `app/*`、`apis/*` 及其他角色策略保留。范围保护因此暂停后续操作，进一步核对精确策略差异；不能继续声称平台的 pre/prod 应用角色列表在本次操作中相互隔离，也不能把列表变化当作正式页面权限已经生效。精确差异见 `output/admin-release-20261015/app-access-scoped-policy-diff.json`。后续页面撤权和权限发布须有独立回读证据。

此前只读核验的时间和结论保留如下，后续实际状态以新增核验记录为准。域名准备路径见 `output/admin-entry-20261015/domain-prerequisites.md`。

## 12:42 初始只读核验（历史）

核验时间：北京时间 2026-10-15 12:42:12—12:42:30。范围为现有微搭后台、应用侧登录、内部用户与角色、集合权限、函数状态及运维准备。本次只执行云端读取，没有发布、调整权限、审核真实业务、读取认证材料或请求函数环境变量明文。

脱敏原始摘要：`output/admin-release-20261015/cloud-readonly-summary.json`。该摘要不含用户 UID、手机号、邮箱、账号名、密钥、令牌、预签名地址或原始业务记录。

## 12:42 判定（历史）

业务接入已完成，正式后台发布及小程序内进入后台的完整链路仍未验收。当前应保持为待发布状态，完成下列访问、账号、手机实机及业务验收后再正式投入运营。

| 核验项 | 2026-10-15 云端只读结果 | 含义 |
| --- | --- | --- |
| 唯一现有后台 | `app-pq2auygx`，HL运营管理后台 | 继续使用现有应用，不新建重复后台 |
| 最新草稿历史 | `6776440` | 与 10月14日修复记录一致 |
| 发布标记 | `LastDeployTime`、`LastWebCiStatus`、`Domain`、`OnlineVersion` 均为空 | 未取得已发布后台的正式访问 URL |
| 平台元数据 | `Platform=ALL`、`AppType=0`、`Status=0` | 仅记录原始非敏感状态；不以数值自行推断发布成功 |
| 环境静态托管 | online，默认域名见下文 | 环境托管可用不等于应用已发布 |
| 应用登录方式 | 用户名密码开启；邮箱、匿名、手机号登录关闭 | 沿用现有内部用户登录，尚未实际输入凭据验证 |
| 内部用户 | 1个 ACTIVE 内部用户，具有 administrator 角色 | 仅确认数量与授权类别，未保存身份明细 |
| 运营角色 | `hl_operator` 无成员、无策略 | 不能当作已经配置好运营权限 |
| 四个敏感集合及审计集合 | ACL 与安全规则标签均为 ADMINONLY；自定义规则为空 | 当前配置回读符合服务端访问边界 |
| 三个相关函数 | `hlApi`、`hlAdminCockpit`、`hlAdminOperations` 均 Active | 仅证明运行状态，不替代完整业务链路验收 |
| 日志服务与主题 | 日志服务未开通，三个函数均未检测到日志主题 | 当前失败请求仍缺少持久日志追踪 |
| 云产品监控告警 | `DescribeAlarmPolicies` 的 MT_QCE 策略总数为0 | 尚无本轮可证实的云产品指标告警；未验证其他告警引擎或通知送达 |

应用详情 RequestId：`783dd219-eefa-4854-9c3f-b922c215ed46`。角色查询 RequestId：`39b8c371-7a0c-409e-895e-48a22d696533`。内部用户数量查询 RequestId：`789a4bd1-3bbc-49b7-9d31-25309eb1ca8c`。告警查询 RequestId：`a588e08c-1d05-47cc-a51a-ea63cda5cc11`。各集合独立 ACL 及规则回读 RequestId 见脱敏摘要。

## 后台域名与小程序入口

本次实际读回的环境静态托管域名为：

`cloud1-d2gza7q9c8d69c721-1441337122.tcloudbaseapp.com`

它是环境默认托管域名，不能把拼接出来的 `/app-pq2auygx/...` 路径标为正式后台地址。应用发布后应使用平台实际返回、回读确认并访问验收的 URL；本次没有生成、猜测或配置正式 URL。

最小可行路线：小程序后端确认当前账号拥有管理员资格后，返回固定的后台入口能力；小程序的“我的”页面仅对该资格显示入口，进入受控 web-view；web-view 加载发布后的现有微搭 H5；后台仍用 CloudBase 内部管理员账户登录，管理函数继续按本次平台会话和 administrator 角色核验。

当前 `weda-admin/app.cals.json` 中为 `loginType=primary`、`pureAnonymousLogin=false`、`enableLoginStatusShare=false`。小程序的业务 JWT／OPENID 与后台内部用户不属于同一身份域。此次路线不实现单点登录，不把小程序 token、内部用户凭据或管理密钥放进 URL、web-view 参数或前端资源。

进入手机内 web-view 前还需完成：

1. 发布现有后台的 H5 正式版本并取得真实访问地址；在正式版本验证受控云函数身份链路。
2. 准备稳定的 HTTPS 业务域名，确认其访问入口、DNS、证书及登录跳转路径；默认托管域名不能视为正式生产域名已准备完成。
3. 用户在微信公众平台配置业务域名，并提供平台生成的域名校验文件；把该文件放到对应 H5 域名根目录后，完成微信侧校验。
4. 实际核对登录页及其他顶层跳转涉及的域名是否可在小程序 web-view 内访问；微信业务域名配置与 CloudBase Web 安全域名配置属于不同检查项。
5. 配置真正已发布且通过校验的固定后台 URL 后，才让正式小程序入口可进入。未配置时显示明确的准备中状态。

腾讯云官方文档确认微搭 H5 可以通过小程序 web-view 引入，但需要业务域名和根目录校验文件，见[小程序相关问题](https://cloud.tencent.com/document/faq/1301/67756)。默认域名的生产访问要求见[域名服务概述](https://docs.cloudbase.net/service/introduce)。

## 账号与访问权限的待处理项

当前系统角色 `registerUser`、`anonymousUser` 仍有 `ResourceType=app`、`Resource=*`、`Effect=allow`、`IsBindAllAccess=true` 的默认应用访问策略；administrator 也有该策略。匿名登录开关关闭不能单独证明应用入口和页面已经仅限内部管理员。

正式发布前需要选择现有后台的应用／页面访问策略并发布所需权限资源，验证未登录、普通注册用户、无 administrator 角色、已撤权用户不能取得后台数据或执行动作。现有后端已按平台身份加内部管理员角色验证；前端隐藏入口只改善展示，不代替后台授权。

运营人员账号需要逐人确认；当前仅证实一个内部管理员。若首期由该管理员使用，可维持现状完成验收。新增人员或启用 `hl_operator` 需要明确对应的允许动作，不能只添加角色名称后宣称可用。

## 业务与手机验收

历史记录中，用户已确认真实运营总览、页面切换及套餐查询展示六档；该确认范围未覆盖套餐启停、其他管理写操作及发布后访问。见 `weda-admin/README.md` 与 `weda-admin/operations-verification.json`。

本地官方组件渲染曾覆盖1440px桌面、375px／320px窄屏、375px H5模拟，未见页面横向溢出，表格采用内部横向滚动。但当时为隔离样例和模拟 UA，不能作为当前云端后台在真实手机上的完整验收。

发布验收至少包括：

- 管理员实际登录后，六页列表、筛选、分页、选中详情及页面切换正常。
- 使用明确的待处理业务或独立隔离样本，完成主理人审核、沙龙审核／取消、套餐启停；核对结果、版本冲突、重复提交和审计回执。不得用真实业务记录作无业务依据的测试性审核或取消。
- 首条真实认证申请的受控材料查看、审核／撤销、图片与 PDF 浏览；关闭材料、切换记录、离页和登录失效时清理。
- 安卓和 iOS 微信内的登录、表格滚动、按钮可点击、键盘遮挡、返回及重新进入；PDF新窗口／下载是否被 web-view 限制，按真机结果处理。
- 未登录、普通用户和撤权用户被拒绝；即使直接访问后台 URL，也不能绕过平台与服务端授权。
- 发布后的正式版本与预览结果一致；回退到已核验草稿／发布版本的方法明确。

## 运维与发布合同

日志及告警需要单独准备：确认适用的费用与保存范围，配置不含认证材料、证件、核验码、令牌和内部备注原文的错误日志；对函数失败、超时及限流设置通知，并验证责任人实际收到通知。本次未开通日志、未创建告警、未发送通知。

现有 `scripts/weda-admin-draft.mjs` 仅提供 `inspect`、`backup`、`save`、`verify`，明确不创建应用、不发布。`scripts/deploy-admin-operations.mjs` 的 `deploy` 是管理函数部署，也不发布微搭应用；其 `verify` 含函数调用和证据覆盖行为，本次没有执行该模式。

官方本地 SDK 路径来源于既有只读核验脚本 `output/cockpit-20261014/verify-real-data.mjs`：

`C:/Users/12157/AppData/Local/npm-cache/_npx/e15d770835b66f6b/node_modules/@cloudbase/cloudbase-mcp/dist/index.cjs`

本次通过该 SDK 的现有管理登录执行应用元数据读取，并通过官方 MCP stdio 查询登录、角色、用户数量、托管、函数及日志状态，没有读取本地凭据文件。普通 `manageApps` 是另一套 CloudBase Web 应用部署能力，不能当作当前原生微搭应用发布命令。

官方微搭 `DeployApp` 合同已核对：服务 `lowcode`、版本 `2021-01-08`，以 `EnvId` 和应用 `Id` 为必填参数，`Mode` 可选 `preview`／`upload`，`BuildType` 可选 `mp`／`pc`／`web`／`adminPortal`。成功触发返回 BuildId，仍需通过 `CheckDeployApp` 核验结果；取得 BuildId 不能视为发布完成。此次只读取文档，没有调用发布接口，也没有验证当前账号对发布动作的写权限。

官方依据：[发布应用操作说明](https://cloud.tencent.com/document/product/1301/95853)、[DeployApp 接口](https://cloud.tencent.com/document/api/1301/122058)、[API 概览](https://cloud.tencent.com/document/api/1301/68887)、[后台发布指南](https://docs.cloudbase.net/lowcode/guide/management-system-dev)、[微搭客户端与登录体系](https://docs.cloudbase.net/lowcode/practices/platform-guide/weda-client)。

后台套餐启停与正式支付开关独立。本核验不构成小程序已提审／发布、正式收费已启用或真实支付全部验收的结论。
