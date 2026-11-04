# IF·U 婚恋小程序优化清单落地记录

需求日期：2026-10-26；本地实现日期：2026-11-03。

## 功能对应

| 需求 | 本地实现 |
| --- | --- |
| 开通 VIP 前查看资料，聊天再付费 | 登录后免费浏览推荐、颜值、学历、资产分类及公开资料详情；双方互选或正式牵线后的会员聊天均校验当前有效 VIP。与主理人的服务聊天保持原规则。 |
| 支付取消页面 | 新增 `pages/user/payment-cancel`。退出微信收银台后先核对原订单，显示待支付、待确认、已支付或查询失败，提供原订单和会员页入口；取消回调不直接改变服务端支付结果。 |
| 成功脱单／邀请脱单 | “我的”及会员聊天可进入关系管理。本人声明或发送邀请后进入已脱单并隐藏；受邀方须本人接受才改变其状态。恢复单身后保持隐藏，公开资料需另行开启。 |
| 解除匹配 | 提供“不礼貌、骚扰”“广告、色情”“不回复”“接触后不合适”四项完整原因。清除双方心动、取消正式匹配和未处理邀请、关闭会员聊天；服务端阻止双方再次互动和从旧会话继续聊天。 |
| 开启定位／距离 | 推荐页主动授权、可关闭；仅保存两位小数的模糊坐标，返回大致公里数，近距离显示“约3公里内”。双方位置有效才显示，7 天后失效；公开接口不返回坐标。 |
| 我心仪的 Ta | 独立页面覆盖年龄、身高、职业、学历、现居住地、结婚时间、有无孩子、生育意愿、体重、生肖、星座、吸烟、饮酒、宠物、婚况。支持不限、保存、重置；保存后刷新推荐缓存。 |
| VIP 已读状态 | 服务端仅向有 VIP 权益的发送方返回自己消息的已读／未读；刷新时可更新最近 100 条本人消息状态，不传出原始已读名单和对方未读数量。 |

偏好用于推荐排序，不是强制排除条件。现有公开档案缺少部分生活习惯和生育资料，这些项可保存，但缺少对方数据时不计入符合项，也不擅自读取主理人的私密档案补齐。高级筛选、谁喜欢我、访客等既有独立权益保持原规则。

## 主要源码

- `cloudfunctions/hlApi/index.js`：路由、VIP 校验、已读投影、距离、偏好推荐排序及解除匹配检查。
- `member-relationship-service.js`、`relationship-policy.js`：脱单邀请和解除匹配。
- `matching-preferences-policy.js`、`member-location-policy.js`：偏好校验与位置处理。
- `miniprogram/pages/user/preferences.*`、`relationship-status.*`、`payment-cancel.*`：新增页面。
- `miniprogram/pages/user/members.*`、`profile.*`、`membership.*` 及聊天公共逻辑：入口与交互。

沿用现有米白、棕金视觉体系、PingFang SC / Microsoft YaHei 字体与分组表单，没有更改商品价格或已有订单快照。

## 取消订单补充（2026-11-03）

会员页的原订单卡片、支付取消页和订单详情增加“取消订单”入口，确认后由服务端处理。退出微信支付窗口与主动取消订单分别记录；主动取消成功显示“订单已取消”，订单历史仍保留，需要购买时重新选择套餐。

`POST /member/payment-orders/:outTradeNo/cancel` 仅处理当前登录用户的订单，成功返回原订单及 `cancelledAt`、`cancelReason: user_requested`，继续使用既有 `closed` 状态。已经关闭或失败的订单可确认取消；未签发收银台的虚拟支付订单可在事务内取消。已经签发收银台的订单先查单，只有全部支付尝试确认关闭才完成取消。微信仍返回未支付、订单不存在、查询失败或不明结果时保留原订单，提示稍后核验；这些结果不能证明旧收银台无法再付款。

取消操作校验订单归属、并发支付尝试和最新付款状态，并防止重复点击。已付款、已退款及待复核订单不允许取消；用户取消后若仍核验到晚到付款，记录为“已付款，待核查”，保留取消审计、不自动发权益或确认发货，并阻止继续签发付款。本次不增加未经确认的微信虚拟支付主动关单接口，也不触发退款。

本轮全量 `npm run check`：1955 项测试，1953 项通过、2 项跳过、0 项失败；最后修复返回会员页时旧查单结果覆盖新状态的问题后，重新构建并通过生成物检查，重跑受影响前端回归 113 项全部通过。微信开发者工具内置本地编译器检查 37 个 WXML、39 个 WXSS 全部通过。验证日志保存在忽略目录 `tmp/ifu-order-cancellation-*`；后续云函数部署结果见末节，真实收银台仍待联调。

## 验证与上线边界

已执行本地构建、TypeScript 检查、生成物一致性、媒体预算、业务回归和管理工作流检查。全量检查结果为 1920 项测试：1918 项通过、2 项因已有外部部署依赖缺失跳过、0 项失败；会员权益展示最后微调后另行重跑对应页面测试并重新构建。

新增回归覆盖普通会员免费分类浏览、正式匹配 VIP 校验、已读信息隔离、审核等待期间失去聊天权限、原订单支付取消恢复、脱单后禁止直接重新公开、邀请本人确认、双向解除匹配、偏好保存／账号隔离／排序／缓存刷新、位置授权时机／关闭／过期／不泄露坐标。

以下为云部署前的本地代码与隔离测试记录，云函数部署结果见末节。尚未上传体验版或发布；微信开发者工具的新接口已连接，已读取当前页并取得首页截图；新增页面自动化执行及编译接口在 AppID 校验时遇到 TLS 连接错误，未完成新增页面视觉与交互验收；真实收银台取消、真实用户定位授权及双方真实消息同步仍需联调。上线须同步更新 `hlApi` 的新增模块和小程序生成物，并按仓库现有受保护部署流程准备候选，不能直接覆盖现网云包。

`app.json` 已添加 `scope.userLocation` 与 `requiredPrivateInfos: ["getLocation"]`。微信后台定位接口资格及隐私指引需与本次用途对应，参考[微信官方 getLocation 文档](https://developers.weixin.qq.com/miniprogram/dev/api/location/wx.getLocation.html)和[腾讯位置服务接口说明](https://github.com/TencentLBS/tencentmap-miniprogram-skill/blob/main/references/wx_location_api/wx.getLocation.md)。

## 开发者工具复验（2026-11-03）

- `wechatide` 版本 2.02.2608080，内置 skill 0.3.11；状态检查确认登录未过期、版本匹配。旧自动化 SDK 仍会超时，本轮改用工具自带的新接口。
- `automation_runtime_info` 成功读取 `pages/index/index`；`simulator_screenshot` 成功取得并检查首页截图，首页正常渲染。
- `automation_evaluate` 和 `compile_wxml` 在项目 AppID 校验阶段返回 `Client network socket disconnected before secure TLS connection was established`，错误代码 `APPID_ERROR`。现有 AppID 未改动，未触发真实支付或修改真实账号资料。此结果不能证明 AppID 本身无效，也不能算作新增页面交互通过。
- 改用开发者工具内置本地编译器检查：37 个 WXML 和 39 个 WXSS 全部编译通过（退出码 0、无标准错误），包含全部新增页面。编译成功不替代视觉和点击验收。
- 修复偏好保存期间离开再返回页面可能重复提交的问题：同一账号请求完成前持续锁定编辑和保存；完成后同步结果或解除锁定供重试。增加两项生命周期回归，偏好专项共 12 项通过，重新构建、生成物一致性与媒体预算检查通过。

本轮本地证据：`tmp/ifu-native-compile-result.json`、`tmp/ifu-current-verified.png`。这些是本地验证产物，不包含云端部署或真机验收。后续需在开发者工具恢复 AppID 校验网络请求后继续新增页面点击、输入、状态切换验证。

## 云函数部署（2026-11-03）

北京时间 2026-11-03 16:36 已部署并验证 `cloud1-d2gza7q9c8d69c721 / ap-shanghai / hlApi`，运行时仍为 `Nodejs16.13`、入口 `index.main`。本次更新七项优化及取消订单的后端；客户端未上传或发布，真实付款及双方账号联调未执行。

- 更新 `index.js`、`relationship-policy.js`，新增 `matching-preferences-policy.js`、`member-location-policy.js`、`member-relationship-service.js`。候选入口通过 AST 比对排除了本地另有的旧后台列表与统计改动。
- 从最新现网完整包构造候选，保留其他 4,053 个文件的内容与属性，包括原生后台 bundle、依赖、认证兼容及支付配置。环境变量、函数配置和依赖安装设置回读一致；未更改集合权限。
- 目标 Node 16.13.0 下运行实际候选：65 项隔离测试、24 个 JS 语法检查通过；健康接口及 9 个未授权接口检查通过，无真实网络或业务写入。测试注册与测试夹具使用兼容适配，生产模块未增加运行时补丁。
- 仅发送一次代码更新请求。部署后完整下载 4,058 个文件，内容、属性及 ZIP 摘要全部吻合；云端 `GET /health` 返回 `code: 0, status: ok`，未登录读取订单返回 `40100`。
- 只读核验 `hl_profiles` 为 `ADMINONLY`，`hl_chat_messages` 为 `PRIVATE`。新增功能不要求新建集合；本次未修改真实用户资料、订单或权益。

现网部署包 SHA256：`5f37f03f20f6edfee9609713980034229370ada330faae5ea16461c8cf65ce0a`。部署前完整回滚包 SHA256：`850922890af481317c1ec5a473518a596408e4d0cbd97df4a8e64cc6e3ed027d`。

本机证据位于忽略目录 `output/ifu-optimization-20261103/`：`hlApi.rollback.zip`、`candidate-manifest.json`、`candidate-node16-proof.json`、`single-code-update-request.json`、`deployment-verification.json` 及 `hlApi.deployed.downloaded.zip`。部署脚本为 `scripts/deploy-ifu-optimization.mjs`，绑定本次基线和不可变候选；后续不能直接重复执行 `deploy`，再次上线须重新核验最新基线。
