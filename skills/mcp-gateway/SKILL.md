---
name: mcp-gateway
description: Use when discovering or calling downstream tools through MCP Gateway without loading every tool schema.
---

# MCP Gateway

Use the gateway as the single entry point for downstream MCP services.

## Workflow

Start with `gateway_list_services`. Choose the downstream service by description and use its returned `serviceId`. Follow the top-level `transparentTools` flag.

- **`true`** — In the client's tool search, filter for this gateway and the selected `serviceId`, then narrow by action keywords. Call the matching published tool directly with its own arguments.
- **`false`** — Search the selected service with `gateway_list_tools`. Obtain unfamiliar or safety-sensitive schemas with `includeSchema: true` or `gateway_get_tool_schema`, then call `gateway_call_tool` with the confirmed identifiers and arguments. Reuse confirmed tool names and schemas. For batch schema requests, resolve only names listed in `errors`.

## Diagnostics and Control

- Treat `serviceId` as a downstream identifier, never as a gateway-owned tool.
- Use `gateway_get_service` for connection diagnostics. Use `gateway_manage_service` only when explicitly requested: `reconnect` does not change config, while `enable` and `disable` persist.

## Safety

- Treat gateway failures and structured downstream error results as failures.
- Resume an `input_required` result with the returned opaque state and matching input responses.
