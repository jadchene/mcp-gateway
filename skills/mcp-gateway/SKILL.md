---
name: mcp-gateway
description: Use the MCP gateway for token-efficient discovery of downstream services and tools, name or description keyword search through gateway_list_tools, filtered schema inclusion, exact-name batch schema retrieval, and forwarded tool calls. Use when routing work through the gateway, broadening tool discovery, reducing repeated schema calls, or diagnosing a managed service.
---

# MCP Gateway

Operate downstream MCP services through the gateway's fixed, token-efficient discovery interface.

## Core Mandates

- **Discovery First**: Never guess a `serviceId` or downstream `toolName`. Discover them through the gateway.
- **Token Efficiency**: Keep tool discovery narrow. Use `includeSchema: true` only when schemas are needed for all filtered matches, and reuse schemas returned by the list call.
- **Schema Before Unclear Arguments**: If the tool arguments are not fully certain, fetch the schema before calling the tool. Do not guess argument names, shapes, or confirmation fields.
- **Cache Mentally Per Session**: Reuse known service lists, tool lists, and schemas within the current session instead of asking again without reason.
- **Compression Recovery Gate**: After any context compression event, re-read `AGENTS.md` and this `SKILL.md` before continuing.

## Required Workflow

1. Call `gateway_list_services` once to find the right downstream service.
2. Call `gateway_list_tools(serviceId)` only for the selected service. Use optional unique non-empty `toolName` and `desc` string arrays for case-insensitive literal substring matching. Description matches may come from negative guidance, so inspect the returned descriptions before selecting.
3. Pass `includeSchema: true` when every filtered match needs its schema, such as when comparing argument contracts or preparing to call multiple matches.
4. If selected schemas were not returned by the list call, call `gateway_get_tool_schema(serviceId, toolName)` with a unique non-empty array of exact, case-sensitive names before first use or whenever arguments remain uncertain. The whole request fails if any name is unknown; use a one-element array for one tool.
5. Call `gateway_call_tool(serviceId, toolName, arguments)` for execution. Always pass an explicit arguments object, using `{}` for no-argument tools, and treat downstream side effects according to the matched service rules.
6. Re-discover only when a call fails, service availability changes, or the task clearly requires fresh metadata.

## Diagnostic Exception

- Treat `gateway_get_service` as a diagnostic tool, not part of the default workflow.
- Use it only when the user explicitly asks to inspect service health, connection state, protocol details, or recent service errors.
- Do not call it during normal routing when service discovery, filtered tool discovery, and execution are sufficient.
- Treat `gateway_manage_service` as an explicit service-control tool, not part of the default workflow.
- Use `gateway_manage_service({ serviceId, action: "reconnect" })` only when the user explicitly wants to retry starting a failed service after its dependency becomes ready.
- Use `gateway_manage_service({ serviceId, action: "enable" | "disable" })` only when the user explicitly wants to persistently change that service's enabled state in the config file.

## Strict Argument Rule

- Treat every `serviceId` argument accepted by `gateway_*` tools as a downstream service identifier returned by `gateway_list_services`. Never pass `gateway`, a gateway-owned tool name, or any inferred self-reference as `serviceId`.
- If a tool has any non-trivial arguments, optional flags, confirmation fields, enum values, or write-safety fields, obtain its schema through `gateway_list_tools(..., includeSchema: true)` or `gateway_get_tool_schema` before execution unless the exact argument contract is already confirmed in the current session.
- Treat a schema returned by `gateway_list_tools(includeSchema: true)` as authoritative for that tool. Do not immediately repeat the same lookup with `gateway_get_tool_schema`.
- When exact names for several selected tools are already known, pass them in one `gateway_get_tool_schema` array instead of making one call per tool.
- Apply gateway discovery, schema, management, and routing tools only to downstream services and downstream tools. Do not use them to inspect or call gateway-owned tools such as `gateway_list_tools` or `gateway_call_tool`; gateway-owned tool schemas come from the MCP client's current gateway tool definitions.
- Do not rely on tool descriptions alone when the argument shape could affect correctness or safety.
- This is especially important for write tools, confirmation-based tools, and tools with nested argument objects.

## Response Shape Expectations

- `gateway_list_services` returns compact service entries with `serviceId`, `description`, and `available`.
- `gateway_list_tools` returns compact tool entries with `name` and `description`. Optional `toolName` and `desc` must be unique non-empty string arrays; they match literal name and description substrings respectively, case-insensitively.
- When both `toolName` and `desc` are present, return the union: a tool matches when its name or description contains any supplied keyword.
- `gateway_list_tools` includes `inputSchema` and `outputSchema` in every matching entry when `includeSchema` is true.
- `includeSchema` is optional and defaults to `false`. Keep it false for name-only discovery or broad unfiltered inventories.
- `gateway_get_tool_schema` requires unique exact, case-sensitive names in `toolName` and returns `schemas`, keyed by requested tool name; each value contains `inputSchema` and `outputSchema`.
- Stable gateway-owned structured results expose `outputSchema`; `gateway_call_tool` omits a fixed output schema and forwards the downstream result unchanged.
- `gateway_call_tool` may return an MCP `input_required` continuation, including one converted from a 2025 downstream form elicitation. Never auto-approve it; obtain the required user input and retry with the returned opaque `requestState` and matching `inputResponses`.
- Treat downstream `structuredContent` as arbitrary JSON rather than assuming it is an object.

## Token-Efficient Strategy

- Start with the smallest discovery call that can answer the current question.
- Avoid listing tools for multiple services when the target domain is already obvious.
- Use `desc` when task language is more likely to appear in tool descriptions than tool names. Combine it with `toolName` to broaden discovery without requesting the full inventory.
- Combine `toolName` filtering with `includeSchema: true` when multiple likely matches all need schema inspection; this replaces one list call plus repeated schema calls with one request.
- Keep `includeSchema` false when only names and descriptions are needed, or when an unfiltered service exposes many tools.
- When exact selected tool names are known and their schemas were omitted from discovery, fetch one or several in a single `gateway_get_tool_schema` call.
- Never fetch a tool schema again in the same session when the list response already supplied it, unless metadata may have changed.

## Common Patterns

- Need a service for one task domain:
  - `gateway_list_services`
  - choose the most relevant `serviceId`
  - `gateway_list_tools({ serviceId: "selected-service", toolName: ["optional-keyword"] })`
  - `gateway_list_tools({ serviceId: "selected-service", toolName: ["keyword-a", "keyword-b"] })`
  - `gateway_list_tools({ serviceId: "selected-service", toolName: ["name-keyword"], desc: ["description phrase"] })`
  - add `includeSchema: true` to either list call when every match needs schema inspection
  - otherwise call `gateway_get_tool_schema` after selecting exact tool names
  - `gateway_call_tool({ serviceId: "selected-service", toolName: "selected-tool", arguments: {...} })`

- Need to inspect several filtered candidates before choosing or calling them:
  - `gateway_list_tools({ serviceId: "selected-service", toolName: ["candidate-a", "candidate-b"], includeSchema: true })`
  - compare or reuse the returned `inputSchema` and `outputSchema` without separate schema calls

- Need schemas for exact selected tools whose schemas were not included in discovery:
  - `gateway_get_tool_schema({ serviceId: "selected-service", toolName: ["selected-tool"] })`
  - or `gateway_get_tool_schema({ serviceId: "selected-service", toolName: ["selected-tool-a", "selected-tool-b"] })`
  - read each result from `schemas[toolName]`
  - build arguments strictly from `inputSchema`
  - call the tool only after the schema is understood

## Prohibited Patterns

- **Never** flatten all downstream tools into your own notes unless the task explicitly needs a full inventory.
- **Never** invent arguments for a tool when the schema can be queried cheaply.
- **Never** proceed without a schema from `gateway_list_tools(..., includeSchema: true)` or `gateway_get_tool_schema` when argument names or fields are unclear.
- **Never** omit `gateway_call_tool.arguments`; pass `{}` when the downstream input schema has no properties.
- **Never** assume a service is available without checking recent gateway discovery results when availability matters.

## Practical Guidance

- Choose `serviceId` by task domain and service description instead of assuming a fixed service naming scheme.
- Prefer the smallest discovery step that can answer the question.
- If a downstream tool fails with a validation error, fetch or re-check its schema before retrying.
- If there is any doubt about required parameters, confirmation tokens, or argument structure, fetch the schema first instead of guessing.
