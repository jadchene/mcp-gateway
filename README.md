English | [简体中文](./README_zh.md)

# MCP Gateway

MCP Gateway is a token-efficient Model Context Protocol gateway. It exposes six stable routing tools instead of flattening every downstream tool into each client's startup context.

MCP Gateway v0.6.0 uses the official TypeScript SDK v2.

> [!IMPORTANT]
> v0.6.0 and later support only MCP `2026-07-28` and `2025-06-18`, using standard newline-delimited stdio or single-endpoint Streamable HTTP. Compatibility with older protocol revisions, standalone HTTP+SSE (`/sse`), and `Content-Length` framing has been removed.

## Capabilities

- Inbound MCP server over stdio and stateless Streamable HTTP.
- Outbound MCP client over standard stdio and Streamable HTTP.
- Automatic negotiation between MCP `2026-07-28` and `2025-06-18`.
- Both standard revisions are served automatically on inbound transports.
- Full downstream tool metadata and JSON Schema 2020-12 preservation.
- MRTR elicitation forwarding, opaque `requestState` forwarding, arbitrary JSON `structuredContent`, cancellation, and `x-mcp-header` handling through the SDK.
- SDK-managed response cache hints and client-local private caches.
- Hot reload, lifecycle recovery, atomic invalid-config rejection, and optional file logging.
- Host and Origin validation for inbound HTTP. Operational logs never use MCP stdout.

## Requirements and Installation

- Node.js 24 or later.

```bash
npm install -g @jadchene/mcp-gateway-service
cp config.example.json config.json
mcp-gateway-service --config ./config.json
```

Enable the additional inbound HTTP endpoint:

```bash
mcp-gateway-service --config ./config.json --http --host 127.0.0.1 --port 3100 --path /mcp
```

When HTTP is enabled, the process serves both stdio and HTTP. Use `--version` or `-v` to print the installed version.

## Protocol Negotiation

Protocol selection is automatic. The gateway and its downstream clients negotiate MCP `2026-07-28` first and use `2025-06-18` when the peer supports only that standard revision. These are the only accepted protocol revisions. `--json-response` selects the standard inbound Streamable HTTP response shape; it does not create protocol sessions.

## Service Configuration

Pass `--config`, set `MCP_GATEWAY_CONFIG`, or place `config.json` in the current directory.

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

Common fields:

- `enable` defaults to `true`.
- `logging.enable` defaults to `false`. A relative log path is resolved from the config file directory.
- Stdio always uses the standard newline-delimited JSON-RPC transport.
- HTTP always uses the standard single-endpoint Streamable HTTP transport.
- Protocol revision negotiation is automatic and has no configuration switch.
- Static HTTP headers are supported. Header values and environment secrets are not written to logs.

## Inbound Streamable HTTP

MCP `2026-07-28` HTTP is stateless: each request is an independent `POST /mcp`. The gateway does not create `Mcp-Session-Id` sessions, and `GET`/`DELETE` return `405`. The SDK validates `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`, request metadata, and protocol errors.

The same endpoint serves MCP `2025-06-18` through its standard stateless Streamable HTTP form. As a downstream client, the gateway also preserves a `2025-06-18` session when a server issues `Mcp-Session-Id`.

The default bind address is `127.0.0.1`. Host and Origin checks protect the local endpoint from DNS rebinding. Do not expose it beyond a trusted local network without an authentication layer.

## Gateway Tools

| Tool | Purpose |
| --- | --- |
| `gateway_list_services` | List configured downstream services and availability. |
| `gateway_get_service` | Inspect one service's status, protocol version, and server identity. |
| `gateway_list_tools` | Search tool names/descriptions; optionally include schemas. |
| `gateway_get_tool_schema` | Fetch schemas for exact, case-sensitive tool names in one batch. |
| `gateway_manage_service` | Reconnect or persistently enable/disable one configured service. |
| `gateway_call_tool` | Call one downstream tool and preserve its MCP result. |

Recommended flow:

1. Call `gateway_list_services`.
2. Call `gateway_list_tools` only for the relevant service, using `toolName` and/or `desc` filters.
3. Reuse schemas returned by `includeSchema: true`, or batch exact names with `gateway_get_tool_schema`.
4. Call `gateway_call_tool`; always provide `arguments`, using `{}` for a no-argument tool.

`gateway_call_tool` intentionally has no fixed output schema because downstream `structuredContent` may be any JSON value. Modern MRTR `input_required` results are forwarded without automatic approval; the upstream client must declare the required capability and retry with `inputResponses` and the opaque `requestState`.

## Client Examples

Stdio (Codex-style TOML):

```toml
[mcp_servers.gateway]
command = "mcp-gateway-service"
args = ["--config", "./config.json"]
```

Streamable HTTP:

```toml
[mcp_servers.gateway]
url = "http://127.0.0.1:3100/mcp"
```

## Development and Verification

```bash
npm install
npm run verify
node dist/index.js --config ./config.json --version
```

The repository also ships the public skill at `skills/mcp-gateway/SKILL.md`.

## License

MIT. See [LICENSE](LICENSE).
