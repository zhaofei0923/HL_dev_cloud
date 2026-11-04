# 管理后台同步（2026-11-04）

本轮同步小程序管理端与 PC 微搭管理后台的订单取消信息，并核对学历认证材料的查看、审核流程。云环境为 `cloud1-d2gza7q9c8d69c721`，地域 `ap-shanghai`。

## 页面与数据

- 已确认由用户取消的关闭订单显示“用户已取消”，详情显示取消时间和“用户主动取消”。
- 历史关闭订单缺少取消记录时仍显示“已关闭”。取消时间必须是有效字符串日期，原因必须为 `user_requested`；内部取消凭证不进入管理端投影。
- 已付款、退款及待核查状态优先显示，取消后收到付款时仍保留历史取消信息。
- 两端“已关闭”筛选包含用户取消的订单；未增加后台手工取消订单的写入口。
- 学历认证仍通过现有受控接口查看图片、PDF、核验信息和提交审核。材料必须绑定到正式提交的认证申请，单纯暂存上传不会进入审核。
- 小程序 TypeScript 与生成的 JavaScript、PC 运行代码及本地 CALS 内嵌 handler 均同步更新。

## 云函数更新

`hlApi` 已于北京时间 15:17:29 更新；整包回读确认仅 `native-admin.bundle.js` 改变，其余 4057 个文件、环境变量和函数配置保留。包 SHA256：`32019bb13c3785e9ba01a75518f72add8e8d4a4865985f4fe86c80da7fcffb2f`。

实际 Node 16.13 候选验证：既有运行时测试 122/122，通过真实 bundle 内模块运行的读取、认证材料和授权测试 53/53。线上健康检查返回 `0`，未登录访问管理接口返回 `40100`。

全量重建曾发现未关联的历史源码和依赖漂移，因此部署采用当前线上包的限定模块补丁。未部署全量重建产物，未覆盖此前学历上传和订单取消逻辑。

PC 独立函数 `hlAdminOperations` 已于北京时间 15:43:18 更新，保持 `Nodejs20.19`。除取消信息外，仅追加同步 `vip-membership-service` 中当前 2 次／6 次套餐与旧 1 次／3 次套餐只读的两个常量，保留其他线上代码和配置。新套餐价格、次数、期限保持固定；后台只支持启停。

最终 v2 包 SHA256：`929fb78e6738700772428dd8dd3af25aa1871fb40008cdc253aed67d498d587f`。实际 Node 20.19 封装模块读取、认证和授权测试 53/53，套餐管理测试 70/70（含 16 项针对新旧套餐的验证）；未登录调用返回 `40150`。旧候选仍有 3 项既有套餐规则不一致，未部署，最终 v2 已修复这些差异。

COS 连接持续超时后，使用官方管理 SDK 的 base64 ZIP 接口执行一次代码更新。云端控制面 `CodeSha256` 与本地完整候选 ZIP 精确一致，配置和环境摘要不变；验收状态为 `verified-by-cloud-package-sha256`。本次未下载该函数更新后的云端包字节，不能表述为已完成字节下载回读。

## PC 预览与验证边界

线上现有 PC 后台为微搭 `app-pq2auygx` 预览版，正式版本未发布。本轮候选基于云端最新草稿 `6777044`，只替换 5 个管理 handler；生命周期、布局、登录和权限配置完整保留。未用本地 CALS 覆盖云端其他编辑。

新草稿 `6795563` 已保存并核对完整内容；于北京时间 15:47 完成 PC 预览更新，BuildId 为 `86a0191f-8c78-488d-9b4b-806030f3b60e`。平台构建状态 `success`，预览入口 HTTP 200，应用页面资产检查通过；发布后草稿编号与权限摘要保持一致。仅一次草稿保存和一次 `Mode=preview / BuildType=web` 构建，没有请求正式发布。

预览入口：[PC 管理后台预览](https://cloud1-d2gza7q9c8d69c721-1441337122.tcloudbaseapp.com/app-pq2auygx/preview/)。以上验证未包含真实管理员浏览器登录和业务操作，`browserLoginVerified=false`；正式发布状态仍为 `OnlineVersion=null / productionActive=false`。

本地定向测试：读取及认证边界 53/53，管理前端 54/54；PC 候选官方编译器 12/12，相关运行和代码绑定测试 34/34。小程序构建、生成文件核对和 7 项 CMS 工作流核对通过。

这些测试不等于 iPhone 实机学历上传已验收。测试未取消真实订单、审核真实申请或发起付款。小程序正式版本未上传或发布。

本轮开发者工具运行时读取可恢复，但订单管理页导航超时；官方 CLI 预览已连接工具并取得 AppID 权限，随后停在 `Preview` 阶段超时。新二维码未生成，不能用旧二维码验收本次管理端页面。未清理登录、修改系统代理或终止开发者工具；页面实际操作验证仍待完成。

## 证据

- `output/admin-sync-20261104/hlApi/deployment-verification.json`
- `output/admin-sync-20261104/hlApi/actual-module-qa.json`
- `output/admin-sync-20261104/hlAdminOperations-v2/deployment-verification.json`
- `output/admin-sync-20261104/hlAdminOperations-v2/actual-isolated-module-qa.json`
- `output/admin-sync-20261104/hlAdminOperations-v2/actual-catalog-mutation-qa.json`
- `output/admin-sync-20261104/weda/candidate-proof.json`
- `output/admin-sync-20261104/weda/local-cals-proof.json`
- `output/admin-sync-20261104/weda/deployment-verification.json`
- `output/admin-sync-20261104/devtools-verification-blocker.json`

部署产物保留原始线上包、限定差异、固定输入摘要和回读结果；旧候选与未部署重建产物不能作为线上完成证据。
