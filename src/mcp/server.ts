import {
  CLIENT_CAPABILITIES_META_KEY,
  McpServer,
  fromJsonSchema,
  type CallToolResult,
  type InputRequiredResult,
  type JsonSchemaType,
  type ServerContext,
  type ServerOptions
} from "@modelcontextprotocol/server";
import { buildGatewayTools, McpGatewayEngine } from "../gateway-engine.ts";
import type { JsonObject } from "../types.ts";
import { VERSION } from "../version.ts";
import type { DownstreamCallContext } from "./client-types.ts";
import { SUPPORTED_MCP_PROTOCOL_VERSIONS } from "./versions.ts";

/**
 * Creates one SDK server instance with all six stable gateway tools.
 */
export function createGatewayMcpServer(engine: McpGatewayEngine): McpServer {
  const options: ServerOptions = {
    supportedProtocolVersions: [...SUPPORTED_MCP_PROTOCOL_VERSIONS],
    capabilities: {
      tools: {
        listChanged: false
      }
    },
    cacheHints: {
      "server/discover": {
        ttlMs: 60_000,
        cacheScope: "public"
      },
      "tools/list": {
        ttlMs: 300_000,
        cacheScope: "public"
      }
    },
    inputRequired: {
      maxRounds: 8
    }
  };
  const server = new McpServer({ name: "mcp-gateway", version: VERSION }, options);

  for (const tool of buildGatewayTools()) {
    const inputSchema = fromJsonSchema<JsonObject>(tool.inputSchema as JsonSchemaType);
    const outputSchema = tool.outputSchema
      ? fromJsonSchema<unknown>(tool.outputSchema as JsonSchemaType)
      : undefined;
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema,
        ...(outputSchema ? { outputSchema } : {})
      },
      async (args, context): Promise<CallToolResult | InputRequiredResult> => {
        const downstreamContext = toDownstreamContext(context, server.server.getClientCapabilities());
        return engine.executeTool(
          tool.name,
          args,
          downstreamContext
        );
      }
    );
  }

  return server;
}

/**
 * Extracts request-scoped MRTR, capability, and cancellation state for the downstream call.
 */
function toDownstreamContext(
  context: ServerContext,
  mcp2025ClientCapabilities: Record<string, unknown> | undefined
): DownstreamCallContext {
  const envelope = context.mcpReq.envelope as Record<string, unknown> | undefined;
  const envelopeCapabilities = envelope?.[CLIENT_CAPABILITIES_META_KEY];
  const clientCapabilities = isRecord(envelopeCapabilities)
    ? envelopeCapabilities
    : mcp2025ClientCapabilities;
  return {
    signal: context.mcpReq.signal,
    ...(clientCapabilities ? { clientCapabilities } : {}),
    ...(context.mcpReq.inputResponses ? { inputResponses: context.mcpReq.inputResponses } : {}),
    ...(context.mcpReq.requestState<string>() ? { requestState: context.mcpReq.requestState<string>() } : {})
  };
}

/**
 * Checks whether a value is a plain record.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
