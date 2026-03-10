English | [简体中文](./README_zh.md)

# MCP Gateway

This project provides a lightweight Model Context Protocol (MCP) gateway for **token-efficient, on-demand discovery** and **one unified entry point for multiple downstream services**.

Instead of exposing every downstream MCP tool up front, the gateway keeps a small fixed tool surface and lets the client discover services, list tools for a specific service, fetch one tool schema when needed, and then forward the actual tool call.

## Why Use This Gateway

This gateway is designed for a practical problem that appears quickly once you use multiple MCP services across multiple agents.

If every agent connects directly to every MCP service, two problems show up:

1. The tool surface becomes too large.
2. The MCP configuration becomes too repetitive.

### 1. Reduce token consumption

Many MCP services expose dozens or even hundreds of tools.

If an agent connects directly to several MCP services, the client often needs to expose or describe a very large tool inventory up front. That increases:

- prompt size
- tool discovery cost
- repeated schema/context overhead across sessions

This gateway avoids that by exposing a **small fixed discovery interface** instead of flattening every downstream tool into the initial tool list.

The normal flow becomes:

1. list available services
2. inspect tools for one selected service
3. fetch schema for one selected tool
4. call that tool

That means the model only sees the minimum amount of MCP metadata needed for the current task.

### 2. Provide one unified MCP entry point for multiple agents

Without a gateway, each agent usually needs its own MCP client configuration for multiple downstream services.

That quickly becomes hard to maintain:

- every agent config needs to be updated when services change
- command paths and environment variables are repeated
- secrets and local machine details are spread across multiple client configs
- different agents may drift out of sync over time

With this gateway, the downstream MCP pool is defined once in one config file, and every agent only needs to connect to the gateway itself.

That gives you a cleaner architecture:

- one MCP entry point for many services
- one place to add, remove, or update downstream MCP definitions
- one place to control what is exposed to agents
- less duplicated local configuration
- easier reuse across Codex, Claude Code, Gemini CLI, or other MCP-capable clients

In short, this gateway is useful when you want to treat multiple MCP services as a managed service pool rather than reconfiguring the same MCP stack separately for every agent.

## Key Pillars

### Token-Efficient Discovery
- Keep the public tool surface small and stable.
- Discover services first, then tools for one service, then schema for one tool.
- Avoid sending hundreds of downstream tools to the model at session start.

### Stable Gateway Surface
- Expose a fixed gateway contract instead of dynamically flattening downstream tools.
- Return compact discovery payloads for service and tool enumeration.
- Forward downstream tool results directly to the caller for minimal wrapping.

### Practical Operations
- Load a static service pool from JSON.
- Reload config automatically when the file changes.
- Stop removed, disabled, or replaced downstream processes during hot reload.
- Restart failed downstream processes up to 3 times before marking them unavailable.
- Preserve the last valid config snapshot when a reload fails.

## Quick Start

### Install globally

```bash
npm install -g @jadchene/mcp-gateway-service
```

Start the gateway:

```bash
mcp-gateway-service
```

With an explicit config path:

```bash
mcp-gateway-service --config ./config.json
```

### Run from source

Create a local `config.json` from `config.example.json`, then start the gateway:

```bash
npm install
npm run dev
```

By default the gateway loads `./config.json`.
Use `--config <path>` to override it for the current process. If `--config` is omitted, the gateway falls back to `MCP_GATEWAY_CONFIG`, then `./config.json`.

Override it with:

```bash
$env:MCP_GATEWAY_CONFIG="config/gateway/config.json"
npm run dev
```

### Version

```bash
mcp-gateway-service --version
```

Short form:

```bash
mcp-gateway-service -v
```

## Configuration

The gateway currently supports `stdio` downstream transports only.

A service is loaded only when `enable` is missing or set to `true`. If `enable` is set to `false`, the gateway skips that service entirely. During hot reload, disabling or removing a service also stops its existing downstream process if one is running.

- `logging.enable` is optional and defaults to `false`.
- `logging.path` is required only when `logging.enable` is `true`.
- When enabled, the gateway writes newline-delimited JSON logs to the configured file and never writes operational logs to MCP `stdout` or `stderr`.
- Relative `logging.path` values are resolved from the config file directory.
- Logging config supports hot reload, so changing `logging.enable` or `logging.path` in the config file takes effect without restarting the gateway.
- `enable` is optional. When omitted, the gateway treats the service as enabled.
- `cwd` is optional. When omitted, the gateway uses its current working directory.
- `env` is optional.
- `framing` is optional. When omitted, the gateway tries `line` first and then `content-length`.

### Config shape

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
    }
  ]
}
```

## Public Gateway Tools

The gateway exposes a fixed set of discovery and routing tools:

- `gateway.listServices`
- `gateway.getService`
- `gateway.listTools`
- `gateway.getToolSchema`
- `gateway.manageService`
- `gateway.callTool`

### Response design

- `gateway.listServices` returns only `serviceId`, `description`, and `available`.
- `gateway.listTools` returns only `name` and `description`.
- `gateway.getToolSchema` returns only `inputSchema` and `outputSchema`.
- `gateway.manageService` returns only `serviceId`, `action`, `enabled`, and `available`.
- `gateway.callTool` forwards the downstream MCP tool result directly without extra gateway metadata wrapping.

### Default workflow vs diagnostics

- The default token-efficient workflow still uses four tools: `gateway.listServices`, `gateway.listTools`, `gateway.getToolSchema`, and `gateway.callTool`.
- `gateway.getService` is primarily for diagnostics, such as checking recent service errors, connection state, protocol version, or downstream server info.
- `gateway.manageService` is an operational tool for explicit service control, not part of the normal discovery flow.

### `gateway.manageService`

Use `gateway.manageService` when you explicitly need to reconnect a service or persistently change its enabled state.

Input:

- `serviceId`: logical service identifier
- `action`: one of `reconnect`, `enable`, or `disable`

Action behavior:

- `reconnect`: immediately tries to start and reinitialize the specified downstream MCP again. Use this when a service previously failed because its dependency was not ready, such as an IDE that was not open yet.
- `enable`: writes `enable: true` to the config file for that service and triggers a reload.
- `disable`: writes `enable: false` to the config file for that service and triggers a reload.

Important notes:

- `enable` and `disable` are persisted to the JSON config file. They are not session-only toggles.
- `reconnect` does not modify the config file. It only retries the current service lifecycle.

## Recommended Client Workflow

For the best token efficiency, the MCP client should cache discovery results instead of repeatedly querying the gateway:

1. Call `gateway.listServices` once at session start.
2. Call `gateway.listTools(serviceId)` only when a service is actually needed.
3. Call `gateway.getToolSchema(serviceId, toolName)` only before the first use of that tool.
4. Call `gateway.callTool(...)` for execution.
5. Use `gateway.getService` only when diagnostics are explicitly needed.
6. Use `gateway.manageService` only when a service must be reconnected or explicitly enabled/disabled.
7. Refresh discovery data only when a call fails, the config changes, or the client explicitly wants a refresh.

## Skill Integration (Recommended)

This repository includes a public skill for agent frameworks that support skill loading:

- Skill path: `skills/mcp-gateway/SKILL.md`

The skill focuses on:

- token-efficient discovery flow
- avoiding unnecessary schema/tool enumeration
- calling downstream tools through the minimal gateway contract

## MCP Client Configuration

The examples below intentionally use relative config paths so they stay portable.

### Codex

`~/.codex/config.toml`

```toml
[mcp_servers.gateway]
command = "mcp-gateway-service"
args = ["--config", "./config.json"]
```

### Gemini CLI

`~/.gemini/settings.json`

```json
{
  "mcpServers": {
    "gateway": {
      "type": "stdio",
      "command": "mcp-gateway-service",
      "args": [
        "--config",
        "./config.json"
      ]
    }
  }
}
```

### Claude Code

`~/.claude.json`

```json
{
  "mcpServers": {
    "gateway": {
      "type": "stdio",
      "command": "mcp-gateway-service",
      "args": [
        "--config",
        "./config.json"
      ]
    }
  }
}
```

## Development Notes

- Repository-managed `config.json` and `config.example.json` are examples only.
- Copy `config.example.json` to your own local `config.json` before running the gateway.
- Keep real local configs and logs outside the repository.
- File logging is disabled by default so MCP startup stays quiet unless you explicitly enable it.
- Downstream output schema is returned only when the downstream service exposes it.
- Windows command resolution supports PowerShell shims such as `.ps1`-backed command aliases.
- On Windows, the gateway prefers `pwsh` for `.ps1` shim resolution and execution, and automatically falls back to `powershell.exe` when `pwsh` is unavailable.

## License

Released under the [MIT License](./LICENSE).
