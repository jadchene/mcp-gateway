/**
 * Describes a JSON-like object used by schemas and structured content.
 */
export type JsonObject = Record<string, unknown>;

/**
 * Declares the supported downstream transport types.
 */
export type TransportConfig = StdioTransportConfig | HttpTransportConfig;

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
 * Declares inbound Streamable HTTP gateway settings.
 */
export interface GatewayServerConfig {
  /**
   * Enables the Streamable HTTP server when true.
   */
  enable: boolean;
  /**
   * Provides the host address to bind.
   */
  host: string;
  /**
   * Provides the TCP port to listen on.
   */
  port: number;
  /**
   * Provides the single MCP endpoint path.
   */
  path: string;
  /**
   * Provides an optional bearer token required by every HTTP request.
   */
  authToken?: string;
  /**
   * Exposes persistent service-management tools over HTTP when explicitly enabled.
   */
  enableAdminTools?: boolean;
  /**
   * Limits concurrently processed HTTP requests.
   */
  maxConcurrentRequests?: number;
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
  /**
   * Rotates the active log after it reaches this many bytes.
   */
  maxBytes?: number;
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
  /**
   * Limits one downstream tool invocation independently of connection setup.
   */
  callTimeoutMs?: number;
  /**
   * Lists exact downstream tool names that require upstream form elicitation
   * confirmation before the gateway invokes them.
   */
  confirmationRequiredTools?: string[];
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
   * Inherits the complete gateway process environment only when explicitly enabled.
   */
  inheritEnv?: boolean;
  /**
   * Adds selected process environment variables to the safe platform defaults.
   */
  envAllowlist?: string[];
}

/**
 * Declares a Streamable HTTP-backed downstream transport.
 */
export interface HttpTransportConfig {
  /**
   * Marks the transport implementation kind.
   */
  type: "http";
  /**
   * Provides the downstream Streamable HTTP MCP endpoint URL.
   */
  url: string;
  /**
   * Provides optional static HTTP headers sent to the downstream service.
   */
  headers?: Record<string, string>;
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
   * Provides the optional human-readable title.
   */
  title?: string;
  /**
   * Provides the tool input schema.
   */
  inputSchema?: JsonObject | null;
  /**
   * Provides the optional tool output schema when exposed by the downstream service.
   */
  outputSchema?: JsonObject | null;
  /**
   * Preserves optional MCP tool annotations.
   */
  annotations?: JsonObject;
  /**
   * Preserves optional MCP tool icons.
   */
  icons?: Array<Record<string, unknown>>;
  /**
   * Preserves optional MCP tool execution metadata.
   */
  execution?: JsonObject;
  /**
   * Preserves extension metadata without interpreting it.
   */
  _meta?: JsonObject;
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
   * Indicates whether the downstream connection negotiated the 2026 or 2025 wire era.
   */
  protocolEra: "modern" | "legacy" | null;
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
