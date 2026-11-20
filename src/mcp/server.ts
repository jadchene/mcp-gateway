import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  McpServer,
  fromJsonSchema,
  type CallToolResult,
  type ElicitRequestFormParams,
  type InputRequiredResult,
  type JsonSchemaType,
  type RegisteredTool,
  type ServerContext,
  type ServerOptions
} from "@modelcontextprotocol/server";
import { buildGatewayTools, McpGatewayEngine } from "../gateway-engine.ts";
import { VERSION } from "../version.ts";
import type { DownstreamCallContext } from "./client-types.ts";
import { SUPPORTED_MCP_PROTOCOL_VERSIONS } from "./versions.ts";
import { createInputSchema, downstreamSchema } from "./input-schema.ts";

/** 在整份目录替换后一次性通知客户端。
 * @author chenjd
 * @created 2026-11-19 21:17:04
 */
class GatewayMcpServer extends McpServer {
  /** 注册和移除一批工具时，由目录发布者统一通知。 */
  public override sendToolListChanged(): void {}
}

/**
 * Creates one SDK server instance with the selected gateway tool surface.
 */
export function createGatewayMcpServer(
  engine: McpGatewayEngine,
  options: { includeAdminTools?: boolean; perRequest?: boolean; configuredServiceIds?: string[] } = {}
): McpServer {
  const serverOptions: ServerOptions = {
    ...(engine.registry.toolCatalog ? {
      instructions: `Start with gateway_list_services for the current service IDs and tool discovery mode. Follow its transparentTools flag. Services at connection time: ${(options.configuredServiceIds ?? engine.registry.listServices().map(({ config }) => config.serviceId)).join(", ")}.`
    } : {}),
    supportedProtocolVersions: [...SUPPORTED_MCP_PROTOCOL_VERSIONS],
    capabilities: {
      tools: {
        listChanged: true
      }
    },
    cacheHints: {
      "server/discover": {
        ttlMs: 60_000,
        cacheScope: "public"
      },
      "tools/list": {
        ttlMs: 0,
        cacheScope: "private"
      }
    },
    inputRequired: {
      maxRounds: 8
    }
  };
  const server = new GatewayMcpServer({ name: "mcp-gateway", version: VERSION }, serverOptions);
  const registered: RegisteredTool[] = [];
  const gatewayTools = buildGatewayTools(options);

  const registerGatewayTool = (tool: (typeof gatewayTools)[number]) => {
    const inputSchema = createInputSchema(tool.inputSchema);
    const outputSchema = tool.outputSchema
      ? fromJsonSchema<unknown>(tool.outputSchema as JsonSchemaType)
      : undefined;
    return server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema,
        ...(outputSchema ? { outputSchema } : {})
      },
      async (args, context): Promise<CallToolResult | InputRequiredResult> => {
        const downstreamContext = toDownstreamContext(
          context, server.server.getClientCapabilities(), server.server.getClientVersion()
        );
        return engine.executeTool(
          tool.name,
          args,
          downstreamContext
        );
      }
    );
  };

  const refresh = () => {
    for (const handle of registered) handle.remove();
    registered.length = 0;
    const catalog = engine.registry.toolCatalog;
    for (const tool of gatewayTools) {
      if (catalog && !["gateway_list_services", "gateway_get_service", "gateway_manage_service"].includes(tool.name)) continue;
      registered.push(registerGatewayTool(tool));
    }
    for (const entry of catalog?.values() ?? []) {
      const tool = entry.definition;
      const handle = server.registerTool(tool.name, {
        title: tool.title,
        description: tool.description,
        annotations: tool.annotations,
        icons: tool.icons,
        _meta: tool._meta,
        inputSchema: downstreamSchema(tool.inputSchema),
        ...(tool.outputSchema ? { outputSchema: downstreamSchema(tool.outputSchema) } : {})
      }, (args, context) => engine.callTransparentTool(tool.name, args,
        toDownstreamContext(context, server.server.getClientCapabilities(), server.server.getClientVersion())));
      handle.execution = tool.execution;
      registered.push(handle);
    }
  };
  refresh();
  if (!options.perRequest) {
    const events = engine.registry.catalogEvents;
    const onChange = () => {
      refresh();
      if (server.isConnected()) void server.server.sendToolListChanged().catch(error => server.server.onerror?.(error));
    };
    events.addEventListener("change", onChange);
    server.server.onclose = () => events.removeEventListener("change", onChange);
  }

  return server;
}

/**
 * Extracts request-scoped MRTR, capability, and cancellation state for the downstream call.
 */
function toDownstreamContext(
  context: ServerContext,
  mcp2025ClientCapabilities: Record<string, unknown> | undefined,
  mcp2025ClientInfo: Record<string, unknown> | undefined
): DownstreamCallContext {
  const envelope = context.mcpReq.envelope as Record<string, unknown> | undefined;
  const envelopeCapabilities = envelope?.[CLIENT_CAPABILITIES_META_KEY];
  const envelopeClientInfo = envelope?.[CLIENT_INFO_META_KEY];
  const clientInfo = context.mcpReq.envelope
    ? (isRecord(envelopeClientInfo) ? envelopeClientInfo : undefined)
    : mcp2025ClientInfo;
  const clientCapabilities = isRecord(envelopeCapabilities)
    ? envelopeCapabilities
    : mcp2025ClientCapabilities;
  if (!context.mcpReq.envelope) {
    normalizeLegacyFormElicitationCapability(clientCapabilities);
  }
  return {
    signal: context.mcpReq.signal,
    ...(clientCapabilities ? { clientCapabilities } : {}),
    ...(clientInfo ? { clientInfo } : {}),
    ...(context.mcpReq.inputResponses ? { inputResponses: context.mcpReq.inputResponses } : {}),
    ...(context.mcpReq.requestState<string>() ? { requestState: context.mcpReq.requestState<string>() } : {}),
    ...(!context.mcpReq.envelope
      ? {
          elicitForm: (params: ElicitRequestFormParams, signal: AbortSignal) => context.mcpReq.elicitInput(
            params,
            {
              signal,
              relatedRequestId: context.mcpReq.id
            }
          )
        }
      : {})
  };
}

/**
 * MCP 2025 clients may advertise form elicitation as the legacy shorthand
 * `elicitation: {}`. The SDK's request helper expects the later explicit
 * `elicitation.form` shape, so normalize the negotiated capability in place.
 */
export function normalizeLegacyFormElicitationCapability(
  clientCapabilities: Record<string, unknown> | undefined
): void {
  const elicitation = clientCapabilities?.elicitation;
  if (isRecord(elicitation) && !("form" in elicitation)) {
    elicitation.form = {};
  }
}

/**
 * Checks whether a value is a plain record.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
