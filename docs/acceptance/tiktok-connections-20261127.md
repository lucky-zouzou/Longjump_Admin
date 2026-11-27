# TikTok 连接接口本地验收 · 2026-11-27

范围：LOONG JUMP 的 TikTok Shop、TikTok 广告连接。以本地 Agent 版本 5126f14 为基础；不连接截图中的第三方平台；本次未发布。

已完成：管理员入口、官方授权跳转和回调、一次性 state 与原会话校验、加密 token 保存、店铺 token 刷新、授权账号发现、按账号手动读取、最近快照/错误保留、断开与审计。Shop 读取近 7 天订单；广告读取近 7 个完整日基础报表消耗/展示/点击。严格区分国家、账户编号、币种及时区。

验收：

- `node --test tests/platform-connections.test.mjs`：17/17 通过。覆盖授权、过期/撤权、重放、并发、加密、分页、缺失数据、HTTP 权限及备份恢复。
- `node --test tests/backup.test.mjs tests/permissions.test.mjs tests/workspace-model.test.mjs`：14/14 通过。
- `node scripts/connections-http-smoke.mjs`：实际 Node 服务、临时数据库完成 8 项 HTTP 边界检查；匿名 401、运营 403、管理员 200、跨源 POST 403、缺配置 503、公开回调校验、页面与模块路由均通过。
- TypeScript、Node 生产构建、备份迁移清单校验、`git diff --check` 通过。
- 真实浏览器 1280px 页面检查：管理员可见两个连接卡片；接入说明能展开并滚动到可视区域；运营直接请求被拒绝；documentWidth 与 viewport 都为 1280，无横向溢出。未宣称所有移动断点均已验收。

证据位于忽略目录 `work/connection-acceptance/`，含构建/测试日志与 `connections.jpg`。预览 http://127.0.0.1:57350/__preview/admin 只使用合成账号，禁用外部 fetch，不读取真实密钥。

真实调用限制：当前私密文件仅有空应用字段和新建加密密钥，没有可用平台凭据。官方审批、真实授权和数据对账尚未验收。未启用定时同步，未向业务账册写入，未接入 GMV Max 专项、商品库存、退款或达人平台明细，未把新来源自动喂给 Agent。完整配置、接口和恢复说明见 `docs/integrations/tiktok-connections.md`。
