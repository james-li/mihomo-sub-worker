# fgfwsub Worker 开发计划

## 1. 执行原则

- 按阶段顺序实施；当前阶段的自动化测试和验收条件全部通过后，才进入下一阶段。
- 每个阶段保持 Worker 可启动、测试可运行，不提交长期不可用的中间状态。
- 所有外部订阅、ACL4SSR INI 和 ruleset 测试均使用脱敏 fixture 或拦截后的 mock，不依赖真实机场订阅。
- 每阶段至少运行 `npm test`；修改 `wrangler.jsonc` bindings 后必须运行 `npm run cf-typegen`。
- 部署前运行完整测试、类型检查和本地 Worker 集成测试。

## 2. 全局完成标准

项目只有同时满足以下条件才视为 MVP 完成：

1. `/<admin-key>` 可以加载、编辑并保存订阅源。
2. `/<admin-key>?format=clash` 能下载包含全部节点的 `clash.yml`。
3. `/<user-key>` 对任何 User-Agent 都只返回 `clash.yml`，且完全排除 `PRIVATE` 节点。
4. ACL4SSR 能生成有效的 `proxy-groups` 和 `rules`，支持普通正则、`!TAISHAN`、`!TAISHAN&&!LLG`、`HK&&!VIP` 和 `!!TAG=`。
5. 单个订阅源失败时仍使用其他成功源生成 YAML；全部源失败且无缓存时返回 502。
6. KV 只包含 Clash 订阅源配置，不包含访问 key、ACL、上游响应、节点或生成后的 YAML。
7. 输出能被 YAML 解析器重新解析，所有 proxy-group/rule 引用均有效。
8. 日志和错误响应不泄漏 key、订阅 URL 凭据、UUID、密码或节点原文。

## 3. 阶段计划

### 阶段 0：建立测试基线

目标：建立稳定的开发门禁，证明初始项目可运行。

工作内容：

- 保留 Cloudflare Vitest 集成方式，补充独立的类型检查脚本。
- 建立 `test/fixtures/`，加入最小 Clash YAML、ACL INI 和 ruleset 样例。
- 建立统一测试辅助函数，用于创建 Request、mock KV 和 mock upstream fetch。
- 记录 Node、Wrangler、Vitest 版本，避免本地与 CI 行为漂移。

自动验证：

```powershell
npm test -- --run
npx tsc --noEmit
```

完成条件：

- 初始测试和类型检查退出码均为 0。
- fixture 不含真实订阅地址、密码、UUID 或访问 key。

### 阶段 1：环境绑定、路由和鉴权

目标：Worker 能准确区分管理员、只读订阅和未知路径，但尚不生成真实订阅。

工作内容：

- 在 `wrangler.jsonc` 声明 `CONFIG_KV` binding。
- 声明必需环境配置：`ADMIN_KEY`、`USER_KEY`、`ACC4SSR_INI`。
- `ADMIN_KEY`、`USER_KEY` 使用 secrets；本地通过 `.dev.vars` 提供占位值。
- 实现 key 摘要比较和角色判断。
- 建立路由：admin 页面、admin API、admin Clash 输出、user Clash 输出、404。

自动验证：

```powershell
npm run cf-typegen
npm test -- --run
npx tsc --noEmit
```

必须覆盖的断言：

- 正确 admin-key 返回管理页面占位响应。
- 正确 user-key 返回 YAML 类型占位响应，不返回 HTML。
- admin/user key 互换不会越权。
- 未知 key、额外路径和不支持的方法返回 404/405。
- 缺少或重复的 key 配置导致明确的启动/请求错误。

完成条件：路由矩阵测试全部通过，任何错误正文和日志中均不出现原始 key。

### 阶段 2：KV 订阅配置模型与管理 API

目标：管理员能够可靠读取和保存 Clash 订阅源配置，且 KV 不保存其他数据。

工作内容：

- 实现 `AppConfig` schema、默认配置、版本号和更新时间。
- URL fragment 按 `_` 拆成 tags，统一大写、去空、去重；保存的 URL 移除 fragment。
- 实现管理员配置读取和更新 API。
- 加入请求体大小、订阅数量、URL 长度及 HTTPS 校验。
- 使用版本号实现乐观并发控制，避免两个页面相互覆盖。

自动验证：

```powershell
npm test -- --run test/config.spec.ts
```

必须覆盖的断言：

- `https://example.com/sub#PRIVATE_HK_PRIVATE` 保存为 URL `https://example.com/sub` 和 tags `PRIVATE, HK`。
- 非 HTTPS、无效 URL、超限请求返回 400/413。
- 非管理员不能读取或修改配置。
- 版本冲突返回 409。
- mock KV 的写入记录中只有 `config:current`。

完成条件：导出测试中的 KV keys 后，集合严格等于 `{ "config:current" }`。

### 阶段 3：管理员页面

目标：`/<admin-key>` 提供可实际操作的订阅编辑器。

工作内容：

- 将确认后的原型实现为 Worker 返回的管理页面。
- 支持加载、新增、启用/禁用、删除、编辑 URL、解析 tag 和保存。
- 显示逐源校验错误、配置版本和更新时间。
- 页面不显示节点认证信息；所有动态文本安全渲染。
- 增加严格 CSP、`frame-ancestors 'none'`、`Referrer-Policy: no-referrer` 和 `Cache-Control: no-store`。

自动验证：

```powershell
npm test -- --run test/admin-ui.spec.ts
```

手工验证：

```powershell
npm run dev
```

在浏览器完成一次“新增带 tags 的订阅 → 保存 → 刷新页面 → 配置仍存在”。

完成条件：上述交互成功，浏览器控制台无错误，管理页面响应不被缓存，恶意节点名/URL 文本不能注入 HTML。

### 阶段 4：订阅安全拉取与 Clash 输入解析

目标：Worker 能从多个 HTTPS 源取得并解析 Clash YAML，同时隔离单源错误。

工作内容：

- 实现 HTTPS URL 校验、超时、响应体大小限制、最多 3 次重定向并逐跳复验。
- 并发上限设为 4。
- 解析顶层 `proxies` 数组，保留 Clash proxy 的完整字段。
- 将来源 tags 附加到内存中的节点元数据，不写回 proxy 对象。
- 返回逐源状态：成功、超时、HTTP 错误、格式错误、超限。

自动验证：

```powershell
npm test -- --run test/upstream.spec.ts test/clash-parse.spec.ts
```

必须覆盖的断言：

- 3 个源可并发成功解析并保持确定性顺序。
- 1 个源超时不影响另外 2 个源。
- HTML、空 YAML、无 `proxies`、超大响应被拒绝。
- fragment 不出现在发往上游的 Request URL 中。
- localhost、私网 IP 字面量和不安全重定向被拒绝。

完成条件：混合成功/失败用例能返回全部成功节点以及准确的逐源错误列表。

### 阶段 5：信息节点过滤、去重和可见性

目标：得到干净、名称唯一，并按 admin/user 正确隔离的节点集合。

工作内容：

- 实现协议必要字段校验和信息关键词过滤。
- 使用协议、server、port 和认证主键摘要计算身份指纹。
- 合并重复节点 tags；为不同节点的重名项增加稳定序号。
- admin 保留全部节点；user 在任何分组计算之前删除带精确 `PRIVATE` tag 的节点。

自动验证：

```powershell
npm test -- --run test/clash-filter.spec.ts
```

必须覆盖的断言：

- “剩余流量 20GB”等无连接字段的信息节点被删除。
- 名称含“流量”但协议字段完整的真实节点不被误删。
- 重复节点只保留一次并合并 tags。
- user 输出节点集合完全不含 `PRIVATE`；`PRIVATE-HK` 不等于 `PRIVATE`。
- 输入顺序一致时，重命名和输出顺序稳定。

完成条件：过滤结果快照稳定，并通过“公开集合是管理员集合子集”的属性测试。

### 阶段 6：ACL4SSR INI 与名称表达式解析

目标：把 `ACC4SSR_INI` 解析成可验证的中间结构。

工作内容：

- `ACC4SSR_INI` 保存 ACL4SSR INI 文件的 HTTPS URL。
- 解析 `ruleset`、`custom_proxy_group`、`enable_rule_generator` 和 `overwrite_original_rules`。
- 保留传统节点名正则。
- 实现 `!` 取反和 `&&` 逻辑 AND。
- 实现 `!!TAG=A,B` 精确 tag OR 过滤，并与名称表达式取交集。
- 检测非法正则、未知 group 类型和直接/间接循环引用。

自动验证：

```powershell
npm test -- --run test/acl-parse.spec.ts test/group-expression.spec.ts
```

表达式真值表必须覆盖：

| 表达式 | `TAISHAN-HK` | `LLG-US` | `HK-VIP` | `HK-01` |
|---|---:|---:|---:|---:|
| `TAISHAN` | 是 | 否 | 否 | 否 |
| `!TAISHAN` | 否 | 是 | 是 | 是 |
| `!TAISHAN&&!LLG` | 否 | 否 | 是 | 是 |
| `HK&&!VIP` | 是 | 否 | 否 | 是 |

完成条件：真值表、tag 组合和错误用例全部通过；解析结果不依赖网络。

### 阶段 7：ACL ruleset 与 proxy-group 编译

目标：将 ACL 中间结构和节点集合编译成引用完整的 Clash 分组与规则。

工作内容：

- 支持 `select`、`url-test`、`fallback` 和 `load-balance`。
- 解析显式成员 `[]组名`、`[]DIRECT`、`[]REJECT`。
- 拉取远程 ruleset，并转换普通规则、`[]GEOIP` 和 `[]FINAL`。
- 删除空分组并清理无效引用；无法安全清理时返回编译错误。
- 公开订阅仅以过滤后的 user 节点集合编译分组。

自动验证：

```powershell
npm test -- --run test/acl-compile.spec.ts
```

必须覆盖的断言：

- `!TAISHAN&&!LLG` 分组只包含符合真值表的节点。
- PRIVATE 节点名不出现在 user 的任何 group 中。
- 所有 rule 目标 group 都存在。
- `FINAL` 转为 `MATCH,<group>`，`GEOIP` 输出正确。
- 空组、循环组和失败 ruleset 的行为符合设计。

完成条件：对编译结果运行引用完整性检查，结果为 0 个悬空引用。

### 阶段 8：Clash YAML 生成和下载端点

目标：生成能够被 Clash/YAML 解析器接受的完整配置文件。

工作内容：

- 按基础字段、`proxies`、`proxy-groups`、`rules` 的固定顺序序列化。
- admin 根据浏览器/User-Agent 或 `?format=clash` 协商页面与 YAML。
- user 不做 User-Agent 协商，始终返回 YAML。
- 文件名固定为 `clash.yml`，生成稳定 ETag。

自动验证：

```powershell
npm test -- --run test/clash-render.spec.ts test/routes.spec.ts
```

必须覆盖的断言：

- 输出 YAML 可以重新 parse，且基础模板字段值正确。
- `GET /<user-key>` 携带浏览器、Clash、空 User-Agent 时均返回 `text/yaml`，正文不含 HTML。
- 响应包含 `Content-Disposition: attachment; filename="clash.yml"`。
- 相同输入得到完全相同的正文和 ETag。

完成条件：至少使用一种真实 Clash 客户端手工导入脱敏测试配置成功。

### 阶段 9：缓存与部分失败

目标：减少重复上游请求，并保证单个订阅源失败时仍能产出配置。

工作内容：

- 使用 Cache API 缓存订阅源、ACL/ruleset 和最终 admin/user YAML。
- 缓存键包含 URL 摘要、配置版本和可见性，不包含明文访问 key。
- 单源失败时优先使用该源最近成功缓存；无缓存则跳过。
- 部分成功响应增加 `X-Fgfwsub-Partial: 1`。
- 所有订阅源失败且无缓存时返回 502。
- 缓存只使用 Cache API，禁止写入 KV。

自动验证：

```powershell
npm test -- --run test/cache.spec.ts test/partial-failure.spec.ts
```

场景矩阵：

| 成功源 | 失败源 | 失败源缓存 | 预期 |
|---:|---:|---|---|
| 2 | 1 | 无 | 200，使用 2 个源，Partial=1 |
| 2 | 1 | 有 | 200，使用成功源和缓存，Partial=1 |
| 0 | 3 | 有 | 200，使用可用缓存，Partial=1 |
| 0 | 3 | 无 | 502 |

完成条件：矩阵全部通过，并再次断言 KV 只有 `config:current`。

### 阶段 10：安全、日志和可观测性

目标：生产错误可定位，同时不泄漏订阅和节点秘密。

工作内容：

- 结构化记录 requestId、角色、sourceId、阶段、耗时、状态和节点数量。
- 实现 URL、key、UUID、密码、token 的日志脱敏。
- 管理响应增加安全头；关闭不需要的 CORS。
- 统一 400、404、405、409、413、502、500 错误结构。
- 设置 CPU/subrequest 防失控限制和合理的上游数量上限。

自动验证：

```powershell
npm test -- --run test/security.spec.ts test/observability.spec.ts
```

完成条件：向系统注入已知 canary secret 后，扫描全部测试日志和错误响应均无 canary；安全头断言全部通过。

### 阶段 11：完整回归和容量验证

目标：证明系统在预期规模内稳定运行。

工作内容：

- 构造 10 个订阅源、每源 100 个节点的脱敏数据集。
- 记录拉取、解析、过滤、ACL 编译、序列化各阶段耗时。
- 验证最多 4 个并发上游请求和 subrequest 预算。
- 检查输出大小、CPU 时间、内存趋势和缓存命中效果。

自动验证：

```powershell
npm test -- --run
npx tsc --noEmit
npx wrangler deploy --dry-run
```

完成条件：

- 1,000 节点数据集生成成功且引用完整。
- 无未处理 Promise rejection、无超时测试、无随机顺序快照变化。
- dry-run 成功，Worker bundle 大小处于 Cloudflare 当前限制以内。
- 若实测 CPU 无法稳定满足 Free 计划限制，部署说明明确要求 Workers Paid，而不是降低正确性。

### 阶段 12：预发布、生产部署和回滚演练

目标：验证真实 Cloudflare 环境，并具备可执行的回滚路径。

工作内容：

- 创建预发布 KV namespace 和环境变量/secrets。
- 在预发布环境配置脱敏订阅，完成 admin/user 端到端验收。
- 确认 KV 中只有 `config:current`。
- 部署生产版本，保存前一 Worker version 标识。
- 演练回滚到前一版本，确认 KV 配置保持不变。

验证命令：

```powershell
npm run cf-typegen
npm test -- --run
npx tsc --noEmit
npx wrangler deploy --env staging
```

生产部署需在预发布验收后单独执行：

```powershell
npm run deploy
```

完成条件：

- 预发布 admin 保存、完整订阅下载、user PRIVATE 隔离、单源失败降级全部通过。
- 生产 smoke test 通过。
- 回滚操作经过实际演练并记录版本号、命令和验证结果。

## 4. 建议的提交边界

每个阶段至少一个独立提交，推荐提交顺序：

```text
test: establish worker test baseline
feat: add bindings routing and key authorization
feat: persist subscription configuration in kv
feat: add admin subscription editor
feat: fetch and parse clash subscriptions
feat: filter deduplicate and isolate private proxies
feat: parse acl4ssr groups and match expressions
feat: compile acl4ssr groups and rules
feat: render clash yaml endpoints
feat: add caching and partial failure handling
chore: harden security and observability
test: add full regression and capacity coverage
```

每个提交都必须满足 `npm test -- --run` 和 `npx tsc --noEmit`，避免把验证工作推迟到最后。
