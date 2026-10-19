# 实现设计

## 页面

保留当前米白与棕色品牌：背景 #f4efe7，内容 #fffdf9，按钮 #a35d45，正文 #2b2420；字体沿用 PingFang SC、Microsoft YaHei 等既有中文字体。采用纵向列表、固定清晰操作区、独立详情页，避免将桌面横表直接缩放到手机。

`pages/admin/portal` 改为原生总览和五个管理入口。新增 `admin-console` 子包中的列表、详情页，共享已有 `request` 和会话生命周期工具。页面隐藏、卸载、账号切换和过期回包均清除私密状态。

## 服务端

新增 `POST /user/admin/operations`，在 `hlApi` 的现有 ACCESS 会话校验之后，再独立核验业务管理员名单。服务端生成 `miniprogram:user:<id>` 审计身份，不伪装微搭内部用户，也不使用共享管理码。

复用已验证的经营总览、读服务、事务写服务与材料服务，构建为独立 facade。它使用独立、打入 bundle 的 `@cloudbase/node-sdk@3.18.3`，避免与既有 `wx-server-sdk` 的写入封套混用。现有 `/admin/*` 接口不变。

动作仅开放既有管理白名单、`overview` 和 `operations.prepare`。后者仅给已授权管理员生成随机操作编号；客户端确认后使用同一编号提交或重试。认证密钥仅在服务端注入。

## 部署

从当前已核验的线上 hlApi ZIP 生成候选，限定修改 index.js、admin-entry-policy.js，新增一个自包含管理 bundle；原依赖与其他文件逐字节及属性保留。云端环境配置不变，部署前后回读保护摘要与代码文件。

小程序使用完整现有工程构建、预览，不直接发布微搭的独立后台包。正式发布和手机完整链路以实际平台及用户验收为准。
