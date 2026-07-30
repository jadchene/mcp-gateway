import type { CallToolResult, InputRequiredResult } from "@modelcontextprotocol/client";
import type { ServiceConfig, ServiceMetadata, ToolDefinition } from "../types.ts";

/**
 * Carries request-scoped modern MCP context through the gateway proxy.
 */
export interface DownstreamCallContext {
  /**
   * Cancels only the active downstream call.
   */
  signal?: AbortSignal;
  /**
   * Declares the upstream client's capabilities for this request.
   */
  clientCapabilities?: Record<string, unknown>;
  /**
   * Carries MRTR input responses from the upstream retry.
   */
  inputResponses?: Record<string, unknown>;
  /**
   * Carries opaque MRTR state from the preceding downstream result.
   */
  requestState?: string;
}

/**
 * Represents a complete downstream tool result or a modern MRTR continuation.
 */
export type DownstreamToolResult = CallToolResult | InputRequiredResult;

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
  callTool(name: string, args: Record<string, unknown>, context?: DownstreamCallContext): Promise<DownstreamToolResult>;
}
