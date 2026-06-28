# CloudBase 后台数据库审批操作手册

本文档用于指导运营人员在 CloudBase 云后台/CMS 中处理小程序日常审批工作，包括红娘审批、沙龙审批、会员资料维护、报名查看和会员添加红娘申请排查。

## 1. 使用范围

后台地址：

```text
https://cloud1-d2gza7q9c8d69c721-1441337122.tcloudbaseapp.com/cloud-admin/index.html?region=ap-shanghai#/management/content-mgr/index
```

当前环境：

```text
cloud1-d2gza7q9c8d69c721
```

已配置的后台菜单：

| 分组 | 菜单 | 数据模型 |
| --- | --- | --- |
| 报名与排查 | 会员添加红娘申请排查 | hl_member_matchmaker_requests |
| 报名与排查 | 报名管理 | hl_registrations |
| 会员管理 | 会员服务管理 | hl_members |
| 会员管理 | 会员资料管理 | hl_profiles |
| 审批管理 | 沙龙审批 | hl_salon_events |
| 审批管理 | 红娘审批 | hl_matchmakers |

## 2. 审批总原则

1. 可以在后台数据库中处理的内容：红娘认证状态、沙龙审核状态、会员展示资料、服务等级、备注、报名签到等轻量维护。
2. 不要直接修改系统字段：`_id`、`_openid`、`openid`、`createdAt`、`updatedAt`、`token`、`refreshToken`。
3. 不要直接修改计数字段：例如 `hl_salon_events.currentParticipants`。报名和取消报名必须走小程序/云函数，否则人数会和报名表不一致。
4. 不要直接审批“会员添加红娘申请”。手动审批必须由红娘端小程序处理；微信分享注册链接自动注册必须由云函数处理，否则不会自动写入 `hl_members` 和 `hl_messages`。
5. 任何会同时影响多个集合的动作，都不要在数据库里手动改，要走小程序或云函数接口。

## 3. 红娘审批

入口：

```text
审批管理 -> 红娘审批
```

数据模型：

```text
hl_matchmakers
```

### 3.1 待审批数据如何识别

在列表中筛选：

| 字段 | 条件 | 含义 |
| --- | --- | --- |
| certificationStatus | 等于 0 | 待审核 |
| status | 等于 1 | 正常账号 |

状态含义：

| certificationStatus | 含义 | 小程序表现 |
| --- | --- | --- |
| 0 | 待审核 | 红娘端显示等待审核 |
| 1 | 已拒绝 | 红娘端显示拒绝原因，可重新提交 |
| 2 | 已通过 | 红娘可进入会员、资源、沙龙管理 |

### 3.2 审批通过

操作步骤：

1. 点击目标红娘记录右侧的“编辑”。
2. 将 `certificationStatus` 改为 `2`。
3. `certificationRemark` 可以填写为空，或填写“审核通过”。
4. 确认 `status` 为 `1`。
5. 如需设置红娘等级，调整 `level`。
6. 保存。

审批通过后，应让红娘重新进入小程序，确认可以打开：

- 红娘工作台
- 会员管理
- 资源池
- 沙龙管理

### 3.3 审批拒绝

操作步骤：

1. 点击目标红娘记录右侧的“编辑”。
2. 将 `certificationStatus` 改为 `1`。
3. 在 `certificationRemark` 填写拒绝原因。
4. 保存。

拒绝原因建议写清楚，例如：

```text
资料不完整，请补充真实姓名、服务介绍和联系方式后重新提交。
```

### 3.4 不要修改的字段

红娘审批时不要修改：

| 字段 | 原因 |
| --- | --- |
| id | 业务主键，改错会导致关联失败 |
| userId | 绑定小程序用户，改错会串号 |
| matchmakerNo | 红娘编号，不建议手工改 |
| inviteCode | 邀请码，改错会影响邀请关系 |
| inviteQrFileID | 邀请码图片文件 ID |
| totalPerformance | 业绩统计字段 |
| _id / _openid | 系统字段 |

## 4. 沙龙审批

入口：

```text
审批管理 -> 沙龙审批
```

数据模型：

```text
hl_salon_events
```

### 4.1 待审批数据如何识别

在列表中筛选：

| 字段 | 条件 | 含义 |
| --- | --- | --- |
| status | 等于 pending | 待审核沙龙 |

状态含义：

| status | 含义 | 小程序表现 |
| --- | --- | --- |
| pending | 待审核 | 用户端不可报名 |
| upcoming | 审核通过/报名中 | 用户端可见、可报名 |
| rejected | 已拒绝 | 用户端不可报名 |
| cancelled | 已取消 | 不再开放 |
| ended | 已结束 | 不再开放报名 |

### 4.2 审批通过

操作步骤：

1. 点击目标沙龙记录右侧的“编辑”。
2. 核对 `title`、`eventDate`、`location`、`maxParticipants`、`price`、`description`。
3. 将 `status` 改为 `upcoming`。
4. `reviewRemark` 可以留空，或填写“审核通过”。
5. 保存。

保存后，用用户端小程序检查：

- 沙龙列表是否能看到该活动。
- 沙龙详情是否能打开。
- 是否可以报名。

### 4.3 审批拒绝

操作步骤：

1. 点击目标沙龙记录右侧的“编辑”。
2. 将 `status` 改为 `rejected`。
3. 在 `reviewRemark` 填写拒绝原因。
4. 保存。

拒绝原因示例：

```text
活动时间、地点或人数信息不完整，请补充后重新提交。
```

### 4.4 红娘修改已通过沙龙后的处理

如果红娘修改了已通过的沙龙，系统会将活动重新变为：

```text
pending
```

运营人员需要重新审核，确认无误后再改为：

```text
upcoming
```

### 4.5 不要修改的字段

沙龙审批时不要修改：

| 字段 | 原因 |
| --- | --- |
| id | 活动业务主键 |
| organizerId | 活动创建人，改错会导致红娘看不到自己的活动 |
| currentParticipants | 当前报名人数，必须由报名/取消报名流程自动维护 |
| reviewedAt | 审核时间字段，优先由接口写入 |
| _id / _openid | 系统字段 |

## 5. 会员资料管理

入口：

```text
会员管理 -> 会员资料管理
```

数据模型：

```text
hl_profiles
```

常用维护字段：

| 字段 | 用途 |
| --- | --- |
| realName | 真实姓名 |
| gender | 性别 |
| age | 年龄 |
| height | 身高 |
| city | 城市 |
| nativePlace | 籍贯 |
| education | 学历 |
| occupation | 职业 |
| incomeRange | 收入范围 |
| maritalStatus | 婚姻状态 |
| houseStatus | 房产情况 |
| carStatus | 车辆情况 |
| selfIntro | 自我介绍 |
| partnerRequirement | 择偶要求 |
| photos | 生活照 |
| displayEnabled | 是否展示 |

`displayEnabled` 的含义：

| displayEnabled | 含义 |
| --- | --- |
| false | 不公开展示，仅内部服务使用 |
| true | 进入公开会员浏览和红娘资源池 |

操作建议：

1. 资料不完整时，先补齐关键字段。
2. 只有确认资料适合展示后，才把 `displayEnabled` 改为 `true`。
3. 不要公开手机号、openid、token 等敏感字段。

## 6. 会员服务管理

入口：

```text
会员管理 -> 会员服务管理
```

数据模型：

```text
hl_members
```

常用维护字段：

| 字段 | 用途 |
| --- | --- |
| memberType | 会员类型 |
| serviceLevel | 服务等级 |
| remark | 内部备注 |
| displayEnabled | 是否进入资源池 |
| status | 服务状态 |

操作边界：

1. 可以维护服务等级、内部备注、展示开关。
2. 不建议在后台手工新增会员关系。
3. 会员申请添加红娘、红娘审批会员申请，必须走小程序端流程。

## 7. 报名管理

入口：

```text
报名与排查 -> 报名管理
```

数据模型：

```text
hl_registrations
```

常用字段：

| 字段 | 用途 |
| --- | --- |
| id | 报名记录 ID |
| eventId | 沙龙活动 ID |
| userId | 报名用户 ID |
| status | 报名状态 |
| checkedInAt | 签到时间 |

状态含义：

| status | 含义 |
| --- | --- |
| registered | 已报名 |
| cancelled | 已取消 |

允许操作：

1. 查看报名名单。
2. 必要时维护 `checkedInAt`。
3. 异常情况下标记 `status`。

禁止操作：

1. 不要直接新增报名记录。
2. 不要直接删除报名记录。
3. 不要为了改报名人数而手动改 `currentParticipants`。

正确报名和取消报名流程：

```text
用户端小程序报名/取消报名 -> hlApi 云函数 -> 同步写 hl_registrations 和 hl_salon_events.currentParticipants
```

## 8. 会员添加红娘申请排查

入口：

```text
报名与排查 -> 会员添加红娘申请排查
```

数据模型：

```text
hl_member_matchmaker_requests
```

这个页面原则上只读，用于排查异常。

常用查看字段：

| 字段 | 用途 |
| --- | --- |
| id | 申请记录 ID |
| userId | 申请会员 |
| matchmakerId | 被申请红娘 |
| status | 申请状态 |
| applySource | 申请来源 |
| applyMessage | 申请备注 |
| reviewRemark | 审批备注 |
| reviewedAt | 审批时间 |
| reviewerId | 审批人 |

状态含义：

| status | 含义 |
| --- | --- |
| pending | 待红娘处理 |
| approved | 红娘已通过 |
| rejected | 红娘已拒绝 |
| cancelled | 用户已取消 |

重点注意：

不要在后台数据库里把 `status` 直接改成 `approved`。

原因是通过申请时，系统需要同时写入：

```text
hl_member_matchmaker_requests
hl_members
hl_messages
```

如果只在数据库里改 `status`，会员关系和消息记录不会自动生成，后续页面会出现数据不一致。

正确处理方式：

```text
微信分享注册链接自动注册 -> POST /member/matchmaker-invite/accept
```

该接口仅用于 `share`、`matchmakerShare`、`memberShare`、`salonShare`、`memberSalonShare` 等微信分享来源，会自动把申请记录置为 `approved`，并同步写入 `hl_members` 和 `hl_messages`。

```text
红娘端小程序 -> 会员申请 -> 通过/拒绝
```

## 9. 常见操作清单

### 9.1 红娘认证通过

```text
红娘审批 -> 筛选 certificationStatus = 0 -> 编辑 -> certificationStatus = 2 -> 保存
```

验证：

```text
红娘重新进入小程序 -> 可以打开红娘工作台和沙龙管理
```

### 9.2 红娘认证拒绝

```text
红娘审批 -> 编辑 -> certificationStatus = 1 -> certificationRemark 填写原因 -> 保存
```

验证：

```text
红娘端看到拒绝原因，并可以重新提交申请
```

### 9.3 沙龙审核通过

```text
沙龙审批 -> 筛选 status = pending -> 编辑 -> status = upcoming -> 保存
```

验证：

```text
用户端沙龙列表可见，详情页可报名
```

### 9.4 沙龙审核拒绝

```text
沙龙审批 -> 编辑 -> status = rejected -> reviewRemark 填写原因 -> 保存
```

验证：

```text
用户端不可报名，红娘端可看到被拒绝状态
```

### 9.5 开启会员展示

```text
会员资料管理 -> 编辑 -> displayEnabled = true -> 保存
```

验证：

```text
用户端会员浏览/红娘资源池可以看到该会员资料
```

### 9.6 查看沙龙报名

```text
报名管理 -> 按 eventId 筛选 -> 查看 registered 记录
```

需要取消报名时，优先让用户在小程序端取消，不要后台手动删记录。

## 10. 审批后验证

每次修改后，至少做一次对应验证：

| 审批动作 | 验证方式 |
| --- | --- |
| 红娘通过 | 红娘端能进入会员、资源、沙龙管理 |
| 红娘拒绝 | 红娘端能看到拒绝原因 |
| 沙龙通过 | 用户端活动列表可见，可报名 |
| 沙龙拒绝 | 用户端不可报名 |
| 开启会员展示 | 用户端会员浏览或资源池可见 |
| 报名/取消报名 | `hl_registrations` 与 `currentParticipants` 数量一致 |

## 11. 出错时如何处理

如果审批后小程序表现不对，按下面顺序排查：

1. 确认是否改了正确环境：`cloud1-d2gza7q9c8d69c721`。
2. 确认是否改了正确数据模型。
3. 确认状态值是否填写正确，例如红娘通过必须是数字 `2`，沙龙通过必须是文本 `upcoming`。
4. 点击后台页面“刷新”，确认数据是否已保存。
5. 重新打开小程序，避免使用旧缓存。
6. 如仍异常，查看云函数 `hlApi` 日志。

## 12. 高风险操作禁止清单

以下操作不要在后台数据库中执行：

| 禁止操作 | 风险 |
| --- | --- |
| 删除用户、红娘、会员、沙龙主记录 | 会造成关联数据丢失 |
| 手动修改 `_id`、`_openid`、`openid` | 会导致系统身份错乱 |
| 手动新增报名记录 | 不会同步报名人数 |
| 手动修改 `currentParticipants` | 会和报名表不一致 |
| 手动把会员添加红娘申请改成 `approved` | 不会写入会员关系和消息 |
| 修改 `hl_counters` | 可能造成业务 ID 重复 |
| 直接改 `userId`、`matchmakerId`、`organizerId` | 会造成数据串号 |

## 13. 推荐工作习惯

1. 每次审批前先使用筛选，只处理待审核记录。
2. 审批拒绝必须填写原因。
3. 只改本文档明确允许的字段。
4. 审批后立即用小程序验证。
5. 无法判断时，不要直接改数据库，先找开发人员确认。
