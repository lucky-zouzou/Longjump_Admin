# ExchangeRate-API 专用接口

系统从服务端请求 Standard API 的 `latest/CNY`，读取 `conversion_rates`。支持 IDR、MYR、THB、VND、PHP、USD、CNY。外币金额除以对应报价得到人民币；不修改原币金额。

## 私密配置

Node 服务设置 `LOONGJUMP_EXCHANGERATE_KEY_FILE` 指向私密文件；也支持服务端 `EXCHANGERATE_API_KEY` 环境变量。Worker 使用同名加密 Secret。未配置时仍使用 Open Access 接口。已配置但无法读取、无效、未激活或额度耗尽时保留有效缓存并标记刷新失败，不把错误当作零汇率。

本地密钥存入 Git 和 Docker 构建忽略的 `secrets/exchangerate/api_key`，权限 0600。正式部署将 `EXCHANGERATE_API_KEY` 保存到 GitHub Actions 加密 Secret，经 SSH 标准输入交给 `scripts/configure-exchangerate-key.py`，只读挂载至容器。宿主私密目录 0700，文件 0444 以支持容器服务 UID 读取；不写入镜像、日志或返回给浏览器。

## 缓存与核算

按供应商下一次更新时间刷新，并发请求合并，失败后退避一小时。公共与专用快照分别保存，切换配置会立即校验专用接口；同一来源、同一时间戳的报价不被覆盖。超过 36 小时标注陈旧，超过 7 天不再用于外币折算。接口只接收密钥与币种，不发送销售、客户或订单资料。

销售看板选择「人民币口径 → 最新参考汇率估算」。内容罗盘仍优先使用财务月度核定汇率，只有未关账且缺核定汇率时使用参考汇率；已关账核算保持原快照。

官方说明：https://www.exchangerate-api.com/docs/standard-requests
