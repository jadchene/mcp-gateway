English | [简体中文](./README_zh.md)

# MCP Gateway

## Introduction

MCP Gateway puts multiple MCP services behind one endpoint. By default, an agent sees up to six routing tools and looks up downstream tools as needed. Clients with tool search can opt into transparent aggregation for direct calls.

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
HTTP hides `gateway_manage_service` by default. Binding to a non-loopback address requires a bearer token. The gateway reads it from `MCP_GATEWAY_AUTH_TOKEN` by default. Use `--auth-token-env <name>` to select a different environment variable.

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
| `--max-concurrent-requests <n>` | Limits in-flight HTTP requests and open notification streams separately. Each pool allows up to this many. | `64` |
| `--max-request-body-bytes <n>` | Rejects HTTP request bodies above this byte limit; maximum configurable value is 64 MiB. | `16777216` (16 MiB) |
| `--max-legacy-sessions <n>` | Bounds retained stateful legacy HTTP sessions. | `256` |
| `--version`, `-v` | Prints the installed version. | — |

Stdio remains available when `--http` is enabled.

### Config File

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

See [config.example.json](config.example.json) for an HTTP downstream service and additional settings.

| Setting | Usage |
| --- | --- |
| `serviceId` | Unique identifier for each service. |
| `confirmationRequiredTools` | Requires confirmation for matching downstream tool names. Patterns match the full original name, are case-sensitive, and support `*` for any number of characters and `?` for one. |
| `disabledTools` | Uses the same patterns to hide and block tools; takes precedence over confirmation rules. |
| `transport.cwd`, `transport.args` | Prefer absolute paths. Relative working directories resolve from the gateway process directory. |
| `transport.env`, `transport.envAllowlist` | Supply variable values or allow named variables through. Custom variables are not inherited unless allowed; `inheritEnv: true` inherits the full environment. Config strings do not expand `${VAR}`. |
| `logging.path`, `logging.maxBytes` | Log paths resolve from the config directory; logs rotate at the configured size. |

The gateway reloads the file automatically and keeps the last valid configuration if a reload fails.

### Gateway Tools

To enable transparent aggregation, set `"transparentTools": true` at the top level of the config file or turn on **透明聚合模式** under **通用设置** in the Web UI and save. The default is `false`.

Call `gateway_list_services`, choose a `serviceId` from `services`, and read the top-level `transparentTools` flag in the result.

- **Transparent (`true`)** — Use the returned `serviceId` and action keywords together in the client's tool search. For example, if the service ID is `database`, search for `database list tables`. Select the matching tool from this gateway and call it directly with its own arguments.
- **Routing (`false`)** — Call `gateway_list_tools` with the returned `serviceId`. Get the schema with `gateway_get_tool_schema` if needed, then call `gateway_call_tool` with `serviceId`, `toolName`, and `arguments`. Pass `{}` for `arguments` when the tool takes no parameters.

| Gateway tool | Mode | Description |
| --- | --- | --- |
| `gateway_list_services` | Both | Returns the current mode and enabled services. Filter by identifier, description, or availability. |
| `gateway_get_service` | Both | Shows one service's connection state, protocol revision, server identity, and recent error. |
| `gateway_manage_service` | Both | Reconnects, enables, or disables a service. HTTP requires `--http-admin-tools` and a bearer token. |
| `gateway_list_tools` | Routing | Searches a service's tools by name or description and can include schemas. |
| `gateway_get_tool_schema` | Routing | Returns schemas for exact tool names. |
| `gateway_call_tool` | Routing | Calls one downstream tool and returns its MCP result. |

In transparent mode, schema loading and token usage depend on the client.

The gateway notifies listening clients when its tool catalog changes. If Codex still shows stale tools, reload MCP and open a new thread.

Manual approvals require a client that supports interactive confirmation. To enable Codex automatic review for gateway confirmations, set `"codexAutoReview": true` on the service and start Codex with `codex -c approvals_reviewer=auto_review`. Configure downstream approvals separately.

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

## Web configuration

Disabled by default. Web binds only to `127.0.0.1`, needs no token, and uses a separate port from MCP communication.

```sh
mcp-gateway-service --config ./config.json --web --web-port 3100
```

Open the printed URL and click **Save configuration** to apply edits. You can also set `"web": { "enabled": true, "port": 3100 }` in the config file. The `--web` and `--no-web` flags take precedence. Restart the gateway after changing the Web port or enablement setting.

Use **Service status** to start or stop stdio processes, or connect or disconnect HTTP services. A manual stop lasts until the gateway restarts. Set a service's `webUrl` to open its own configuration page.

## License

[MIT](./LICENSE)
