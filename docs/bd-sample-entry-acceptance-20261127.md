# BD 寄样申请入口修复验收

日期：2026-11-27。分支：`codex/bd-sample-entry-20261127`。基线：`ded6961`。

## 问题与结果

截图中的“申请寄样”按钮存在，但无符合条件的合作轮次时只展示说明，没有新建合作或处理待确认合作的入口。

经只读核对，问题来自既有合作轮次已有历史寄样记录，不是达人档案读取失败。历史已寄出的合作不能再次作为新样品出库依据，需要先建立独立的新合作轮次。

本次在寄样申请区域增加：

- 选择已有达人发起合作、直接新建达人档案。
- 待接收、待确认、历史已寄出、已存在寄样单等原因和具体处理入口。
- 合作确认后直接进入寄样表单，并选中对应轮次。
- 历史合作入口直接展开原寄样订单号及执行凭据，避免跳转空地址或来回循环。
- 中文和印尼语申请指引。

列表与提交接口共用资格判断，按已确认的 SKU 明细识别申请数量，兼容缺少历史汇总字段的记录。已寄出、已有样品费用、暂停、未确认、其他 BD 或其他站点等限制继续生效。

## 验证

相关自动测试：93 项通过，0 失败。

```bash
node --test tests/marketing-sample-entry.test.mjs tests/marketing-samples.test.mjs tests/marketing-samples-ui.test.mjs tests/creators.test.mjs tests/creator-intake.test.mjs
```

包括申请及重复申请、权限隔离、历史样品费用、SKU 数量、库存审核和发货、签收、独立财务费用、备份恢复，以及申请页面的中印尼语和轮次预选。

最终源码已通过 TypeScript 检查、备份清单校验、Node 生产构建和 `git diff --check`。

浏览器使用独立合成数据实测：

1. BD 从寄样页面选择已有达人，进入其合作需求表单。
2. 提交测试合作，明确勾选确认条件，再进入新轮次的寄样申请。
3. 校验日期 DOM 值、完整收件信息，成功创建待审核样品单。
4. 提交后库存 10 件、锁定 0 件；供应链审核通过后库存仍为 10 件、锁定 2 件。
5. 再次打开申请入口显示“已有寄样单”，可继续原单。
6. 待确认合作、历史寄样凭据、新达人建档的直达入口均正常。
7. 印尼语切换正常；1280 × 720 浏览器页面及完整页面截图已查看。

证据：[本地合成数据截图](evidence/bd-sample-entry-20261127/application-entry.jpg)。

## 本地预览

预览：<http://127.0.0.1:57352/__preview>。仅合成数据，可选择 BD、供应链等测试身份。该预览禁止外部接口调用，数据库固定于 `work/bd-sample-entry-preview/`，不会写入正式数据。

首次生成和启动：

```bash
node scripts/bd-sample-entry-preview.mjs
node server/build.mjs
LOONGJUMP_BD_SAMPLE_ENTRY_PREVIEW=1 LOONGJUMP_DATA_DIR="$PWD/work/bd-sample-entry-preview" node scripts/bd-sample-entry-preview-server.mjs
```

已有预览数据库时生成脚本会停止，避免覆盖测试记录。

## 发布范围

本次仅本地开发和验收，未推送、未部署、未修改正式合作或库存。没有数据库迁移；不包含其他分支的 TikTok 接口、Agent 或模型适配功能。正式站仍使用原流程，待本修复获得发布指令后上线。
