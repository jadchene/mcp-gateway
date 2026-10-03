import type { ElicitRequestFormParams } from "@modelcontextprotocol/client";

/**
 * 按 Codex 0.160.0 的私有约定构造审批元数据，不改变服务端权限校验。
 * @author chenjd
 * @created 2026-10-02 22:15:29
 */
export function buildCodexApprovalMeta(
  clientInfo: unknown,
  toolName: string,
  toolParams: Record<string, unknown>,
  description: string,
  sensitive = false
): Record<string, unknown> | undefined {
  if (typeof clientInfo !== "object" || clientInfo === null || Array.isArray(clientInfo)) {
    return undefined;
  }
  const name = (clientInfo as Record<string, unknown>).name;
  if (typeof name !== "string" || !/^codex(?:$|[-_])/i.test(name.trim())) {
    return undefined;
  }
  return {
    codex_request_type: "approval_request",
    codex_approval_kind: "mcp_tool_call",
    codex_strict_auto_review: true,
    ...(sensitive ? { codex_sensitive_action: true } : {}),
    tool_name: toolName,
    tool_description: description,
    tool_params: structuredClone(toolParams)
  };
}

/** 仅为网关自行生成的空确认表单添加 Codex 扩展。 */
export function withCodexApprovalMeta(
  params: ElicitRequestFormParams,
  clientInfo: unknown,
  toolName: string,
  toolParams: Record<string, unknown>,
  serviceId: string,
  serviceName?: string,
  enabled = false
): ElicitRequestFormParams {
  const existing = params._meta ?? {};
  if (!enabled || Object.keys(params.requestedSchema.properties).length > 0
    || existing.codex_requires_user_input === true
    || (existing.codex_approval_kind !== undefined && existing.codex_approval_kind !== "mcp_tool_call")) {
    return params;
  }
  // 网关要求显式确认的调用统一同步审查，避免未知工具提前执行。
  const approvalMeta = buildCodexApprovalMeta(clientInfo, toolName, toolParams, params.message, true);
  if (!approvalMeta) return params;
  const meta: Record<string, unknown> = {
    ...existing,
    ...approvalMeta,
    connector_id: serviceId,
    connector_name: serviceName ?? serviceId
  };
  delete meta.persist;
  return { ...params, _meta: meta };
}
