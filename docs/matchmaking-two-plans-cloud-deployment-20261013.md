# 当前六档VIP与专属红娘牵线云端部署记录

2026-10-13用户提供六道具“已发布”截图并要求修改云函数、确认云端部署后，本次仅更新 `hlApi` 业务代码，使云端目录与四档VIP及两档专属红娘牵线商品一致。云端部署、代码下载比对、健康检查及11项云端专项全部通过，测试数据已清理并复查为零；正式收费、现网切换和小程序发布分别保留既有状态。

## 部署事实与证据

| 项目 | 已确认结果 |
| --- | --- |
| 环境 | `cloud1-d2gza7q9c8d69c721` |
| 地域 | `ap-shanghai` |
| 云函数 | `hlApi` |
| 类型 / 运行时 / 状态 | Event / Nodejs16.13 / Active |
| 云端返回更新时间 | `2026-10-13 12:39:25` |
| 更新请求 | 1次代码更新；未请求配置或权限变更 |
| 云端代码SHA256 | `97ea49448dfccc0e725833bd58e2d7cd9ef2c218f52af07ac3daeeb9ab9598b8` |
| 云下载比对 | 15个根目录文件与冻结部署源一致，本地源与冻结源一致 |
| 相对2026-10-12基线变化 | 仅 `index.js`、`vip-membership-service.js`；其余13文件一致 |
| 健康检查 | 返回 `code=0`、`status=ok` |

部署前检查为 `.cloudbase/matchmaking-two-plans-deploy-20261013/inspection.json`，部署后核验为同目录 `verification.json`。源文件审核及本地测试记录为 `.cloudbase/matchmaking-two-plans-source-audit-20261013.json` 和 `.cloudbase/matchmaking-two-plans-source-audit-tests-20261013.log`。

2026-10-12部署基线及其报告、检查和状态哈希保留不改写；部署前云端代码SHA256为 `a11708027721952734cbd4679d8a943941c5a8648da93c90a9513779d3f5b632`，与另存回滚压缩包自身的文件哈希分别记录。历史人工牵线虚拟支付部署见[2026-10-12记录](matchmaking-virtual-cloud-deployment-20261012.md)。

## 当前六个商品

| 道具ID | 名称 | 总价（元） | 订单金额（分） | 期限 | 牵线次数 |
| --- | --- | ---: | ---: | ---: | ---: |
| `vip_week` | VIP周卡 | 61.60 | 6160 | 7天 | — |
| `vip_month` | VIP月卡 | 198.00 | 19800 | 30天 | — |
| `vip_quarter` | VIP季卡 | 398.00 | 39800 | 90天 | — |
| `vip_year` | VIP年卡 | 698.00 | 69800 | 365天 | — |
| `matchmaking_single` | 人工牵线单次 | 2980.00 | 298000 | 30天 | 1次 |
| `matchmaking_month_3` | 人工牵线1个月 | 6980.00 | 698000 | 30天 | 3次 |

人工两档使用虚拟支付，不赠送VIP，付款确认后30天有效。正式建联需双方同意，服务端同一事务建联并扣一次。旧 `matchmaking_month`、`matchmaking_quarter`、`matchmaking_halfyear` 停止新购，即使数据库残留active或目录门禁关闭也不会恢复出售；原订单按原通道、原金额、原期限和次数查单、处理可信迟到履约及退款。

用户本次提供的后台截图显示六个道具均为“已发布”，ID、名称及元价格与上表匹配。截图文件为 `codex-clipboard-635617f0-e66e-4a55-aee3-c5560fe69395.png`；此次未调用微信平台道具API独立查询，也未代用户发布道具。后台发布状态不能代替权限和真实付款证明。短备注与小程序完整规则见[上架指引](wechat-virtual-goods-listing-guide-20261013.md)。

## 配置和权限保留

- 完整函数配置、密钥及函数授权与部署前一致；未变更支付网关或旧HTTP支付桥接。
- `VIP_MEMBERSHIP_CATALOG_READY=true`保持目录展示；`PAYMENT_INTEGRATION_READY=false`和`MATCHMAKING_PAYMENT_READY=false`保持两类正式收费关闭。
- `VPAY_ENV=1`保持沙箱，未切现网；未发布小程序前端。
- 9个权益及隐私集合的安全规则部署前后一致，客户端直接CRUD全部拒绝：`hl_vip_entitlements`、`hl_matchmaking_packages`、`hl_matchmaking_requests`、`hl_matchmaking_readiness`、`hl_member_visits`、`hl_member_privacy`、`hl_wechat_exchanges`、`hl_online_subscriptions`、`hl_member_presence`。

## 验证结果

部署前独立重跑完整检查968/968通过，零失败、跳过或取消。生成物核验覆盖59份JavaScript、29份样式、3份工作区输出和62处事件绑定；媒体20文件、191.12KiB且低于200KiB预算；TypeScript、全部12份云函数根目录JavaScript语法及7个CMS视图通过。检查期间部署源哈希未变。

云端专项最终记录为 `.cloudbase/matchmaking-two-plans-cloud-smoke-20261013.json`，`success=true`、`passed=11`、`failed=0`。实际验证范围为：

- `hlApi`始终Active且版本固定为本次更新时间；目录为六个准确套餐，无旧三个人工商品。
- VIP和人工牵线均返回虚拟支付契约，但两个收费开关仍为false、`VPAY_ENV=1`；未绑定主理人的普通用户可读取目录。
- 六个当前商品及三个旧商品的新单请求均被关闭门禁拒绝，未创建订单；未认证请求不能调用虚拟支付收银台或查询。
- 三个历史格式的未付款隔离测试订单保留原金额、期限及次数的内部查询契约，续付收银台返回40905，普通支付错误通道查询返回40907。
- 三个测试订单保持未付款原样，未发放期限或牵线次数、未新增付款占位；未改动现有用户。

专项只在14个预先确认为空的精确测试范围内创建5条合成记录：1个测试用户、1份空VIP权益记录和3个未付款测试订单；未伪造已付款订单或已购权益，未改动任何现有用户。结束后 `cleanup.attempted=true`、`cleanup.verified=true`，14个范围全部回读为零，失败与残留集合均为空，`finalFixtureRecords=0`。`realPaymentInvoked`、`providerXpayInvoked`、`paymentConfirmationInvoked`、`refundOrCloseInvoked`均为false。

目录门禁关闭时仍不可恢复旧商品新购、历史可信迟到履约和退款的证据来自本地回归，本次云专项没有打开门禁或调用平台支付服务去模拟这些结果。

## 验收范围与下一步

此次云端代码更新与健康检查成功不等于正式收费已启用。未发起真实付款、支付确认、退款或关闭商户订单，未验证微信真机支付，未独立查询平台道具发布API，未重新部署或测试旧HTTP桥接。本地旧订单迟到履约、退款和门禁关闭后的停售逻辑回归，不冒充本次云端实付验收。

后续正式收费需按用户授权另行核验现网支付配置和权限、安排受控真机付款，并确认服务端查单或可信回调、幂等发放及售后记录。当前六档的修改规则和素材见[两档调整记录](matchmaking-two-plans-20261013.md)与[会员体系说明](vip-membership-system.md)。
