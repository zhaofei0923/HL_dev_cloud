# 会员与人工牵线虚拟支付云端部署记录

> 本文记录2026-10-12七档版本的真实部署和测试结果。2026-10-13已调整人工牵线为两档；当前商品资料见[六档上架指引](wechat-virtual-goods-listing-guide-20261013.md)。不将本报告的七档验收改写为新六档验收。

2026-10-12按用户授权更新现有云环境的函数代码。会员与在线人工牵线新购买统一使用虚拟支付，历史JSAPI订单保留原通道查单、迟到付款及退款处理，禁止重新打开旧收银台。

## 部署与回读

环境：`cloud1-d2gza7q9c8d69c721`，地域：`ap-shanghai`，小程序：`wx7e5c0f4d07d2f0f8`。

| 云函数 | 状态 | 类型 / 运行时 | 更新时间（北京时间） | 实际代码更新 |
| --- | --- | --- | --- | --- |
| `hlApi` | Active | Event / Nodejs16.13 | 2026-10-12 12:27:55 | `index.js`、`membership-payment-policy.js` |
| `hl-wechat-pay-o6axgghd-demo-scfweb` | Active | HTTP / Nodejs18.15 | 2026-10-12 12:31:50 | `services/hl-membership-bridge.js` |

部署使用官方CloudBase MCP，先只读核验原云代码、完整配置和权限，再冻结待部署源码并保存各自回退代码包。两次操作均仅请求更新代码，没有请求修改运行时、环境变量、权限、网关或数据库安全规则。

主云函数下载回读的15个根目录源文件与冻结的本地源文件全部一致，健康接口返回 `code=0/status=ok`。HTTP桥接下载回读的4914个代码及依赖文件一致，16个Windows平台生成工具文件按原部署验证规则排除；其完整配置和权限保持不变。本轮未调用HTTP桥接支付、退款或真实回调进行端到端验证。

代码包SHA-256：

- `hlApi`：`a11708027721952734cbd4679d8a943941c5a8648da93c90a9513779d3f5b632`
- HTTP桥接：`6a73a69ad7173f0d73b93498d3f03e9ad6d526adcfea30cf4187d021e9c04f46`

## 收费及安全状态

北京时间12:34:43再次只读回读确认：

- `VIP_MEMBERSHIP_CATALOG_READY=true`，展示4个VIP与3个人工牵线套餐。
- `PAYMENT_INTEGRATION_READY=false`、`MATCHMAKING_PAYMENT_READY=false`，两类新收费均关闭。
- `VPAY_ENV=1`，仍为沙箱；OfferID为 `1450674507`，没有切换现网。
- 没有有效付款测试窗口，没有启用正式收款。
- 九个新增会员保护集合的客户端CRUD规则保持拒绝，原授权策略、密钥和其他完整配置保持不变。

## 验证结果

部署前的小程序构建及完整检查965/965通过；部署后比对受测源码哈希仍一致，无需重复执行未变更代码的完整检查。

云端专项检查12/12通过，覆盖当前部署版本、七档准确金额/期限/次数、两类虚拟支付配置、七档收费关闭时不创建订单、未登录虚拟接口拒绝、虚拟与历史JSAPI契约隔离、缺通道字段历史单禁止重新付款。种植的三份测试订单始终为未付款且没有发放VIP、牵线余额或付款占位。二十个测试数据范围均已精确清理，前后测试记录数为0，没有修改已有用户。

实际微信开发者工具模拟器只读确认人工牵线页加载正常，两类商品 `provider=virtual`、`available=false`；七档金额、天数及2/8/16次正确。官方前端预览包编译成功，体积975911字节，生成了新的首页二维码，未上传体验版或发布正式小程序。

本轮没有真实付款、xpay平台查单、支付确认、退款或平台道具发布。云端拒绝与契约测试通过不能代替沙箱及现网付款闭环、真机或三档高额商品审批。

## 证据与后续操作

- 主云函数部署回读：`.cloudbase/matchmaking-virtual-deploy-20261012/verification.json`
- HTTP桥接部署回读：`.cloudbase/matchmaking-virtual-http-deploy-20261012/verification.json`
- 最终只读配置摘要：`.cloudbase/matchmaking-virtual-final-state-20261012.json`
- 云端专项测试与清理：`.cloudbase/matchmaking-virtual-cloud-smoke-20261012.json`
- 本地完整检查：`.cloudbase/matchmaking-virtual-check-20261012.log`
- 新前端二维码：`.cloudbase/matchmaking-virtual-preview-20261012.png`
- 微信模拟器与预览记录：`.cloudbase/matchmaking-virtual-preview-20261012.md`

下一步按[七档道具上架指引](wechat-virtual-goods-listing-guide-20261012.md)配置商品并取得审核结果，随后安排获授权的付款闭环验收。平台商品上架、iOS入口、切换现网、启用收费和正式小程序发布分别确认，不由本次代码部署自动执行。
