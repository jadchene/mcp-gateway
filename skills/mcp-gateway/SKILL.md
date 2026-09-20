---
name: mcp-gateway
description: Use when discovering or calling downstream tools through MCP Gateway without loading every tool schema.
---

# MCP Gateway

Use the gateway as the single entry point for downstream MCP services.

## Workflow

1. Reuse an exact `serviceId` already confirmed in the current session; otherwise call `gateway_list_services`.
2. Reuse an exact downstream tool name already confirmed in the session; otherwise search only that service with `gateway_list_tools`.
3. Obtain unfamiliar or safety-sensitive schemas with `includeSchema: true` or `gateway_get_tool_schema`.
4. Call `gateway_call_tool` with the confirmed identifiers and arguments.
5. Retain successful batch schemas; resolve only names listed in `errors`. Refresh only stale identifiers or schemas.

## Diagnostics and Control

- Treat `serviceId` as a downstream identifier, never as a gateway-owned tool.
- Use `gateway_get_service` for connection diagnostics. Use `gateway_manage_service` only when explicitly requested: `reconnect` does not change config, while `enable` and `disable` persist.

## Safety

- Treat gateway failures and structured downstream error results as failures.
- Never auto-approve an `input_required` result. Obtain the requested user input and retry with the returned opaque state and matching responses.
