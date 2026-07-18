# HL 小程序云开发版

本项目由 `D:\HL_dev` 迁移而来，当前目录保留微信云开发项目配置和 AppID，并将业务接口改为云函数 `hlApi`。

## 项目结构

- `miniprogram/`：HL 小程序用户端、主理人端页面、组件、资源和服务层。
- `cloudfunctions/hlApi/`：统一业务云函数，承接登录、用户资料、主理人、会员、沙龙等接口。
- `typings/`、`tsconfig.json`：TypeScript 类型和本地检查配置。

## 云数据库集合

云函数会在调用时尝试创建以下集合，建议在 CloudBase 云后台/CMS 中围绕这些集合配置运营视图：

- `hl_users`：用户基础信息，包含 `openid` 等系统字段。
- `hl_profiles`：用户资料和择偶偏好。
- `hl_matchmakers`：主理人申请、认证状态和运营指标。
- `hl_members`：主理人管理的会员关系。
- `hl_salon_events`：沙龙活动。
- `hl_registrations`：沙龙报名记录。
- `hl_match_records`：会员推荐记录。
- `hl_messages`：系统和推荐消息。
- `hl_membership_plans`：会员套餐、服务端金额和有效期配置。
- `hl_payment_orders`：微信支付业务订单和履约状态，禁止运营人员手工修改。
- `hl_counters`：业务自增 ID 计数器，不建议运营人员编辑。

> 产品界面统一使用“主理人”称呼。为兼容已发布版本和存量数据，代码中的 `matchmaker` 角色值、页面与接口路径，以及 `hl_matchmakers`、`matchmakerId`、`matchmakerNo` 等技术标识保持不变。

## 后台管理建议

后台管理优先使用 CloudBase 云后台/CMS。建议只给运营人员开放 `hl_profiles`、`hl_matchmakers`、`hl_members`、`hl_salon_events`、`hl_registrations` 的必要字段；`openid`、token 相关字段、`hl_counters` 等系统字段仅开发者可见。

详细字段视图、角色权限和运营动作建议见 `docs/cloudbase-cms-operations.md`。微信手机号和会员支付的外部开通、环境变量及回调契约见 `docs/wechat-member-payment-integration.md`。

## 本地验证

```bash
npm run build:miniprogram
npm run check
```

## 部署提示

在微信开发者工具中打开 `D:\HL_dev_cloud` 后，需要部署 `cloudfunctions/hlApi` 云函数，并在云开发控制台配置云后台/CMS、集合权限和运营角色。
