English | [简体中文](./README_zh.md)

# MCP Gateway

## Introduction

MCP Gateway puts multiple MCP services behind one endpoint. An agent connects to the gateway and sees up to six routing tools; downstream services, tools, and schemas are looked up only when they are needed.

Supports stdio and Streamable HTTP with MCP `2026-07-28`, `2025-11-25`, and `2025-06-18`. Legacy `/sse` endpoints are unsupported.

## Quick Start

### Install

Requires Node.js 24 or later.

```bash
npm install -g @jadchene/mcp-gateway-service
```

Create `config.json` using the [configuration example](#config-file). Replace the downstream command, arguments, and paths with those of an installed MCP server.

### Stdio

The agent starts the gateway process, so no separate startup command is needed.

Codex:

```bash
codex mcp add gateway -- mcp-gateway-service --config /absolute/path/config.json
```

Claude Code:

```bash
claude mcp add gateway -- mcp-gateway-service --config /absolute/path/config.json
```

Replace `/absolute/path/config.json` with the file you created. On Windows, a path such as `C:/mcp/gateway/config.json` works. Absolute paths avoid depending on the client's working directory.

### Streamable HTTP

Start the gateway:

```bash
mcp-gateway-service --http --config ./config.json
```

The default endpoint is `http://127.0.0.1:3000/mcp`.
HTTP hides `gateway_manage_service` by default. Non-loopback binds require a bearer token in `MCP_GATEWAY_AUTH_TOKEN`.

Codex:

```bash
codex mcp add gateway --url http://127.0.0.1:3000/mcp
```

Claude Code:

```bash
claude mcp add --transport http gateway http://127.0.0.1:3000/mcp
```

## Configuration and Tools

### CLI Options

| Option | Description | Default |
| --- | --- | --- |
| `--config <path>` | Config file path. | `MCP_GATEWAY_CONFIG`, then `./config.json` |
| `--http` | Enables the Streamable HTTP endpoint. | Disabled |
| `--host <host>` | HTTP bind address. | `127.0.0.1` |
| `--port <port>` | HTTP port. | `3000` |
| `--path <path>` | HTTP endpoint path. | `/mcp` |
| `--auth-token-env <name>` | Environment variable containing the HTTP bearer token. | `MCP_GATEWAY_AUTH_TOKEN` |
| `--http-admin-tools` | Exposes `gateway_manage_service` over authenticated HTTP. | Disabled |
| `--max-concurrent-requests <n>` | Bounds in-flight HTTP requests. | `64` |
| `--max-request-body-bytes <n>` | Rejects HTTP request bodies above this byte limit; maximum configurable value is 64 MiB. | `16777216` (16 MiB) |
| `--max-legacy-sessions <n>` | Bounds retained stateful legacy HTTP sessions. | `256` |
| `--version`, `-v` | Prints the installed version. | — |

Stdio remains available when `--http` is enabled.

### Config File

```json
{
  "logging": {
    "enable": false,
    "path": "./logs/mcp-gateway.log",
    "maxBytes": 10485760
  },
  "services": [
    {
      "serviceId": "local-tools",
      "enable": true,
      "name": "Local Tools",
      "description": "Local MCP service",
      "callTimeoutMs": 120000,
      "confirmationRequiredTools": ["delete_*", "deploy_?"],
      "codexAutoReview": false,
      "disabledTools": ["internal_*", "legacy_tool"],
      "transport": {
        "type": "stdio",
        "command": "your-mcp-service",
        "args": ["--config", "/absolute/path/service/config.json"],
        "cwd": "/absolute/path/service",
        "env": {},
        "inheritEnv": false,
        "envAllowlist": []
      }
    },
    {
      "serviceId": "remote-tools",
      "enable": false,
      "name": "Remote Tools",
      "description": "Remote MCP service",
      "callTimeoutMs": 120000,
      "confirmationRequiredTools": [],
      "codexAutoReview": false,
      "disabledTools": [],
      "transport": {
        "type": "http",
        "url": "http://127.0.0.1:3200/mcp",
        "headers": {
          "Authorization": "Bearer replace-with-token"
        }
      }
    }
  ]
}
```

Configure and enable the services you use. Remove `Authorization` for an HTTP service without token authentication.

| Setting | Usage |
| --- | --- |
| `serviceId` | Unique identifier for each service. |
| `confirmationRequiredTools` | Case-sensitive full tool-name patterns: `*` matches any number of characters, `?` matches one. Matching calls require confirmation. |
| `disabledTools` | Uses the same patterns to hide and block tools; takes precedence over confirmation rules. |
| `transport.cwd`, `transport.args` | Prefer absolute paths. Relative working directories resolve from the gateway process directory. |
| `transport.env`, `transport.envAllowlist` | Supply variable values or allow named variables through. Custom variables are not inherited unless allowed; `inheritEnv: true` inherits the full environment. Config strings do not expand `${VAR}`. |
| `logging.path`, `logging.maxBytes` | Log paths resolve from the config directory; logs rotate at the configured size. |

Configuration reloads automatically; invalid updates keep the last valid configuration. The complete example is also available in [config.example.json](config.example.json).

### Gateway Tools

| Tool | Description |
| --- | --- |
| `gateway_list_services` | Searches enabled services by identifier or description and can filter by availability. |
| `gateway_get_service` | Shows one service's connection state, protocol revision, server identity, and recent error. |
| `gateway_list_tools` | Searches a service's tools by name or description and can include schemas. |
| `gateway_get_tool_schema` | Returns schemas for exact tool names. |
| `gateway_manage_service` | Reconnects a service or enables/disables it in the config file. |
| `gateway_call_tool` | Calls one downstream tool and returns its MCP result. |

The usual flow is `gateway_list_services` → `gateway_list_tools` → `gateway_get_tool_schema` when needed → `gateway_call_tool`. Pass `{}` to `gateway_call_tool` when the downstream tool has no arguments.

Confirmations show the service, tool, and arguments and require a client with interactive confirmation support. Calls with uncertain outcomes are not retried automatically.

For Codex automatic review, set `"codexAutoReview": true` in the selected `services[]` block and start Codex with `codex -c approvals_reviewer=auto_review`. This applies to gateway confirmations; configure downstream services' own approvals separately. Otherwise, use Accept / Decline / Cancel. Codex policy determines whether an operation is approved.

Agents with Skills support can use the included [MCP Gateway Skill](./skills/mcp-gateway/SKILL.md) for the discovery and calling workflow.

## Development

```bash
git clone https://github.com/jadchene/mcp-gateway.git
cd mcp-gateway
npm install
npm run verify
```

Create `config.json` as shown above, then start the development service:

```bash
npm run dev -- --config ./config.json
```

`npm run verify` builds the service. Run the compiled output with `npm start -- --config ./config.json`.

## License

[MIT](./LICENSE)
