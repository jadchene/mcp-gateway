import { createHash } from "node:crypto";
import type { Tool } from "@modelcontextprotocol/server";
import type { ServiceConfig, ToolDefinition } from "./types.ts";

/** 透明工具的上游声明及对应的下游路由。
 * @author chenjd
 * @created 2026-11-19 21:17:04
 */
export interface TransparentTool {
  /** 用于调用与权限校验的原始服务标识。 */
  serviceId: string;
  /** 下游工具的原始名称。 */
  toolName: string;
  /** 客户端搜索和调用时看到的声明。 */
  definition: Tool;
}

/** 为已有的任意服务标识生成稳定名称，保留三连下划线作为摘要分隔符。 */
export function transparentToolName(serviceId: string, toolName: string): string {
  const name = `${serviceId}__${toolName}`;
  if (name.length <= 64 && /^[A-Za-z0-9_-]+$/.test(name)
    && !serviceId.includes("__") && !toolName.includes("__")
    && !serviceId.endsWith("_") && !toolName.startsWith("_")) return name;

  const suffix = createHash("sha256").update(JSON.stringify([serviceId, toolName])).digest("hex").slice(0, 16);
  const clean = (part: string) => part.replace(/[^A-Za-z0-9-]+/g, "_");
  return `${clean(serviceId).slice(0, 20)}__${clean(toolName).slice(0, 23)}___${suffix}`;
}

/** 保留原始参数和结果契约，并让检索词包含服务名称。 */
export function createTransparentTool(service: ServiceConfig, tool: ToolDefinition): TransparentTool {
  const name = transparentToolName(service.serviceId, tool.name);
  const serviceLabel = service.name.includes(service.serviceId) ? service.name : `${service.name} (${service.serviceId})`;
  const { inputSchema, outputSchema, ...metadata } = tool;
  return {
    serviceId: service.serviceId,
    toolName: tool.name,
    definition: {
      ...metadata,
      name,
      description: [serviceLabel, tool.description ?? tool.title ?? tool.name].join(" — "),
      inputSchema: inputSchema ?? { type: "object" },
      ...(outputSchema ? { outputSchema } : {})
    } as Tool
  };
}
