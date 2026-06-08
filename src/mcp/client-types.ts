import type { ServiceConfig, ServiceMetadata, ToolDefinition } from "../types.ts";

/**
 * Describes the transport-independent downstream MCP client contract.
 */
export interface McpClient {
  /**
   * Returns a stable key for logs.
   */
  readonly key: string;
  /**
   * Indicates whether the service has become unavailable after recovery exhaustion.
   */
  readonly isUnavailable: boolean;
  /**
   * Returns the terminal unavailability reason when one exists.
   */
  readonly unavailableMessage: string | null;
  /**
   * Returns the restart attempts consumed by the current lifecycle.
   */
  readonly restartCount: number;
  /**
   * Checks whether the current client still matches a desired service config.
   */
  matchesConfig(service: ServiceConfig): boolean;
  /**
   * Ensures that the downstream transport is connected and initialized.
   */
  ensureConnected(): Promise<void>;
  /**
   * Stops the downstream transport and clears runtime error state.
   */
  dispose(): Promise<void>;
  /**
   * Refreshes downstream metadata.
   */
  getMetadata(): Promise<ServiceMetadata>;
  /**
   * Lists tools exposed by the downstream service.
   */
  listTools(): Promise<ToolDefinition[]>;
  /**
   * Calls one downstream tool with the provided arguments.
   */
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}
