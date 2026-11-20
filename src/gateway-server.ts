import { isJSONRPCRequest, type JSONRPCRequest } from "@modelcontextprotocol/server";
import { serveStdio, StdioServerTransport, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
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
  public start(configuredServiceIds?: string[]): void {
    if (this.handle) {
      return;
    }
    const transport = new StdioServerTransport();
    const handle = serveStdio(
      () => createGatewayMcpServer(this.engine, { configuredServiceIds }),
      {
        legacy: "serve",
        transport,
        onerror: (error) => {
          this.logger.error("gateway.protocol_error", { message: error.message });
        }
      }
    );
    this.handle = handle;
    if (this.engine.registry.toolCatalog) {
      // SDK 继续处理握手和订阅。目录就绪之前只暂存工具请求，包括已缓存工具名的直接调用。
      const receive = transport.onmessage!;
      const waiting = new Map<JSONRPCRequest["id"], JSONRPCRequest>();
      transport.onmessage = message => {
        if (isJSONRPCRequest(message) && (message.method === "tools/list" || message.method === "tools/call")) {
          waiting.set(message.id, message);
          return;
        }
        if ("method" in message && message.method === "notifications/cancelled") {
          const id = message.params?.requestId;
          if ((typeof id === "string" || typeof id === "number") && waiting.delete(id)) return;
        }
        receive(message);
      };
      void this.engine.waitForToolCatalog().then(() => {
        transport.onmessage = receive;
        if (this.handle === handle) {
          for (const request of waiting.values()) receive(request);
        }
        waiting.clear();
      }, () => waiting.clear());
    }
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
