import http from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  createMcpHandler,
  isLegacyRequest,
  WebStandardStreamableHTTPServerTransport,
  type McpHttpHandler
} from "@modelcontextprotocol/server";
import { hostHeaderValidation, originValidation, toNodeHandler } from "@modelcontextprotocol/node";
import { McpGatewayEngine } from "./gateway-engine.ts";
import { Logger } from "./logger.ts";
import { createGatewayMcpServer } from "./mcp/server.ts";
import type { GatewayServerConfig } from "./types.ts";

const LEGACY_SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1_000;
const LEGACY_SESSION_SWEEP_INTERVAL_MS = 60 * 1_000;

/**
 * Exposes the gateway through SDK v2 Streamable HTTP.
 */
export class StreamableHttpGatewayServer {
  private readonly config: GatewayServerConfig;
  private readonly engine: McpGatewayEngine;
  private readonly logger: Logger;
  private readonly handler: McpHttpHandler;
  private readonly legacySessions = new Map<string, LegacyHttpSession>();
  private legacySessionSweepTimer: NodeJS.Timeout | null = null;
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
    this.engine = engine;
    this.logger = logger;
    this.handler = createMcpHandler(
      () => createGatewayMcpServer(engine, {
        includeAdminTools: config.enableAdminTools ?? false
      }),
      {
        legacy: "reject",
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

    if (!isLoopbackHost(this.config.host) && !this.config.authToken) {
      throw new Error("HTTP bearer authentication is required when binding to a non-loopback host.");
    }
    if (this.config.enableAdminTools && !this.config.authToken) {
      throw new Error("HTTP admin tools require bearer authentication.");
    }

    const allowedHosts = allowedHostnames(this.config.host);
    const validateHost = hostHeaderValidation(allowedHosts);
    const validateOrigin = originValidation(allowedHosts);
    const handleMcp = toNodeHandler({
      fetch: (request) => this.handleMcpRequest(request)
    }, {
      onerror: (error) => this.logger.error("gateway.http_adapter_error", { message: error.message })
    });

    const maxConcurrentRequests = this.config.maxConcurrentRequests ?? 64;
    let activeRequests = 0;
    this.server = http.createServer((request, response) => {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      if (pathname !== this.config.path) {
        response.writeHead(404).end();
        return;
      }
      if (!validateHost(request, response) || !validateOrigin(request, response)) {
        return;
      }
      if (!hasValidBearerToken(request, this.config.authToken)) {
        response.writeHead(401, { "WWW-Authenticate": "Bearer" }).end();
        return;
      }
      if (activeRequests >= maxConcurrentRequests) {
        response.writeHead(503, { "Retry-After": "1" }).end();
        return;
      }
      activeRequests += 1;
      let released = false;
      const release = (): void => {
        if (!released) {
          released = true;
          activeRequests -= 1;
        }
      };
      response.once("finish", release);
      response.once("close", release);
      void handleMcp(request, response);
    });

    await new Promise<void>((resolveListen, rejectListen) => {
      this.server?.once("error", rejectListen);
      this.server?.listen(this.config.port, this.config.host, () => {
        this.server?.off("error", rejectListen);
        resolveListen();
      });
    });
    this.legacySessionSweepTimer = setInterval(
      () => void this.closeExpiredLegacySessions(),
      LEGACY_SESSION_SWEEP_INTERVAL_MS
    );
    this.legacySessionSweepTimer.unref();

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
    if (this.legacySessionSweepTimer) {
      clearInterval(this.legacySessionSweepTimer);
      this.legacySessionSweepTimer = null;
    }
    await Promise.all(
      [...this.legacySessions.values()].map((session) => session.server.close().catch(() => undefined))
    );
    this.legacySessions.clear();
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

  /**
   * Routes modern requests to the per-request handler and preserves 2025 sessions.
   */
  private async handleMcpRequest(request: Request): Promise<Response> {
    if (!(await isLegacyRequest(request))) {
      return this.handler.fetch(request);
    }

    const sessionId = request.headers.get("mcp-session-id");
    if (sessionId) {
      const session = this.legacySessions.get(sessionId);
      if (!session) {
        return sessionNotFoundResponse();
      }
      session.lastAccessedAt = Date.now();
      return session.transport.handleRequest(request);
    }

    return this.handleLegacyInitialization(request);
  }

  /**
   * Creates a stateful 2025 transport for an initialize request.
   */
  private async handleLegacyInitialization(request: Request): Promise<Response> {
    let session: LegacyHttpSession;
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      onsessioninitialized: (sessionId) => {
        this.legacySessions.set(sessionId, session);
      },
      onsessionclosed: (sessionId) => {
        this.legacySessions.delete(sessionId);
      }
    });
    const server = createGatewayMcpServer(this.engine, {
      includeAdminTools: this.config.enableAdminTools ?? false
    });
    session = { server, transport, lastAccessedAt: Date.now() };
    await server.connect(transport);

    try {
      const response = await transport.handleRequest(request);
      if (!transport.sessionId) {
        await server.close().catch(() => undefined);
      }
      return response;
    } catch (error) {
      if (transport.sessionId) {
        this.legacySessions.delete(transport.sessionId);
      }
      await server.close().catch(() => undefined);
      throw error;
    }
  }

  /**
   * Releases abandoned legacy sessions without touching active modern requests.
   */
  private async closeExpiredLegacySessions(): Promise<void> {
    const expiresBefore = Date.now() - LEGACY_SESSION_IDLE_TIMEOUT_MS;
    const expired = [...this.legacySessions.entries()]
      .filter(([, session]) => session.lastAccessedAt < expiresBefore);
    for (const [sessionId, session] of expired) {
      this.legacySessions.delete(sessionId);
      await session.server.close().catch(() => undefined);
    }
  }
}

interface LegacyHttpSession {
  server: ReturnType<typeof createGatewayMcpServer>;
  transport: WebStandardStreamableHTTPServerTransport;
  lastAccessedAt: number;
}

/**
 * Returns the standard status for a missing or expired MCP session.
 */
function sessionNotFoundResponse(): Response {
  return Response.json({
    jsonrpc: "2.0",
    error: {
      code: -32001,
      message: "Session not found"
    },
    id: null
  }, { status: 404 });
}

/**
 * Compares a supplied bearer credential without leaking a useful timing signal.
 */
function hasValidBearerToken(request: http.IncomingMessage, expectedToken: string | undefined): boolean {
  if (!expectedToken) {
    return true;
  }
  const supplied = request.headers.authorization;
  const expected = `Bearer ${expectedToken}`;
  if (!supplied) {
    return false;
  }
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  return suppliedBytes.length === expectedBytes.length
    && timingSafeEqual(suppliedBytes, expectedBytes);
}

/**
 * Identifies bind addresses that do not expose the gateway off-machine.
 */
function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return normalized === "localhost"
    || normalized === "::1"
    || normalized === "[::1]"
    || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

/**
 * Builds the Host and Origin allow-list for the configured bind address.
 */
function allowedHostnames(host: string): string[] {
  return [...new Set([host, "localhost", "127.0.0.1", "[::1]"])];
}
