English | [简体中文](./README_zh.md)

# MCP Gateway

## Introduction

MCP Gateway puts multiple MCP services behind one endpoint. An agent connects to the gateway and sees six routing tools; downstream services, tools, and schemas are looked up only when they are needed.

The project uses the official TypeScript SDK v2 and requires Node.js 24 or later.

> [!IMPORTANT]
> MCP Gateway v0.6.2 and later accept only MCP `2026-07-28`, `2025-11-25`, and `2025-06-18`. Supported transports are newline-delimited stdio and single-endpoint Streamable HTTP. Standalone HTTP+SSE (`/sse`), `Content-Length` framing, and other protocol revisions are not supported.

## Why Use It

- Keep the agent context small even when many MCP services are configured.
- Connect the agent once, then add or remove downstream services in the gateway config.
- Find tools by name or description and load schemas only when required.
- Use stdio and Streamable HTTP services through the same interface.
- Reload config changes without restarting the gateway.

## Quick Start

### Install

```bash
npm install -g @jadchene/mcp-gateway-service
```

Create `config.json`. Replace `your-mcp-service` with the command of an installed MCP server:

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

The agent starts the gateway process, so no separate startup command is needed.

Codex `config.toml`:

```toml
[mcp_servers.gateway]
command = "mcp-gateway-service"
args = ["--config", "./config.json"]
```

Claude Code:

```bash
claude mcp add gateway -- mcp-gateway-service --config ./config.json
```

### Streamable HTTP

Start the gateway:

```bash
mcp-gateway-service --http --config ./config.json
```

The default endpoint is `http://127.0.0.1:3000/mcp`.
HTTP hides `gateway_manage_service` by default. Non-loopback binds require a bearer token in `MCP_GATEWAY_AUTH_TOKEN`.

Codex `config.toml`:

```toml
[mcp_servers.gateway]
url = "http://127.0.0.1:3000/mcp"
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
| `--version`, `-v` | Prints the installed version. | — |

Stdio remains available when `--http` is enabled.

### Config File

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

| Field | Description |
| --- | --- |
| `services` | List of downstream MCP services. |
| `serviceId` | Required unique identifier used by gateway tools. |
| `name` | Required display name. |
| `description` | Optional service description. |
| `enable` | Optional; defaults to `true`. |
| `callTimeoutMs` | Optional downstream tool-call timeout; defaults to 120 seconds. |
| `transport.type` | `stdio` or `http`. |
| `transport.command` | Required command for a stdio service. |
| `transport.args` | Optional command arguments for a stdio service. |
| `transport.cwd` | Optional working directory for a stdio service. |
| `transport.env` | Optional environment variables for a stdio service. |
| `transport.inheritEnv` | Opts into inheriting the complete gateway environment; defaults to `false`. |
| `transport.envAllowlist` | Additional process environment names passed to stdio services. |
| `transport.url` | Required Streamable HTTP URL for an HTTP service. |
| `transport.headers` | Optional static headers for an HTTP service. |
| `logging.enable` | Enables file logging; defaults to `false`. |
| `logging.path` | Log file path. Relative paths use the config file directory. |
| `logging.maxBytes` | Active log size before rotation; defaults to 10 MiB. |

The config file is watched for changes. Invalid updates are rejected and the last valid config stays active. See [config.example.json](./config.example.json) for another example.

### Gateway Tools

| Tool | Description |
| --- | --- |
| `gateway_list_services` | Lists configured services and their availability. |
| `gateway_get_service` | Shows one service's connection state, protocol revision, server identity, and recent error. |
| `gateway_list_tools` | Searches a service's tools by name or description and can include schemas. |
| `gateway_get_tool_schema` | Returns schemas for exact tool names. |
| `gateway_manage_service` | Reconnects a service or enables/disables it in the config file. |
| `gateway_call_tool` | Calls one downstream tool and returns its MCP result. |

The usual flow is `gateway_list_services` → `gateway_list_tools` → `gateway_get_tool_schema` when needed → `gateway_call_tool`. Pass `{}` to `gateway_call_tool` when the downstream tool has no arguments.

Calls keep the downstream tool's original side effects and confirmation rules. An uncertain `gateway_call_tool` failure is never replayed automatically. Enabling or disabling a service with `gateway_manage_service` atomically updates the config file.

Agents with Skills support can use the included [MCP Gateway Skill](./skills/mcp-gateway/SKILL.md) for the discovery and calling workflow.

## Development

```bash
git clone https://github.com/jadchene/mcp-gateway.git
cd mcp-gateway
npm install
npm run verify
npm run dev -- --config ./config.json
```

Build and run the compiled service:

```bash
npm run build
npm start -- --config ./config.json
```

## License

[MIT](./LICENSE)
