---
name: mcp-gateway
description: Route work through an MCP gateway with token-efficient downstream service discovery, filtered tool search, exact schema lookup, service diagnostics, and forwarded tool calls. Use when an agent needs to find or call tools behind the gateway without loading every downstream schema.
---

# MCP Gateway

Use the gateway as the single entry point for downstream MCP services.

## Routing Workflow

1. Reuse an exact `serviceId` already confirmed in the current session; otherwise call `gateway_list_services`.
2. Reuse an exact downstream tool name already confirmed in the current session; otherwise call `gateway_list_tools` for only the selected service.
3. Filter discovery with unique non-empty `toolName` and/or `desc` string arrays. Treat both filters as case-insensitive literal substring matches joined by OR.
4. Obtain the input schema when arguments are unfamiliar, incomplete, or safety-sensitive. Use `includeSchema: true` during filtered discovery or call `gateway_get_tool_schema` with exact case-sensitive tool names.
5. Call `gateway_call_tool` with the confirmed `serviceId`, exact `toolName`, and an explicit `arguments` object. Pass `{}` for a no-argument tool.
6. Refresh only stale service, tool, or schema information after an unknown-identifier or validation failure.

## Discovery Rules

- Never guess a service identifier, tool name, or argument shape.
- Treat `serviceId` as a downstream identifier returned by `gateway_list_services`; never use a gateway-owned tool name as a service identifier.
- Search only the relevant service instead of collecting every downstream tool.
- Inspect description matches because negative guidance may also contain the search term.
- Reuse schemas returned by `gateway_list_tools(includeSchema: true)` instead of fetching them again.
- Batch exact names in one `gateway_get_tool_schema` call when several selected tools need schemas.
- Treat downstream `structuredContent` as arbitrary JSON.

## Diagnostics and Control

- Use `gateway_get_service` only when connection state, protocol details, server identity, or recent errors matter.
- Use `gateway_manage_service` only when the user explicitly requests reconnecting, enabling, or disabling a service.
- Treat `reconnect` as a connection refresh that does not change config.
- Treat `enable` and `disable` as persistent config changes.

## Safety

- Apply the downstream tool's schema, side-effect rules, and confirmation flow before calling it.
- Treat gateway failures and structured downstream error results as failures.
- Never auto-approve an `input_required` result. Obtain the requested user input and retry with the returned opaque state and matching responses.
