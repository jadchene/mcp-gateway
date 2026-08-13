---
name: mcp-gateway
description: Route work through an MCP gateway with token-efficient downstream service discovery, filtered tool search, exact schema lookup, service diagnostics, and forwarded tool calls. Use when an agent needs to find or call tools behind the gateway without loading every downstream schema.
---

# MCP Gateway

Use the gateway as the single entry point for downstream MCP services.

## Workflow

1. Reuse an exact `serviceId` already confirmed in the current session; otherwise call `gateway_list_services`.
2. Reuse an exact downstream tool name already confirmed in the session; otherwise search only that service with `gateway_list_tools`. The unique non-empty `toolName` and `desc` filters are case-insensitive literal substrings joined by OR, so inspect description matches for negative guidance.
3. Obtain unfamiliar or safety-sensitive schemas with `includeSchema: true` or `gateway_get_tool_schema`; tool names are exact and case-sensitive.
4. Call `gateway_call_tool` with the confirmed identifiers and an explicit `arguments` object; pass `{}` when the tool has no arguments.
5. Refresh only the identifier or schema rejected as stale.

## Diagnostics and Control

- Treat `serviceId` as a downstream identifier, never as a gateway-owned tool.
- Use `gateway_get_service` for connection diagnostics. Use `gateway_manage_service` only when explicitly requested: `reconnect` does not change config, while `enable` and `disable` persist.

## Safety

- Apply the downstream tool's schema, side-effect rules, and confirmation flow before calling it.
- Treat gateway failures and structured downstream error results as failures.
- Never auto-approve an `input_required` result. Obtain the requested user input and retry with the returned opaque state and matching responses.
