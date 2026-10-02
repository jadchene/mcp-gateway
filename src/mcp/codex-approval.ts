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

/** 仅为空的操作确认表单添加 Codex 扩展，保留普通输入表单与下游上下文。 */
export function withCodexApprovalMeta(
  params: ElicitRequestFormParams,
  clientInfo: unknown,
  toolName: string,
  toolParams: Record<string, unknown>,
  serviceId: string,
  serviceName?: string
): ElicitRequestFormParams {
  const existing = params._meta ?? {};
  if (Object.keys(params.requestedSchema.properties).length > 0
    || existing.codex_requires_user_input === true
    || (existing.codex_approval_kind !== undefined && existing.codex_approval_kind !== "mcp_tool_call")) {
    return params;
  }
  // 下游通常将网关识别为普通客户端；统一同步审查，避免漏掉敏感操作标记。
  const approvalMeta = buildCodexApprovalMeta(clientInfo, toolName, toolParams, params.message, true);
  if (!approvalMeta) return params;
  const meta: Record<string, unknown> = {
    ...existing,
    ...approvalMeta,
    connector_id: serviceId,
    connector_name: serviceName ?? serviceId
  };
  if (existing.codex_request_type === "approval_request") {
    for (const key of ["tool_name", "tool_description", "tool_title", "tool_params"]) {
      if (existing[key] !== undefined) meta[key] = structuredClone(existing[key]);
    }
  }
  delete meta.persist;
  return { ...params, _meta: meta };
}
