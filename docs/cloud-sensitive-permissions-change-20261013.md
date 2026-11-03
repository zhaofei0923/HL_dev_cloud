# 四个敏感集合的云端权限调整方案

状态：**用户明确批准后已执行，四项ADMINONLY双读回核通过**。用户回复为“批准调整并回读验证”。调整前后ACL、规则及请求记录保存在`output/cloud-sensitive-permissions-20261013.json`；并未修改业务记录。

执行后`hlApi`仍Active，健康调用`code=0/status=ok`，RequestId为`08c4cf65-4164-4024-bfa0-5eb6724d72b8`；证据`output/cloud-sensitive-permissions-health-20261013.json`。当前仅配置与健康核对完成；真实账号/客户端拒绝及完整业务运行验收仍待完成。

## 具体调整

环境仅限`cloud1-d2gza7q9c8d69c721`（上海）。四集合均真实存在，调整前简易权限为`PRIVATE`、自定义规则为空；现均为`ADMINONLY`，普通小程序/浏览器客户端不能直接读写，业务继续通过`hlApi`进行鉴权和处理。下表保留调整前状态及原始方案记录。

| 集合 | 当前 | 目标 | 调整前读取RequestId |
|---|---|---|---|
| `hl_profiles` | PRIVATE | ADMINONLY | `568352d0-5240-4d70-8ec4-cd8cf5733ef0` |
| `hl_member_private_archives` | PRIVATE | ADMINONLY | `26ccf085-bd77-4419-aec3-99fb6e86627f` |
| `hl_member_identity_claims` | PRIVATE | ADMINONLY | `453718da-64c4-456c-b653-ba73126739c9` |
| `hl_member_certifications` | PRIVATE | ADMINONLY | `4089a914-3cfb-4546-b8cd-bd63cb0f4647` |

PRIVATE允许创建者本人及管理员读写，并非仅服务端。未读取业务文档或执行客户端写入探针，所以没有判定某条既有记录已经被越权读取或修改。项目已有运营说明明确要求这四个集合禁止小程序直接读写。

## 影响核对

当前小程序TS及生成JS没有直接`database()`、`collection()`调用，也没有这四个集合的名称。请求统一通过`miniprogram/services/api.ts`的`wx.cloud.callFunction`进入`hlApi`；会员资料、详情、认证申请和认领均走该业务入口。微搭当前六页CALS也没有数据库调用。

官方说明数据库安全规则限制客户端请求，对云函数等开发者请求不作同样限制；因此目标与当前代码访问方式一致。依赖客户端直接编辑这些集合的外部工具将被禁止，应改走受控接口；本次并未审计项目之外的外部工具。

这项调整不更改文档、认证结果、会员权益、订单、支付配置、人员或应用发布状态，也不部署函数。

## 执行合同与复核

1. 使用已有官方MCP管理登录，显式固定上述环境和上海地域。
2. 修改前再次读取四个集合的`DescribeDatabaseACL`与`DescribeSafeRule`。仅当仍为`PRIVATE`且无自定义规则时继续；若已发生并行变更则停止，不能覆盖。
3. 通过官方manager的NoSQL专用安全规则合同执行每个集合的：

```js
await manager.commonService().call({
  Action: 'ModifySafeRule',
  Param: {
    EnvId: 'cloud1-d2gza7q9c8d69c721',
    CollectionName: '<上述四集合之一>',
    AclTag: 'ADMINONLY'
  }
});
```

不传自定义`Rule`，它仅CUSTOM权限需要。该合同避免依赖旧的通用角色/资源授权接口，不修改OPA或运营账号权限。

4. 每项立即回读`DescribeDatabaseACL/DescribeSafeRule`，确认ADMINONLY，并记录修改及回读RequestId。若部分成功而后续失败，应报告具体状态并停止，不声称四项整体通过。
5. 核对`hlApi`仍Active、健康接口成功；进行只读业务检查后，再安排真实身份/客户端拒绝验证。规则回读不能替代真实账号访问验收。

## 回退

在批准范围内需要恢复时，使用同一官方合同，仅将`AclTag`改为修改前的`PRIVATE`，只操作本次成功调整的集合；回退后再次读取ACL及规则。回退会恢复创建者直接访问能力，应报告恢复原因与未解决风险。不得回退未由本次改动的集合或覆盖并行自定义规则。

## 证据

- [官方权限类别及读写合同](https://docs.cloudbase.net/api-reference/manager/node/rule)
- [数据库安全规则及云函数访问说明](https://cloud.tencent.com/document/product/876/41802)
- 本地完整检查`1034/1034`：`output/full-review-weda-gate-20261013.log`；它不能证明当前云规则已安全。
- 原生微搭设计及接入状态：`docs/weda-admin-readiness-20261013.md`。
