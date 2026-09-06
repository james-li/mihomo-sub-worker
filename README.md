# fgfwsub-worker

运行在 Cloudflare Workers 上的 Clash/Mihomo 多协议订阅聚合服务。它提供一个受 `ADMIN_KEY` 保护的管理页面，将远程订阅、本地文件和单条协议链接统一解析为 Clash YAML，并通过独立的 `USER_KEY` 输出过滤后的用户订阅。

## 文档导航

- [部署前准备](#部署前准备)
- [Cloudflare 配置](#cloudflare-配置)
- [本地开发](#本地开发)
- [使用管理页面](#使用管理页面)
- [下载订阅](#下载订阅)
- [ACL4SSR 扩展语法](#acl4ssr-扩展语法)
- [管理 API](#管理-api)
- [缓存与故障降级](#缓存与故障降级)
- [应用限制](#应用限制)
- [安全说明](#安全说明)
- [常见问题](#常见问题)
- [致谢与参考项目](#致谢与参考项目)

## 功能

- 三种订阅来源：远程 HTTPS URL、本地文件上传、单条协议链接。
- 输入格式自动识别：Clash YAML、URI 文本列表、Base64/Base64URL URI 列表。
- 协议支持：Trojan、VLESS、VMess、Shadowsocks、SSR、Hysteria2/Hy2、TUIC。
- 使用 ACL4SSR INI 生成 `proxy-groups` 和 `rules`。
- `proxies` 中每个节点使用单行 flow-style YAML 输出；字符串值统一加双引号，避免 URI path 或密码中的 YAML 特殊字符造成 Mihomo 解析错误。
- 节点名称正则支持取反与组合表达式，例如 `!TAISHAN`、`!TAISHAN&&!LLG`。
- 来源标签会附加到节点名称，例如 `Hong Kong 01 [HK] [WORK]`，便于 ACL 正则匹配。
- 带精确 `PRIVATE` 标签的节点只出现在管理员订阅中，不会进入用户订阅或用户代理组。
- 单个来源失败时跳过该来源并继续生成订阅；存在最近成功缓存时优先使用缓存。
- 管理页面可展示用户订阅地址二维码，二维码在 Worker 内生成，不调用第三方服务。
- KV 只保存订阅源配置，不保存访问密钥、ACL 文件、上游缓存或生成后的 YAML。

## 工作方式

```text
远程 URL ─┐
本地文件 ─┼─> 解析节点 ─> 校验/去重 ─> 追加 tags ─> PRIVATE 隔离 ─> ACL4SSR ─> clash.yml
协议链接 ─┘
```

管理员订阅包含全部有效节点；用户订阅在生成代理组和规则之前移除 `PRIVATE` 节点，因此用户配置中不会留下对私有节点的引用。

## 部署前准备

需要：

- Cloudflare 账号；
- Node.js 20 或更高版本；
- 一个 Workers KV namespace；
- 一份可通过 HTTPS 访问的 ACL4SSR INI；
- 可选：已接入 Cloudflare 的自定义域名。

先克隆仓库并安装锁定版本的依赖：

```bash
git clone <your-repository-url>
cd fgfwsub-worker
npm ci
npx wrangler login
```

## Cloudflare 配置

### 1. 创建并绑定 KV

创建 namespace：

```bash
npx wrangler kv namespace create CONFIG_KV
```

将命令返回的 ID 写入 `wrangler.jsonc`：

```jsonc
{
  "kv_namespaces": [
    {
      "binding": "CONFIG_KV",
      "id": "<YOUR_KV_NAMESPACE_ID>"
    }
  ]
}
```

绑定名称必须保持为 `CONFIG_KV`。应用只使用一个 KV key：`config:current`。

> 当前仓库的 `wrangler.jsonc` 带有原部署环境的 KV ID。复制部署时必须替换为你自己账号下的 namespace ID。

### 2. 配置 ACL4SSR

在 `wrangler.jsonc` 的 `vars` 中设置 ACL4SSR INI 地址：

```jsonc
{
  "vars": {
    "ACC4SSR_INI": "https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/config/ACL4SSR_Online.ini",
    "FILTER_SITE": "剩余流量:流量剩余:套餐到期:订阅到期:traffic remaining:quota remaining"
  }
}
```

`ACC4SSR_INI` 是 Worker 环境变量，不写入 KV。远程地址必须使用 HTTPS，且不能携带 URL 用户名或密码。

`FILTER_SITE` 用于过滤节点名称中的信息或占位节点，多个关键字使用英文冒号 `:` 分隔。匹配会忽略英文大小写、空白差异和全角/半角字符差异。未配置或值为空时使用项目内置关键字；设置后由自定义列表替换默认列表。例如：

```jsonc
{
  "vars": {
    "FILTER_SITE": "剩余流量:套餐到期:官网:Traffic Remaining"
  }
}
```

ACL4SSR 原始项目及配置目录：

- 仓库：[ACL4SSR/ACL4SSR](https://github.com/ACL4SSR/ACL4SSR)
- INI 配置目录：[Clash/config](https://github.com/ACL4SSR/ACL4SSR/tree/master/Clash/config)

可以从原仓库选择适合自己的在线配置，并把对应的 Raw URL 填入 `ACC4SSR_INI`：

| 配置 | 用途 | Raw URL |
|---|---|---|
| Online | 常用在线规则和基础分组，适合作为起点 | [ACL4SSR_Online.ini](https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/config/ACL4SSR_Online.ini) |
| Online Mini | 较少的规则和分组，适合希望保持精简的用户 | [ACL4SSR_Online_Mini.ini](https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/config/ACL4SSR_Online_Mini.ini) |
| Online Full | 包含更多服务分流和地区分组 | [ACL4SSR_Online_Full.ini](https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/config/ACL4SSR_Online_Full.ini) |
| Online Full MultiMode | 完整规则，并提供更多策略选择方式 | [ACL4SSR_Online_Full_MultiMode.ini](https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/config/ACL4SSR_Online_Full_MultiMode.ini) |
| Online MultiCountry | 按更多国家和地区划分节点 | [ACL4SSR_Online_MultiCountry.ini](https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/config/ACL4SSR_Online_MultiCountry.ini) |

必须使用 `raw.githubusercontent.com` 文件地址，不能把 GitHub 的 `blob` 浏览页面地址直接填入环境变量。原仓库还提供去广告、NoAuto、NoApple、Netflix 等变体，可在配置目录中自行选择。

如果需要使用本项目扩展的 `!`、`&&`、`!!TAG=`，或自定义 OpenAI 等分组，请 fork ACL4SSR 仓库、修改所选 INI，然后将 `ACC4SSR_INI` 指向 fork 中对应文件的 Raw URL。

### 3. 配置访问密钥

生成两个不同的高强度随机值：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

分别写入 Cloudflare Secrets：

```bash
npx wrangler secret put ADMIN_KEY
npx wrangler secret put USER_KEY
```

Wrangler 会交互式要求输入值。不要把密钥直接写入 `wrangler.jsonc`、README、提交记录或 CI 日志。`ADMIN_KEY` 与 `USER_KEY` 必须不同。

权限区别：

| 密钥 | 能力 |
|---|---|
| `ADMIN_KEY` | 打开管理页面、读写完整来源配置、预览节点、下载包含 `PRIVATE` 节点的管理员订阅、查看用户二维码 |
| `USER_KEY` | 只能下载已经过滤 `PRIVATE` 节点的用户订阅 |

虽然 `USER_KEY` 权限较低，但它仍是订阅凭据，不建议公开传播。

### 4. 配置访问域名

若使用自定义域名，将 `wrangler.jsonc` 中的 `routes` 替换为自己的域名：

```jsonc
{
  "routes": [
    {
      "pattern": "sub.example.com",
      "custom_domain": true
    }
  ]
}
```

自定义域名必须属于当前 Cloudflare 账号中的有效 Zone，且不能与已有 CNAME 冲突。不使用自定义域名时，可删除仓库中的 `routes`，改用 Cloudflare 分配的 `workers.dev` 地址。

### 5. 生成类型并部署

修改 bindings 后先生成类型，再执行完整验证和部署：

```bash
npm run cf-typegen
npm run typecheck
npm run test:run
npx wrangler deploy --dry-run
npm run deploy
```

部署完成后，Wrangler 会显示 Worker 地址或已绑定的自定义域名。

## 本地开发

复制本地变量模板：

```bash
cp .dev.vars.example .dev.vars
```

Windows PowerShell：

```powershell
Copy-Item .dev.vars.example .dev.vars
```

编辑 `.dev.vars`：

```dotenv
ADMIN_KEY=replace-with-a-random-admin-key
USER_KEY=replace-with-a-different-random-user-key
```

`ACC4SSR_INI` 默认读取 `wrangler.jsonc` 的 `vars`。如需在本地覆盖，也可把它加入 `.dev.vars`：

```dotenv
ACC4SSR_INI=https://example.com/path/to/acl.ini
FILTER_SITE=剩余流量:套餐到期:Traffic Remaining
```

启动本地 Worker：

```bash
npm run dev
```

`.dev.vars*` 已被 Git 忽略，只有不含真实密钥的 `.dev.vars.example` 会进入版本库。

## 使用管理页面

浏览器访问：

```text
https://<YOUR_DOMAIN>/<ADMIN_KEY>
```

管理页面支持新增、启用、禁用、修改和删除来源，并使用配置版本号防止多个页面相互覆盖。保存后配置整体写入 KV 的 `config:current`。

### 来源类型

#### 远程 URL

- 只允许 HTTPS；
- 不允许 URL 中包含用户名或密码；
- 支持 Clash YAML、URI 列表和 Base64 URI 列表；
- 可选择自动识别或手动指定格式；
- URL fragment 可作为标签，例如 `https://example.com/sub#PRIVATE_HK`，保存时 fragment 会从请求 URL 中移除并转为 `PRIVATE`、`HK` 标签。

#### 本地文件

- 支持 `.yaml`、`.yml`、`.txt`、`.conf` 等文本文件；
- 单文件最大 2 MiB；
- 文件正文会完整保存在 KV 中；
- 支持 Clash YAML、URI 列表和 Base64 URI 列表。

#### 协议链接

- 每个来源保存一条完整协议链接；
- 支持 `trojan://`、`vless://`、`vmess://`、`ss://`、`ssr://`、`hysteria2://`、`hy2://`、`tuic://`；
- “来源名称”会覆盖协议链接 fragment，并作为最终节点名称；
- VLESS/Trojan WebSocket 链接未提供 `host=` 时，会依次使用 `sni`、`servername` 或节点服务器地址生成 `ws-opts.headers.Host`；
- 完整协议链接可能包含 UUID、密码或私钥，会原样保存在 KV 中。

### 标签规则

- 标签统一转换为大写并去重；
- 可以使用空格、逗号或下划线分隔；
- 同一来源产生的所有节点继承相同标签；
- 标签在 ACL 匹配前附加到名称，格式为 `原节点名称 [TAG1] [TAG2]`；
- `PRIVATE` 必须是一个完整标签；名称中仅出现 `PRIVATE` 字样不会触发用户过滤。

### 订阅二维码

点击管理页面右上角的“用户订阅二维码”，即可显示当前访问域名对应的用户订阅地址。二维码接口位于管理员路由下，响应设置为 `Cache-Control: no-store`，SVG 中不会以明文文本节点重复写入订阅地址。

## 下载订阅

### 用户订阅

```text
https://<YOUR_DOMAIN>/<USER_KEY>
```

无论 User-Agent 是浏览器、Clash 还是其他客户端，该地址都只返回 `clash.yml`，不会显示 HTML 页面。

使用 Clash/Mihomo User-Agent 验证：

```bash
curl -A "Clash.Meta" -L -o clash.yml "https://<YOUR_DOMAIN>/<USER_KEY>"
```

同时检查响应头和正文：

```bash
curl -A "Clash.Meta" -D - -o clash.yml "https://<YOUR_DOMAIN>/<USER_KEY>"
```

> 当前实现只允许 `GET`，因此使用发送 `HEAD` 请求的 `curl -I` 会得到 `405 Method Not Allowed`。

### 管理员订阅

Clash/Mihomo 客户端携带相应 User-Agent 请求管理员地址时会获得包含全部节点的 YAML：

```bash
curl -A "Clash.Meta" -L -o clash-admin.yml "https://<YOUR_DOMAIN>/<ADMIN_KEY>"
```

浏览器或普通 HTTP 客户端可显式添加 `format=clash`：

```bash
curl -L -o clash-admin.yml "https://<YOUR_DOMAIN>/<ADMIN_KEY>?format=clash"
```

## ACL4SSR 扩展语法

项目支持 ACL4SSR 的 `select`、`url-test`、`fallback`、`load-balance` 分组，并扩展了节点名称筛选语法。

```ini
; 名称包含 TAISHAN
custom_proxy_group=泰山节点`select`TAISHAN

; 名称不包含 TAISHAN
custom_proxy_group=排除泰山`select`!TAISHAN

; 同时不包含 TAISHAN 和 LLG
custom_proxy_group=其他节点`url-test`!TAISHAN&&!LLG`http://www.gstatic.com/generate_204`300,,50

; 名称匹配 HK，同时排除 VIP
custom_proxy_group=普通香港`select`HK&&!VIP

; 精确匹配来源标签 WORK；多个标签使用逗号表示 OR
custom_proxy_group=工作节点`select`.*`!!TAG=WORK,OFFICE
```

表达式说明：

- 普通内容按 JavaScript 正则表达式匹配节点名称；
- `!表达式` 表示正则不匹配；
- `A&&B` 表示两个条件必须同时成立；
- `!!TAG=A,B` 表示节点至少拥有其中一个标签；
- 名称表达式和 `!!TAG=` 同时出现时取交集；
- 非 `select` 分组必须提供健康检查 URL；默认检测间隔为 300 秒。

标签已经出现在节点名称中，因此现有 ACL 正则也可以直接匹配 `\[WORK\]`。`!!TAG=` 则按内部标签精确匹配，不受节点名称文本影响。

## 管理 API

所有管理 API 都必须位于 `/<ADMIN_KEY>/` 下，不提供 CORS。

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/<ADMIN_KEY>/api/config` | 返回完整配置，包括文件正文和完整协议链接 |
| `PUT` | `/<ADMIN_KEY>/api/config` | 使用当前 `version` 保存完整配置 |
| `GET` | `/<ADMIN_KEY>/api/status` | 返回配置版本、来源统计和完整来源信息 |
| `POST` | `/<ADMIN_KEY>/api/preview` | 生成管理员视角预览和站点信息 |
| `GET` | `/<ADMIN_KEY>/api/subscription-qr.svg` | 返回当前域名用户订阅地址的 SVG 二维码 |

配置示例：

```json
{
  "version": 0,
  "sources": [
    {
      "id": "airport-a",
      "type": "url",
      "name": "Airport A",
      "url": "https://example.com/subscription",
      "format": "auto",
      "tags": ["WORK"],
      "enabled": true
    },
    {
      "id": "self-hosted",
      "type": "protocol_url",
      "name": "My VLESS",
      "protocolUrl": "vless://<UUID>@server.example.com:443?security=tls#ignored-name",
      "tags": ["PRIVATE"],
      "enabled": true
    }
  ]
}
```

保存成功后 `version` 自动加一。两个管理页面同时编辑时，后提交的旧版本请求会返回 `409 config_version_conflict`，刷新页面取得最新版本后再修改即可。

## 缓存与故障降级

- 上游订阅、ACL 和远程 ruleset 使用 Cloudflare Cache API，不写入 KV；
- 五分钟内的成功上游缓存直接复用，缓存最长保留约三十分钟用于失败回退；
- 最终生成的 admin/user YAML 按配置版本分别缓存 60 秒；
- 某个来源失败且无缓存时，该来源会被跳过，其他来源仍继续生成；
- 所有已启用来源都失败且没有缓存时返回 502；
- 部分成功响应包含：

```text
X-Fgfwsub-Partial: 1
X-Fgfwsub-Failed-Sources: <数量>
```

响应还包含 `X-Fgfwsub-Node-Count`，用于确认最终节点数量。

## 应用限制

以下是代码主动设置的限制，不代表 Cloudflare 套餐的全部限制：

| 项目 | 限制 |
|---|---:|
| 来源数量 | 10 |
| 单个上传文件 | 2 MiB |
| 单个远程响应 | 2 MiB |
| 完整配置/管理请求体 | 8 MiB |
| 单条协议链接 | 16 KiB |
| 最终节点数量 | 2,000 |
| 上游并发 | 4 |
| 单次上游请求超时 | 8 秒 |
| 最大重定向次数 | 3 |

实际可用规模还受 Cloudflare Workers 与 KV 套餐限制影响。部署较大订阅前请查看 Cloudflare 官方的 [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) 和 [Workers KV limits](https://developers.cloudflare.com/kv/platform/limits/)。

## 安全说明

- `ADMIN_KEY`、`USER_KEY` 使用 Cloudflare Secrets；`ACC4SSR_INI`、`FILTER_SITE` 使用环境变量；这些配置都不会写入 KV。
- KV 中的 `config:current` 会完整保存上传文件、远程订阅地址和协议链接，请限制 Cloudflare 账号及 KV 的访问权限。
- 管理页面、管理 API 和二维码响应均禁止缓存，并设置严格的安全响应头。
- 未知密钥统一返回 404，避免提示某个密钥是否接近有效值。
- 远程来源只接受 HTTPS，并拒绝 URL 凭据、localhost、常见私网 IP 字面量及不安全重定向。
- 密钥位于 URL path 中，可能进入浏览器历史、客户端配置或边缘访问日志；请使用足够长的随机值，避免分享截图和完整 URL，并定期轮换。
- 二维码包含 `USER_KEY` 订阅地址。只应在可信设备上展示或扫描。

轮换密钥时重新执行：

```bash
npx wrangler secret put ADMIN_KEY
npx wrangler secret put USER_KEY
```

旧地址会在新 Worker 版本生效后失效，KV 中的订阅源配置不受影响。

## 常见问题

### 访问地址返回 404

检查域名和密钥是否正确。为避免泄漏鉴权信息，无效密钥和越权子路径都会返回 404。

### 浏览器打开 USER_KEY 后直接下载文件

这是预期行为。用户路由不提供网页，任何 `GET /<USER_KEY>` 都返回 `clash.yml`。

### 保存配置返回 409

当前页面的配置版本已经过期。刷新管理页面，重新应用修改后保存。

### 返回 413

来源数量、上传文件、远程正文或完整配置超过了应用限制。参见“应用限制”。

### 返回 502

常见原因包括：全部订阅源不可用、订阅格式无法解析、ACL4SSR INI 无效、ACL ruleset 获取失败或代理组配置错误。先在管理页面执行“生成预览”，再检查 Cloudflare Worker 日志。

### 配置已更新但订阅短时间没有变化

最终 YAML 使用最长 60 秒缓存。等待缓存过期后重试；配置版本变化通常会使用新的缓存键。

## 开发与测试

```bash
npm run typecheck
npm run test:run
npx wrangler deploy --dry-run
```

测试使用 Cloudflare Workers Vitest 集成，覆盖鉴权、KV 配置、订阅解析、协议转换、ACL 表达式、缓存降级、`PRIVATE` 隔离、二维码和 YAML 输出。

进一步设计资料：

- [技术方案](docs/technical-design.md)
- [多协议输入方案](docs/protocol-input-design.md)
- [开发计划](docs/development-plan.md)
- [开发进度](docs/development-progress.md)

## 提交到 GitHub 前检查

```bash
git status --short
git diff --check
npm ci
npm run typecheck
npm run test:run
npx wrangler deploy --dry-run
```

提交前请确认：

- `.dev.vars`、`.idea/`、日志、真实订阅文件和导出的 `clash.yml` 未被暂存；
- `wrangler.jsonc` 中的 KV ID、域名和 ACL 地址是你确实准备公开的内容；
- README 和测试 fixture 中不含真实 `ADMIN_KEY`、`USER_KEY`、UUID、密码或订阅 URL；
- 仓库根目录已添加与你发布意图一致的 `LICENSE` 文件。

## 致谢与参考项目

本项目的订阅聚合需求与产品思路参考了 [cmliu/CF-Workers-SUB](https://github.com/cmliu/CF-Workers-SUB)。感谢原作者 **cmliu** 及该项目贡献者对 Cloudflare Workers 订阅聚合方案的探索和开源分享。原项目目前已经归档，本项目并非其官方后续版本，也不代表原作者维护或背书。

代理分组及分流规则使用 [ACL4SSR/ACL4SSR](https://github.com/ACL4SSR/ACL4SSR) 提供的 INI 配置与规则生态。感谢 ACL4SSR 的维护者和贡献者持续整理、维护相关规则。

本项目同时使用了以下开源软件：

- [yaml](https://github.com/eemeli/yaml)：解析和生成 YAML；
- [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator)：在 Worker 内生成订阅二维码；
- [Cloudflare Workers SDK](https://github.com/cloudflare/workers-sdk)：本地开发、测试与部署工具链。

引用、修改或分发上游项目的代码与规则时，请分别遵守各上游仓库声明的许可证。本项目自己的许可证以仓库根目录的 `LICENSE` 文件为准。

## Cloudflare 参考文档

- [Workers 文档](https://developers.cloudflare.com/workers/)
- [Wrangler 配置](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [Workers Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Workers KV 入门](https://developers.cloudflare.com/kv/get-started/)
- [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
