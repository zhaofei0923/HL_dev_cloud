# 经营驾驶舱指标口径

本稿对应会员分析、主理人分析和经营收款分析。收款展示实付、退款、净收款和套餐构成，不做主理人收入归因，也不将净收款称为会计收入。只读统计实现位于 `cloudfunctions/hlAdminCockpit`，页面通过固定云函数 `hlAdminCockpit` 调用；未知显示 `—`，已完成聚合的真实零值显示 `0`。部署及实际验收状态单独记录于 `cockpit-integration-verification.json`，不能由代码存在推断上线通过。

## 时间与统一规则

- 默认“近 30 天”采用北京时间自然日：今天及此前 29 天，起点为首日 00:00，终点为本次统计截至时间。服务器按 `Asia/Shanghai` 划分日期；存储的 ISO 时间先转换，不能直接截取 UTC 日期。
- 会员档案数、认证主理人和会员分类是截至统计时点的存量；新增、收款和退款是所选期间的发生量。所有图表共用统计截至时间。
- 人数按 canonical `userId` 去重，仅纳入 `hl_users.status=1` 且没有 `mergedIntoUserId` 的有效账号。认领合并保留原档案身份，不能将被合并账号再计一次；`currentRole` 是界面角色选择，不能作为会员／主理人的互斥分类。
- 测试、演示来源必须排除；无法可靠识别的来源或冲突记录单列数据缺口，不能静默归入正式统计。真实零值仅在聚合已完成且确实无符合条件记录时显示。

## 六项核心指标

| 指标 | 数据与计算口径 |
| --- | --- |
| 会员档案数 | 有效 `hl_members.status=1` 与 `hl_profiles` 已建档账号合并，关联有效账号后按 `userId` 去重。包含未公开的档案；纯注册、尚未建档的账号不等于会员档案。 |
| 新增会员 | 同一 canonical 会员的首次建档时间落在所选期间。取可核实的最早档案 `createdAt`，不使用 `updatedAt`；新增归属、认领 `claimedAt` 和账号合并不重复增加会员。缺失首次时间的档案不强行分配日期。 |
| 认证主理人 | 有效 `hl_matchmakers.status=1`，对应账号有效，且 `certificationStatus=2`；按主理人身份去重。 |
| 实付 | 期间内已核验的正式收款交易之和，按 `paidAt` 归期；退款订单的原实付仍保留。具体证据、排除和去重规则见下文。 |
| 退款 | 期间内已核验全额退款之和，使用 `refundAmountFen`，暂按本地处理时间 `refundedAt` 归期。 |
| 净收款 | 同一期间实付减退款。退款可以来自此前期间的订单，因此期间净收款可以为负；以分累计后统一转元。 |

## 会员与主理人分析

**会员新增／累计趋势**：现有记录可按首次建档日期生成“当前有效档案的新增分布／累计建档数”。应明确标注“按当前有效档案回算”，不能将它呈现为历史每天的真实在册人数。历史停用、删除、重新启用和归属变化缺少完整事件或快照，当前状态无法准确回溯历史存量、流失与留存。

**会员分类**：有效 VIP／普通会员以 `vipMembership.getEntitlement` 的当前有效权益为准，包含期限、退款后 grants 和历史 lifetime 规则；二者在会员档案基数内互斥。实名使用身份认证的 `verified` 结果，公开展示使用 `hl_profiles.displayEnabled`；这两项是可重叠的属性，不能与 VIP／普通一起组成四分饼图。`hl_users.isVerified`、`hl_members.memberType=paid` 和登记表 `packageType` 均不能代替实名认证或支付证据。五类认证的审核状态和当前有效状态不同，续期待审可能仍有有效旧认证；资产认证须重算到期时间。

**主理人分析**：

- 通过／待审分别使用 `certificationStatus=2/0`。拒绝状态 `1` 仍存在，两项合计不能标为全部主理人。
- 近 30 天使用人数：关联 `hl_member_presence.lastSeenAt`，统计期间使用过小程序的有效主理人。该记录由前台更新，只保留最近一次时间；不能据此生成历史每日活跃曲线、使用次数或留存，也不能称为业务服务活跃。
- 所在地：关联主理人账号的 `hl_profiles.city/province`，缺失显示“未填写”。这是个人所在地，当前没有明确的服务城市字段；不能从其会员城市或活动地址推断。
- 名下会员：按当前 `hl_members.matchmakerId` 聚合有效、去重的会员。新增归属暂指本期新建归属记录，按其 `createdAt` 归期，名称不得写成新增会员；重新启用旧记录没有独立发生时间，仅靠当前归属记录不能完整统计归属变化或复原历史分布。

## 正式收款、退款与套餐构成

- 收款订单需 `status` 为 `paid` 或 `refunded`，具有有效 `transactionId`、`paidAt` 和正安全整数 `amountFen`。虚拟支付需 `virtualPaymentEnv=0`，且 `confirmationSource` 为 `wechat_push` 或 `virtual_query`；来源为 `internal` 或证据缺失的历史记录先列待核验，不能直接纳入已核验收款。已确认付款但 `fulfillmentStatus=requires_review` 的交易仍是收款事实，另列履约异常。
- 排除沙箱环境、`hl_payment_probe`、支付测试批次标记 `paymentTestPlanCode/paymentTestRunId`、`payment_probe_user_*` 文档及 `pending/confirming/closed/failed` 记录。`vip_week` 同时是正常套餐，不能仅按套餐代码整体排除。支付尝试环境与订单环境不一致时列为冲突。
- 交易去重键采用支付通道、订单商户、AppID、环境和 `transactionId`。原订单付款只计一次；`duplicateVirtualPayments[]` 中不同的已核验正式交易属于额外收款，按其 `amountFen/paidTime` 纳入并去重，不能只汇总每个业务订单一次金额。身份、金额或交易归属冲突须单列复核。
- 已核验退款需 `status=refunded`、有效 `refundId/refundAmountFen/refundedAt`，退款金额等于原付款；虚拟退款需 `refundSource=virtual_order_query`。按原交易及退款标识去重。当前仅确认全额退款；`refundedAt` 是本地处理时间，不是微信实际退款完成时间，尚不支持精确的退款发生日、部分／多次退款和重复付款售后结案统计。
- 套餐构成使用下单快照 `planCode/planTitle/productType/amountFen/durationDays/serviceCount`，包含真实发生的历史套餐，不用当前价格回算。金额图按核验收款交易统计；若展示订单数，按业务订单去重，并与交易笔数明确区分。退款沿用原订单套餐归类。
- 当前没有会计收入确认、递延分摊、手续费及结算到账台账，净收款仅表示已核验收款减已核验退款，不代表银行到账、利润或会计收入。

## 实现边界与剩余数据缺口

独立服务端接口已实现全部投影字段的稳定游标分页、身份去重、来源排除、时间划分和权益投影，每集合最多 50,000 条，超限或读取失败时整体报错，不返回不完整总数。现有 `/admin/dashboard` 的 `memberCount` 仍为有效归属行数，本次没有替换该业务接口。前端分页订单列表裁剪了测试标记和支付尝试，不能拿它汇总正式收款。

已排除可明确识别的 `isDemo/isTest`、测试来源、演示专用 OpenID 前缀与精确演示备注。历史演示路径缺少统一稳定来源标识，仍提示 `demoDetectionIncomplete`；不能按姓名猜测，也不能整体排除真实的主理人手工建档会员。补齐历史来源之前，人数存在这一数据质量限制。

函数每次使用当前平台注入的 `TCB_UUID` 查验内部账号、ACTIVE 状态及 `administrator` 角色；不使用前端传入的 UID/角色，不沿用进程缓存身份。返回仅含聚合及脱敏排名，不返回原始账号、订单或认证材料。函数没有写库、退款、履约、支付或调价分支。撤权、禁用与匿名请求均须拒绝。

默认页面展示近 30 天，服务端支持 7/30/90 天；当前页面未开放周期切换控件。统计为一次读取窗口，不具备跨集合事务快照；会员趋势为当前有效档案回算。退款只支持已核验全额退款，按本地处理时间归期。云端真实管理员身份调用与发布验收仍需分别记录，不得用本地虚构样例代替。

代码依据：

- [混合档案来源与归属统计](D:/HL_dev_cloud/cloudfunctions/hlApi/index.js:1089)、[认领合并](D:/HL_dev_cloud/cloudfunctions/hlApi/index.js:3104)、[现有后台统计](D:/HL_dev_cloud/cloudfunctions/hlApi/index.js:6572)、[演示会员路径](D:/HL_dev_cloud/cloudfunctions/hlApi/index.js:6675)。
- [有效 VIP 权益](D:/HL_dev_cloud/cloudfunctions/hlApi/vip-membership-service.js:200)、[最近使用时间](D:/HL_dev_cloud/cloudfunctions/hlApi/vip-membership-service.js:773)、[认证有效规则](D:/HL_dev_cloud/cloudfunctions/hlApi/showcase-policy.js:75)。
- [订单快照](D:/HL_dev_cloud/cloudfunctions/hlApi/membership-payment-policy.js:118)、[确认收款](D:/HL_dev_cloud/cloudfunctions/hlApi/index.js:4322)、[全额退款](D:/HL_dev_cloud/cloudfunctions/hlApi/index.js:4415)、[重复付款](D:/HL_dev_cloud/cloudfunctions/hlApi/index.js:3620)、[测试识别](D:/HL_dev_cloud/cloudfunctions/hlApi/index.js:3796)。
