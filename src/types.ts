/**
 * Describes a JSON-like object used by schemas and structured content.
 */
export type JsonObject = Record<string, unknown>;

/**
 * Declares the supported downstream transport types.
 */
export type TransportConfig = StdioTransportConfig;

/**
 * Declares the supported stdio framing styles.
 */
export type StdioFraming = "line" | "content-length";

/**
 * Declares a downstream MCP service pool config file.
 */
export interface GatewayConfig {
  /**
   * Declares the file logging behavior for the gateway process.
   */
  logging: LoggingConfig;
  /**
   * Lists all logical MCP services managed by the gateway.
   */
  services: ServiceConfig[];
}

/**
 * Declares the file logging behavior for the gateway process.
 */
export interface LoggingConfig {
  /**
   * Indicates whether structured file logging is enabled.
   */
  enable: boolean;
  /**
   * Provides the absolute file path used for log appends when logging is enabled.
   */
  path: string | null;
}

/**
 * Declares one logical MCP service managed by the gateway.
 */
export interface ServiceConfig {
  /**
   * Provides the unique logical identifier used by the gateway API.
   */
  serviceId: string;
  /**
   * Indicates whether the service should be loaded by the gateway.
   */
  enable: boolean;
  /**
   * Provides a display name for operators and clients.
   */
  name: string;
  /**
   * Provides an optional service description.
   */
  description?: string;
  /**
   * Describes how the gateway connects to the downstream process.
   */
  transport: TransportConfig;
}

/**
 * Declares a stdio-backed downstream transport.
 */
export interface StdioTransportConfig {
  /**
   * Marks the transport implementation kind.
   */
  type: "stdio";
  /**
   * Provides the command used to launch the downstream process.
   */
  command: string;
  /**
   * Provides command line arguments for the downstream process.
   */
  args?: string[];
  /**
   * Provides the working directory for the downstream process.
   */
  cwd?: string;
  /**
   * Provides environment variables merged into the current process environment.
   */
  env?: Record<string, string>;
  /**
   * Selects the stdio message framing style used by the downstream process.
   */
  framing?: StdioFraming;
}

/**
 * Describes one tool exposed by a downstream service.
 */
export interface ToolDefinition {
  /**
   * Provides the stable tool name.
   */
  name: string;
  /**
   * Provides the human-readable tool description.
   */
  description?: string;
  /**
   * Provides the tool input schema.
   */
  inputSchema?: JsonObject;
  /**
   * Provides the optional tool output schema when exposed by the downstream service.
   */
  outputSchema?: JsonObject | null;
}

/**
 * Describes cached metadata for a logical service.
 */
export interface ServiceMetadata {
  /**
   * Indicates the downstream protocol version reported during initialization.
   */
  protocolVersion: string | null;
  /**
   * Provides the downstream server identity when available.
   */
  serverInfo: JsonObject | null;
  /**
   * Lists the tools discovered from the downstream service.
   */
  tools: ToolDefinition[];
  /**
   * Stores the last successful refresh timestamp in ISO-8601 form.
   */
  refreshedAt: string | null;
}

/**
 * Describes the runtime status of one managed service process.
 */
export interface ServiceRuntimeStatus {
  /**
   * Indicates whether the gateway currently considers the service available.
   */
  available: boolean;
  /**
   * Stores the last error message observed for the service.
   */
  lastError: string | null;
  /**
   * Stores the last successful connection timestamp in ISO-8601 form.
   */
  lastConnectedAt: string | null;
  /**
   * Stores the restart attempts consumed by the current lifecycle.
   */
  restartAttempts: number;
}

/**
 * Describes a logical service snapshot used for request routing.
 */
export interface ServiceRuntimeSnapshot {
  /**
   * Provides the immutable service config currently in effect.
   */
  config: ServiceConfig;
  /**
   * Stores the latest metadata visible to callers.
   */
  metadata: ServiceMetadata;
  /**
   * Stores the runtime status of the managed process.
   */
  runtime: ServiceRuntimeStatus;
}
