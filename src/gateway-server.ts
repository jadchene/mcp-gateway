import { serveStdio, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import { McpGatewayEngine } from "./gateway-engine.ts";
import { Logger } from "./logger.ts";
import { createGatewayMcpServer } from "./mcp/server.ts";
import { ServiceRegistry } from "./service-registry.ts";

/**
 * Exposes the MCP gateway over stdio through the official SDK v2.
 */
export class GatewayServer {
  private readonly engine: McpGatewayEngine;
  private readonly logger: Logger;
  private handle: StdioServerHandle | null = null;

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
   * Starts the dual-era SDK server on the current process streams.
   */
  public start(): void {
    if (this.handle) {
      return;
    }
    this.handle = serveStdio(
      () => createGatewayMcpServer(this.engine),
      {
        legacy: "serve",
        onerror: (error) => {
          this.logger.error("gateway.protocol_error", { message: error.message });
        }
      }
    );
  }

  /**
   * Stops the stdio serving entry.
   */
  public async stop(): Promise<void> {
    const handle = this.handle;
    this.handle = null;
    await handle?.close();
  }
}
