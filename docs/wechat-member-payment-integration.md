# 微信手机号与会员支付接入

## 当前实现边界

- 小程序登录继续使用 `wx.login`，身份唯一值只接受 CloudBase 注入的 `OPENID`。生产环境不得配置 `ALLOW_MOCK_WECHAT_LOGIN=true`。
- 手机号由小程序 `getPhoneNumber` 按钮取得动态 code，再由 `hlApi` 调用微信开放接口换取；客户端明文手机号不会被接受。
- `hlApi` 负责会员套餐、业务订单、订单归属校验、会员有效期和幂等履约。
- CloudBase 集成中心生成的独立 HTTP 云函数负责微信支付下单、查单、退款、回调验签和报文解密。函数名及 HTTP 路径以集成中心实际生成结果为准。
- 在商户配置和联调未完成前，会员中心显示“微信支付开通准备中”，继续保留联系主理人人工开通。

## 外部开通步骤

1. 完成微信支付商户号申请，开通小程序支付权限，并将当前小程序 AppID 绑定到商户号。
2. 在 CloudBase 集成中心创建小程序支付应用，配置商户号、APIv3 密钥、商户私钥和平台证书。
3. 记录集成中心实际生成的 HTTP 云函数名称和会员下单路径，不使用示例名称替代。
4. 扩展生成函数的会员下单处理：只接收小程序提交的 `outTradeNo`，通过云调用向 `hlApi` 请求 `/internal/payment-orders/checkout`，取得可信的付款人 `OPENID`、金额和商品描述；同时核对平台注入的 `x-wx-openid` 与订单付款人一致，再调用微信支付下单。
5. 在生成函数完成回调验签和报文解密后，通过云调用向 `hlApi` 请求 `/internal/payment-orders/confirm`。不得把未验签的通知或客户端支付结果传入确认接口。
6. 完成小额真机支付、取消支付、延迟回调、重复回调、查单补偿和续费测试后，再将支付功能提交小程序审核。

## `hlApi` 环境变量

| 变量 | 用途 |
| --- | --- |
| `PAYMENT_INTEGRATION_READY` | 全链路联调完成后设为 `true`；此前保持未设置或 `false`。 |
| `PAYMENT_FUNCTION_NAME` | 集成中心实际生成的支付 HTTP 云函数名称。 |
| `PAYMENT_CREATE_PATH` | 生成函数内实际部署的会员下单路径。 |
| `PAYMENT_CALLBACK_TOKEN` | `hlApi` 与支付函数共享的高强度随机内部令牌，只放云函数环境变量。 |
| `ALLOW_MOCK_WECHAT_LOGIN` | 仅隔离测试环境可设为 `true`，生产环境必须关闭。 |

`PAYMENT_CALLBACK_TOKEN` 至少使用 32 个随机字符，同时配置到支付函数环境，不能写入 Git、小程序代码、HTTP 响应或运营后台。支付商户私钥、APIv3 密钥和证书只配置在 CloudBase 集成中心。

## 内部接口契约

### 可信下单数据

支付函数通过云调用请求：

```json
{
  "path": "/internal/payment-orders/checkout",
  "method": "POST",
  "data": {
    "outTradeNo": "服务端订单号",
    "callbackToken": "支付函数环境变量中的内部令牌"
  }
}
```

返回的 `amountFen`、`payerOpenid` 和 `description` 是微信下单的唯一可信来源。支付函数不得接受客户端提交的金额、套餐期限或付款人 OpenID。

### 已验签支付确认

支付函数完成微信回调验签和报文解密后，通过云调用请求：

```json
{
  "path": "/internal/payment-orders/confirm",
  "method": "POST",
  "data": {
    "outTradeNo": "服务端订单号",
    "transactionId": "微信支付交易号",
    "payerOpenid": "微信回调中的付款人 OPENID",
    "amountFen": 29900,
    "tradeState": "SUCCESS",
    "successTime": "2026-07-18T12:00:00+08:00",
    "callbackToken": "支付函数环境变量中的内部令牌"
  }
}
```

`hlApi` 会再次核对订单号、付款人、金额和交易状态，并在数据库事务中同时更新订单与会员。相同交易号的重复回调返回成功但不会再次顺延有效期。

## 套餐配置

管理员登录后使用 `PUT /admin/membership-plans/:planCode` 配置套餐。建议先保存为 `active=false`，核对后再启用：

```json
{
  "title": "三个月会员",
  "description": "解锁心动关系资料与互选聊天",
  "badge": "推荐",
  "amountFen": 29900,
  "durationDays": 90,
  "active": false,
  "sortOrder": 10
}
```

不要在小程序端硬编码或覆盖套餐金额。历史 `paid/vip` 且 `expireAt` 为空的会员继续视为长期有效；有到期时间的会员续费时从当前未到期时间顺延。

## 上线检查

- 开发版和体验版均使用真实 CloudBase `OPENID`，手机号拒绝后仍能浏览非受限页面。
- 支付取消不会修改 `hl_members`，客户端 `wx.requestPayment` 成功也只显示确认中。
- 微信回调金额、OPENID、订单号或状态任一不匹配时，订单和会员均不更新。
- 同一回调重复投递不会重复顺延会员有效期。
- 支付回调延迟时，会员中心保持确认中；回调或查单补偿完成后才显示已开通。
- 退款由支付函数先向微信发起并确认成功，再通过受保护的业务接口更新订单和会员；未实现退款履约前不要在运营端提供退款按钮。
