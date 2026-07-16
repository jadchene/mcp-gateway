import { Logger } from "./logger.ts";
import { jsonRpcError, jsonRpcResult, type JsonRpcFailure, type JsonRpcMessage, type JsonRpcRequest, type JsonRpcSuccess } from "./mcp/protocol.ts";
import { ServiceRegistry } from "./service-registry.ts";
import type { JsonObject, ServiceRuntimeSnapshot } from "./types.ts";
import { VERSION } from "./version.ts";

/**
 * Handles MCP JSON-RPC requests independently of the outer transport.
 */
export class McpGatewayEngine {
  /**
   * Stores the registry used for metadata lookup and routing.
   */
  private readonly registry: ServiceRegistry;

  /**
   * Stores the shared logger instance.
   */
  private readonly logger: Logger;

  /**
   * Stores the startup barrier that must resolve before gateway tools can use the registry.
   */
  private startupBarrier: Promise<void> = Promise.resolve();

  /**
   * Creates the transport-neutral gateway engine.
   */
  public constructor(
    registry: ServiceRegistry,
    logger: Logger
  ) {
    this.registry = registry;
    this.logger = logger;
  }

  /**
   * Sets the startup barrier used to delay tool handling until the registry is ready.
   */
  public setStartupBarrier(barrier: Promise<void>): void {
    this.startupBarrier = barrier;
  }

  /**
   * Handles one inbound JSON-RPC message and returns a response when the message has an id.
   */
  public async handleMessage(message: JsonRpcMessage): Promise<JsonRpcSuccess | JsonRpcFailure | null> {
    if (!isJsonRpcRequest(message)) {
      return null;
    }
    return this.handleRequest(message);
  }

  /**
   * Handles one inbound JSON-RPC request.
   */
  public async handleRequest(request: JsonRpcRequest): Promise<JsonRpcSuccess | JsonRpcFailure | null> {
    try {
      if (request.method === "initialize") {
        return jsonRpcResult(request.id, this.buildInitializeResult());
      }

      if (request.method === "ping") {
        return jsonRpcResult(request.id, {});
      }

      if (request.method === "tools/list") {
        return jsonRpcResult(request.id, { tools: buildGatewayTools() });
      }

      if (request.method === "tools/call") {
        await this.startupBarrier;
        const result = await this.handleToolCall(request);
        return jsonRpcResult(request.id, result);
      }

      if (request.method === "notifications/initialized") {
        return null;
      }

      return jsonRpcError(request.id, -32601, `Unsupported method '${request.method}'.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error("gateway.request_failed", {
        method: request.method,
        message
      });
      return jsonRpcError(request.id, -32000, message);
    }
  }

  /**
   * Handles one gateway tool invocation.
   */
  public async handleToolCall(request: JsonRpcRequest): Promise<unknown> {
    const params = toObject(request.params, "The tools/call params must be an object.");
    const toolName = requireString(params.name, "The tool name must be a string.");
    const args = toObject(params.arguments ?? {}, "The tool arguments must be an object.");

    switch (toolName) {
      case "gateway_list_services":
        return successContent({
          services: this.registry.listServices().map(formatServiceSummary)
        });
      case "gateway_get_service":
        return this.getService(args);
      case "gateway_list_tools":
        return this.listTools(args);
      case "gateway_get_tool_schema":
        return this.getToolSchema(args);
      case "gateway_manage_service":
        return this.manageService(args);
      case "gateway_call_tool":
        return this.callDownstreamTool(args);
      default:
        throw new Error(`Unknown gateway tool '${toolName}'.`);
    }
  }

  /**
   * Returns detailed metadata for one logical service.
   */
  public getService(args: JsonObject): unknown {
    const serviceId = requireString(args.serviceId, "The 'serviceId' argument must be a string.");
    const snapshot = this.registry.getService(serviceId);
    if (!snapshot) {
      throw new Error(`Unknown service '${serviceId}'.`);
    }

    return successContent({
      serviceId: snapshot.config.serviceId,
      name: snapshot.config.name,
      description: snapshot.config.description ?? null,
      available: snapshot.runtime.available,
      lastError: snapshot.runtime.lastError,
      lastConnectedAt: snapshot.runtime.lastConnectedAt,
      protocolVersion: snapshot.metadata.protocolVersion,
      serverInfo: snapshot.metadata.serverInfo
    });
  }

  /**
   * Returns tool summaries for one logical service.
   */
  public listTools(args: JsonObject): unknown {
    const serviceId = requireString(args.serviceId, "The 'serviceId' argument must be a string.");
    const toolName = optionalStringArray(args.toolName, "The 'toolName' argument must be a string or string array when provided.");
    const includeSchema = optionalBoolean(args.includeSchema, "The 'includeSchema' argument must be a boolean when provided.") ?? false;
    return successContent({
      tools: this.registry.listTools(serviceId, toolName).map((tool) => {
        const summary: JsonObject = {
          name: tool.name,
          description: tool.description ?? null
        };

        if (includeSchema) {
          summary.inputSchema = tool.inputSchema ?? null;
          summary.outputSchema = tool.outputSchema ?? null;
        }

        return summary;
      })
    });
  }

  /**
   * Returns input and output schemas keyed by downstream tool name.
   */
  public getToolSchema(args: JsonObject): unknown {
    const serviceId = requireString(args.serviceId, "The 'serviceId' argument must be a string.");
    const toolNames = requireStringArray(args.toolName, "The 'toolName' argument must be a non-empty string or non-empty string array.");
    const schemas = Object.fromEntries(toolNames.map((toolName) => {
      const tool = this.registry.getTool(serviceId, toolName);

      if (!tool) {
        throw new Error(`Unknown tool '${toolName}' in service '${serviceId}'.`);
      }

      return [toolName, {
        inputSchema: tool.inputSchema ?? null,
        outputSchema: tool.outputSchema ?? null
      }] as const;
    }));

    return successContent({ schemas });
  }

  /**
   * Routes one downstream tool call through the service registry.
   */
  public async callDownstreamTool(args: JsonObject): Promise<unknown> {
    const serviceId = requireString(args.serviceId, "The 'serviceId' argument must be a string.");
    const toolName = requireString(args.toolName, "The 'toolName' argument must be a string.");
    const toolArgs = toObject(args.arguments ?? {}, "The 'arguments' field must be an object.");
    const call = await this.registry.callTool(serviceId, toolName, toolArgs);
    return call.result;
  }

  /**
   * Applies one compact service management action.
   */
  public async manageService(args: JsonObject): Promise<unknown> {
    const serviceId = requireString(args.serviceId, "The 'serviceId' argument must be a string.");
    const action = requireServiceAction(args.action);
    const result = await this.registry.manageService(serviceId, action);
    return successContent({
      serviceId: result.serviceId,
      action: result.action,
      enabled: result.enabled,
      available: result.available
    });
  }

  /**
   * Builds the MCP initialize result advertised by the gateway.
   */
  private buildInitializeResult(): JsonObject {
    return {
      protocolVersion: "2025-06-18",
      capabilities: {
        tools: {
          listChanged: false
        }
      },
      serverInfo: {
        name: "mcp-gateway",
        version: VERSION
      }
    };
  }
}

/**
 * Builds the fixed gateway tool definitions exposed to all MCP clients.
 */
export function buildGatewayTools(): JsonObject[] {
  return [
    {
      name: "gateway_list_services",
      description: "Lists all MCP services currently managed by the gateway.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false
      }
    },
    {
      name: "gateway_get_service",
      description: "Returns one service summary, runtime state, and metadata cache details.",
      inputSchema: objectSchema(["serviceId"], {
        serviceId: stringSchema("Logical service identifier.")
      })
    },
    {
      name: "gateway_list_tools",
      description: "Lists tools exposed by one downstream service, optionally filtered by name keywords and including their schemas.",
      inputSchema: objectSchema(["serviceId"], {
        serviceId: stringSchema("Logical service identifier."),
        toolName: {
          anyOf: [
            stringSchema("Optional keyword matched against downstream tool names."),
            {
              type: "array",
              description: "Optional keywords matched against downstream tool names. A tool is returned when any keyword matches.",
              items: {
                type: "string"
              }
            }
          ]
        },
        includeSchema: {
          type: "boolean",
          description: "Includes inputSchema and outputSchema in every returned tool when true. Defaults to false."
        }
      })
    },
    {
      name: "gateway_get_tool_schema",
      description: "Returns input and output schemas for one or more downstream tools, keyed by tool name.",
      inputSchema: objectSchema(["serviceId", "toolName"], {
        serviceId: stringSchema("Logical service identifier."),
        toolName: {
          anyOf: [
            {
              type: "string",
              description: "Downstream tool name.",
              minLength: 1
            },
            {
              type: "array",
              description: "Downstream tool names whose schemas should be returned.",
              minItems: 1,
              items: {
                type: "string",
                minLength: 1
              }
            }
          ]
        }
      })
    },
    {
      name: "gateway_manage_service",
      description: "Reconnects one service or updates its enabled state with a compact action.",
      inputSchema: objectSchema(["serviceId", "action"], {
        serviceId: stringSchema("Logical service identifier."),
        action: {
          type: "string",
          description: "Management action applied to the service.",
          enum: ["reconnect", "enable", "disable"]
        }
      })
    },
    {
      name: "gateway_call_tool",
      description: "Calls one downstream tool through the gateway service pool.",
      inputSchema: objectSchema(["serviceId", "toolName", "arguments"], {
        serviceId: stringSchema("Logical service identifier."),
        toolName: stringSchema("Downstream tool name."),
        arguments: {
          type: "object",
          description: "Arguments passed to the downstream tool."
        }
      })
    }
  ];
}

/**
 * Formats one service into the compact listServices result shape.
 */
function formatServiceSummary(snapshot: ServiceRuntimeSnapshot): JsonObject {
  return {
    serviceId: snapshot.config.serviceId,
    description: snapshot.config.description ?? null,
    available: snapshot.runtime.available
  };
}

/**
 * Builds a standard MCP tool success payload with text and structured content.
 */
function successContent(data: JsonObject): JsonObject {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(data, null, 2)
      }
    ],
    structuredContent: data
  };
}

/**
 * Builds a simple JSON schema object descriptor.
 */
function objectSchema(required: string[], properties: Record<string, JsonObject>): JsonObject {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false
  };
}

/**
 * Builds a simple JSON schema string descriptor.
 */
function stringSchema(description: string): JsonObject {
  return {
    type: "string",
    description
  };
}

/**
 * Ensures the input is a plain object.
 */
function toObject(input: unknown, message: string): JsonObject {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(message);
  }
  return input as JsonObject;
}

/**
 * Ensures the input is a string.
 */
function requireString(input: unknown, message: string): string {
  if (typeof input !== "string" || input.trim() === "") {
    throw new Error(message);
  }
  return input;
}

/**
 * Returns optional string keywords, treating blank strings as absent.
 */
function optionalStringArray(input: unknown, message: string): string | string[] | undefined {
  if (input === undefined || input === null) {
    return undefined;
  }

  if (typeof input !== "string") {
    if (!Array.isArray(input) || input.some((value) => typeof value !== "string")) {
      throw new Error(message);
    }

    const values = input.map((value) => value.trim()).filter((value) => value !== "");
    return values.length === 0 ? undefined : values;
  }

  const trimmed = input.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Returns one or more required non-empty strings with duplicates removed.
 */
function requireStringArray(input: unknown, message: string): string[] {
  if (typeof input === "string") {
    if (input.trim() === "") {
      throw new Error(message);
    }
    return [input];
  }

  if (!Array.isArray(input) || input.length === 0 || input.some((value) => typeof value !== "string" || value.trim() === "")) {
    throw new Error(message);
  }

  return [...new Set(input)];
}

/**
 * Returns an optional boolean without coercing other input types.
 */
function optionalBoolean(input: unknown, message: string): boolean | undefined {
  if (input === undefined || input === null) {
    return undefined;
  }
  if (typeof input !== "boolean") {
    throw new Error(message);
  }
  return input;
}

/**
 * Ensures the service management action is supported.
 */
function requireServiceAction(input: unknown): "reconnect" | "enable" | "disable" {
  if (input === "reconnect" || input === "enable" || input === "disable") {
    return input;
  }
  throw new Error("The 'action' argument must be one of 'reconnect', 'enable', or 'disable'.");
}

function isJsonRpcRequest(message: JsonRpcMessage): message is JsonRpcRequest {
  return "id" in message && "method" in message && typeof message.method === "string";
}
