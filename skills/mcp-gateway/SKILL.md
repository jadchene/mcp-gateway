---
name: mcp-gateway
description: Use when discovering or calling downstream tools through MCP Gateway without loading every tool schema.
---

# MCP Gateway

Use the gateway as the single entry point for downstream MCP services.

## Workflow

If the matching tool is already available from this gateway in the current session, call it directly. Otherwise, reuse the known `serviceId` and mode. Call `gateway_list_services` only when the service ID or mode is unclear. Its `transparentTools` flag gives the current mode.

- **Transparent (`true`)** — To find a tool, search this gateway by `serviceId` and action keywords. Call the matching published tool with its own arguments.
- **Routing (`false`)** — Call `gateway_call_tool` with the known service ID, tool name, and arguments. Use `gateway_list_tools` to find missing tool names. Obtain unfamiliar or safety-sensitive schemas with `includeSchema: true` or `gateway_get_tool_schema`. For batch schema requests, resolve only names listed in `errors`.

## Diagnostics and Control

- Treat `serviceId` as a downstream identifier, never as a gateway-owned tool.
- Use `gateway_get_service` for connection diagnostics. Use `gateway_manage_service` only when explicitly requested: `reconnect` does not change config, while `enable` and `disable` persist.

## Safety

- Treat gateway failures and structured downstream error results as failures.
- Resume an `input_required` result with the returned opaque state and matching input responses.
