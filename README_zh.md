[English](./README.md) | 简体中文

# MCP Gateway

## 简介

MCP Gateway 把多个 MCP 服务收拢到一个入口。默认提供最多 6 个路由工具，Agent 可按需查询下游工具。支持工具搜索的客户端也可手动开启透明聚合，直接调用下游工具。

支持 stdio 和 Streamable HTTP，兼容 MCP `2026-07-28`、`2025-11-25` 和 `2025-06-18`；不支持旧式 `/sse` 入口。

## 快速开始

### 安装

需要 Node.js 24 或更高版本。

```bash
npm install -g @jadchene/mcp-gateway-service
```

按照[配置文件示例](#配置文件)创建 `config.json`，将下游命令、参数和路径替换为已经安装的 MCP 服务配置。

### Stdio

网关进程由 Agent 启动，不需要单独运行启动命令。

Codex：

```bash
codex mcp add gateway -- mcp-gateway-service --config /absolute/path/config.json
```

Claude Code：

```bash
claude mcp add gateway -- mcp-gateway-service --config /absolute/path/config.json
```

请将 `/absolute/path/config.json` 替换为刚创建的配置文件路径。Windows 可使用 `C:/mcp/gateway/config.json` 这样的写法。使用绝对路径可避免依赖客户端的工作目录。

### Streamable HTTP

启动网关：

```bash
mcp-gateway-service --http --config ./config.json
```

默认地址为 `http://127.0.0.1:3000/mcp`。
HTTP 默认隐藏 `gateway_manage_service`。监听非回环地址时需要 Bearer Token。网关默认从环境变量 `MCP_GATEWAY_AUTH_TOKEN` 读取令牌，可通过 `--auth-token-env <名称>` 指定其他环境变量。

Codex：

```bash
codex mcp add gateway --url http://127.0.0.1:3000/mcp
```

Claude Code：

```bash
claude mcp add --transport http gateway http://127.0.0.1:3000/mcp
```

## 配置与工具

### 启动参数

| 参数 | 说明 | 默认值 |
| --- | --- | --- |
| `--config <path>` | 配置文件路径。 | `MCP_GATEWAY_CONFIG`，其次为 `./config.json` |
| `--http` | 启用 Streamable HTTP。 | 不启用 |
| `--host <host>` | HTTP 监听地址。 | `127.0.0.1` |
| `--port <port>` | HTTP 监听端口。 | `3000` |
| `--path <path>` | HTTP endpoint 路径。 | `/mcp` |
| `--auth-token-env <名称>` | 保存 HTTP Bearer Token 的环境变量名。 | `MCP_GATEWAY_AUTH_TOKEN` |
| `--http-admin-tools` | 在已认证 HTTP 入口暴露 `gateway_manage_service`。 | 不启用 |
| `--max-concurrent-requests <数量>` | HTTP 请求和通知长连接分别计数，各自最多允许此数量。 | `64` |
| `--max-request-body-bytes <字节数>` | HTTP 请求体字节上限，最大可配置为 64 MiB，超限返回 `413`。 | `16777216`（16 MiB） |
| `--max-legacy-sessions <数量>` | 有状态旧版 HTTP 会话的保留上限。 | `256` |
| `--version`、`-v` | 输出已安装版本。 | — |

启用 `--http` 后，stdio 入口仍然可用。

### 配置文件

```json
{
  "services": [
    {
      "serviceId": "local-tools",
      "name": "Local Tools",
      "description": "Local MCP service",
      "transport": {
        "type": "stdio",
        "command": "your-mcp-service",
        "args": [
          "--config",
          "/absolute/path/service/config.json"
        ]
      }
    }
  ]
}
```

HTTP 下游和更多配置项见 [config.example.json](config.example.json)。

| 配置 | 使用说明 |
| --- | --- |
| `serviceId` | 每个服务的唯一标识。 |
| `confirmationRequiredTools` | 按下游原始工具名匹配，区分大小写。`*` 匹配任意数量字符，`?` 匹配一个字符。命中时须确认。 |
| `disabledTools` | 使用相同匹配规则，隐藏并禁止调用匹配工具，优先于确认规则。 |
| `transport.cwd`、`transport.args` | 建议使用绝对路径；相对工作目录以网关进程目录为基准。 |
| `transport.env`、`transport.envAllowlist` | 分别提供环境变量值或允许传递的变量名。默认不继承自定义变量；`inheritEnv: true` 才继承完整环境。配置字符串不展开 `${VAR}`。 |
| `logging.path`、`logging.maxBytes` | 日志路径以配置目录为基准，达到大小上限时轮转。 |

配置文件保存后自动重载。如果新配置无效，网关继续使用上一次有效配置。

### 网关工具

在配置文件顶层设置 `"transparentTools": true`，或在 Web 页面的「通用设置」开启「透明聚合模式」并保存。该开关默认关闭。

先调用 `gateway_list_services`，从返回的 `services` 中选取目标服务的 `serviceId`，再按结果顶层的 `transparentTools` 选择调用方式。

- **透明模式（`true`）**：在客户端工具搜索中同时使用返回的 `serviceId` 和操作关键词。例如，若服务 ID 为 `database`，要列出数据表就搜索 `database list tables`。选中当前网关下匹配的工具，按该工具的参数直接调用。
- **路由模式（`false`）**：用返回的 `serviceId` 调用 `gateway_list_tools`，按需通过 `gateway_get_tool_schema` 获取参数定义，再把 `serviceId`、`toolName` 和 `arguments` 传给 `gateway_call_tool`。下游工具无参数时，`arguments` 传 `{}`。

| 网关工具 | 适用模式 | 说明 |
| --- | --- | --- |
| `gateway_list_services` | 两种模式 | 返回当前模式和已启用服务，可按服务标识、描述或可用状态筛选。 |
| `gateway_get_service` | 两种模式 | 查看服务连接状态、协议版本、服务端信息和最近一次错误。 |
| `gateway_manage_service` | 两种模式 | 重连、启用或禁用服务。通过 HTTP 使用时须开启 `--http-admin-tools` 并配置 Bearer Token。 |
| `gateway_list_tools` | 路由模式 | 按名称或描述搜索服务中的工具，可同时返回 schema。 |
| `gateway_get_tool_schema` | 路由模式 | 按准确工具名获取 schema。 |
| `gateway_call_tool` | 路由模式 | 调用一个下游工具并返回 MCP 结果。 |

透明模式下，工具定义的延迟加载和 token 消耗取决于客户端。

工具目录变化时，网关会通知已订阅或监听的客户端。若 Codex 仍显示旧工具，可重新加载 MCP 并打开新会话。

需要人工确认的调用要求客户端支持交互确认。要让 Codex 自动审查网关发起的确认，请在对应服务配置中设置 `"codexAutoReview": true`，并用 `codex -c approvals_reviewer=auto_review` 启动 Codex。下游服务自己的审批需单独配置。

支持 Skills 的 Agent 可以使用仓库内置的 [MCP Gateway Skill](./skills/mcp-gateway/SKILL.md) 完成工具发现和调用。

## 开发

```bash
git clone https://github.com/jadchene/mcp-gateway.git
cd mcp-gateway
npm install
npm run verify
```

按上文创建 `config.json` 后，启动开发服务：

```bash
npm run dev -- --config ./config.json
```

`npm run verify` 会构建服务；之后可用 `npm start -- --config ./config.json` 运行编译产物。

## Web 配置页面

默认关闭，固定监听本机 `127.0.0.1`，无需令牌。使用独立端口，不影响 MCP 通信。

```sh
mcp-gateway-service --config ./config.json --web --web-port 3100
```

打开终端显示的地址，编辑后点击“保存配置”即可生效。也可在配置文件中设置 `"web": { "enabled": true, "port": 3100 }`。启动参数 `--web` 和 `--no-web` 优先于文件配置。修改 Web 开关或端口后需重启网关。

“服务状态”页可启停 stdio 进程或连接、断开 HTTP 服务。手动停止只在本次网关运行期间有效。填写下游服务的 `webUrl` 后，可打开它自己的配置页面。

## 版权声明

[MIT](./LICENSE)
