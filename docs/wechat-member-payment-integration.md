# 微信手机号与会员支付接入

## 当前实现边界

- 小程序登录继续使用 `wx.login`，身份唯一值只接受 CloudBase 注入的 `OPENID`。生产环境不得配置 `ALLOW_MOCK_WECHAT_LOGIN=true`。
- 手机号由小程序 `getPhoneNumber` 按钮取得动态 code，再由 `hlApi` 调用微信开放接口换取；客户端明文手机号不会被接受。
- `hlApi` 负责会员套餐、业务订单、订单归属校验、会员有效期和幂等履约。
- CloudBase 集成中心生成的独立 HTTP 云函数负责微信支付下单、查单、退款、回调验签和报文解密。函数名及 HTTP 路径以集成中心实际生成结果为准。
- 在商户配置和联调未完成前，会员中心显示“微信支付开通准备中”，继续保留联系主理人人工开通。

## 本项目登记与当前接入进度

2026-10-08，用户提供收款商户号 **1118515135**，先确认仅完成商户号申请，随后确认已完成小程序绑定。项目小程序 AppID 为 **wx7e5c0f4d07d2f0f8**，CloudBase 环境为 **cloud1-d2gza7q9c8d69c721**。用户报告的绑定完成已记录；后续实时查询该环境仍仅有 `hlApi`，尚未生成支付集成函数。JSAPI 权限、商户凭据和真机支付结果仍需单独核验，不能由绑定完成推定。

`cloudfunctions/hlApi/payment-merchant-config.json` 仅登记公开商户标识、小程序标识、环境及人民币币种，不保存密钥。新会员订单保存商户号、AppID、币种快照；确认付款和微信关单均核对快照与登记信息。缺少新配置 `PAYMENT_QUERY_PATH` 时，即使此前误设 `PAYMENT_INTEGRATION_READY=true` 也不会开放下单。

项目侧已增加 `integrations/wechat-pay/` 会员支付扩展和配套测试。扩展通过实际生成函数的 PayService 使用微信支付渠道，会员下单仅接受业务订单号，金额及付款人由 `hlApi` 提供。主动查单及回调均向微信重新查询，并匹配商户、AppID、币种、金额、付款人和交易号后再提交幂等履约；前端支付成功不会直接开通权益。该代码仍须安装到实际生成函数并联调，不等于线上收款已接通。

## 外部开通步骤

1. 超级管理员在微信支付商户平台开通 JSAPI/小程序支付，并将 **wx7e5c0f4d07d2f0f8** 授权绑定到商户 **1118515135**；在小程序后台完成对应授权确认。商户申请成功不代表这些步骤完成。
2. 在 CloudBase 环境 **cloud1-d2gza7q9c8d69c721** 的「模板与集成 → 集成中心 → 小程序微信支付」创建集成。按现行向导配置 `appId`、`merchantId`、`apiV3Key`、`merchantSerialNumber`、`privateKey`、`wxPayPublicKey`、`wxPayPublicKeyId`。使用商户 API 私钥与微信支付公钥，不能混淆两者；密钥仅在控制台填写，不发到聊天、不放项目目录。
3. 记录集成中心实际生成的 HTTP 云函数名称和会员下单路径，不使用示例名称替代。
4. 扩展生成函数的会员下单处理：只接收小程序提交的 `outTradeNo`，通过云调用向 `hlApi` 请求 `/internal/payment-orders/checkout`，取得可信的付款人 `OPENID`、金额和商品描述；同时核对平台注入的 `x-wx-openid` 与订单付款人一致，再调用微信支付下单。
5. 在生成函数完成回调验签和报文解密后，通过云调用向 `hlApi` 请求 `/internal/payment-orders/confirm`。不得把未验签的通知或客户端支付结果传入确认接口。
6. 完成小额真机支付、取消支付、延迟回调、重复回调、查单补偿和续费测试后，再将支付功能提交小程序审核。

以上流程依据 [CloudBase 小程序微信支付指南](https://docs.cloudbase.net/integration/wechat-pay-miniprogram) 与 [微信支付小程序开发接入准备](https://pay.wechatpay.cn/doc/v3/merchant/4015459512)。实际表单和函数名称以创建结果为准。

## 安装会员支付扩展

集成中心生成函数后，从控制台或官方 CLI 下载其源码到以实际函数名命名的目录。项目不会自动创建一个示例名称的支付函数。先查看安装预览：

```powershell
npm run prepare:wechat-pay -- --target "实际生成支付函数的绝对目录" --function-name "集成中心显示的实际函数名"
```

预览核对成功后，使用同样的参数追加 `--apply`，再按项目正常部署流程更新该支付函数。脚本验证官方模板入口、路由和回调钩子，若实际模板结构不同则停止；保留原来的凭据读取、回调验签、解密、启动脚本。若生成源码包含依赖锁文件，先在该目录添加 `wx-server-sdk` 并更新锁文件，再准备扩展。脚本只修改本地源码，不改变云配置或部署。

会员扩展提供 `/hl-membership/create`、`/hl-membership/query` 两个 POST 路由，只接受平台注入的 `x-wx-openid`，不能由请求体指定付款人。实际支付函数仍须使用适用于小程序云调用的权限，不开放匿名直接调用。原模板的通用下单、退款、转账等路由及其 `_action` 分发被会员扩展关闭；支付回调继续交给原模板处理。

回调业务钩子改为等待会员履约完成后才应答，失败会传回原生成控制器并触发重试。会员钩子设 3.5 秒预算，依赖调用超时后不再启动下一步写入；已发出的履约事务由幂等机制保证可重复确认。前端主动查单可补偿回调延迟。生成函数编辑凭据或模板更新后可能覆盖扩展，需要重新下载并运行预览、校验和联调。

配置以下业务变量，内部令牌仅通过两端云函数环境变量传递，禁止写入任何部署 JSON 或代码：

| 位置 | 配置 |
| --- | --- |
| 支付集成函数 | 保留集成中心管理的全部商户凭据；另设 `PAYMENT_CALLBACK_TOKEN`，与 `hlApi` 一致 |
| `hlApi` | `PAYMENT_FUNCTION_NAME` = 实际生成函数名 |
| `hlApi` | `PAYMENT_CREATE_PATH=/hl-membership/create` |
| `hlApi` | `PAYMENT_QUERY_PATH=/hl-membership/query` |
| `hlApi` | 配置同一个 `PAYMENT_CALLBACK_TOKEN`；未完成商户配置与受控联调前保持 `PAYMENT_INTEGRATION_READY=false` |

首次联调应先使用隔离测试及受控测试账号、已确认套餐金额，在真机完成付款和服务端履约核对，再向正式用户开放支付；不要把商户号登记、模拟测试或源码部署当作收款成功。

## `hlApi` 环境变量

| 变量 | 用途 |
| --- | --- |
| `JWT_SECRET` | 生产必填的令牌签名密钥，至少 32 个随机字符；只放云函数环境变量。 |
| `ALLOW_LOCAL_JWT` | 仅隔离的本地开发环境可设为 `true`，允许改用 `JWT_DEV_SECRET`；生产环境必须关闭。 |
| `JWT_DEV_SECRET` | 本地/mock 模式专用签名密钥，至少 32 个字符，不得与生产密钥共用。 |
| `PAYMENT_INTEGRATION_READY` | 全链路联调完成后设为 `true`；此前保持未设置或 `false`。 |
| `PAYMENT_FUNCTION_NAME` | 集成中心实际生成的支付 HTTP 云函数名称。 |
| `PAYMENT_CREATE_PATH` | 生成函数内实际部署的会员下单路径。 |
| `PAYMENT_QUERY_PATH` | 生成函数内会员查单补偿路径，必须与下单路径一起配置。 |
| `PAYMENT_CALLBACK_TOKEN` | `hlApi` 与支付函数共享的高强度随机内部令牌，只放云函数环境变量。 |
| `ALLOW_MOCK_WECHAT_LOGIN` | 仅隔离测试环境可设为 `true`，生产环境必须关闭。 |

`JWT_SECRET` 未配置或少于 32 个字符时，`hlApi` 会拒绝启动令牌服务。只有显式设置 `ALLOW_LOCAL_JWT=true`（或隔离测试使用的 `ALLOW_MOCK_WECHAT_LOGIN=true`）时，才允许在没有 `JWT_SECRET` 的情况下读取 `JWT_DEV_SECRET`；`NODE_ENV=production` 时始终禁止该回退。用户 access token 有效期 24 小时，refresh token 有效期 30 天，管理员 token 有效期 2 小时，且三类令牌不能互换调用接口。

升级到此令牌格式后，旧的两段式令牌会立即失效，用户和管理员需要重新登录；`/auth/wx-login` 的 `token`、`refreshToken`、`user` 返回结构不变。

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
    "requesterOpenid": "平台注入并经支付桥接取得的当前微信身份",
    "callbackToken": "支付函数环境变量中的内部令牌"
  }
}
```

返回的 `amountFen`、`payerOpenid` 和 `description` 是微信下单的唯一可信来源，另含登记的 `merchantId`、`appId`、`currency`、`status` 及脱敏 `order`。支付函数不得接受客户端提交的金额、套餐期限或付款人 OpenID。内部 checkout 在改变订单状态前核对 `requesterOpenid`，订单状态更新在事务中再次检查，不能覆盖并发已付款的订单。

`POST /internal/payment-orders/query` 使用相同请求字段读取可信订单，不改变状态。`POST /internal/payment-orders/close` 接收与下述确认一致的商户、AppID、币种、金额、付款人和订单号，仅在实际微信查询为 `CLOSED`/`PAYERROR` 且字段全部匹配时关闭未付款订单；重复关闭幂等，不覆盖已付款订单，不修改会员权益。

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
    "merchantId": "1118515135",
    "appId": "wx7e5c0f4d07d2f0f8",
    "currency": "CNY",
    "amountFen": 29900,
    "tradeState": "SUCCESS",
    "successTime": "2026-07-18T12:00:00+08:00",
    "callbackToken": "支付函数环境变量中的内部令牌"
  }
}
```

会员桥接会重新查询微信付款凭据，即使集成中心转发了明文也不直接以该明文授予权益。`hlApi` 会再次核对订单号、商户、AppID、币种、付款人、金额和交易状态，并在数据库事务中同时更新订单与会员。相同交易号的重复回调返回成功但不会再次顺延有效期。

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
