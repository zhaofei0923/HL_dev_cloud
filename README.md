# HL 小程序云开发版

本项目由 `D:\HL_dev` 迁移而来，当前目录保留微信云开发项目配置和 AppID，并将业务接口改为云函数 `hlApi`。

## 项目结构

- `miniprogram/`：HL 小程序用户端、主理人端页面、组件、资源和服务层。
- `cloudfunctions/hlApi/`：统一业务云函数，承接登录、用户资料、主理人、会员、沙龙等接口。
- `typings/`、`tsconfig.json`：TypeScript 类型和本地检查配置。

## 云数据库集合

云函数会在调用时尝试创建以下集合，建议在 CloudBase 云后台/CMS 中围绕这些集合配置运营视图：

- `hl_users`：用户基础信息，包含 `openid` 等系统字段。
- `hl_profiles`：用户资料、择偶偏好和服务端受控的分类核验摘要；禁止小程序端直接读写，资料统一通过 `hlApi` 读取和保存。
- `hl_matchmakers`：主理人申请、认证状态和运营指标。
- `hl_members`：主理人管理的会员关系。
- `hl_member_private_archives`：会员验资、资产、生活照和风险等高敏内部档案，仅由所属认证主理人的云函数接口读取；内部生活照按 `hl_uploads/member-private/<主理人用户ID>/` 隔离存放。
- `hl_member_certifications`：实名、学历、车辆、房产和金融资产认证的申请、加密材料元数据、审核记录和当前结论；禁止小程序端直接读写及普通 CMS 运营账号操作，本人申请及管理员核验统一通过 `hlApi`。
- `hl_salon_events`：沙龙活动。
- `hl_registrations`：沙龙报名记录。
- `hl_match_records`：会员推荐记录。
- `hl_messages`：系统和推荐消息。
- `hl_membership_plans`：会员套餐、服务端金额和有效期配置。
- `hl_payment_orders`：微信支付业务订单和履约状态，禁止运营人员手工修改。
- `hl_member_identity_claims`：手工会员的一次性微信认领邀请、并发锁和审计状态；只允许云函数读写，禁止 CMS 运营账号直接操作。
- `hl_counters`：业务自增 ID 计数器，不建议运营人员编辑。

> 产品界面统一使用“主理人”称呼。为兼容已发布版本和存量数据，代码中的 `matchmaker` 角色值、页面与接口路径，以及 `hl_matchmakers`、`matchmakerId`、`matchmakerNo` 等技术标识保持不变。

## 后台管理建议

后台管理优先使用 CloudBase 云后台/CMS。建议只给运营人员开放 `hl_profiles`、`hl_matchmakers`、`hl_members`、`hl_salon_events`、`hl_registrations` 的必要字段；`openid`、token 相关字段、`hl_counters`、`hl_member_private_archives`、`hl_member_identity_claims`、`hl_member_certifications` 等系统或高敏数据仅开发者可见。CMS 不得编辑 `hl_profiles.showcaseCertification`，也不得代会员设置 `assetCategoryConsent` 或 `assetRangeDisclosure`；资产分类同意及区间公开选项必须由会员本人通过 `hlApi` 保存。

详细字段视图、角色权限和运营动作建议见 `docs/cloudbase-cms-operations.md`。微信手机号和会员支付的外部开通、环境变量及回调契约见 `docs/wechat-member-payment-integration.md`。

“我的资料 → 认证中心”支持在小程序内提交核验材料，学历可选择学信网验证码、毕业或学位证照片、在读辅助材料、留服认证编号，包含海外及港澳台学历。图片和 PDF 经云函数加密后存储，公开页面只读取已审核的认证摘要。材料格式、密钥维护和管理员审核流程见 `docs/member-showcase-certification.md`。

## 本地验证

```bash
npm run build:miniprogram
npm run check
```

## 部署提示

在微信开发者工具中打开 `D:\HL_dev_cloud` 后，需要先为 `hlApi` 配置至少 32 个随机字符的生产环境变量 `JWT_SECRET`，再部署 `cloudfunctions/hlApi` 云函数，并在云开发控制台配置云后台/CMS、集合权限和运营角色。`hl_profiles`、`hl_member_private_archives`、`hl_member_identity_claims` 与 `hl_member_certifications` 必须禁止小程序端直接读写；`hl_profiles.showcaseCertification` 中的核验档位仅供服务端分类及公开投影使用，公开接口默认只返回“资产已认证”，本人同意公开区间时才返回对应区间。内部生活照必须禁止公开读取和目录枚举，只允许上传者写入/删除，查看时由 `hlApi` 为所属主理人换取临时地址。仅隔离本地/mock 环境可显式开启 `ALLOW_LOCAL_JWT=true` 并配置独立的 `JWT_DEV_SECRET`；生产环境不得启用该回退。以上权限需要在部署环境实际配置，本地配置清单不代表云端权限已生效。
