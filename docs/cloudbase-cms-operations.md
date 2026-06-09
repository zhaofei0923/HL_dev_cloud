# CloudBase/CMS 后台运营说明

## 运营角色

- 开发者：可查看和维护全部集合、云函数、权限规则和系统字段。
- 运营人员：只管理红娘审核、会员资料、会员展示、沙龙审核、活动上下架和报名记录。
- 普通红娘：不进入 CloudBase/CMS，通过小程序红娘端完成会员经营、活动推送和互推。

## 推荐视图

### 红娘审核 `hl_matchmakers`

- 可编辑：`certificationStatus`、`certificationRemark`、`level`、`status`。
- 只读：`id`、`userId`、`matchmakerNo`、`totalPerformance`、`createdAt`、`updatedAt`。
- 运营动作：通过填 `certificationStatus = 2`；拒绝填 `certificationStatus = 1` 并补充 `certificationRemark`。

### 会员资料 `hl_profiles` + `hl_members`

- 可编辑：`realName`、`gender`、`age`、`height`、`city`、`nativePlace`、`education`、`occupation`、`incomeRange`、`maritalStatus`、`houseStatus`、`carStatus`、`selfIntro`、`partnerRequirement`、`photos`、`displayEnabled`、`memberType`、`serviceLevel`、`remark`、`status`。
- 只读：`id`、`userId`、`matchmakerId`、`displayUpdatedAt`、`createdAt`、`updatedAt`。
- 运营动作：补齐资料、调整会员类型和服务等级、协助关闭/开启展示。`displayEnabled = true` 后，会员才会进入公开会员浏览和红娘资源池。

### 会员添加红娘申请 `hl_member_matchmaker_requests`

- 可编辑：`status`、`reviewRemark`。
- 只读：`id`、`userId`、`matchmakerId`、`applySource`、`applyMessage`、`reviewedAt`、`reviewerId`、`createdAt`、`updatedAt`。
- 运营动作：日常审批应由红娘在小程序端处理；后台只用于排查异常状态。审批通过会同时写入 `hl_members`，因此不要只在 CMS 手工把 `status` 改成 `approved`。

### 沙龙活动 `hl_salon_events`

- 可编辑：`title`、`description`、`coverImage`、`location`、`eventDate`、`maxParticipants`、`price`、`status`、`reviewRemark`。
- 只读：`id`、`organizerId`、`currentParticipants`、`reviewedAt`、`createdAt`、`updatedAt`。
- 运营动作：红娘创建后默认为 `pending`；审核通过改为 `upcoming`；拒绝改为 `rejected` 并填写 `reviewRemark`。建议优先通过 `/admin/salons/:id/review` 云函数接口审核，确保状态字段一致。

### 报名记录 `hl_registrations`

- 可编辑：`status`、`checkedInAt`。
- 只读：`id`、`eventId`、`userId`、`createdAt`、`updatedAt`。
- 运营动作：查看活动报名名单，必要时标记取消或签到。

### 消息与互推 `hl_match_records` + `hl_messages`

- 可编辑：`hl_match_records.status`、`hl_messages.isRead`。
- 只读：双方用户、红娘、消息发送人、消息内容和创建时间。
- 运营动作：互推和活动推送必须通过小程序/云函数写入，避免只改记录而没有消息通知。

## 隐藏字段

运营视图应隐藏 `openid`、`_id`、`_openid`、`token`、`refreshToken`、`hl_counters` 集合和所有内部计数字段。上述字段只允许开发者排障时查看。

## 必须通过云函数或小程序处理的动作

- 用户登录、登录态刷新、手机号绑定。
- 会员添加红娘申请、红娘通过/拒绝申请。
- 红娘申请提交、重新提交和管理员认证审核。
- 会员展示开关保存。
- 会员互推、推荐消息写入。
- 沙龙创建、审核、报名、取消报名、活动推送会员。
- 任何会同时修改多个集合的操作。
