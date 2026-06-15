---
name: mcp-gateway
description: Use the MCP gateway for token-efficient discovery of downstream MCP services, tool lists, tool schemas, and forwarded tool calls. Prefer the default four-tool workflow and use detailed service inspection only for explicit diagnosis.
---

# MCP Gateway

Operate downstream MCP services through the gateway's fixed, token-efficient discovery interface.

## Core Mandates

- **Discovery First**: Never guess a `serviceId` or downstream `toolName`. Discover them through the gateway.
- **Token Efficiency**: Do not enumerate every service and every tool unless the task genuinely needs it.
- **Schema Before Unclear Arguments**: If the tool arguments are not fully certain, fetch the schema before calling the tool. Do not guess argument names, shapes, or confirmation fields.
- **Cache Mentally Per Session**: Reuse known service lists, tool lists, and schemas within the current session instead of asking again without reason.
- **Compression Recovery Gate**: After any context compression event, re-read `AGENTS.md` and this `SKILL.md` before continuing.

## Required Workflow

1. Call `gateway_list_services` once to find the right downstream service.
2. Call `gateway_list_tools(serviceId)` only for the selected service, using optional `toolName` as a string or string array when one or more keywords can narrow a large tool list.
3. Call `gateway_get_tool_schema(serviceId, toolName)` before the first use of that tool, or any time the arguments are not fully certain.
4. Call `gateway_call_tool(serviceId, toolName, arguments)` for execution.
5. Re-discover only when a call fails, service availability changes, or the task clearly requires fresh metadata.

## Diagnostic Exception

- Treat `gateway_get_service` as a diagnostic tool, not part of the default workflow.
- Use it only when the user explicitly asks to inspect service health, connection state, protocol details, or recent service errors.
- Do not call it during normal task execution when the four-tool flow is sufficient.
- Treat `gateway_manage_service` as an explicit service-control tool, not part of the default workflow.
- Use `gateway_manage_service({ serviceId, action: "reconnect" })` only when the user explicitly wants to retry starting a failed service after its dependency becomes ready.
- Use `gateway_manage_service({ serviceId, action: "enable" | "disable" })` only when the user explicitly wants to persistently change that service's enabled state in the config file.

## Strict Argument Rule

- Treat every `serviceId` argument accepted by `gateway_*` tools as a downstream service identifier returned by `gateway_list_services`. Never pass `gateway`, a gateway-owned tool name, or any inferred self-reference as `serviceId`.
- If a tool has any non-trivial arguments, optional flags, confirmation fields, enum values, or write-safety fields, call `gateway_get_tool_schema` before execution unless the exact argument contract is already confirmed in the current session.
- Apply gateway discovery, schema, management, and routing tools only to downstream services and downstream tools. Do not use them to inspect or call gateway-owned tools such as `gateway_list_tools` or `gateway_call_tool`; gateway-owned tool schemas come from the MCP client's current gateway tool definitions.
- Do not rely on tool descriptions alone when the argument shape could affect correctness or safety.
- This is especially important for write tools, confirmation-based tools, and tools with nested argument objects.

## Response Shape Expectations

- `gateway_list_services` returns compact service entries with `serviceId`, `description`, and `available`.
- `gateway_list_tools` returns compact tool entries with `name` and `description`, and supports optional substring filtering by `toolName` as a string or string array.
- `gateway_get_tool_schema` returns only `inputSchema` and `outputSchema`.
- `gateway_call_tool` forwards the downstream MCP result directly with minimal or no gateway wrapping.

## Token-Efficient Strategy

- Start with the smallest discovery call that can answer the current question.
- Avoid listing tools for multiple services when the target domain is already obvious.
- Avoid fetching schemas for multiple tools when only one likely matches the task.
- Do not repeatedly fetch schemas for the same tool within the same active session unless the tool appears to have changed.

## Common Patterns

- Need a service for one task domain:
  - `gateway_list_services`
  - choose the most relevant `serviceId`
  - `gateway_list_tools({ serviceId: "selected-service", toolName: "optional-keyword" })`
  - `gateway_list_tools({ serviceId: "selected-service", toolName: ["keyword-a", "keyword-b"] })`
  - `gateway_get_tool_schema({ serviceId: "selected-service", toolName: "selected-tool" })`
  - `gateway_call_tool({ serviceId: "selected-service", toolName: "selected-tool", arguments: {...} })`

- Need to inspect an unfamiliar tool before first use, or any tool whose arguments are not fully certain:
  - `gateway_get_tool_schema({ serviceId: "selected-service", toolName: "selected-tool" })`
  - build arguments strictly from `inputSchema`
  - call the tool only after the schema is understood

## Prohibited Patterns

- **Never** flatten all downstream tools into your own notes unless the task explicitly needs a full inventory.
- **Never** invent arguments for a tool when the schema can be queried cheaply.
- **Never** skip `gateway_get_tool_schema` when argument names or fields are unclear.
- **Never** assume a service is available without checking recent gateway discovery results when availability matters.

## Practical Guidance

- Choose `serviceId` by task domain and service description instead of assuming a fixed service naming scheme.
- Prefer the smallest discovery step that can answer the question.
- If a downstream tool fails with a validation error, fetch or re-check its schema before retrying.
- If there is any doubt about required parameters, confirmation tokens, or argument structure, fetch the schema first instead of guessing.
