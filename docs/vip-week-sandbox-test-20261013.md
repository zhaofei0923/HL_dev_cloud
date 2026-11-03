# VIP周卡受限沙箱测试

用户于2026-10-13明确要求沙箱测试VIP周卡。商品固定为 `vip_week`、6160分（¥61.60）、7天VIP权益、购买数量1；人工牵线及其他VIP商品不在本次测试范围。

本轮安卓周卡沙箱支付与服务端会员履约验证已通过，受限测试窗口已关闭。用户直接反馈使用安卓手机和“赵飞”账号完成付款；微信平台只读查单、云端订单及独立VIP账本证据一致。正式收费开关仍关闭，环境未切现网。

## 当前状态

- 周卡测试支持的本地构建和完整检查984/984通过，无失败、跳过或取消；这是开窗前的代码验证记录，本轮付款后未重新执行全部权益测试。
- 云函数 `hlApi` 的周卡测试代码已部署，Active / Event / Nodejs16.13，代码部署更新时间 `2026-10-13 13:06:10`；当时重新下载的15个根目录文件与冻结部署源一致，健康检查返回 `code=0/status=ok`。
- 本次仅 `index.js`、`payment-test-policy.js` 相对上一六档版本变化，代码SHA256为 `5258a91fc6b39c043171214ca78f5235911303654ae388083c4ac300b847de8f`；完整配置、密钥、函数授权和9个保护集合安全规则保持不变。
- 用户明确回复安卓手机、昵称“赵飞”；云端按该昵称匹配唯一有效账号 `userId=1`，手机号与真实微信身份完整，未合并，无未处理付款订单或付款占位。
- 批次 `week_20261013_mv68bzxs` 原窗口从 `2026-10-13 13:19:55` 至 `14:04:55`（北京时间），上限45分钟；本次在北京 `13:49:42` 完成提前关窗回读。开窗请求1次、关窗请求1次，状态为 `closed_verified`，云配置关窗更新时间为 `2026-10-13 13:49:32`。
- `VPAY_ENV=1`、`PAYMENT_INTEGRATION_READY=false`、`MATCHMAKING_PAYMENT_READY=false`保持不变；开窗时只允许指定账号购买 `vip_week`，`PAYMENT_TEST_PUSH_ONLY=false`允许查单补偿。关窗仅将本批次 `PAYMENT_TEST_ENABLED` 改为false，其他环境变量及函数授权比对不变，历史订单和权益记录保留。
- 开窗后的云端会员目录曾返回 `code=0`，仅展示 `vip_week/6160分/7天/VIP`，`testMode=true`且可下单；这是窗口内的历史核验。当前已关窗，不再允许新测试付款尝试。
- 本批次已付款订单 `paid/fulfilled`、发货确认 `confirmed`，首次确认来源 `wechat_push`。微信平台只有1个已付款尝试，返回状态4（已发货）和 `SUCCESS`，6160分、交易及尝试绑定均一致。
- 独立VIP账本仅增加1个7天权益，原到期 `2026-10-13T12:38:34.756Z` 正确延长至 `2026-10-20T12:38:34.756Z`，即北京时间 **2026-10-20 20:38:34**。其他权益与原会员档案期限未变，付款占位已释放，验收前后订单和账本只读快照稳定。
- 北京 `13:56:06` 再次只读调用关窗后的云端会员API，返回 `code=0`、`isPremiumMember=true`、`membershipTier=vip`和上述到期日；当前六个业务套餐已恢复展示，两个正式收费开关仍关闭、`testEnabled=false`、沙箱保留且无待处理订单。概览返回11个权益权限标志为启用，但本轮没有逐项重测这11项功能。
- 官方微信开发者工具已生成会员页预览二维码，预览包977,505字节；本次未上传体验版或发布小程序。二维码见[手机预览](../.cloudbase/vip-week-sandbox-preview-20261013.png)。

## 测试边界

`PAYMENT_TEST_PLAN_CODE=vip_week`只允许固定周卡快照；必须同时满足非空有效测试批次、指定单一用户、沙箱环境、两个正式收费开关关闭和未来24小时内的截止时间。本次实际窗口上限45分钟，付款验证结束后已提前关闭。

同一批次只有一笔业务订单，重复点击使用原订单；支付尝试须先查单再决定是否重签。订单关闭、失败、付款完成或退款后不能在同一批次创建第二笔周卡。未确认的原订单及付款占位保留，不能通过切换商品或批次绕过。

新收银台同时核验指定账号、当前批次、订单文档、商品ID、金额、期限和沙箱环境。到期或关闭窗口后禁止新付款尝试；已签发尝试的可信迟到付款仍按原订单核验并履约。历史 `hl_payment_probe` 保留原1分、1天快照，不受当前周卡选择影响。

周卡成功履约写入账号独立VIP账本：有效VIP从原到期日延长7天，已过期或无VIP从服务端确认时间起算7天；永久资格保留。每笔订单只增加一个7天权益记录。未绑定主理人也可测试VIP，人工牵线不随本次测试开放。

## 手机操作与核验

使用安卓手机的微信开发或预览版；当前项目iOS付款入口保持关闭。[微信官方虚拟支付说明](https://developers.weixin.qq.com/miniprogram/dev/platform-capabilities/business-capabilities/virtual-payment.html)明确Apple支付不支持沙箱；[客户端API](https://developers.weixin.qq.com/miniprogram/dev/api/payment/wx.requestVirtualPayment.html)列明现网版本不能使用env=1。

手机类型、账号及开窗前无未处理订单已确认。用户使用安卓手机及“赵飞”账号完成付款，并在本轮直接反馈“已经完成支付测试”。设备操作证据限于用户直接反馈；本轮未取得付款截图或操作录像，也没有代理代操作手机付款。最终通过结论同时依据微信平台只读查单和云端履约记录，不依据客户端成功提示单独判断。

关窗后在北京 `13:51:39` 完成独立只读验收：6160分、7天、沙箱环境、唯一已付款尝试和平台交易绑定，服务端 `paid/fulfilled`、发货确认、VIP账本唯一7天记录、到期顺延和付款占位释放均通过。验收助手只读查询平台和数据库，不调用收银台、履约、发货确认、退款或商户关单；未改写任何付款、账本或证据记录。

本轮实际安卓沙箱支付及会员履约已通过，完整正式收款、iOS付款、退款链路和11项VIP权益整体并未在本轮重新验收。正式收费开关仍关闭，未切现网、上传体验版或发布小程序；本轮沙箱通过不扩大为这些范围的通过结论。

## 本地与云端证据

- 本地检查：`.cloudbase/vip-week-sandbox-check-20261013.log`。
- 代码部署目录：`.cloudbase/vip-week-sandbox-deploy-20261013/`，分别保留检查、回退包、冻结源和部署回读结果。
- 当前配置只读核验：`.cloudbase/vip-week-sandbox-preflight-20261013.json`。
- 用户选择和唯一账号匹配：`.cloudbase/vip-week-sandbox-selected-account-20261013.json`。
- 开窗意图与回读：`.cloudbase/vip-week-sandbox-20261013/week_20261013_mv68bzxs_user_1/intent.json`及`state.json`。
- 实际云端目录：`.cloudbase/vip-week-sandbox-live-overview-20261013.json`。
- 开窗、查单验收与关闭助手：`.cloudbase/vip-week-sandbox-window-20261013.mjs`；12项离线检查通过。助手不创建付款订单，不调用收银台、履约、发货、退款或商户关单；付款由用户手机操作。
- 当前六档套餐此前已部署的证据见[六档部署记录](matchmaking-two-plans-cloud-deployment-20261013.md)；本次只补受限周卡测试，不调整业务商品价格、期限和权益。

最终付款与关窗记录保留原文件、不覆盖：

- [关窗后当前会员概览](../.cloudbase/vip-week-sandbox-final-overview-20261013.json)：实际会员API确认VIP到期、恢复六档目录及关闭测试与正式收费入口；请求未发起付款、未改动配置或数据库。
- [最终只读付款与权益验收](../.cloudbase/vip-week-sandbox-20261013/week_20261013_mv68bzxs_user_1/verification-1791870699514.json)：`success=true`、`serverAndPlatformPaymentVerified=true`，只读验收时间 `2026-10-13T05:51:39.513Z`；公开文档不展示openid、手机号、密钥或完整平台交易ID。
- [最新证据索引](../.cloudbase/vip-week-sandbox-20261013/week_20261013_mv68bzxs_user_1/verification.latest.json)：指向上述验收文件并保留其SHA256。
- [关窗状态及配置回读](../.cloudbase/vip-week-sandbox-20261013/week_20261013_mv68bzxs_user_1/state.json)：`closed_verified`，开、关各1次，其他环境变量保持不变；关窗回读时间 `2026-10-13T05:49:42.429Z`。
