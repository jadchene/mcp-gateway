---
name: mcp-gateway
description: Use the MCP gateway for token-efficient discovery of downstream MCP services, tool lists, tool schemas, and forwarded tool calls. Prefer this skill when the gateway exposes a fixed discovery surface instead of flattening all downstream tools.
---

# MCP Gateway

Operate downstream MCP services through the gateway's fixed, token-efficient discovery interface.

## Core Mandates

- **Discovery First**: Never guess a `serviceId` or downstream `toolName`. Discover them through the gateway.
- **Token Efficiency**: Do not enumerate every service and every tool unless the task genuinely needs it.
- **Schema Before First Call**: Before the first call to an unfamiliar downstream tool, fetch its schema.
- **Cache Mentally Per Session**: Reuse known service lists, tool lists, and schemas within the current session instead of asking again without reason.
- **Compression Recovery Gate**: After any context compression event, re-read `AGENTS.md` and this `SKILL.md` before continuing.

## Required Workflow

1. Call `gateway.listServices` once to find the right downstream service.
2. Call `gateway.listTools(serviceId)` only for the selected service.
3. Call `gateway.getToolSchema(serviceId, toolName)` only before the first use of that tool, or when arguments are unclear.
4. Call `gateway.callTool(serviceId, toolName, arguments)` for execution.
5. Re-discover only when a call fails, service availability changes, or the task clearly requires fresh metadata.

## Response Shape Expectations

- `gateway.listServices` returns compact service entries with `serviceId`, `description`, and `available`.
- `gateway.listTools` returns compact tool entries with `name` and `description`.
- `gateway.getToolSchema` returns only `inputSchema` and `outputSchema`.
- `gateway.callTool` forwards the downstream MCP result directly with minimal or no gateway wrapping.

## Token-Efficient Strategy

- Start with the smallest discovery call that can answer the current question.
- Avoid listing tools for multiple services when the target domain is already obvious.
- Avoid fetching schemas for multiple tools when only one likely matches the task.
- Do not repeatedly fetch schemas for the same tool within the same active session unless the tool appears to have changed.

## Common Patterns

- Need a service for one task domain:
  - `gateway.listServices`
  - choose the most relevant `serviceId`
  - `gateway.listTools({ serviceId: "selected-service" })`
  - `gateway.getToolSchema({ serviceId: "selected-service", toolName: "selected-tool" })`
  - `gateway.callTool({ serviceId: "selected-service", toolName: "selected-tool", arguments: {...} })`

- Need to inspect an unfamiliar tool before first use:
  - `gateway.getToolSchema({ serviceId: "selected-service", toolName: "selected-tool" })`
  - build arguments strictly from `inputSchema`
  - call the tool only after the schema is understood

## Prohibited Patterns

- **Never** flatten all downstream tools into your own notes unless the task explicitly needs a full inventory.
- **Never** invent arguments for a tool when the schema can be queried cheaply.
- **Never** assume a service is available without checking recent gateway discovery results when availability matters.

## Practical Guidance

- Choose `serviceId` by task domain and service description instead of assuming a fixed service naming scheme.
- Prefer the smallest discovery step that can answer the question.
- If a downstream tool fails with a validation error, fetch or re-check its schema before retrying.
