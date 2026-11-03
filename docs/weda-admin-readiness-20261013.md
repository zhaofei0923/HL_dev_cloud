# 微搭管理后台：接入核实与首期页面

## 已确认事实

- 用户于2026-10-13明确选择“微搭优先：先核实控制台额度和接入方式，再搭建”。
- 用户随后完成标准版升级。重新查询当前环境：`cloud1-d2gza7q9c8d69c721`，`ap-shanghai`，NORMAL、`baas_pf_standard`标准版，有效期至2026-11-13 23:59:59；环境创建于2026-06-08 19:01:28。现有数据库仍为NoSQL，不迁移数据库。此前个人版及其到期时间是升级前快照，不再代表现状。
- 当前套餐目录实测总额度：10个可发布应用、100个内部用户、月额度330000资源点。剩余发布数及计费席位未实测；当前有1个未发布草稿，不能把应用数直接当作已消费发布名额。套餐类型及资源点总额已确认，但查询的`EnvDeductionMode=normal`、`PointsTime=0000-00-00 00:00:00`尚不足以证明实际扣费模式已切换。
- 当前官方资源点文档说明标准版支持自定义角色、体验/正式数据分离。2026-08-11后的云后台限制仅针对新建环境；本环境6月创建，属可继续使用的存量环境。此为套餐能力，不等于当前角色、数据隔离及业务接口已配置或验收。
- 官方MCP角色查询：当前1个ACTIVE内部管理员，已绑定内置administrator；`hl_operator`角色存在，但Policies为空、Members为空。角色存在不能当作权限已生效或高级套餐能力已开通。
- `hlApi` 本轮只读健康检查成功。现有管理接口采用管理员令牌，不直接信任微搭前端自报的uid/role；需要核对平台可信身份上下文并建立适配。

事实依据：升级后官方`queryEnv(info)` RequestId `ec21cd44-b939-45f2-b0fe-64cef8d6ddc3`，`DescribeEnvInfo`为`b7e1fcf0-54c0-494c-8ef4-647d4a27a6fd`，当前套餐目录为`cf492305-ce53-43fe-b05d-81ca9311faa9`；角色/内部用户查询 RequestId `0e23639d-edab-4a4d-bdcc-701d3445a588`、`d9318f75-a6fb-4e6b-a7cb-5f93a0b0788a`、`7a5b97fe-d0b3-4d9a-874c-a9d23e8aff34`。未保存凭据、用户UID、联系方式或完整云工具结果。

## 已创建的设计稿

- 应用：**HL运营管理后台**，ID/云端Name为`app-pq2auygx`，本地设计名为`hl-admin-weda`。
- 六页：运营总览、主理人审核、会员认证、沙龙管理、套餐管理、支付订单；源码为`weda-admin/app.cals.json`。
- 原生CALS官方Schema验证通过；已通过正式管理API创建、保存、回读，并对JSON做完整结构相等核对。初始历史ID`6774706`；创建RequestId`01450479-2e64-4d04-a98e-02c89aebef83`。组件升级后的历史`6774762`已备份，重设计最新历史为`6774856`，保存RequestId`6358de12-69ae-4d56-a9c4-5a3ca4e0de4b`，回读历史查询`62dfea7c-aa17-40b3-a753-6d26167568f0`。
- 当前为**未发布、未接业务接口、编辑器渲染未验收**。`LastDeployTime`及`LastWebCiStatus`为空；没有发布调用。所有业务按钮禁用、无写入监听器、无示例业务记录；统计以未加载呈现。
- 安全证据：`output/weda-admin-draft-20261013.json`，不包含凭据或预签名地址。保存脚本只可操作本轮命名应用，使用创建结果ID恢复，保存后回读，不能发布。
- [控制台应用入口](https://tcb.cloud.tencent.com/dev?envId=cloud1-d2gza7q9c8d69c721#/lowcode/apps)。前期独立React草稿已可恢复归档至`D:\HL_dev_cloud_drafts\20261013`，不再作为当前实现或纳入小程序源扫描。

## 首期页面与接口映射

| 页面 | 读取 | 动作与保护 |
| --- | --- | --- |
| 运营总览 | `/admin/dashboard` | 主理人、会员及活动真实统计，待办跳转 |
| 主理人审核 | `/admin/matchmakers`，status/keyword/page/pageSize | `PUT /admin/matchmakers/:id/certification`；明确通过/拒绝和备注 |
| 会员认证 | `/admin/member-certifications`及当前申请evidence/materials | `PUT /admin/member-certifications/:uid`；必须绑定当前applicationId，材料仅核验权限可读 |
| 沙龙管理 | `/admin/salons`，status/keyword/page/pageSize | review/cancel接口；不直接修改人数，不重开终态活动 |
| 套餐管理 | `/admin/membership-plans` | 六档虚拟商品首期只读，价格/期限/次数与既有固定目录一致 |
| 支付订单 | `/admin/payment-orders`，状态/履约/产品/用户/关键词 | 仅查询和详情；不提供改订单、退款或发权益入口 |

## 接入约束

1. 页面使用微搭原生组件。2026-10-13按用户反馈重设计，视觉以小程序 `app.less` 与 `weda-admin/design.md` 为准，旧深绿概念图已被替代。组件以用户升级后的 `gsd-h5-react@3.31.0` 为准。
2. 复用既有NoSQL数据及业务云函数，不新建并行会员/订单表，不把微搭示例数据当作当前业务数据。
3. 多集合状态变更必须经现有业务接口。生成模型CRUD不能绕过审核、归属、幂等及金额规则。
4. 管理员码、JWT密钥与长期管理令牌不进入微搭前端代码、变量或页面资源。微搭登录身份与小程序OPENID属于不同身份域。
5. 后端从平台可信上下文验证当前环境、已登录非匿名UID及运营授权；前端传入的UID/role只可视为普通输入。
6. 标准版具有角色和内部用户能力，仍需逐账号配置最小权限；`hl_operator`目前没有成员和策略。角色存在不等于授权生效，不自动添加人员、购买或开启套餐服务。
7. 数据源/APIs正式与体验设置按实际能力确认；自定义接口调入同一生产函数不会自动获得数据隔离，测试不得真实审核业务记录。
8. 本轮创建并保存微搭设计稿；套餐升级由用户自行完成。用户随后明确批准四个敏感集合改为ADMINONLY，已执行并回读。未修改人员、数据源、云函数或支付配置。业务接入及发布仍需完成原生身份、账号授权和运行验证。
9. 新版资源点文档的自定义APIs不支持自定义代码。接入采用原生云函数调用及独立后端适配，不能把`weda-admin-policy.js`直接放进自定义API并宣称可运行；其当前仅支持官方custom-API的`context.env`形状，原生函数当前调用上下文必须另行验证和适配。微搭前端自动注入的appId/envType等仍属于请求数据，不能用于授权。

## 云端权限调整及运行验证

只读交叉核查发现`hl_profiles`、`hl_member_private_archives`、`hl_member_identity_claims`、`hl_member_certifications`当前均为`PRIVATE`、无自定义规则。官方语义为“创建者本人及管理员可读写”，不满足项目要求的“禁止小程序直接读写”；应为仅管理员/服务端可访问的`ADMINONLY`。本次未读业务记录、未做客户端写探针，因此没有断言某条既有记录已被改写。

调整前四个`DescribeSafeRule` RequestId依次为`568352d0-5240-4d70-8ec4-cd8cf5733ef0`、`26ccf085-bd77-4419-aec3-99fb6e86627f`、`453718da-64c4-456c-b653-ba73126739c9`、`4089a914-3cfb-4546-b8cd-bd63cb0f4647`。

用户明确回复“批准调整并回读验证”后，已只对上述四集合执行`ModifySafeRule(AclTag=ADMINONLY)`，逐项`DescribeDatabaseACL`和`DescribeSafeRule`均返回ADMINONLY，规则为空。调整及回退方案见`docs/cloud-sensitive-permissions-change-20261013.md`，完整安全记录见`output/cloud-sensitive-permissions-20261013.json`。

| 集合 | 调整后权限 | 修改RequestId | 安全规则回读RequestId |
|---|---|---|---|
| `hl_profiles` | ADMINONLY | `3ee2d3b2-a5e9-4829-b5e2-79a09d1e9e87` | `33207c18-39eb-422a-9404-c42bcaff9bba` |
| `hl_member_private_archives` | ADMINONLY | `ac611366-94f6-4768-adf1-c227a19baed4` | `8ed67591-2b94-4e21-9572-ba212e6bcd4e` |
| `hl_member_identity_claims` | ADMINONLY | `b4df843b-8563-4515-9f5a-ffa8ba7b1e30` | `f7f860ec-4936-4fdf-bb3c-6092e2548bd1` |
| `hl_member_certifications` | ADMINONLY | `3a8248a0-4808-4994-acce-4cfcc7407e27` | `e21f471d-63c2-4d51-84f8-689bec7659fb` |

随后`hlApi`状态仍Active，`GET /health`返回`code=0/status=ok`，健康RequestId`08c4cf65-4164-4024-bfa0-5eb6724d72b8`。没有读取或修改业务记录，未重新部署函数；因此规则配置回读已通过，但仍未将健康检查当作完整客户端拒绝、资料读取/保存和真机流程验收。

应用默认权限中，`registerUser`、`anonymousUser`、`administrator`有`app/*/allow`（RequestId`2a187a47-c8d9-4fb8-8da2-468c0e71adfc`）。因此不能声称应用已具备私有运行访问控制；后端须同时拒绝匿名、非授权及跨环境调用。

## 当前访问条件

用户已在Edge登录腾讯云，并提供扩展已安装、权限已开启的截图。但重新检测仍为`Browser 3: nodeRepl.fetch request failed`，无法读取标签或操作预览；问题在浏览器工具通信，不应重复要求腾讯云登录或扩大权限。官方MCP已有管理登录已完成套餐、应用创建、设计稿保存回读；编辑器渲染、导航实际点击及当前账号登录接口验收待浏览器连接恢复。

## 本次界面重设计与验证

用户反馈的文字重叠和空白按钮已在官方同版本本地渲染中复现：CALS 将旧无单位行高字符串 `1.35` 转换为约 `1.35px`；旧按钮文字和背景同为绿色。现将全部175处文本行高显式设为带单位值，使用当前合法按钮主题及样式。六页统一小程序的米白、陶土棕、深棕字体和卡片规范。

以官方 `lowcode-render@1.1.10` 和精确的 `gsd-h5-react@3.31.0` 进行本地实际浏览器验收，覆盖1440px桌面、375px和320px窄桌面、375px模拟H5。六页桌面导航、总览入口、H5抽屉导航正常；按钮标签清晰、无短行高文字、页面无横向溢出，表格保留内部滚动。24个业务按钮和筛选输入仍禁用。验证文件见 `weda-admin/validation-report.json` 与 `weda-admin/render-verification.json`。

本地预览隔离云身份和业务调用，H5为初始化UA模拟；它不能证明真实手机、云编辑器、登录授权和业务接口可用。云端保存回读的内容与本地完整一致，未发布应用。本次没有修改云函数、数据库权限或支付设置。

## 驾驶舱更新

2026-10-13后续更新：按用户要求将运营总览改为经营驾驶舱，用户选择“经营收款：实付、退款、净收款、套餐构成”。已在基线`6774865`上保存为历史`6774937`，完整JSON回读相等；保存RequestId `ddc80e25-71c5-4038-94ba-4b1ccc7a4d78`。新增会员、主理人和经营收款分析面板，其他五页、模板与应用配置保持完整。本地官方组件渲染通过，指标仍为空态，经营聚合接口未实现。详见 `weda-admin/cockpit-metrics.md` 与 `weda-admin/cockpit-verification.json`。

## 官方资料

- [后台管理系统开发指南](https://docs.cloudbase.net/lowcode/guide/management-system-dev)
- [云后台概述](https://docs.cloudbase.net/toolbox/intro)
- [当前资源点套餐与能力项](https://cloud.tencent.com/document/product/1301/133852)
- [数据库权限语义](https://docs.cloudbase.net/api-reference/manager/node/rule)
- [使用和管理API](https://cloud.tencent.com/document/product/1301/68456)
- [用户权限配置指南](https://docs.cloudbase.net/lowcode/guide/data-permission)
