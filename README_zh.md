[English](./README.md) | 简体中文

# MCP Gateway

## 简介

MCP Gateway 把多个 MCP 服务收拢到一个入口。Agent 连接网关后只会看到 6 个路由工具，具体的下游服务、工具和 schema 在需要时再查询。

项目使用官方 TypeScript SDK v2，需要 Node.js 24 或更高版本。

> [!IMPORTANT]
> MCP Gateway v0.6.2 及后续版本仅接受 MCP `2026-07-28`、`2025-11-25` 和 `2025-06-18`。传输方式仅支持换行分隔 stdio 和单端点 Streamable HTTP。不支持独立 HTTP+SSE（`/sse`）、`Content-Length` framing 和其他协议版本。

## 为什么使用

- 即使配置了很多 MCP 服务，也不会一次性占用大量 Agent 上下文。
- Agent 只需接入一次，后续增减下游服务只改网关配置。
- 可以按名称或描述查找工具，需要时再读取 schema。
- Stdio 和 Streamable HTTP 服务使用同一套调用方式。
- 修改配置文件后自动重载，不必重启网关。

## 快速开始

### 安装

```bash
npm install -g @jadchene/mcp-gateway-service
```

创建 `config.json`，将 `your-mcp-service` 替换为已经安装的 MCP 服务命令：

```json
{
  "services": [
    {
      "serviceId": "tools",
      "name": "Tools",
      "transport": {
        "type": "stdio",
        "command": "your-mcp-service"
      }
    }
  ]
}
```

### Stdio

网关进程由 Agent 启动，不需要单独运行启动命令。

Codex `config.toml`：

```toml
[mcp_servers.gateway]
command = "mcp-gateway-service"
args = ["--config", "./config.json"]
```

Claude Code：

```bash
claude mcp add gateway -- mcp-gateway-service --config ./config.json
```

### Streamable HTTP

启动网关：

```bash
mcp-gateway-service --http --config ./config.json
```

默认地址为 `http://127.0.0.1:3000/mcp`。
HTTP 默认隐藏 `gateway_manage_service`。监听非回环地址时，必须通过 `MCP_GATEWAY_AUTH_TOKEN` 配置 Bearer Token。

Codex `config.toml`：

```toml
[mcp_servers.gateway]
url = "http://127.0.0.1:3000/mcp"
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
| `--max-concurrent-requests <数量>` | HTTP 并发请求上限。 | `64` |
| `--version`、`-v` | 输出已安装版本。 | — |

启用 `--http` 后，stdio 入口仍然可用。

### 配置文件

```json
{
  "logging": {
    "enable": false,
    "path": "./logs/mcp-gateway.log"
  },
  "services": [
    {
      "serviceId": "local-tools",
      "name": "Local Tools",
      "transport": {
        "type": "stdio",
        "command": "your-mcp-service",
        "args": []
      }
    },
    {
      "serviceId": "remote-tools",
      "name": "Remote Tools",
      "transport": {
        "type": "http",
        "url": "http://127.0.0.1:3200/mcp"
      }
    }
  ]
}
```

| 字段 | 说明 |
| --- | --- |
| `services` | 下游 MCP 服务列表。 |
| `serviceId` | 必填，网关工具使用的唯一服务标识。 |
| `name` | 必填，服务名称。 |
| `description` | 可选，服务说明。 |
| `enable` | 可选，默认为 `true`。 |
| `callTimeoutMs` | 可选，下游工具调用超时；默认 120 秒。 |
| `transport.type` | `stdio` 或 `http`。 |
| `transport.command` | stdio 服务必填，启动命令。 |
| `transport.args` | stdio 服务的可选命令参数。 |
| `transport.cwd` | stdio 服务的可选工作目录。 |
| `transport.env` | stdio 服务的可选环境变量。 |
| `transport.inheritEnv` | 是否继承网关完整环境；默认为 `false`。 |
| `transport.envAllowlist` | 额外传递给 stdio 服务的进程环境变量名。 |
| `transport.url` | HTTP 服务必填，Streamable HTTP 地址。 |
| `transport.headers` | HTTP 服务的可选静态请求头。 |
| `logging.enable` | 是否写入文件日志，默认为 `false`。 |
| `logging.path` | 日志文件路径；相对路径按配置文件目录解析。 |
| `logging.maxBytes` | 当前日志轮转前的大小上限；默认 10 MiB。 |

网关会监听配置文件变化。配置有误时不会替换当前配置，服务继续按最后一次有效配置运行。其他示例见 [config.example.json](./config.example.json)。

### 网关工具

| 工具 | 说明 |
| --- | --- |
| `gateway_list_services` | 列出已配置的服务及其可用状态。 |
| `gateway_get_service` | 查看服务连接状态、协议版本、服务端信息和最近一次错误。 |
| `gateway_list_tools` | 按名称或描述搜索服务中的工具，可同时返回 schema。 |
| `gateway_get_tool_schema` | 获取准确工具名称对应的 schema。 |
| `gateway_manage_service` | 重连服务，或在配置文件中启用、禁用服务。 |
| `gateway_call_tool` | 调用一个下游工具并返回 MCP 结果。 |

通常按 `gateway_list_services` → `gateway_list_tools` → 按需调用 `gateway_get_tool_schema` → `gateway_call_tool` 的顺序使用。下游工具没有参数时，`gateway_call_tool` 的 `arguments` 传 `{}`。

工具调用会保留下游工具原有的副作用和确认规则。状态不确定的 `gateway_call_tool` 失败不会自动重放。通过 `gateway_manage_service` 启用或禁用服务会原子更新配置文件。

支持 Skills 的 Agent 可以使用仓库内置的 [MCP Gateway Skill](./skills/mcp-gateway/SKILL.md) 完成工具发现和调用。

## 开发

```bash
git clone https://github.com/jadchene/mcp-gateway.git
cd mcp-gateway
npm install
npm run verify
npm run dev -- --config ./config.json
```

构建并运行编译产物：

```bash
npm run build
npm start -- --config ./config.json
```

## 版权声明

[MIT](./LICENSE)
