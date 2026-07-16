English | [简体中文](./README_zh.md)

# MCP Gateway

MCP Gateway is a lightweight Model Context Protocol gateway that exposes one small MCP entry point for multiple downstream MCP services.

Instead of flattening every downstream tool into the client at startup, the gateway exposes a fixed discovery and routing API. Agents can list services, inspect tools for one service, fetch one schema, and then forward the actual tool call.

## Features

- One MCP entry point for multiple downstream MCP services.
- Token-efficient discovery through a small fixed gateway tool surface.
- Stdio and Streamable HTTP downstream transports.
- Optional inbound Streamable HTTP endpoint enabled by CLI flags.
- Hot reload for service-pool config changes.
- Stops removed, disabled, or replaced downstream services during reload.
- Restarts failed downstream processes up to three times before marking them unavailable.
- Atomic config reload that keeps the previous valid config when a new config is invalid.
- Optional newline-delimited JSON file logging that never writes operational logs to MCP stdout.
- Version reporting through `--version` or `-v`.

## Why Use It

- Keep agent-side MCP configuration small: every agent connects to the gateway, while downstream services are managed in one config file.
- Reduce initial tool context: agents discover only the service, tool, and schema needed for the current task.
- Keep service lifecycle control centralized instead of duplicating command paths, environment variables, and secrets across multiple clients.

## Quick Start

Install globally:

```bash
npm install -g @jadchene/mcp-gateway-service
```

Create a local config:

```bash
cp config.example.json config.json
```

Start the stdio gateway:

```bash
mcp-gateway-service --config ./config.json
```

Start with inbound Streamable HTTP:

```bash
mcp-gateway-service --config ./config.json --http --host 127.0.0.1 --port 3100 --path /mcp
```

Use stateless JSON responses for HTTP clients that expect direct JSON-RPC responses from `POST`:

```bash
mcp-gateway-service --config ./config.json --http --port 3100 --path /mcp --json-response
```

Check the installed version:

```bash
mcp-gateway-service --version
mcp-gateway-service -v
```

## Configuration

Pass the config file by CLI argument:

```bash
mcp-gateway-service --config ./config.json
```

Or by environment variable:

```bash
MCP_GATEWAY_CONFIG=./config.json mcp-gateway-service
```

If neither is provided, the service tries `config.json` in the current working directory.

Config example:

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

Configuration notes:

- `logging.enable` defaults to `false`.
- `logging.path` is required only when `logging.enable` is `true`.
- Relative `logging.path` values are resolved from the config file directory.
- Service `enable` defaults to `true`; setting it to `false` skips that service.
- `cwd` and `env` are optional for stdio services.
- Stdio `transport.framing` may be `line` or `content-length`. When omitted, the gateway tries `line` and then `content-length`.
- HTTP downstream services use `transport.type: "http"` and `transport.url`.
- HTTP `transport.headers` provides static request headers.
- HTTP `transport.enableJsonResponse` enables stateless JSON response mode for that downstream service.

## Inbound Streamable HTTP

Inbound HTTP is enabled only with `--http`. Passing `--host`, `--port`, `--path`, or `--json-response` without `--http` does not start an HTTP listener.

The HTTP endpoint uses the same path for `GET` and `POST`:

- `GET /mcp` opens the SSE read channel and returns the session in the `Mcp-Session-Id` response header.
- `POST /mcp` sends JSON-RPC messages. New clients should bind the session through the `Mcp-Session-Id` request header.
- Query-string `sessionId` is accepted for compatibility.
- The `endpoint` SSE event advertises the single path, such as `/mcp`.

## Gateway Tools

The gateway exposes six public tools:

| Tool | Purpose |
| --- | --- |
| `gateway_list_services` | List downstream services with each logical `serviceId`, description, and current availability. |
| `gateway_get_service` | Return one service's identity, availability, recent error and connection time, protocol version, and server information. Use this for diagnostics. |
| `gateway_list_tools` | Search tool names or descriptions by case-insensitive literal substrings. Optional unique non-empty `toolName` and `desc` arrays use OR; `includeSchema: true` includes schemas. |
| `gateway_get_tool_schema` | Return schemas for unique exact, case-sensitive tool names. Results are keyed by name, and any unknown name fails the whole request. |
| `gateway_manage_service` | Reconnect without changing config, or persistently enable/disable a service in the config and reload the registry. |
| `gateway_call_tool` | Call one exact downstream tool and forward its result unchanged. The downstream tool may have read or write side effects. |

Default token-efficient workflow:

1. Call `gateway_list_services` once.
2. Call `gateway_list_tools(serviceId)` only when a service is needed. Use a `toolName` array for name keywords and a `desc` array for description keywords.
3. When all filtered matches need schemas, pass `includeSchema: true`; when exact tool names are already known, call `gateway_get_tool_schema` with a non-empty name array.
4. Call `gateway_call_tool` to execute the downstream tool.
5. Use `gateway_get_service` only for diagnostics.
6. Use `gateway_manage_service` only to reconnect, enable, or disable a service.

`gateway_get_tool_schema.toolName` is a required unique non-empty string array and returns a `schemas` object keyed by each requested exact tool name. Use a one-element array when requesting one schema.

`gateway_list_tools.toolName` and `gateway_list_tools.desc` are optional unique non-empty string arrays. Matching is case-insensitive and uses literal substrings. When both are present, a tool is returned when either its name or description matches any supplied keyword. Description matching can also hit negative guidance such as "when not to use", so inspect the returned descriptions before selecting a tool.

All gateway tools with stable structured content expose an `outputSchema`. `gateway_call_tool` intentionally omits a fixed output schema because it forwards arbitrary downstream results. Its `arguments` object is always required; pass `{}` for a downstream tool with no arguments.

`gateway_manage_service` actions:

- `reconnect`: retry the current downstream lifecycle without modifying config.
- `enable`: persist `enable: true` for the service and reload config.
- `disable`: persist `enable: false` for the service and reload config.

## Skill Integration

This repository includes a public gateway skill:

- Skill path: `skills/mcp-gateway/SKILL.md`

Use it when your agent supports skills. It keeps discovery token-efficient and routes downstream calls through the minimal gateway contract.

## MCP Client Configuration

Codex:

```toml
[mcp_servers.gateway]
command = "mcp-gateway-service"
args = ["--config", "./config.json"]
```

Gemini CLI:

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

Claude Code:

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

Streamable HTTP mode:

Start one shared HTTP gateway process first:

```bash
mcp-gateway-service --config ./config.json --http --host 127.0.0.1 --port 3100 --path /mcp
```

Then point MCP clients at the HTTP endpoint.

Codex:

```toml
[mcp_servers.gateway]
url = "http://127.0.0.1:3100/mcp"
```

Gemini CLI:

```json
{
  "mcpServers": {
    "gateway": {
      "httpUrl": "http://127.0.0.1:3100/mcp"
    }
  }
}
```

Claude Code:

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

Use the same URL for every client that should share the gateway service pool. Use `--json-response` only when your HTTP client expects stateless JSON-RPC responses directly from `POST` requests.

## Development

```bash
npm install
npm run dev
```

Build and test:

```bash
npm run build
npm test
```

Run the built server:

```bash
node dist/index.js --config ./config.json
```

## License

MIT. See [LICENSE](LICENSE).
