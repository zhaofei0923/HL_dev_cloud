# HL 原生微搭运营后台设计稿

`app.cals.json` 是可保存到微搭设计态的完整 CALS 应用 JSON，包含六个原生页面及导航。当前交付包含**未发布的六页设计稿及运营总览的只读统计接入代码**。其余五页的业务查询、审核等操作仍未接通。保存设计稿不等于发布应用，也不等于获得管理员权限或完成真实业务验收。

云端应用为“HL运营管理后台”，应用ID`app-pq2auygx`。2026-10-13 根据用户反馈重新设计六页；组件以云端已升级的 `gsd-h5-react@3.31.0` 为准。最新保存历史与回读结果见 `output/weda-admin-draft-20261013.json`。

运营总览已进一步改为经营驾驶舱，前次云端历史为 `6774937`；本次统计接入的保存及回读结果见 `cockpit-integration-verification.json`。包括六项关键指标、会员增长/结构、主理人运营、经营收款趋势与套餐构成。仅更新 overview，保留最新云端其他五页及六个布局模板。用户选择的收入分析口径为实付、退款、净收款和套餐构成；已增加独立只读聚合函数 `hlAdminCockpit`，使用可信平台身份实时核验内部管理员。指标定义与接入缺口见 `cockpit-metrics.md`，旧版纯界面验证见 `cockpit-verification.json`；本次接入验证见 `cockpit-integration-verification.json`。

重设计前已备份云历史 `6774762`。修复了 CALS 把无单位行高字符串解释成像素导致的文字重叠，以及旧全局 CSS 将描边按钮文字、背景设成相同绿色导致的空白按钮。新设计沿用小程序暖米白/陶土棕品牌，规范见 `design.md`；`theme.css` 和 `scripts/build-weda-admin-design.mjs` 是可维护的设计源。

## 页面及交互

| 页面 ID | 页面 | 已准备内容 | 后续受控接口 |
|---|---|---|---|
| `overview` | 运营总览 | 六项核心指标、会员增长/结构、主理人运营、经营收款/套餐构成、五个工作入口 | `hlAdminCockpit`；独立只读聚合，保留现有业务接口 |
| `matchmakers` | 主理人审核 | 状态及关键词输入、资料列表字段、审核操作区 | `matchmakers.list/review` |
| `certifications` | 会员认证 | 类型及状态输入、认证列表字段、材料与审核操作区 | `certifications.list/evidence/material/review` |
| `salons` | 沙龙管理 | 状态及关键词输入、沙龙列表字段、审核及取消操作区 | `salons.list/review/cancel` |
| `plans` | 套餐管理 | 套餐列表字段、价格及启停操作占位 | `membership-plans.list`；本阶段仅查看 |
| `orders` | 支付订单 | 支付及履约状态输入、订单列表字段、详情占位 | `payment-orders.list`；本阶段仅查看 |

左侧导航使用官方 `WdMenuLayout` 的内部路由配置。总览中的五个入口使用官方 `navigateTo` 事件格式。本地同版本官方组件已验证六页导航、总览工作入口，以及 H5 折叠菜单跳转；腾讯云编辑器内的实际点击仍待独立验收。

所有业务查询、重置、资料查看、审核、取消、调价和启停按钮均设置 `disabled: true`，且没有业务写入监听器。总览加载生命周期仅调用固定只读统计函数，不直接调用数据库。仅页面跳转入口可点击。筛选框按当前组件合同设置 `status: disabled`，避免让用户输入无法执行的查询。

列表没有演示记录。总览将真实返回值绑定至指标、趋势、套餐构成与脱敏主理人排名；`—` 表示未知或无权限，`0` 表示聚合完成后的真实零值。权限失败时清空旧结果，过期的并发响应不能覆盖最新结果。此接入不证明其余五页审核链路已实现。

## 保存设计稿

1. 使用已确认的 CloudBase 环境 ID 与微搭应用 ID；需要先核验套餐、应用额度和管理身份。
2. 新应用首次保存使用官方 CLI 包内实现的 `UpdateWeAppContentByAppId`：`WeAppId` 为目标应用 ID，`HistoryContent` 为本文件全文，`IsFirstCommit: true`，并填写明确的设计稿提交说明。
3. 更新已有应用时，先读取并备份目标应用最新 CALS，再使用该应用的真实 `CommitBaseline`。不要将 `IsFirstCommit` 用于覆盖既有应用。
4. 保存后重新读取设计稿历史，核对六页、导航、禁用操作和内容。保存 API 是否对当前账号开放须由实际响应确认。
5. 本阶段不调用 `DeployApp`、发布、开通匿名访问或修改数据库权限。官方模板导入 ZIP 与此 CALS 文件是不同机制；不要将该文件包装成自制 ZIP 导入。

这里仅交付设计态资源，管理脚本负责环境核验和保存操作。设计稿中未硬编码环境 ID、应用 ID、用户 ID、密钥或凭据。

## 接口接入边界

总览通过微搭官方 `$w.cloud.callFunction` 调用固定的 `hlAdminCockpit`，由该函数查验本次平台身份并读取最小投影字段。其余管理页面后续可接入独立身份适配层和既有受控管理入口。仅允许固定的运营动作；不得直接给高敏业务集合配置通用 CRUD，也不得从前端传递权限、管理员身份或任意函数名。新版标准套餐自定义APIs不支持自定义代码，不能将纯策略草稿直接配置为微搭自定义API；原生函数的本次身份上下文必须另外核实、适配并运行验证。

服务端必须使用可信的平台身份完成管理员映射、能力授权和审计；订单及套餐保持只读。认证材料与审核应携带真实申请标识，避免审核过期申请。接入后再将真实返回结果绑定到列表及统计，并在对应接口验收通过后逐项开放按钮。

调价、套餐启停、退款、手工履约和补单不在当前已连接的接口范围内。相关按钮只作为禁用占位，不能通过直接解禁获得这些能力。

## 原生格式、组件与视觉来源

- 官方空白应用模板：<https://weda.cloud.tencent.com/tcb-iac-templates/tcb-iac-templates.zip>。沿用 `schemaVersion: 4.0.0`，组件版本、登录等应用配置保留云端最新草稿。
- CALS Schema：`@cloudbase/cals@1.2.25` 中的 `lib/schema/platform_application.json`，已保存至 `vendor/platform-application.schema.json`。
- 当前 `Container`、`WdText`、`WdInput`、`WdButton`、`WdMenuLayout` 合同来自云端 `gsd-h5-react@3.31.0` 官方 control UMD，已保存于 `vendor/component-contracts-3.31.0.json`。不再使用旧公开 npm 包的元数据推断当前组件行为。
- 驾驶舱补充同版本官方 `Line`、`Bar`、`Pie` 合同，实际使用2个 `Line` 和1个 `Pie`（ring）。三图表均显式使用 `variable`，初始空数组，取得统计后绑定真实序列，禁止默认数据源产生组件内置示例数据。圆环未连接数据时只有中性轮廓和“占比待计算”。
- 布局导航文档：<https://docs.cloudbase.net/lowcode/components/wedaUI/src/docs/compsdocs/navmenu/WdMenuLayout>。
- 原生事件格式：<https://docs.cloudbase.net/lowcode/framework/event>。
- 云函数调用文档：<https://docs.cloudbase.net/lowcode/api/cloud>。
- 视觉依据：`miniprogram/app.less` 和小程序底部导航。字体 PingFang SC / Microsoft YaHei；页面 `#F7F3EC`，卡片 `#FFFDF9`，主色 `#A35D45`。内容区沿用小程序 Lucide 图标；原生菜单使用当前组件内置 TDesign 线性图标（data URL 在该菜单会被当作内置图标名，不能直接复用）。旧深绿概念图不再是视觉依据。

`sources.json` 记录官方来源、版本、哈希及页面动作映射。业务读取仅限当前 CloudBase 环境中的受控只读统计；任何本地 QA fixture 均带显著虚构样例标记，不属于交付数据。

## 验证结果与剩余验收

`validation-report.json` 记录当前文件哈希及本地静态验证结果，包括官方应用 Schema、3.31.0 组件属性、明确行高、节点 ID、导航目标和按钮状态。渲染验收另外记录，不能用静态结果代替。

2026-10-13 的六页重设计曾保存为云端历史 `6774856`，完整 JSON 回读与本地一致。`render-verification.json` 记录独立的本地视觉验证：官方 `@cloudbase/lowcode-render@1.1.10` 加载精确的 `gsd-h5-react@3.31.0`，桌面 1440×1000、窄桌面 375×812 / 320×740、模拟 H5 375×812 均检查。新版本没有文字高度压缩、按钮文字隐形或页面横向溢出；手机表格仅在内部横向滚动。H5 菜单抽屉经单独样式覆盖，修复门户节点不继承页面品牌及内部盒模型溢出。

本地预览禁用了云身份和业务调用，仅使用本地静态资源；H5 通过初始化前设置 UA 选择官方手机组件分支，并非真机验收。更新后的首次加载、H5 菜单跳转和输入组件未观察到新增 warning/error；总览 `navigateTo` 跳转后的官方生命周期结束提示单独记录，目标页已实际打开。没有隐藏浏览器异常。

2026-10-14 已部署只读统计函数、核验伪造身份拒绝、回算真实数据并保存微搭历史 `6775626`。仍未完成真实微搭内部管理员成功调用与发布验收；Edge 工具连接失败，本地原生渲染和 IAM 本地回算均不替代该链路。其余五页的审核、材料查看和业务查询尚未接通。四个敏感集合先前已按用户批准改为 ADMINONLY，本次未改这些权限和支付配置。交付状态为“总览只读统计已接入设计稿，应用未发布，管理员正向待验收”。

## 统计接入维护

- 服务端入口：`cloudfunctions/hlAdminCockpit/index.js`，鉴权与只读聚合分别位于 `auth.js`、`service.js`。人数与金额纯聚合模块位于 `cloudfunctions/hlApi/cockpit-*-statistics.js`，仅复用代码，不更新既有 `hlApi/index.js`。
- 页面源：`cockpit-runtime.js`；`scripts/connect-weda-cockpit.mjs` 绑定受审数据状态、handler 和加载生命周期。`scripts/build-weda-admin-design.mjs` 每次重建自动保留接入，其余五页与布局模板保留。
- 构建使用 `scripts/build-cockpit-function.mjs`，将 SDK 与共享策略捆为独立 `index.js`，部署目录不需要跨函数依赖。目标 Nodejs20.19；SDK 精确版本见函数 `package.json`。esbuild 工具目录、SDK 安装目录与输出父目录均由参数指定。
- `scripts/deploy-cockpit-function.mjs` 使用官方已登录 MCP SDK 的 ZIP 直传；新函数名固定，只更新具有本功能构建标记的既有函数。不会发布微搭应用或修改支付配置。
- `scripts/weda-admin-draft.mjs` 只保存既有应用 `app-pq2auygx`，先 backup 再 save，以 CommitBaseline 防止覆盖并行编辑；保存后完整 JSON 回读。
- 验证：`node --test tests/cockpit-*.test.js`；`node scripts/validate-weda-admin-design.mjs`。本地原生组件的虚构样例只能验证绑定与排版，不替代云端真实管理员成功调用。当前部署、真实回算、拒绝访问与剩余验收以 `cockpit-integration-verification.json` 为准。
