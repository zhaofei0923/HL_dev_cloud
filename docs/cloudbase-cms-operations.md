# CloudBase/CMS 后台运营说明

本项目第一版后台采用 CloudBase 云后台 CMS，统一业务动作仍由云函数 `hlApi` 承接。CMS 负责给运营人员提供可控的数据视图；凡是会联动多个集合、生成消息、刷新人数或影响登录态的动作，都必须走小程序端或云函数接口。

## 基础配置

- 环境：`cloud1-d2gza7q9c8d69c721`
- 云函数：`hlApi`
- 版本化视图清单：`docs/cloudbase-cms-views.json`
- CloudBase 角色：`运营人员` / `hl_operator` / `2064514415116599298`
- 管理接口登录：`POST /admin/login`，管理员码来自云函数环境变量 `ADMIN_CODE`。当前兼容逻辑未配置时会使用 `HLADMIN`，生产环境必须显式配置高强度管理员码。

产品和运营界面统一使用“主理人”称呼；CMS 集合、字段和接口仍保留 `matchmaker` 技术标识，以兼容已发布小程序和存量数据。运营人员不得因显示称呼变化而重命名集合或字段。

建议在 CloudBase 控制台按 `docs/cloudbase-cms-views.json` 创建 CMS 视图和角色权限。该 JSON 是项目内的运营配置源，用来记录每个视图的集合、字段、隐藏字段、推荐动作和禁止手工处理的边界。

已通过 CLI 完成的配置：

- 已创建自定义角色 `运营人员`，标识 `hl_operator`。当前环境只有 `administrator` 用户，因此该角色暂未分配成员。
- 已将 CloudBase MCP 加入 Codex 全局配置；重启 Codex 后可加载 `cloudbase` MCP。
- 已重新部署 `hlApi`，并通过 `/health` 云函数调用验证。

## 运营角色

- 开发者：可查看和维护全部集合、云函数、权限规则和系统字段。
- 运营人员：只管理主理人审核、会员资料、会员展示、沙龙审核、活动上下架和报名记录。
- 普通主理人：不进入 CloudBase CMS，通过小程序主理人端完成会员经营、活动推送和互推。

## 推荐视图

### 主理人审批 `hl_matchmakers`

- 可编辑：`certificationStatus`、`certificationRemark`、`level`、`status`。
- 只读：`id`、`userId`、`matchmakerNo`、`inviteCode`、`inviteCodeStatus`、`totalPerformance`、`createdAt`、`updatedAt`。
- 状态：`0` 为待审核，`1` 为已拒绝，`2` 为已通过。
- 推荐动作：优先调用 `PUT /admin/matchmakers/:id/certification`。
- 运营动作：通过填 `certificationStatus = 2`；拒绝填 `certificationStatus = 1` 并补充 `certificationRemark`。

### 沙龙审批 `hl_salon_events`

- 可编辑：`title`、`description`、`coverImage`、`location`、`eventDate`、`maxParticipants`、`price`、`status`、`reviewRemark`。
- 只读：`id`、`organizerId`、`currentParticipants`、`reviewedAt`、`createdAt`、`updatedAt`。
- 状态：`pending` 为待审核，`upcoming` 为报名中，`rejected` 为未通过，`cancelled` 为已取消，`ended` 为已结束。
- 推荐动作：优先调用 `POST /admin/salons/:id/review`，通过时传 `status = upcoming`，拒绝时传 `status = rejected` 并填写 `remark`。
- 运营动作：主理人创建后默认为 `pending`；审核通过改为 `upcoming`；拒绝改为 `rejected` 并填写 `reviewRemark`。

### 会员资料管理 `hl_profiles` + `hl_members`

高敏会员档案存放在 `hl_member_private_archives`，包括验资索引、资产情况、内部生活照、风险备注和合规确认。该集合不得加入普通运营 CMS 视图，也不得从会员资源池或普通会员接口返回；主理人只能通过小程序内所属会员详情接口查看。

学历及金融资产的正式核验凭据和审核历史存放在 `hl_member_certifications`，只通过管理员核验接口维护，不配置普通运营 CMS 视图。`hl_profiles.showcaseCertification` 只保存服务端受控的核验摘要，含用于分类排序的内部金融资产档位；不得在 CMS 手工编辑。`hl_profiles` 必须禁止小程序端直接读写，客户端统一通过 `hlApi` 获取经过投影的资料。

- `hl_profiles` 可编辑：`realName`、`gender`、`age`、`height`、`city`、`nativePlace`、`education`、`occupation`、`incomeRange`、`maritalStatus`、`houseStatus`、`carStatus`、`selfIntro`、`partnerRequirement`、`photos`、`displayEnabled`。
- `hl_members` 可编辑：`memberType`、`serviceLevel`、`remark`、`status`。
- 只读：`id`、`userId`、`matchmakerId`、`displayUpdatedAt`、`createdAt`、`updatedAt`。
- 运营动作：补齐资料、调整会员类型和服务等级、协助关闭/开启展示。公开展示只看 `hl_profiles.displayEnabled`；`displayEnabled = true` 后，会员才会进入公开会员浏览和主理人资源池。
- 注意：新增会员关系、主理人通过会员申请、微信注册链接自动注册、会员互推应走小程序或云函数，不建议在 CMS 手工新增联动记录。
- 本人授权：`assetCategoryConsent` 和 `assetRangeDisclosure` 仅由会员本人通过 `hlApi` 保存，CMS 和主理人不得代为同意资产分类或公开区间。公开接口默认只显示“资产已认证”，只有本人同意公开时才返回已核验区间。

### 会员套餐管理 `hl_membership_plans`

- 可编辑：`title`、`description`、`badge`、`amountFen`、`durationDays`、`active`、`sortOrder`。
- 只读：`id`、`planCode`、`createdAt`、`updatedAt`。
- 金额：`amountFen` 以分为单位；有效期：`durationDays` 以天为单位。
- 推荐动作：调用 `PUT /admin/membership-plans/:planCode` 保存套餐。新套餐默认保持未启用，核对金额和期限后再设置 `active = true`。
- 支付订单会固化下单时的套餐名称、金额和期限。之后修改套餐不影响既有订单。

### 报名管理 `hl_registrations`

- 可编辑：`status`、`checkedInAt`。
- 只读：`id`、`eventId`、`userId`、`createdAt`、`updatedAt`。
- 运营动作：查看活动报名名单，必要时标记签到或异常取消。
- 注意：报名和取消报名必须走云函数，确保 `hl_salon_events.currentParticipants` 同步。

### 会员添加主理人申请排查 `hl_member_matchmaker_requests`

- 默认只读：`id`、`userId`、`matchmakerId`、`status`、`applySource`、`applyMessage`、`reviewRemark`、`reviewedAt`、`reviewerId`、`createdAt`、`updatedAt`。
- 运营动作：日常审批应由主理人在小程序端处理；后台只用于排查异常状态。
- 微信分享：`matchmakerShare`、`memberShare`、`salonShare`、`memberSalonShare` 来源会通过 `/member/matchmaker-invite/accept` 自动写入 `approved`、`hl_members` 和 `hl_messages`。
- 禁止动作：不要在 CMS 手工把 `status` 改成 `approved`。审批通过或分享自动注册都会同时写入 `hl_members` 和 `hl_messages`，必须通过云函数完成。

## 隐藏字段和保护集合

运营视图应隐藏 `openid`、`_id`、`_openid`、`token`、`refreshToken`；会员资料视图还应隐藏 `showcaseCertification`、`assetCategoryConsent`、`assetRangeDisclosure`。`hl_counters`、`hl_payment_orders`、`hl_member_private_archives`、`hl_member_identity_claims` 和 `hl_member_certifications` 是受保护集合，不允许运营人员手工新增、修改或删除。支付订单只通过 `/admin/payment-orders` 查询，状态只允许经已验签的支付回调更新；认领邀请和身份合并只允许通过小程序与 `hlApi` 完成。学历及金融资产核验只通过 `/admin/member-certifications` 管理，不得把审核凭据复制到公开资料或资源池。

部署时必须在云数据库权限规则中禁止小程序端直接读写 `hl_profiles`、`hl_member_private_archives`、`hl_member_identity_claims` 和 `hl_member_certifications`；CMS 的字段隐藏配置不能替代数据库权限规则。本清单只记录应配置的边界，不代表云端已经完成配置。

## 必须通过云函数或小程序处理的动作

- 用户登录、登录态刷新、微信手机号动态 code 换号。
- 主理人生成手工会员认领邀请、会员核验手机号及微信身份合并。
- 会员支付下单、支付结果确认和会员有效期顺延。
- 主理人申请提交、重新提交和管理员认证审核。
- 会员添加主理人申请、主理人通过/拒绝申请。
- 会员展示开关保存。
- 学历及金融资产核验、撤销核验，以及会员本人保存资产分类同意和区间公开选项。
- 会员互推、推荐消息写入。
- 沙龙创建、审核、报名、取消报名、活动推送会员。
- 任何会同时修改多个集合的操作。

## 验证清单

- 运行 `npm run check`，确认 TypeScript、云函数语法和 CMS 工作流约定都通过。
- 小程序端提交主理人申请后，检查 `hl_matchmakers.certificationStatus = 0`。
- 后台通过主理人认证后，确认主理人端可进入会员、资源、沙龙管理页面。
- 主理人创建沙龙后，确认新活动为 `pending`，用户端不可报名。
- 后台通过沙龙审核后，确认用户端活动列表可见且可报名。
- 用户报名和取消报名后，检查 `hl_registrations` 与 `hl_salon_events.currentParticipants` 一致。
- 会员申请添加主理人时，确认只有主理人端审批会同步写入 `hl_members` 和 `hl_messages`。
- 配置会员套餐时，确认 `amountFen` 使用分、`durationDays` 使用天；支付订单金额与套餐服务端金额一致。
- 重复发送同一笔已验签支付回调时，确认会员有效期只顺延一次。
