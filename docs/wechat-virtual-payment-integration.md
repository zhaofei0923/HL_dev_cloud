# 小程序虚拟支付接入（VIP与人工牵线收款）

> 本文档取代 `wechat-member-payment-integration.md` 中的旧 JSAPI 收款链路。  
> VIP与在线人工牵线新订单均走虚拟支付。旧链路（微信支付函数 + `wx.requestPayment`）只保留历史查单、迟到付款履约与退款对账，不再打开旧订单收银台。

## 1. 背景与根因

微信规定：小程序内提供的**虚拟商品**（会员、订阅、付费功能等）购买必须走  
「小程序虚拟支付」（米大师），2026-04-01 起全终端强制。继续使用旧  
`wx.requestPayment` 通道收虚拟商品款项会被平台拦截，即本项目 2026-10-10  
实测遇到的 `requestPayment:fail banned`（支付能力受限）。

2026-10-11 已在 MP 后台开通虚拟支付：

| 项目              | 值                            | 说明                              |
| --------------- | ---------------------------- | ------------------------------- |
| AppID           | `wx7e5c0f4d07d2f0f8`         | 小程序                             |
| OfferID（支付应用ID） | `1450674507`                 | 虚拟支付 → 基本配置                     |
| 虚拟支付结算商户号       | `1118643251`                 | 开通时新建，与旧商户 `1118515135` 独立，不可混用 |
| 结算账户            | 农业银行（成都亦心合情感信息技术有限公司）        | 已验证，可提现                         |
| 费率              | 工具/社交等类目主动支付当前安卓 1%（标准 10%），iOS 12%（标准 17%） | 以官方费率页和实际类目为准 |
| 结算              | 普通支付 T+3；iOS 通常月末后 45–60 天由 Apple 结算至腾讯，再入开发者账户 | 以平台实际账单为准 |

## 2. 架构

```
小程序 membership.ts
  │  wx.login → code
  │  POST /member/payment-orders            （创建业务订单，原有逻辑）
  │  POST /member/payment-virtual/checkout  {outTradeNo, loginCode}
  ▼
hlApi（cloudfunctions/hlApi）
  │  code2session 校验 loginCode → session_key（openid 必须与当前账号一致）
  │  内部 checkout（归属/会员关系/金额可信快照，业务订单 → confirming）
  │  查验全部历史支付尝试；事务分配新 paymentAttemptNo，保存通道/环境/OfferID
  │  生成 signData + paySig(HMAC-SHA256, AppKey) + signature(HMAC-SHA256, session_key)
  ▼
小程序  wx.requestVirtualPayment（mode: short_series_goods）
  │
  ├─ 支付成功 → 平台发货推送 xpay_goods_deliver_notify
  │     → 云开发消息推送 → hlApi（按支付尝试号定位业务单，查单核实 → 发VIP权益或独立牵线套餐）
  │     → 只有 fulfilled 才成功应答；未付/缺单/待复核返回失败
  │
  └─ 前端轮询 POST /member/payment-virtual/query {outTradeNo}
        → hlApi 调用 /xpay/query_order 核对全部尝试 → 已支付则履约（幂等）
        → /xpay/notify_provide_goods 确认平台发货；失败保留 pending，下次重试
```

安全原则（与旧链路一致）：

- 客户端只能提交订单号；金额、付款人、套餐全部来自 hlApi 可信快照。
- 推送与前端回调都**不是**付款证据；履约前必须由 hlApi 向 `/xpay/query_order`  
  重新查单，核对订单号、环境（`env_type`）、金额（`order_fee`/`paid_fee` 严格相等）、  
  支付时间与交易单号。
- 平台查单的 `order_type=0` 为普通支付、`7` 为苹果 iOS 支付；苹果付款还要求现网与至少 100 分。
  `order_type=8` 是苹果退款单，不能作为原付款的确认或退款回收凭据。退款回收仍查询并校验原支付单。
- 履约复用既有 `confirmPayment` 事务：幂等、会员关系变更转 `requires_review` 人工处理。
- 业务订单号保持不变；每次拉起收银台使用独立平台支付尝试号，不复用 `signData.outTradeNo`。
  历史尝试全部保留并查验，避免取消后的迟到付款被遗漏；多笔真实付款记录为人工复核，权益只发一次。
  单个业务订单最多分配 10 次支付尝试，达到上限后需工作人员核查；并发准备不能基于同一快照分配两次。
- 订单创建时保存 `paymentProvider / virtualPaymentEnv / virtualPaymentOfferId`。
  环境或 OfferID 变化时拒绝直接切换既有订单，先恢复原配置核查。
- AppKey / AppSecret / 内部令牌只存在于云端环境变量，不进代码库、不出现在任何响应或日志。

## 3. 云端环境变量（hlApi）

| 变量                          | 说明                                         |
| --------------------------- | ------------------------------------------ |
| `VPAY_OFFER_ID`             | 虚拟支付 OfferID，当前 `1450674507`               |
| `VPAY_ENV`                  | 必须明确为 `0` 现网 / `1` 沙箱；缺失或错误值关闭入口 |
| `VPAY_APP_KEY`              | 现网 AppKey                                  |
| `VPAY_SANDBOX_APP_KEY`      | 沙箱 AppKey                                  |
| `WX_APP_SECRET`             | 小程序 AppSecret（code2session、stable_token 用） |
| `PAYMENT_CALLBACK_TOKEN`    | hlApi 内部路由令牌（已有，保持不变）                      |
| `PAYMENT_INTEGRATION_READY` | `true` 放开VIP正式收款；测试期保持 `false`                |
| `MATCHMAKING_PAYMENT_READY` | 独立控制人工牵线正式收款；测试期保持 `false`，仍需主理人准备确认 |
| `PAYMENT_TEST_*`            | 测试账号窗口（与旧机制一致，0.01 元 / 1 天会员）              |

配置方式（密钥只经 shell 环境传入，不写盘、不入 argv）：

```bash
VPAY_OFFER_ID=1450674507 VPAY_ENV=1 \
VPAY_SANDBOX_APP_KEY=<沙箱AppKey> \
WX_APP_SECRET=<小程序AppSecret> \
node scripts/configure-virtual-payment-env.mjs --cli-bin <tcb CLI 绝对路径> --mcp-bin <MCP 绝对路径> --apply
```

通道裁决：VIP与人工牵线新付款均使用 `payment.provider = 'virtual'`，共享虚拟支付配置，分别检查购买门禁。虚拟支付配置缺项时
`available=false`，即使旧 JSAPI 配置完整也不回退。裁决绝不暴露密钥。

`virtualPaymentAttempts` 保存在受保护的 `hl_payment_orders`，不在会员公开响应中返回；
平台尝试号到业务订单的索引使用受保护的 `hl_counters` 中
`virtualPaymentAttempt_<支付尝试号>` 文档。两个集合均禁止小程序端直接读写和运营手工修改。
`virtualPaidAttemptNo / virtualDeliveryOrderNo / virtualDeliveryStatus / virtualDeliveryConfirmedAt`
用于对账及发货补偿，发货状态为 `pending → confirmed`。

## 4. MP 后台配置清单（人工操作）

1. **道具配置**（虚拟支付 → 基本配置 → 道具配置）：
   - 为4个VIP与3个人工牵线套餐分别创建道具：**道具ID 必须与套餐 `planCode` 完全一致**，  
     **价格必须与套餐 `amountFen` 完全一致**（不一致会报 `-15013`）。
     2026-10-13起人工牵线道具为 `matchmaking_single`（298000分、30天1次）与 `matchmaking_month_3`（698000分、30天3次），提供专属红娘对接。旧三个牵线商品停止新购，历史订单继续按原快照查单、迟到履约和退款。新商品审核及实际可购买性需单独核验，资料见[当前上架指引](wechat-virtual-goods-listing-guide-20261013.md)。
   - 测试道具：`hl_payment_probe`，价格 0.01 元（1 分）。
   - 上传后**发布到现网**；沙箱测试使用开发版本道具，发布后约 10 分钟生效（`-15014`）。
2. **取密钥**：基本配置 → 查看沙箱AppKey / 现网AppKey（管理员扫码）。
3. **AppSecret**：开发管理 → 开发设置 → 使用已有 AppSecret，并直接保存到云函数环境变量；
   不在对话或日志中发送密钥，不为本次测试重置已有 AppSecret。
4. **消息推送**：微信开发者工具 → 云开发 → 设置 → 其他设置 → 消息推送，
   推送模式选择「云函数」，点击「添加消息推送配置」。云函数环境选择
   `cloud1-d2gza7q9c8d69c721`，云函数选择 `hlApi`，按消息类型和事件类型添加规则：
   - `event` / `xpay_goods_deliver_notify` → 云函数 `hlApi`
   - `event` / `xpay_refund_notify` → 云函数 `hlApi`（新版代码重新查原支付单；全额凭据完整时同步权益，否则人工复核；须部署新版后生效）
   保存后检查配置处于启用状态；同一消息类型和事件类型只能绑定一个环境的一个云函数，
   已有匹配规则时应核对并更新该规则。该接入方式由平台直接传入事件 JSON，
   不需要配置开发者服务器 URL、Token 或 EncodingAESKey。
   具体字段见[微信官方虚拟支付回调配置说明](https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloud/guide/wechatpay/virtual-payment-callback.html)。
5. **iOS / 苹果 IAP**：先在账号设置 → 基本信息配置「小程序简称」，再在虚拟支付 → 基本配置开通苹果 IAP 支付。
   2026-10-19 用户已确认后台「苹果 IAP」已开通；客户端适配解除无条件 iOS 拦截。
   后台状态尚未由自动化回读，iPhone 真机付款、回调与权益到账仍须单独验收。
   官方要求 iOS ≥ 15、微信 ≥ 8.0.68、中国大陆 App Store 账号、最低实付 1 元；仅支持 `env: 0` 现网，不支持沙箱。
   已配置并发布的道具可直接用于 iOS，无需另建商品或增加 Apple 专用签名参数。

## 5. 前端要点

- `wx.requestVirtualPayment` 基础库 ≥ 2.19.2 可直接使用；低版本用 `wx.canIUse` 判定。
  基础库版本从 `wx.getAppBaseInfo()` 读取，旧版本回退 `wx.getSystemInfoSync()`；设备信息只用于平台判断。
- iOS 同时核验系统版本与微信版本；信息缺失或不达标时在创建订单前提示升级。
  沙箱测试入口及低于 100 分的套餐在 iOS 创建订单前拦截；调用收银台前再次核验已签名的 `env` 与金额。
  开通的是按次购买套餐的 Apple IAP，不引入自动续费；仍调用 `wx.requestVirtualPayment`，不添加 `platform` 签名字段。
- 取消支付（`errCode -2`）→ 自动查单；未支付时可继续同一业务订单，但必须请求新的
  `paymentAttemptNo`、登录态和签名，不能重复使用之前的平台单号。
  `-15017/-15019`（收款受限）  
  → 锁定支付入口并提示联系主理人。
- 收银台成功回调后最多查询 8 次，间隔 1.5 秒，等待微信付款状态同步。
  此时即使暂时查到 `NOTPAY` 或平台无单，也保持“付款结果确认中”、禁用续付；
  最终是否发放权益仍由服务端付款证据决定。取消与普通手动查询仍直接反馈一次查单结果。
- 查单语义：`NOTPAY`（存在未支付尝试，可准备新尝试）/ `SUCCESS`（已确认付款，
  是否已发权益还需查看 `fulfillmentStatus`）/ `CLOSED`（所有尝试均已关闭）/
  `providerOrderAbsent`（尚无平台订单，可准备新尝试）。发货确认失败返回可重试错误，
  本地已发权益不会回滚或重复发放。
- `checkout` 响应包含 `{ order, paymentAttemptNo, virtualPayment }`。前端核验签名中的
  平台单号等于 `paymentAttemptNo`，道具/金额等于业务订单快照，才调用支付接口。

## 6. 测试与上线

1. 部署前执行 `npm run build:miniprogram` 与 `npm run check`，确保 TypeScript 与运行 JS 同步。
   切换通道前先核查存量 JSAPI 未完成订单；未留存虚拟通道快照的历史单不能直接换通道再次收款。历史JSAPI订单的原查单、迟到付款及退款继续处理，付款准备入口拒绝重新拉起旧JSAPI收银台。
2. `PAYMENT_INTEGRATION_READY=false`、`VPAY_ENV=1`（沙箱）+ 测试账号窗口/测试道具 → 安卓真机拉起收银台，走通  
   下单 → 支付（沙箱不扣真钱）→ 推送/查单 → 履约发会员。
3. 沙箱未完成订单先核查并结束，再 `VPAY_ENV=0` 切现网，测试账号开 0.01 元窗口（`PAYMENT_TEST_*`），  
   真实付款 0.01 元验证回调与权益发放。
4. 后台按平台支付尝试号核对虚拟支付「交易订单」与 hlApi 业务订单、权益及发货确认一致后，设  
   `PAYMENT_INTEGRATION_READY=true` 放开VIP正式收款；人工牵线需其3个商品及套餐履约单独验收后，再设置 `MATCHMAKING_PAYMENT_READY=true`。两项开关不会因配置密钥而自动启用。
5. 上线后抽查：MP 交易订单金额、平台技术服务费、hlApi 订单状态三方一致。

错误码速查：`-15002` 单号重复（换新单）、`-15005` 用户态签名错、  
`-15006` 支付签名错、`-15007` session_key 过期（重新 wx.login）、  
`-15010` 道具未发布、`-15011` 现网 env 误用沙箱、`-15013` 价格不一致、  
`-15017/-15019` 收款受限（查商户平台违约记录）。

## 7. 代码位置

| 内容                    | 文件                                                                                                                               |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 虚拟支付核心（配置/签名/查单/推送校验） | `cloudfunctions/hlApi/virtual-payment-policy.js`                                                                                 |
| 通道裁决                  | `cloudfunctions/hlApi/membership-payment-policy.js` `paymentProviderConfig`                                                      |
| 下单/查单/推送履约            | `cloudfunctions/hlApi/index.js` `virtualCheckout` / `virtualQuery` / `handleVirtualPaymentPush` / `reconcileVirtualPaymentOrder` |
| 前端支付页                 | `miniprogram/pages/user/membership.ts`                                                                                           |
| 前端参数校验                | `miniprogram/utils/payment-response.ts` `virtualPaymentParamsFrom`                                                               |
| 前端服务层                 | `miniprogram/services/member.ts`                                                                                                 |
| 环境配置脚本                | `scripts/configure-virtual-payment-env.mjs`                                                                                      |
| 单元测试                  | `tests/virtual-payment-policy.test.js`                                                                                           |

## 8. 官方协议与本地验证范围

- [虚拟支付产品、签名和推送协议](https://developers.weixin.qq.com/miniprogram/dev/platform-capabilities/business-capabilities/virtual-payment.html)
- [客户端参数及错误码](https://developers.weixin.qq.com/miniprogram/dev/api/payment/wx.requestVirtualPayment.html)
- [查单接口](https://developers.weixin.qq.com/miniprogram/dev/server/API/VirtualPayment/api_query_order)
- [发货确认接口](https://developers.weixin.qq.com/miniprogram/dev/server/API/VirtualPayment/api_notify_provide_goods)
- [技术服务费](https://developers.weixin.qq.com/miniprogram/dev/platform-capabilities/business-capabilities/virtual-payment/devplan.html)

### 2026-10-19 苹果 IAP 适配

- 用户确认 MP 后台已开通苹果 IAP。云端只读核验：`VPAY_ENV=0`、VIP 与牵线正式收款开启、测试窗口关闭，正式配置齐全；本次不改变这些配置。
- 客户端允许满足版本要求的 iOS 设备付款，拒绝沙箱与不足 1 元的订单，并在原生收银台调用前复核签名环境和金额。
- 服务端支持原苹果付款单 `order_type=7` 的确认、查单补偿及原单全额退款证明，仍拒绝类型 8 退款单充当付款证据。
- 完整构建及 `npm run check` 通过，1547 项测试无失败；开发者工具会员页 WXML/WXSS 编译通过。
- 服务端已于北京时间 15:20:42 更新，最终回读为 `Active`，健康检查 `code=0/status=ok`。
  线上包 SHA-256 为 `813475890e68cc1f5a40db66a9848165223bb1d2fdd8649f46753d999263b730`；4050 个文件中仅支付策略文件变化，其余 4049 个文件及所有环境、配置保持一致。
  首次 MCP 上传因平台 COS 取包授权失败，旧版本持续健康；随后通过既有官方 SDK 临时 COS 通道完成同一候选包发布。
  最终证据：`output/apple-iap-20261019/repair-verification.json`；原包备份和两次独立请求记录均已保留。
- 预览二维码：`output/apple-iap-20261019/iphone-preview.png`。预览成功不等于体验版或正式版发布，也不等于 iPhone 真机付款与权益到账已验收。
- 用户随后授权上传云端，已通过微信开发者工具上传客户端版本 `2026.10.19-ios`，任务状态与执行结果均为成功，包大小 1,070,985 字节。上传前后 280 个源文件/项目配置的 SHA-256 一致。
  上传回执：`output/apple-iap-20261019/upload-completion.json`；版本及源文件核对记录：`output/apple-iap-20261019/upload-state.json`。本次为开发版本上传，未设置体验版、提交审核或正式发布。
- 用户随后提供公众平台截图，确认 `2026.10.19-ios` 已标记为体验版，但 iPhone 仍出现旧的“请使用安卓设备”提示。当前实际源代码、生成 JS 均无该提示，280 个上传输入文件仍与上传前一致；不能继续归因于“体验版尚未切换”。已明确重新编译，并生成 `output/apple-iap-20261019/iphone-preview-recompiled.png` 供同一设备复验。手机实际加载的包、编译缓存或平台原生弹窗的区别尚待复验；诊断记录为 `output/apple-iap-20261019/iphone-retest-diagnostics.json`。
- 用户确认重新编译的预览能调起苹果收银台，并补充“业务后台管理员手机无法支付、非管理员手机可以”。当前代码无管理员禁付分支，管理员名单中三个账号的未决订单只读查询为零；管理员手机使用新预览的结果及实际付款到账仍待确认。按用户再次授权，已上传开发版本 `2026.10.19-ios2`，上传成功，280 个输入文件的集合及内容均未变。上传回执：`output/apple-iap-20261019/upload-ios2-completion.json`；记录：`output/apple-iap-20261019/upload-ios2-state.json`。仍需在公众平台将体验版切换到 `2026.10.19-ios2` 后复测管理员手机；未提交审核或正式发布。
- `xpay_subscribe_ios_refund_query_notify` 尚未实现商户建议应答；当前按未知事件忽略，不能声称支持退款问询。退款成功仍依赖 `xpay_refund_notify` 重查原支付单并按权益账本处理；真实 Apple 退款未实测。

本地测试覆盖取消/失败后的新支付尝试、迟到付款、并发准备、配置缺项、支付参数绑定、
未履约不成功应答、发货确认失败重试及重复收款人工复核。
本地通过不代表云端配置已生效或真机支付已完成；上线前仍需以上沙箱及现网验收。

## 9. 2026-10-11 安卓沙箱验收记录

- 测试道具：`hl_payment_probe`，0.01 元、1 天会员；沙箱环境 `VPAY_ENV=1`。
- 指定测试账号在安卓微信收银台完成支付，随后通过会员页查询确认权益。
- 业务订单 `1791721901282000` 已为 `paid / fulfilled`，只分配了 1 次平台支付尝试；
  会员到期时间为北京时间 **2026-10-12 20:38:34**，从本次履约时间起增加 24 小时。
- 微信平台订单已为状态 `4`（已发货），本地 `virtualDeliveryStatus=confirmed`；
  待支付占位已释放，没有重复付款复核，也没有重复发放权益。

本次发货确认发现并修复了漏传 `pay_sig`：同一已付款、已履约的沙箱订单、相同请求体，
未签名调用返回 `268490002`，按主接入文档通用规则增加服务端签名后返回 `errcode=0`，
随后微信查单为已发货。`notify_provide_goods` 同样应使用环境对应 AppKey 对
`"/xpay/notify_provide_goods&" + 实际 JSON 请求体` 计算签名，并随 `access_token` 发送。
端点参数表未列此项，不能据此省略主接入文档的服务端签名要求。

这次平台发货通过对原订单进行受控补偿确认完成，并由已有幂等对账入口补齐本地记录；
补偿前后会员、交易凭据及支付尝试均保持一致。**微信真实消息推送配置已完成第 10 节回读验收，
实际送达尚未独立验收**；人工补偿触发不作为消息推送已通过的证据。正式收款仍关闭；道具发布、现网密钥和受控现网验证
仍按第 6 节单独完成。

安全验收摘要保存在本地 `.cloudbase/virtual-sandbox-payment-verification-20261011.json`；
上述签名对比及补偿记录保存在 `.cloudbase/current-virtual-delivery-1791722876862-apply.json`。

最终修复通过 `npm run check` 的 **746/746** 项测试，以及类型、生成文件和运行语法检查。
`hlApi` 修复已部署，状态 `Active`、健康检查通过；下载的云端代码包中 14 个根目录源文件
与本地 SHA-256 全部一致。前端已生成包含最终修复的开发预览，尚未上传或发布小程序版本。
验收结束后已关闭本次测试窗口：`PAYMENT_TEST_ENABLED=false`，沙箱配置保持，
`PAYMENT_INTEGRATION_READY=false`；回读确认其余环境变量均未改变，已有会员权益保留。

## 10. 2026-10-11 消息推送配置验收

北京时间 21:16，通过微信开发者工具的云开发控制台「设置 → 其他设置 → 消息推送」
保存配置，再点击该列表的「刷新」回读。配置前列表为空，推送模式已为「云函数」；
配置后只有以下两条规则，均显示「停用」操作，确认当前已启用：

| 消息类型 | 事件类型 | 云函数环境 | 云函数 | 状态 |
| --- | --- | --- | --- | --- |
| `event` | `xpay_goods_deliver_notify` | `cloud1-d2gza7q9c8d69c721` | `hlApi` | 已启用 |
| `event` | `xpay_refund_notify` | `cloud1-d2gza7q9c8d69c721` | `hlApi` | 已启用 |

退款通知沿用现有处理：记录日志并人工复核，不自动调整会员权益。本次只添加并启用以上两条
消息规则，没有发布道具、打开付款测试窗口、启用正式收款或创建新的支付订单。
配置回读通过仅证明规则保存并启用，**仍需下一次受控沙箱支付确认微信真实通知到达、
自动履约和发货确认**。安全配置摘要保存在
`.cloudbase/wechat-message-push-verification-20261011.json`。

## 11. 2026-10-11 安卓沙箱真实推送验收

2026-10-11 已准备独立沙箱批次 `push_20261011_2127`，限指定测试账号、
`hl_payment_probe`、1 分及 1 天权益。旧已付款订单保留；本次成功履约按现有有效期与
履约时间的较晚者增加 1 天，不重新计算或扣减已有权益。

- 可选 `PAYMENT_TEST_RUN_ID` 由服务端配置，合法批次使用独立测试订单文档；
  未配置时保留原一次性测试行为，非法值关闭测试入口。
- `PAYMENT_TEST_PUSH_ONLY=true` 仅对当前有效沙箱批次生效：手机查单只读本地状态，
  不通过查单履约或补发。关闭窗口或过期后恢复正常查单，迟到付款推送仍可处理。
- 首次付款确认记录 `confirmationSource`、`confirmationRequestId`；成功推送记录
  `virtualPushHandledAt`、`virtualPushRequestId`、`virtualPushOrderNo`，重试不覆盖。
  请求编号仅取云函数执行上下文，来源由服务端调用路径指定。
- 全部检查 **758/758** 通过；云函数已部署为 `Active`，健康检查通过，
  云端代码包 14 个根目录源文件与本地 SHA-256 一致。

本次安卓真机支付已完成，业务订单为 `1791725947887000`。服务端首次确认来源为
`wechat_push`，付款确认和推送处理请求编号均为
`fe7fc33b-cb77-4087-95fe-d8f049050fe6`，推送处理时间为北京时间 **21:39:48**。
订单为 `paid / fulfilled`、发货状态 `confirmed`；本轮没有人工调用推送入口，
手机查单在当前窗口只读取本地状态，因此本次会员履约由自动推送完成。

微信只读查单已逐一核对两次平台尝试：第一笔为状态 `6`（已关闭，未付款），
第二笔为状态 `4`（已发货），金额 1 分，交易凭据与业务订单相符。实际只付款一次；
旧订单未改变，没有重复发放权益，赵飞会员有效期从北京时间
`2026-10-12 20:38:34` 延长至 **2026-10-13 20:38:34**。

北京时间 **21:42:40** 已关闭 `PAYMENT_TEST_ENABLED` 和本轮查单隔离开关，
回读确认其他受保护环境配置保持一致，正式收款继续关闭。
**此次验收覆盖发货推送，退款推送没有实测**。独立云日志查询暂未取到记录；
上述结论依据受控查询隔离、首次履约来源、成功推送处理记录及微信只读查单，
不将配置保存或人工补偿算作真实推送证据。

本次窗口记录、订单权益验收和独立云日志查询结果分别保存在本地
`.cloudbase/virtual-push-run-push_20261011_2127.json`、
`.cloudbase/virtual-push-run-push_20261011_2127-verification.json` 和
`.cloudbase/virtual-push-log-push_20261011_2127-verification.json`。
微信平台各尝试只读证据保存在
`.cloudbase/virtual-push-provider-push_20261011_2127-verification.json`。
