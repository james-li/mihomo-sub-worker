# 开发进度

更新时间：2026-09-06

## 已完成

- 阶段 0：测试基线、类型检查脚本和 Cloudflare Vitest 环境。
- 阶段 1：`CONFIG_KV`、`ADMIN_KEY`、`USER_KEY`、`ACC4SSR_INI` bindings，路由和 key 鉴权。
- 阶段 2：KV 单键 `config:current`、订阅配置校验、tag 解析、版本冲突检查。
- 阶段 3：管理员订阅编辑页面、安全响应头和管理 API。
- 阶段 4：HTTPS 上游拉取、重定向复验、8 秒超时、2 MiB 流式大小限制、4 路并发。
- 阶段 5：Clash YAML 解析、协议字段校验、节点去重、稳定重命名和 PRIVATE 隔离。
- 阶段 6：ACL4SSR INI、普通正则、`!`、`&&` 和 `!!TAG=` 解析。
- 阶段 7：`select`、`url-test`、`fallback`、`load-balance` 分组以及远程/内联 ruleset 编译。
- 阶段 8：admin/user `clash.yml` 输出；user-key 永远返回 YAML。
- 阶段 9：Cache API 上游/最终结果缓存、过期缓存回退和单源部分失败。
- 阶段 10（主体）：安全 URL 校验、恒定时间 key 比较、CSP、脱敏错误和非敏感状态头。
- v0.2：`url`、`file`、`protocol_url` 三类型配置，文件正文和协议链接随 `config:current` 保存。
- v0.2：Clash YAML、纯文本/Base64 URI 列表自动识别。
- v0.2：Trojan、VLESS、VMess、SS、SSR、Hysteria2 和 TUIC 协议链接解析。
- v0.2：管理员完整文件/协议编辑、文件选择、站点字段预览以及 2 MiB/8 MiB 容量保护。
- 修复：来源 tags 在 ACL 匹配前追加到节点名称，格式为 `原名称 [TAG1] [TAG2]`。
- 修复：`protocol_url` 来源名称优先映射为 Clash 节点 `name`，覆盖 URI fragment 名称。
- 新增：管理员页面展示当前域名的用户订阅二维码；SVG 在 Worker 内生成，仅 ADMIN_KEY 路由可访问且禁止缓存。
- 修复：VLESS/Trojan WebSocket URI 缺少 `host=` 时，使用 SNI/servername/server 补全 `ws-opts.headers.Host`，兼容依赖 Host 路由的服务端。

## 当前验证结果

```text
Test Files  9 passed (9)
Tests       34 passed (34)
TypeScript  passed
Wrangler dry-run passed
Bundle      312.46 KiB / gzip 72.31 KiB
```

## 已部署

- Worker：`fgfwsub-worker`
- 正式域名：`fgfwsub.11190228.xyz`
- 保留测试域名：`fgfwsubtest.11190228.xyz`
- KV：`FGFW` (`4fce6691c9ab419392548465458d76f4`)
- 当前版本：`a008a899-28e2-46f5-97fe-4ce8fef65f2c`
- 线上验证：正式及测试域名的 admin 页面和二维码接口均返回 200；二维码为 `image/svg+xml`、`Cache-Control: no-store`，user-key 不能访问管理二维码接口（404）。

## 后续待完成

1. 用真实 Clash 订阅执行端到端验证和客户端导入测试。
2. 根据真实节点规模记录 CPU、subrequest、输出大小和缓存命中情况。
3. 完成回滚演练。

访问 key 仅保存于 Cloudflare Secrets 和 Git 忽略的本地 `.dev.vars`，不写入版本库。
