import { McpGatewayEngine } from "./gateway-engine.ts";
import { Logger } from "./logger.ts";
import { createMessageReader, createMessageWriter, type JsonRpcMessage } from "./mcp/protocol.ts";
import { ServiceRegistry } from "./service-registry.ts";

/**
 * Exposes the MCP gateway tools over stdio.
 */
export class GatewayServer {
  /**
   * Stores the transport-neutral gateway engine.
   */
  private readonly engine: McpGatewayEngine;

  /**
   * Stores the shared logger instance.
   */
  private readonly logger: Logger;

  /**
   * Stores the stdio message reader bound to the current process.
   */
  private readonly reader = createMessageReader(process.stdin);

  /**
   * Stores the stdio message writer bound to the current process.
   */
  private readonly writer = createMessageWriter(process.stdout);

  /**
   * Creates the stdio gateway server.
   */
  public constructor(
    registry: ServiceRegistry,
    logger: Logger,
    engine = new McpGatewayEngine(registry, logger)
  ) {
    this.engine = engine;
    this.logger = logger;
  }

  /**
   * Sets the startup barrier used to delay tool handling until the registry is ready.
   */
  public setStartupBarrier(barrier: Promise<void>): void {
    this.engine.setStartupBarrier(barrier);
  }

  /**
   * Starts consuming inbound MCP messages from stdin.
   */
  public start(): void {
    this.reader.on("message", (message: JsonRpcMessage) => {
      const framingMode = this.reader.framingMode;
      if (framingMode) {
        this.writer.setFramingMode(framingMode);
      }
      void this.handleMessage(message);
    });
    this.reader.on("error", (error) => {
      this.logger.error("gateway.protocol_error", {
        message: error instanceof Error ? error.message : String(error)
      });
    });
  }

  /**
   * Handles one inbound MCP message.
   */
  private async handleMessage(message: JsonRpcMessage): Promise<void> {
    const response = await this.engine.handleMessage(message);
    if (response) {
      this.writer.write(response);
    }
  }
}
