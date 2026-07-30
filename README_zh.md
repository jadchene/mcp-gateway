[English](./README.md) | 简体中文

# MCP Gateway

MCP Gateway 是一个节省 token 的 Model Context Protocol 网关。它不把所有下游工具展开到每个客户端的启动上下文，而是通过 6 个稳定工具完成发现、管理和转发。

MCP Gateway v0.6.1 使用官方 TypeScript SDK v2。

> [!IMPORTANT]
> v0.6.0 及后续版本仅支持 MCP `2026-07-28` 和 `2025-06-18`，传输方式仅支持标准换行分隔 stdio 和单端点 Streamable HTTP。已移除对更早协议版本、独立 HTTP+SSE（`/sse`）和 `Content-Length` framing 的兼容支持。

## 能力

- 上游同时支持 stdio 和无状态 Streamable HTTP。
- 下游支持标准 stdio 和 Streamable HTTP。
- 在 MCP `2026-07-28` 与 `2025-06-18` 之间自动协商。
- 入站传输自动服务这两个标准版本。
- 完整转发下游工具元数据和 JSON Schema 2020-12。
- 由 SDK 处理 MRTR elicitation、opaque `requestState`、任意 JSON `structuredContent`、取消传播和 `x-mcp-header`。
- 遵守 SDK 缓存提示，private 缓存按客户端实例隔离。
- 支持配置热更新、生命周期恢复、无效配置原子拒绝和可选文件日志。
- 入站 HTTP 校验 Host 和 Origin；运行日志不会写入 MCP stdout。

## 环境与安装

- Node.js 24 或更高版本。

```bash
npm install -g @jadchene/mcp-gateway-service
cp config.example.json config.json
mcp-gateway-service --config ./config.json
```

额外启用入站 HTTP：

```bash
mcp-gateway-service --config ./config.json --http --host 127.0.0.1 --port 3100 --path /mcp
```

启用 HTTP 时，进程同时提供 stdio 和 HTTP 入口。使用 `--version` 或 `-v` 查看版本。

## 协议协商

协议选择完全自动：网关及其下游客户端优先协商 MCP `2026-07-28`，对端仅支持 `2025-06-18` 时使用该标准版本。只接受这两个协议版本。入站 Streamable HTTP 的响应形态由官方 SDK 自动选择。

## 服务配置

可通过 `--config`、`MCP_GATEWAY_CONFIG` 或当前目录的 `config.json` 指定配置。

```json
{
  "logging": {
    "enable": false,
    "path": "./logs/mcp-gateway.log"
  },
  "services": [
    {
      "serviceId": "local-tools",
      "enable": true,
      "name": "Local Tools",
      "transport": {
        "type": "stdio",
        "command": "node",
        "args": ["./server.js"]
      }
    },
    {
      "serviceId": "remote-tools",
      "enable": true,
      "name": "Remote Tools",
      "transport": {
        "type": "http",
        "url": "http://127.0.0.1:3200/mcp",
        "headers": {
          "Authorization": "Bearer example-token"
        }
      }
    }
  ]
}
```

配置要点：

- `enable` 默认为 `true`。
- `logging.enable` 默认为 `false`；相对日志路径按配置文件所在目录解析。
- stdio 始终使用标准的换行分隔 JSON-RPC 传输。
- HTTP 始终使用标准的单端点 Streamable HTTP 传输。
- 协议版本自动协商，不提供手动切换配置。
- 支持静态 HTTP 请求头；请求头值和环境变量密钥不会写入日志。

## 入站 Streamable HTTP

MCP `2026-07-28` HTTP 是无状态的：每个请求都是独立的 `POST /mcp`。网关不创建 `Mcp-Session-Id`，`GET` 和 `DELETE` 返回 `405`。标准版本头、方法头、名称头、每请求 metadata 和协议错误由 SDK 校验。

同一 endpoint 通过标准无状态 Streamable HTTP 服务 MCP `2025-06-18`。作为下游客户端，如果 `2025-06-18` 服务端签发 `Mcp-Session-Id`，网关会按标准维持该 session。

默认只绑定 `127.0.0.1`。Host 和 Origin 校验用于防护 DNS rebinding；没有额外认证层时，不应把端口暴露到不可信网络。

## 网关工具

| 工具 | 用途 |
| --- | --- |
| `gateway_list_services` | 列出下游服务和可用状态。 |
| `gateway_get_service` | 查看服务状态、协议版本和服务端身份。 |
| `gateway_list_tools` | 按名称或描述搜索工具，可选返回 schema。 |
| `gateway_get_tool_schema` | 批量获取准确、区分大小写的工具 schema。 |
| `gateway_manage_service` | 重连，或持久化启用/禁用一个服务。 |
| `gateway_call_tool` | 调用一个下游工具并原样转发其 MCP 结果。 |

推荐流程：

1. 调用 `gateway_list_services`。
2. 只对相关服务调用 `gateway_list_tools`，使用 `toolName` 和/或 `desc` 缩小范围。
3. 复用 `includeSchema: true` 返回的 schema；已知准确名称时用 `gateway_get_tool_schema` 一次批量查询。
4. 使用 `gateway_call_tool` 调用；`arguments` 始终必填，无参数工具传 `{}`。

`gateway_call_tool` 不声明固定输出 schema，因为下游 `structuredContent` 可以是任意 JSON。modern MRTR 的 `input_required` 不会被自动同意；上游必须声明所需能力，并使用 `inputResponses` 和 opaque `requestState` 重试。

## 客户端示例

stdio（Codex 风格 TOML）：

```toml
[mcp_servers.gateway]
command = "mcp-gateway-service"
args = ["--config", "./config.json"]
```

Streamable HTTP：

```toml
[mcp_servers.gateway]
url = "http://127.0.0.1:3100/mcp"
```

## 开发与验证

```bash
npm install
npm run verify
node dist/index.js --config ./config.json --version
```

仓库还包含公开 Skill：`skills/mcp-gateway/SKILL.md`。

## License

MIT. See [LICENSE](LICENSE).
