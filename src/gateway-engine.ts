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
        return this.listServices(args);
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
   * Returns service summaries optionally matching identifiers, descriptions, and availability.
   */
  public listServices(args: JsonObject): DownstreamToolResult {
    const serviceId = optionalStringOrArray(args.serviceIdFilter, "The 'serviceIdFilter' argument must be a non-empty string or unique non-empty string array when provided.");
    const desc = optionalStringOrArray(args.descFilter, "The 'descFilter' argument must be a non-empty string or unique non-empty string array when provided.");
    const available = optionalBoolean(args.availableFilter, "The 'availableFilter' argument must be a boolean when provided.");
    const serviceIdKeywords = normalizeKeywords(serviceId);
    const descriptionKeywords = normalizeKeywords(desc);
    const services = this.registry.listServices().filter((snapshot) => {
      const matchesText = serviceIdKeywords.length === 0 && descriptionKeywords.length === 0
        || serviceIdKeywords.some((keyword) => snapshot.config.serviceId.toLowerCase().includes(keyword))
        || descriptionKeywords.some((keyword) => (snapshot.config.description ?? "").toLowerCase().includes(keyword));
      const matchesAvailability = available === undefined || snapshot.runtime.available === available;
      return matchesText && matchesAvailability;
    });

    return successContent({
      services: services.map(formatServiceSummary)
    });
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
    const toolName = optionalStringOrArray(args.toolNameFilter, "The 'toolNameFilter' argument must be a non-empty string or unique non-empty string array when provided.");
    const desc = optionalStringOrArray(args.descFilter, "The 'descFilter' argument must be a non-empty string or unique non-empty string array when provided.");
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
    const toolNames = requireStringOrArray(args.toolName, "The 'toolName' argument must be a non-empty string or unique non-empty string array.");
    const found: Array<[string, JsonObject]> = [];
    const missing: Array<[string, string]> = [];
    for (const toolName of toolNames) {
      const tool = this.registry.getTool(serviceId, toolName);

      if (!tool) {
        missing.push([toolName, `Unknown tool in service '${serviceId}'.`]);
        continue;
      }

      found.push([toolName, {
        inputSchema: tool.inputSchema ?? null,
        outputSchema: tool.outputSchema ?? null
      }]);
    }

    return {
      ...successContent({
        schemas: Object.fromEntries(found),
        ...(missing.length ? { errors: Object.fromEntries(missing) } : {})
      }),
      ...(found.length === 0 ? { isError: true } : {})
    };
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
    if (
      this.toolConfirmation.handlesState(context.requestState)
      || matchesAnyToolNamePattern(toolName, snapshot?.config.confirmationRequiredTools)
    ) {
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
      description: "Finds enabled services. Text filters use case-insensitive substrings joined by OR; availability further limits matches.",
      inputSchema: objectSchema([], {
        serviceIdFilter: stringOrArraySchema("Service ID keywords."),
        descFilter: stringOrArraySchema("Description keywords."),
        availableFilter: {
          type: "boolean",
          description: "true: available services; false: unavailable services; omitted or null: either."
        }
      }),
      outputSchema: outputSchemas.listServices
    },
    {
      name: "gateway_get_service",
      description: "Inspects a service's connection status, server metadata, and last error.",
      inputSchema: objectSchema(["serviceId"], {
        serviceId: stringSchema("Exact, case-sensitive service ID from gateway_list_services.")
      }),
      outputSchema: outputSchemas.getService
    },
    {
      name: "gateway_list_tools",
      description: "Finds tools within one service. Text filters use case-insensitive substrings joined by OR.",
      inputSchema: objectSchema(["serviceId"], {
        serviceId: stringSchema("Exact, case-sensitive service ID from gateway_list_services."),
        toolNameFilter: stringOrArraySchema("Tool name keywords."),
        descFilter: stringOrArraySchema("Description keywords. Matches may include negative guidance."),
        includeSchema: {
          type: "boolean",
          description: "Include inputSchema and outputSchema. Omitted or null: false."
        }
      }),
      outputSchema: outputSchemas.listTools
    },
    {
      name: "gateway_get_tool_schema",
      description: "Returns schemas keyed by tool name. Unknown names appear in errors; valid schemas are retained.",
      inputSchema: objectSchema(["serviceId", "toolName"], {
        serviceId: stringSchema("Exact, case-sensitive service ID from gateway_list_services."),
        toolName: stringOrArraySchema("Exact, case-sensitive tool names from gateway_list_tools.")
      }),
      outputSchema: outputSchemas.getToolSchema
    },
    {
      name: "gateway_manage_service",
      description: "Reconnects, enables, or disables a configured service.",
      inputSchema: objectSchema(["serviceId", "action"], {
        serviceId: stringSchema("Exact, case-sensitive service ID from configuration. Disabled services are absent from gateway_list_services."),
        action: {
          type: "string",
          description: "reconnect refreshes the connection; enable and disable persist to config.",
          enum: ["reconnect", "enable", "disable"]
        }
      }),
      outputSchema: outputSchemas.manageService
    },
    {
      name: "gateway_call_tool",
      description: "Calls one downstream tool and forwards its result. Side effects and confirmation requirements depend on that tool.",
      inputSchema: objectSchema(["serviceId", "toolName", "arguments"], {
        serviceId: stringSchema("Exact, case-sensitive service ID from gateway_list_services."),
        toolName: stringSchema("Exact, case-sensitive tool name from gateway_list_tools."),
        arguments: {
          type: "object",
          description: "Downstream tool arguments matching its inputSchema. Use {} for no arguments."
        }
      })
    }
  ];
  // 可选参数允许显式传 null，运行时统一按未传处理。
  for (const tool of tools) {
    const required = tool.inputSchema.required as string[];
    const properties = tool.inputSchema.properties as Record<string, JsonObject>;
    for (const [name, schema] of Object.entries(properties)) {
      if (!required.includes(name)) {
        const { description, ...shape } = schema;
        properties[name] = {
          ...(description ? { description } : {}),
          ...nullableSchema(shape)
        };
      }
    }
  }
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
 * 返回单份结构化结果，避免在文本内容中重复同一份 JSON。
 */
function successContent(data: JsonObject): DownstreamToolResult {
  return {
    content: [],
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
        additionalProperties: objectSchema(["inputSchema", "outputSchema"], {
          inputSchema: nullableToolSchema,
          outputSchema: nullableToolSchema
        })
      },
      errors: {
        type: "object",
        additionalProperties: { type: "string" }
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
 * 接受单个非空字符串或非空且不重复的字符串数组。
 */
function stringOrArraySchema(description: string): JsonObject {
  const { description: _stringDescription, ...string } = stringSchema(description);
  const { description: _arrayDescription, ...array } = uniqueNonEmptyStringArraySchema(description);
  return { description, anyOf: [string, array] };
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
 * 将字符串或字符串数组统一为非空且不重复的字符串数组。
 */
function optionalStringOrArray(input: unknown, message: string): string[] | undefined {
  if (input === undefined || input === null) {
    return undefined;
  }

  if (typeof input === "string") {
    input = [input];
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
 * 校验必填字符串或字符串数组并统一返回数组。
 */
function requireStringOrArray(input: unknown, message: string): string[] {
  const values = optionalStringOrArray(input, message);
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
 * Normalizes optional substring filters for case-insensitive matching.
 */
function normalizeKeywords(input: string[] | undefined): string[] {
  return (input ?? []).map((value) => value.trim().toLowerCase());
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
