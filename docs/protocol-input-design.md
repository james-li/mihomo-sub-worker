# 多协议订阅与本地上传：原型及技术方案（v0.2）

## 1. 已确认的输入模型

所有来源都保存在现有 Workers KV 的 `config:current` 中，并使用明确的 `type` 区分：

- `url`：HTTPS 远程订阅地址；先安全拉取，再自动识别订阅正文。
- `file`：管理员上传的本地文本文件；文件名、正文和识别格式一起保存在 KV。
- `protocol_url`：单条 `trojan://`、`vless://`、`vmess://` 等协议链接；链接原文保存在 KV。

三类来源使用不同加载方式，但最终都转换为统一的 `TaggedProxy[]`，继续复用 tags、`PRIVATE`、过滤、去重、ACL 和 Clash YAML 输出逻辑。协议链接只被解析为节点配置，不会作为 Worker 的网络请求地址；只有 `type: "url"` 会发起网络请求，并继续只允许经过 SSRF 校验的 HTTPS URL。

## 2. 管理页原型

```text
┌──────────────────────────────────────────────────────────────────┐
│ fgfwsub                                      [复制管理员订阅地址] │
├──────────────────────────────────────────────────────────────────┤
│ 订阅来源                                      [+ 新增来源 ▾]      │
│                                                  远程订阅 URL     │
│                                                  本地文件         │
│                                                  协议链接         │
│                                                                  │
│ ☑ 香港机场      [url] 自动识别          128 节点    [编辑][删除] │
│   https://example.com/sub                  TAG: HK WORK           │
│                                                                  │
│ ☑ 备用配置      [file] backup.txt           9 节点    [替换][删除] │
│   12.4 KiB · Clash YAML / URI 列表             TAG: BACKUP         │
│                                                                  │
│ ☑ 自建节点      [protocol_url] VLESS           1 节点    [编辑][删除] │
│   vless://uuid@example.com:443?...              TAG: PRIVATE        │
│                                                                  │
│ 配置版本 8 · 有未保存修改                           [保存配置]     │
└──────────────────────────────────────────────────────────────────┘
```

新增来源弹层提供三个标签页，公共字段为名称、tags 和启用状态。上传或添加前显示完整校验结果：识别类型、格式、有效节点数、协议分布、错误行及解析出的站点字段。管理员通过 `ADMIN_KEY` 进入，可查看和编辑文件正文、UUID、密码及完整协议链接。

## 3. KV 数据模型

```ts
type SourceType = "url" | "file" | "protocol_url";
type SourceFormat = "auto" | "clash-yaml" | "uri-list" | "base64-uri-list";

interface SourceBase {
  id: string;
  type: SourceType;
  name?: string;
  tags: string[];
  enabled: boolean;
}

interface UrlSource extends SourceBase {
  type: "url";
  url: string;                 // HTTPS，保存时移除 fragment
  format: SourceFormat;        // 默认 auto
}

interface FileSource extends SourceBase {
  type: "file";
  fileName: string;            // 清洗后的展示名
  content: string;             // UTF-8 原文，保存在 config:current
  size: number;
  sha256: string;
  format: SourceFormat;
}

interface ProtocolUrlSource extends SourceBase {
  type: "protocol_url";
  protocolUrl: string;         // 单条协议链接原文，保存在 config:current
  protocol: string;
}

interface AppConfig {
  version: number;
  updatedAt: string;
  sources: Array<UrlSource | FileSource | ProtocolUrlSource>;
}
```

继续只写一个 KV key：`config:current`。文件内容、协议链接和元数据随版本一次写入，避免多个 KV key 在最终一致性传播时出现“配置已更新但正文暂时不可见”。旧配置中没有 `type` 且包含 `url` 的来源，读取时自动视为 `type: "url"`、`format: "auto"`。

文件和协议 URL 中的 UUID、密码会存在 KV。通过 `ADMIN_KEY` 鉴权后，管理 API 返回完整配置：`file` 包含 `content`，`protocol_url` 包含完整 `protocolUrl`，管理页面允许直接查看、编辑、替换和删除。所有管理响应保持 `Cache-Control: no-store`、`Referrer-Policy: no-referrer`，且不开放 CORS，降低包含敏感字段的响应被浏览器缓存或跨站读取的风险。

## 4. 容量与更新边界

Cloudflare KV 当前单 value 上限为 25 MiB，但业务主动限制：

- 单个上传文件最大 2 MiB。
- `config:current` 序列化后的 UTF-8 总大小最大 8 MiB。
- 最多 10 个来源；单来源及最终聚合最多 2,000 个节点。
- 文件只支持 UTF-8 文本，不支持压缩包、二进制或递归编码。

保存前以 `TextEncoder` 计算最终 JSON 字节数，超限返回 `config_too_large`（413）。KV 同一 key 每秒最多写一次；界面在请求期间禁用保存，服务端继续做 version 冲突检查，并把 KV 429 转成可重试错误。

## 5. 按类型加载和解析

```text
source.type
    ├─ url ─────────── HTTPS fetch + Cache API ── parseSubscriptionText
    ├─ file ────────── KV content ─────────────── parseSubscriptionText
    └─ protocol_url ── KV protocolUrl ─────────── parseProtocolUrl
                                                        │
                                                        ↓
       站点/节点字段 → TaggedProxy[] → 清理 → PRIVATE → ACL → clash.yml
```

- `url`：维持 HTTPS/SSRF、8 秒、2 MiB、重定向复验和 stale cache；正文可为 Clash YAML、Base64 URI 列表或纯文本 URI 列表。
- `file`：上传时检查 UTF-8 和大小，预解析后把原文写入 KV；生成时不发网络请求。
- `protocol_url`：只接受一条受支持链接，拒绝换行和控制字符；每个来源产生一个节点。
- `protocol_url` 的来源名称直接映射为生成节点的 `name`。名称优先级为：来源名称 → URI fragment → `协议-server:port`；之后再按统一规则追加 `[TAG]`。

## 6. 格式识别和站点信息

统一识别顺序：移除 BOM/规范换行 → Clash YAML → 最多一层 Base64/Base64URL → 逐行 URI。无有效节点返回 `unsupported_subscription_format`；至少一个有效节点时允许忽略坏行并给出 warning。

协议 parser 提取：节点名、协议、server/port、认证字段、TCP/WS/HTTP/gRPC、TLS/Reality、SNI、ALPN、fingerprint、public-key、short-id、UDP 和协议专属字段。管理员预览返回这些完整站点字段；user-key 端点仍只返回最终 `clash.yml`。

首批支持：

| 输入 | 输出 |
|---|---|
| `trojan://` | Mihomo `trojan` |
| `vless://` | Mihomo `vless`，含 TLS/Reality |
| `vmess://` | v2rayN Base64 JSON → `vmess` |
| `ss://` | SIP002/legacy → `ss` |
| `ssr://` | SSR Base64 → `ssr` |
| `hysteria2://` / `hy2://` | `hysteria2` |
| `tuic://` | `tuic` |

未知 query 参数只生成 warning，不原样注入 YAML。URI fragment 作为节点名，缺失时生成 `协议-server:port`。

## 7. API 原型

| 方法 | 路径 | 行为 |
|---|---|---|
| `GET` | `/<admin-key>/api/config` | 返回完整配置，包括文件正文和协议链接 |
| `PUT` | `/<admin-key>/api/config` | 修改名称、tags、enabled、url 等普通字段 |
| `POST/PUT` | `/<admin-key>/api/sources/file` | 新增或替换文件，原子更新 config:current |
| `POST/PUT` | `/<admin-key>/api/sources/protocol-url` | 新增或替换协议链接，原子更新 config:current |
| `DELETE` | `/<admin-key>/api/sources/:id` | 删除来源并递增版本 |
| `POST` | `/<admin-key>/api/sources/inspect` | 返回完整预解析结果，不保存 |

新增或替换都携带当前 `version`。服务端读取完整配置、校验版本、替换来源、检查最终字节数，然后只执行一次 `CONFIG_KV.put("config:current", ...)`。

## 8. 失败策略

- `url` 拉取失败：优先 stale Cache API，无缓存则跳过。
- `file` 或 `protocol_url` 异常：跳过该源并提示管理员替换。
- 文件中部分坏行：有有效节点则生成并给 warning；零节点则该源失败。
- 所有启用来源都失败或均无节点：返回 502。
- 管理 API 可以返回完整原文和认证字段；运行日志仍只含 sourceId、type、协议、字节数、计数、行号和错误码，避免凭据进入长期日志系统。

## 9. 可验证开发计划

1. **配置模型**：实现三类型联合、旧 URL 配置兼容、完整管理员视图和 8 MiB 检查。验收：三类可混合保存，KV key 仍严格为 `{ "config:current" }`。
2. **解析器**：实现统一文本识别及各协议白名单映射。验收：每种协议至少三组 fixture，可转换为能被 `yaml` 重读的代理对象。
3. **管理 API**：实现 inspect、新增、编辑、替换、删除和版本冲突。验收：管理员能完整读写 file/protocol_url；日志不含测试 UUID/password；超限不写 KV。
4. **管理页**：实现三入口、拖放、完整站点预览和原文编辑。验收：刷新后可继续读取和编辑已保存的文件正文与完整协议链接。
5. **生成集成**：按 type 分派后汇入现有清理/ACL。验收：旧测试全过，混合来源的 admin/user YAML 可由 Mihomo 导入。
6. **部署**：继续绑定现有 `FGFW` KV，不增加 R2/D1/DO。验收：线上三类冒烟通过，KV 中只有 `config:current`。

## 10. 当前确认项

1. 来源类型固定为 `url`、`file`、`protocol_url`。
2. 三类配置及 file/protocol_url 原文都保存在现有 KV 的 `config:current`。
3. 根据 type 使用不同加载方式，再统一提取站点/节点信息并生成 Clash。
4. R2 方案取消，不新增存储 binding。
5. `ADMIN_KEY` 代表完整管理权限，管理 API 不对配置内容和站点认证字段做脱敏；日志及 user-key 路由仍禁止额外泄露。

## 11. Cloudflare 依据

- Workers KV limits：https://developers.cloudflare.com/kv/platform/limits/
- KV 写入与一致性：https://developers.cloudflare.com/kv/api/write-key-value-pairs/
- KV 工作方式：https://developers.cloudflare.com/kv/concepts/how-kv-works/
- Workers limits：https://developers.cloudflare.com/workers/platform/limits/
