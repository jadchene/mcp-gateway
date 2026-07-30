import http from "node:http";
import { createMcpHandler, type McpHttpHandler } from "@modelcontextprotocol/server";
import { hostHeaderValidation, originValidation, toNodeHandler } from "@modelcontextprotocol/node";
import { McpGatewayEngine } from "./gateway-engine.ts";
import { Logger } from "./logger.ts";
import { createGatewayMcpServer } from "./mcp/server.ts";
import type { GatewayServerConfig } from "./types.ts";

/**
 * Exposes the gateway through SDK v2 Streamable HTTP.
 */
export class StreamableHttpGatewayServer {
  private readonly config: GatewayServerConfig;
  private readonly logger: Logger;
  private readonly handler: McpHttpHandler;
  private server: http.Server | null = null;

  /**
   * Returns the current endpoint URL after the server starts.
   */
  public get url(): string {
    const address = this.server?.address();
    const port = typeof address === "object" && address ? address.port : this.config.port;
    return `http://${this.config.host}:${port}${this.config.path}`;
  }

  /**
   * Creates an SDK HTTP handler that automatically serves both standard protocol revisions.
   */
  public constructor(
    config: GatewayServerConfig,
    engine: McpGatewayEngine,
    logger: Logger
  ) {
    this.config = config;
    this.logger = logger;
    this.handler = createMcpHandler(
      () => createGatewayMcpServer(engine),
      {
        legacy: "stateless",
        onerror: (error) => {
          this.logger.error("gateway.http_protocol_error", { message: error.message });
        }
      }
    );
  }

  /**
   * Starts the guarded single-endpoint HTTP server.
   */
  public async start(): Promise<void> {
    if (this.server) {
      return;
    }

    const allowedHosts = allowedHostnames(this.config.host);
    const validateHost = hostHeaderValidation(allowedHosts);
    const validateOrigin = originValidation(allowedHosts);
    const handleMcp = toNodeHandler(this.handler, {
      onerror: (error) => this.logger.error("gateway.http_adapter_error", { message: error.message })
    });

    this.server = http.createServer((request, response) => {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      if (pathname !== this.config.path) {
        response.writeHead(404).end();
        return;
      }
      if (!validateHost(request, response) || !validateOrigin(request, response)) {
        return;
      }
      void handleMcp(request, response);
    });

    await new Promise<void>((resolveListen, rejectListen) => {
      this.server?.once("error", rejectListen);
      this.server?.listen(this.config.port, this.config.host, () => {
        this.server?.off("error", rejectListen);
        resolveListen();
      });
    });

    this.logger.info("gateway.http_started", {
      host: this.config.host,
      port: this.config.port,
      path: this.config.path
    });
  }

  /**
   * Stops accepting requests and closes all in-flight SDK exchanges.
   */
  public async stop(): Promise<void> {
    await this.handler.close();
    const server = this.server;
    this.server = null;
    if (!server) {
      return;
    }
    await new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose());
      server.closeAllConnections();
    });
  }
}

/**
 * Builds the Host and Origin allow-list for the configured bind address.
 */
function allowedHostnames(host: string): string[] {
  return [...new Set([host, "localhost", "127.0.0.1", "[::1]"])];
}
