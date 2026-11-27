# TikTok Shop 与广告连接

本次实现 LOONG JUMP 自有连接页面及 Node 服务端接口。源码基于本地单店 Agent 版本 `5126f14`；没有向极光或其他服务商发送数据。店铺连接和广告连接独立授权。

## 使用与状态

管理员从「产品与系统 → 连接与授权」进入，准备官方应用 → 授权 → 核对实际店铺/广告账户 → 点击「读取最近数据」。普通岗位没有连接管理权限。

页面区分：等待配置、等待授权、已授权、需重新授权、读取未完成、已断开。已授权只代表成功验证账户身份；首次成功读取会显示独立时间戳和统计期间，不能据此声称全部业务数据已经同步。

| 来源 | 已实现读取 | 当前边界 |
| --- | --- | --- |
| TikTok Shop | 商家 token、授权店铺列表、近 7 天创建订单及当前履约状态 | 仅最少订单字段；不保存姓名、电话、地址、买家留言。订单数含取消/未支付，不当作销量和收入。每次最多 20 页，超限整个结果不覆盖旧快照。 |
| TikTok 广告 | token、授权广告账户及国家/币种/时区、近 7 个完整日基础报表消耗/展示/点击 | 使用 v1.3 BASIC/AUCTION_ADVERTISER；按官方账户时区，原币分列。未返回日期不补零。这不是 GMV Max 专项报表。 |

当前是管理员手动读取，不做自动任务调度。数据进入独立快照，重读覆盖同一账户快照，不累加重复数。不覆盖现有手工报表、广告费用、库存或财务账。尚未把新来源自动接入两个 Agent 的结论。首店核对数据口径及店铺映射后再做这一步，尤其马来西亚店铺不能自动归入印尼试点。

## 服务端配置

运行 `node scripts/tiktok-config-init.mjs` 创建两个被 Git 忽略的 0600 私密文件（已有文件不覆盖）：

- `secrets/tiktok_credentials.json`：`shop` 与 `ads` 分别包含 `appId`、`appSecret`、`authorizationUrl`。Shop 的 `appId` 填 App Key；广告填 App ID。授权链接必须是自己应用官方后台生成的链接。
- `secrets/tiktok_token_key.txt`：32 字节随机密钥的 hex 编码，仅供 AES-256-GCM 加密平台 token。

可分别用环境变量 `LOONGJUMP_TIKTOK_CREDENTIALS_FILE`、`LOONGJUMP_TIKTOK_TOKEN_KEY_FILE` 指定绝对文件路径。生产必须挂载持久私密目录。不要将这两个文件写入源码、镜像、浏览器或公开日志。

在官方应用登记准确回调（以实际 `LOONGJUMP_ORIGIN` 为准）：

- `https://admin.loongjump.com/api/connections/callback/shop`
- `https://admin.loongjump.com/api/connections/callback/ads`

Shop 应用使用商家授权而非达人授权。回调地址要在官方后台登记；广告跳转会使用当前站点回调地址。只申请商家身份、订单、广告账户信息及报表读取所需权限。应用审核和账户授权由官方决定，本地测试不代表审核通过。

## 接口契约

所有管理接口要求有效公司管理员会话，POST 要求同源 Origin，响应 no-store。

- `GET /api/connections`：脱敏配置状态、账户、最新快照摘要、近 20 条连接事件。
- `GET /api/connections?account={id}`：指定账户最近快照，明细预览最多 50 条，附实际总条数。
- `POST /api/connections`，`{action:"authorize", provider:"shop"|"ads"}`：生成 10 分钟一次性 state 与独立 HttpOnly/SameSite=Lax 绑定 cookie，返回官方 URL。
- `GET /api/connections/callback/{provider}`：校验 state、浏览器绑定、原公司会话及管理员权限。先消费 state，再换 token 和验证账户。完成后返回无脚本的结果页，点击回系统。公司主会话仍然 SameSite=Strict。
- `POST /api/connections`，`{action:"sync", accountId}`：读取近期数据。Shop 过期前自动刷新 token；同账户并发读取受租约保护；连接变化后旧任务不能写回。
- `POST /api/connections`，`{action:"disconnect", accountId}`：断开本地读取、删除不再使用的加密 token，保留历史快照与事件。平台端撤销需要用户到官方后台取消授权。

Node HTTP 入口拦截以上路由；Worker 版本明确返回未启用，不会在 Worker 中回落到不安全的文件访问或无会话回调。

## 数据与恢复

迁移 `0082_platform_connections.sql` 创建五张独立表，所有写操作有维护锁触发器。授权 token 使用 AES-256-GCM 加密，并以 grant ID 绑定认证上下文。API 不输出 token、Secret、shop cipher、session hash。

业务备份包含加密 token 和最少订单/广告快照，但**不包含加密密钥**。密钥必须在独立私密渠道备份并与对应业务备份配套恢复；丢失密钥时需重新授权。不要重新生成密钥后宣称旧 token 可恢复。OAuth state 虽随数据库存档，恢复后无原登录会话不能继续使用。反向代理如启用访问日志，必须删除回调请求 query（auth code/state），只记录路径与状态；Node 指标不记录回调参数。

## 待真实联调

开发者注册、应用审批、凭据与只读权限尚待官方后台完成。本版不写入真实店铺、不调整预算、不创建订单，不代发消息。测试用模拟响应覆盖授权与读取链路，真实账号授权和订单/广告报表对账仍须凭据就绪后完成。

首店真实验收：确认店名/编号/国家 → 授权账户范围 → 回调验证 → 手动同步 → 对照同期间、同币种官方订单/基础广告报表 → 重读检查不重复 → 取消授权检查失效提示。截图中的马来西亚店铺只归马来西亚；印尼 Agent 另行确认关联。

## 官方资料

- [Shop 商家类型](https://partner.tiktokshop.com/docv2/page/tts-developer-types)
- [Shop 签名](https://partner.tiktokshop.com/docv2/page/wfi3nz36)
- [获取授权店铺](https://partner.tiktokshop.com/docv2/page/6507ead7b99d5302be949ba9)
- [订单列表 202309](https://partner.tiktokshop.com/docv2/page/get-order-list-202309)
- [TikTok 官方 Marketing SDK 授权接口](https://github.com/tiktok/tiktok-business-api-sdk/blob/main/js_sdk/docs/AuthenticationApi.md)
- [TikTok 官方 SDK 广告账户接口](https://github.com/tiktok/tiktok-business-api-sdk/blob/main/js_sdk/docs/AccountManagementApi.md)
- [TikTok 官方 SDK 报表接口](https://github.com/tiktok/tiktok-business-api-sdk/blob/main/js_sdk/docs/ReportingApi.md)
- [基础广告报表口径](https://business-api.tiktok.com/portal/docs/basic-reports/v1.3)
- [报表延迟与口径](https://business-api.tiktok.com/portal/docs/data-latency-for-reports/v1.3)
