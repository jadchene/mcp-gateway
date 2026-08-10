import { Logger } from "./logger.ts";
import { ServiceRegistry } from "./service-registry.ts";
import type { DownstreamCallContext, DownstreamToolResult } from "./mcp/client-types.ts";
import { ToolConfirmationInterceptor } from "./mcp/tool-confirmation.ts";
import { matchesAnyToolNamePattern } from "./tool-name-pattern.ts";
import type { JsonObject, ServiceRuntimeSnapshot } from "./types.ts";

/**
 * Handles MCP JSON-RPC requests independently of the outer transport.
 */
export class McpGatewayEngine {
  /**
   * Stores the registry used for metadata lookup and routing.
   */
  private readonly registry: ServiceRegistry;

  /**
   * Stores the startup barrier that must resolve before gateway tools can use the registry.
   */
  private startupBarrier: Promise<void> = Promise.resolve();

  /**
   * Stores pending and approved confirmation continuation state.
   */
  private readonly toolConfirmation = new ToolConfirmationInterceptor();

  /**
   * Creates the transport-neutral gateway engine.
   */
  public constructor(
    registry: ServiceRegistry,
    _logger: Logger
  ) {
    this.registry = registry;
  }

  /**
   * Sets the startup barrier used to delay tool handling until the registry is ready.
   */
  public setStartupBarrier(barrier: Promise<void>): void {
    this.startupBarrier = barrier;
  }

  /**
   * Executes one registered gateway tool independently of the outer SDK transport.
   */
  public async executeTool(
    toolName: string,
    args: JsonObject,
    context: DownstreamCallContext = {}
  ): Promise<DownstreamToolResult> {
    await this.startupBarrier;
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
        return this.callDownstreamTool(args, context);
      default:
        throw new Error(`Unknown gateway tool '${toolName}'.`);
    }
  }

  /**
   * Returns detailed metadata for one logical service.
   */
  public getService(args: JsonObject): DownstreamToolResult {
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
  public listTools(args: JsonObject): DownstreamToolResult {
    const serviceId = requireString(args.serviceId, "The 'serviceId' argument must be a string.");
    const toolName = optionalUniqueNonEmptyStringArray(args.toolName, "The 'toolName' argument must be a unique non-empty string array when provided.");
    const desc = optionalUniqueNonEmptyStringArray(args.desc, "The 'desc' argument must be a unique non-empty string array when provided.");
    const includeSchema = optionalBoolean(args.includeSchema, "The 'includeSchema' argument must be a boolean when provided.") ?? false;
    return successContent({
      tools: this.registry.listTools(serviceId, toolName, desc).map((tool) => {
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
  public getToolSchema(args: JsonObject): DownstreamToolResult {
    const serviceId = requireString(args.serviceId, "The 'serviceId' argument must be a string.");
    const toolNames = requireUniqueNonEmptyStringArray(args.toolName, "The 'toolName' argument must be a unique non-empty string array.");
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
  public async callDownstreamTool(
    args: JsonObject,
    context: DownstreamCallContext = {}
  ): Promise<DownstreamToolResult> {
    const serviceId = requireString(args.serviceId, "The 'serviceId' argument must be a string.");
    const toolName = requireString(args.toolName, "The 'toolName' argument must be a string.");
    const toolArgs = toObject(args.arguments, "The 'arguments' field must be an object.");
    const snapshot = this.registry.getService(serviceId);

    const invoke = async (callContext: DownstreamCallContext): Promise<DownstreamToolResult> => {
      const call = await this.registry.callTool(serviceId, toolName, toolArgs, callContext);
      return call.result;
    };
    if (matchesAnyToolNamePattern(toolName, snapshot?.config.disabledTools)) {
      throw new Error(`Tool '${toolName}' in service '${serviceId}' is disabled by gateway configuration.`);
    }
    if (matchesAnyToolNamePattern(toolName, snapshot?.config.confirmationRequiredTools)) {
      return this.toolConfirmation.execute(serviceId, toolName, toolArgs, context, invoke);
    }
    return invoke(context);
  }

  /**
   * Applies one compact service management action.
   */
  public async manageService(args: JsonObject): Promise<DownstreamToolResult> {
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
}

/**
 * Builds the fixed gateway tool definitions exposed to all MCP clients.
 */
export function buildGatewayTools(options: { includeAdminTools?: boolean } = {}): GatewayToolDefinition[] {
  const outputSchemas = buildGatewayOutputSchemas();
  const tools: GatewayToolDefinition[] = [
    {
      name: "gateway_list_services",
      description: "Lists downstream MCP services with their logical identifiers, descriptions, and current availability.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false
      },
      outputSchema: outputSchemas.listServices
    },
    {
      name: "gateway_get_service",
      description: "Returns one downstream service's configured identity, availability, recent error and connection time, protocol version, and server information.",
      inputSchema: objectSchema(["serviceId"], {
        serviceId: stringSchema("Logical downstream service identifier returned by gateway_list_services.")
      }),
      outputSchema: outputSchemas.getService
    },
    {
      name: "gateway_list_tools",
      description: "Lists downstream tools by case-insensitive name or description substring filters and optionally includes each matching schema.",
      inputSchema: objectSchema(["serviceId"], {
        serviceId: stringSchema("Logical downstream service identifier returned by gateway_list_services."),
        toolName: uniqueNonEmptyStringArraySchema("Optional unique name substrings. Matching is case-insensitive; any name or description keyword may match."),
        desc: uniqueNonEmptyStringArraySchema("Optional unique literal description substrings. Matching is case-insensitive and may hit negative guidance, so inspect candidate descriptions. Name and description filters use OR."),
        includeSchema: {
          type: "boolean",
          description: "Includes inputSchema and outputSchema in every returned tool when true. Defaults to false."
        }
      }),
      outputSchema: outputSchemas.listTools
    },
    {
      name: "gateway_get_tool_schema",
      description: "Returns schemas for exact, case-sensitive downstream tool names, keyed by name; the whole request fails when any name is unknown.",
      inputSchema: objectSchema(["serviceId", "toolName"], {
        serviceId: stringSchema("Logical downstream service identifier returned by gateway_list_services."),
        toolName: uniqueNonEmptyStringArraySchema("Unique exact, case-sensitive downstream tool names returned by gateway_list_tools.")
      }),
      outputSchema: outputSchemas.getToolSchema
    },
    {
      name: "gateway_manage_service",
      description: "Reconnects a downstream service without changing config, or persistently enables or disables it in the gateway config and reloads the registry.",
      inputSchema: objectSchema(["serviceId", "action"], {
        serviceId: stringSchema("Logical downstream service identifier returned by gateway_list_services."),
        action: {
          type: "string",
          description: "reconnect refreshes the connection and metadata without changing config; enable and disable persist the enable flag and reload the registry.",
          enum: ["reconnect", "enable", "disable"]
        }
      }),
      outputSchema: outputSchemas.manageService
    },
    {
      name: "gateway_call_tool",
      description: "Calls one exact downstream tool and forwards its result unchanged. The downstream tool may have read or write side effects; inspect its schema and service rules first.",
      inputSchema: objectSchema(["serviceId", "toolName", "arguments"], {
        serviceId: stringSchema("Logical downstream service identifier returned by gateway_list_services."),
        toolName: stringSchema("Exact, case-sensitive downstream tool name returned by gateway_list_tools."),
        arguments: {
          type: "object",
          description: "Required arguments object built from the downstream inputSchema. Pass an empty object when the tool has no arguments."
        }
      })
    }
  ];
  return options.includeAdminTools === false
    ? tools.filter((tool) => tool.name !== "gateway_manage_service")
    : tools;
}

/**
 * Describes one stable gateway tool registered with the MCP SDK.
 */
export interface GatewayToolDefinition {
  /**
   * Provides the public tool name.
   */
  name: string;
  /**
   * Provides the public tool description.
   */
  description: string;
  /**
   * Provides the JSON Schema 2020-12 compatible input contract.
   */
  inputSchema: JsonObject;
  /**
   * Provides the stable output schema when the tool has one.
   */
  outputSchema?: JsonObject;
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
function successContent(data: JsonObject): DownstreamToolResult {
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
 * Builds output schemas for gateway tools with stable structured content.
 */
function buildGatewayOutputSchemas(): Record<"listServices" | "getService" | "listTools" | "getToolSchema" | "manageService", JsonObject> {
  const nullableString = nullableSchema({ type: "string" });
  const nullableObject = nullableSchema({ type: "object" });
  const nullableToolSchema = nullableSchema({ type: "object" });

  return {
    listServices: objectSchema(["services"], {
      services: {
        type: "array",
        items: objectSchema(["serviceId", "description", "available"], {
          serviceId: { type: "string" },
          description: nullableString,
          available: { type: "boolean" }
        })
      }
    }),
    getService: objectSchema([
      "serviceId",
      "name",
      "description",
      "available",
      "lastError",
      "lastConnectedAt",
      "protocolVersion",
      "serverInfo"
    ], {
      serviceId: { type: "string" },
      name: { type: "string" },
      description: nullableString,
      available: { type: "boolean" },
      lastError: nullableString,
      lastConnectedAt: nullableString,
      protocolVersion: nullableString,
      serverInfo: nullableObject
    }),
    listTools: objectSchema(["tools"], {
      tools: {
        type: "array",
        items: objectSchema(["name", "description"], {
          name: { type: "string" },
          description: nullableString,
          inputSchema: nullableToolSchema,
          outputSchema: nullableToolSchema
        })
      }
    }),
    getToolSchema: objectSchema(["schemas"], {
      schemas: {
        type: "object",
        minProperties: 1,
        additionalProperties: objectSchema(["inputSchema", "outputSchema"], {
          inputSchema: nullableToolSchema,
          outputSchema: nullableToolSchema
        })
      }
    }),
    manageService: objectSchema(["serviceId", "action", "enabled", "available"], {
      serviceId: { type: "string" },
      action: {
        type: "string",
        enum: ["reconnect", "enable", "disable"]
      },
      enabled: { type: "boolean" },
      available: { type: "boolean" }
    })
  };
}

/**
 * Builds a schema that accepts the supplied shape or null.
 */
function nullableSchema(schema: JsonObject): JsonObject {
  return {
    anyOf: [schema, { type: "null" }]
  };
}

/**
 * Builds a simple JSON schema string descriptor.
 */
function stringSchema(description: string): JsonObject {
  return {
    type: "string",
    description,
    minLength: 1,
    pattern: "\\S"
  };
}

/**
 * Builds a non-empty unique string array descriptor.
 */
function uniqueNonEmptyStringArraySchema(description: string): JsonObject {
  return {
    type: "array",
    description,
    minItems: 1,
    uniqueItems: true,
    items: {
      type: "string",
      minLength: 1,
      pattern: "\\S"
    }
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
 * Returns an optional unique non-empty array of non-empty strings.
 */
function optionalUniqueNonEmptyStringArray(input: unknown, message: string): string[] | undefined {
  if (input === undefined || input === null) {
    return undefined;
  }

  if (
    !Array.isArray(input)
    || input.length === 0
    || input.some((value) => typeof value !== "string" || value.trim() === "")
    || new Set(input).size !== input.length
  ) {
    throw new Error(message);
  }

  return input;
}

/**
 * Returns a required unique non-empty string array.
 */
function requireUniqueNonEmptyStringArray(input: unknown, message: string): string[] {
  const values = optionalUniqueNonEmptyStringArray(input, message);
  if (!values) {
    throw new Error(message);
  }
  return values;
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
