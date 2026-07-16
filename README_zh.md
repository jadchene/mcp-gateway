[English](./README.md) | 简体中文

# MCP Gateway

MCP Gateway 是一个轻量级 Model Context Protocol 网关，用一个小型 MCP 入口管理多个下游 MCP 服务。

它不会在客户端启动时把所有下游工具直接展开，而是提供固定的发现和转发 API。Agent 可以先列出服务，再查看某个服务的工具，按需获取单个工具 schema，最后转发真实工具调用。

## 功能

- 用一个 MCP 入口接入多个下游 MCP 服务。
- 通过固定的小型网关工具面实现按需发现，减少初始 token 消耗。
- 支持 stdio 和 Streamable HTTP 下游传输。
- 可通过 CLI 参数启用入站 Streamable HTTP。
- 支持服务池配置热刷新。
- 热刷新时会停止已删除、已禁用或配置被替换的下游服务。
- 下游进程失败后最多自动重启 3 次，然后标记为不可用。
- 配置刷新是原子的，新配置无效时保留上一份有效配置。
- 支持可选的换行 JSON 文件日志，不把运行日志写入 MCP stdout。
- 支持通过 `--version` 或 `-v` 查看版本。

## 为什么使用它

- 简化 Agent 侧 MCP 配置：每个 Agent 只连接网关，下游服务统一在一个配置文件中管理。
- 减少初始工具上下文：Agent 只发现当前任务需要的服务、工具和 schema。
- 集中管理服务生命周期，避免在多个客户端中重复维护命令路径、环境变量和密钥。

## 快速开始

全局安装：

```bash
npm install -g @jadchene/mcp-gateway-service
```

创建本地配置：

```bash
cp config.example.json config.json
```

启动 stdio 网关：

```bash
mcp-gateway-service --config ./config.json
```

启动入站 Streamable HTTP：

```bash
mcp-gateway-service --config ./config.json --http --host 127.0.0.1 --port 3100 --path /mcp
```

如果 HTTP 客户端希望 `POST` 直接返回 JSON-RPC 响应，可启用无状态 JSON 直返：

```bash
mcp-gateway-service --config ./config.json --http --port 3100 --path /mcp --json-response
```

查看安装版本：

```bash
mcp-gateway-service --version
mcp-gateway-service -v
```

## 配置

通过 CLI 参数指定配置文件：

```bash
mcp-gateway-service --config ./config.json
```

或通过环境变量指定：

```bash
MCP_GATEWAY_CONFIG=./config.json mcp-gateway-service
```

如果两者都没有提供，服务会尝试读取当前工作目录下的 `config.json`。

配置示例：

```json
{
  "logging": {
    "enable": false,
    "path": "./logs/mcp-gateway.log"
  },
  "services": [
    {
      "serviceId": "demo-echo",
      "enable": true,
      "name": "Demo Echo Service",
      "description": "Sample echo MCP service.",
      "transport": {
        "type": "stdio",
        "command": "node",
        "args": [
          "--experimental-strip-types",
          "examples/echo-service.ts"
        ]
      }
    },
    {
      "serviceId": "remote-http",
      "enable": false,
      "name": "Remote Streamable HTTP Service",
      "description": "Example downstream MCP service over Streamable HTTP.",
      "transport": {
        "type": "http",
        "url": "http://127.0.0.1:3200/mcp",
        "headers": {
          "Authorization": "Bearer ${MCP_TOKEN}"
        },
        "enableJsonResponse": false
      }
    }
  ]
}
```

配置说明：

- `logging.enable` 默认为 `false`。
- 只有 `logging.enable` 为 `true` 时，`logging.path` 才必填。
- 相对 `logging.path` 会按配置文件所在目录解析。
- 服务 `enable` 默认为 `true`；设为 `false` 时跳过该服务。
- stdio 服务的 `cwd` 和 `env` 可选。
- stdio `transport.framing` 可为 `line` 或 `content-length`。不填写时网关先尝试 `line`，再尝试 `content-length`。
- HTTP 下游服务使用 `transport.type: "http"` 和 `transport.url`。
- HTTP `transport.headers` 用于提供静态请求头。
- HTTP `transport.enableJsonResponse` 为该下游服务启用无状态 JSON 直返模式。

## 入站 Streamable HTTP

入站 HTTP 只有传入 `--http` 时才会启用。只传 `--host`、`--port`、`--path` 或 `--json-response`，但不传 `--http`，不会启动 HTTP 监听。

HTTP endpoint 使用同一路径处理 `GET` 和 `POST`：

- `GET /mcp` 打开 SSE 读取通道，并通过 `Mcp-Session-Id` 响应头返回 session。
- `POST /mcp` 发送 JSON-RPC 消息。新客户端应通过 `Mcp-Session-Id` 请求头绑定 session。
- 为兼容旧客户端，仍接受 query string 中的 `sessionId`。
- `endpoint` SSE 事件只返回统一路径，例如 `/mcp`。

## 网关工具

网关暴露 6 个公开工具：

| 工具 | 用途 |
| --- | --- |
| `gateway_list_services` | 列出下游服务及其逻辑 `serviceId`、描述和当前可用状态。 |
| `gateway_get_service` | 返回服务标识、可用状态、最近错误和连接时间、协议版本及服务端信息，主要用于诊断。 |
| `gateway_list_tools` | 按不区分大小写的字面子串搜索工具名称或描述。可选的唯一非空 `toolName` 和 `desc` 数组使用 OR；`includeSchema: true` 会附带 schema。 |
| `gateway_get_tool_schema` | 按唯一、准确、区分大小写的工具名返回 schema，并以名称为 key；任一名称未知时整批失败。 |
| `gateway_manage_service` | 不修改配置地重连服务，或持久化启用/禁用配置并重载注册表。 |
| `gateway_call_tool` | 调用一个准确的下游工具并原样转发结果；下游工具可能包含读写副作用。 |

默认的节省 token 流程：

1. 调用一次 `gateway_list_services`。
2. 真正需要某个服务时，再调用 `gateway_list_tools(serviceId)`。用 `toolName` 数组按名称关键词筛选，或用 `desc` 数组按描述关键词筛选。
3. 所有筛选结果都需要 schema 时，传入 `includeSchema: true`；已知准确工具名时，调用 `gateway_get_tool_schema` 并传入非空名称数组。
4. 调用 `gateway_call_tool` 执行下游工具。
5. 只有诊断时才使用 `gateway_get_service`。
6. 只有需要重连、启用或禁用服务时才使用 `gateway_manage_service`。

`gateway_get_tool_schema.toolName` 必须是唯一非空字符串数组，返回的 `schemas` 对象以每个准确工具名为 key。只查询一个 schema 时使用单元素数组。

`gateway_list_tools.toolName` 和 `gateway_list_tools.desc` 都是可选的唯一非空字符串数组，按字面子串进行不区分大小写的匹配。同时传入时，只要工具名称或描述匹配任一关键词就会返回。描述匹配也可能命中 “when not to use” 等负向说明，因此选择工具前应检查完整描述。

所有具有稳定结构化结果的网关工具都声明了 `outputSchema`。`gateway_call_tool` 会转发任意下游结果，因此不声明固定输出 schema；其 `arguments` 对象始终必填，下游工具无参数时传 `{}`。

`gateway_manage_service` 动作：

- `reconnect`：不修改配置，只重试当前下游服务生命周期。
- `enable`：把该服务的 `enable: true` 持久化到配置文件，然后刷新配置。
- `disable`：把该服务的 `enable: false` 持久化到配置文件，然后刷新配置。

## Skill 集成

仓库内包含一个公开网关 skill：

- Skill 路径：`skills/mcp-gateway/SKILL.md`

当你的 Agent 支持 skills 时建议加载它。它会保持按需发现、节省 token，并通过最小网关契约转发下游调用。

## MCP 客户端配置

Codex：

```toml
[mcp_servers.gateway]
command = "mcp-gateway-service"
args = ["--config", "./config.json"]
```

Gemini CLI：

```json
{
  "mcpServers": {
    "gateway": {
      "type": "stdio",
      "command": "mcp-gateway-service",
      "args": ["--config", "./config.json"]
    }
  }
}
```

Claude Code：

```json
{
  "mcpServers": {
    "gateway": {
      "type": "stdio",
      "command": "mcp-gateway-service",
      "args": ["--config", "./config.json"]
    }
  }
}
```

Streamable HTTP 模式：

先启动一个共享 HTTP 网关进程：

```bash
mcp-gateway-service --config ./config.json --http --host 127.0.0.1 --port 3100 --path /mcp
```

然后让 MCP 客户端连接这个 HTTP endpoint。

Codex：

```toml
[mcp_servers.gateway]
url = "http://127.0.0.1:3100/mcp"
```

Gemini CLI：

```json
{
  "mcpServers": {
    "gateway": {
      "httpUrl": "http://127.0.0.1:3100/mcp"
    }
  }
}
```

Claude Code：

```json
{
  "mcpServers": {
    "gateway": {
      "type": "http",
      "url": "http://127.0.0.1:3100/mcp"
    }
  }
}
```

需要共享同一个网关服务池的客户端都使用同一个 URL。只有当 HTTP 客户端希望 `POST` 直接返回无状态 JSON-RPC 响应时，才需要在启动网关时加 `--json-response`。

## 开发

```bash
npm install
npm run dev
```

构建和测试：

```bash
npm run build
npm test
```

运行构建后的服务：

```bash
node dist/index.js --config ./config.json
```

## License

MIT. See [LICENSE](LICENSE).
