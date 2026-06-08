import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { McpGatewayEngine } from "./gateway-engine.ts";
import { Logger } from "./logger.ts";
import { jsonRpcError, type JsonRpcMessage } from "./mcp/protocol.ts";
import type { GatewayServerConfig } from "./types.ts";

const MAX_POST_BODY_BYTES = 4 * 1024 * 1024;

/**
 * Exposes the MCP gateway over the Streamable HTTP single-endpoint transport.
 */
export class StreamableHttpGatewayServer {
  /**
   * Stores inbound HTTP behavior.
   */
  private readonly config: GatewayServerConfig;

  /**
   * Stores the transport-neutral gateway engine.
   */
  private readonly engine: McpGatewayEngine;

  /**
   * Stores the shared logger instance.
   */
  private readonly logger: Logger;

  /**
   * Stores active SSE sessions keyed by MCP session id.
   */
  private readonly sessions = new Map<string, ServerResponse>();

  /**
   * Stores the underlying HTTP server instance.
   */
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
   * Creates a Streamable HTTP gateway server.
   */
  public constructor(
    config: GatewayServerConfig,
    engine: McpGatewayEngine,
    logger: Logger
  ) {
    this.config = config;
    this.engine = engine;
    this.logger = logger;
  }

  /**
   * Starts listening for inbound HTTP requests.
   */
  public async start(): Promise<void> {
    if (this.server) {
      return;
    }

    this.server = http.createServer((request, response) => {
      void this.handleRequest(request, response).catch((error) => {
        this.logger.error("gateway.http_request_failed", {
          message: error instanceof Error ? error.message : String(error)
        });
        writeJson(response, 500, jsonRpcError(null, -32000, error instanceof Error ? error.message : String(error)));
      });
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
      path: this.config.path,
      enableJsonResponse: this.config.enableJsonResponse
    });
  }

  /**
   * Stops listening and closes all active SSE sessions.
   */
  public async stop(): Promise<void> {
    for (const response of this.sessions.values()) {
      response.end();
    }
    this.sessions.clear();

    const server = this.server;
    this.server = null;
    if (!server) {
      return;
    }

    await new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => {
        if (error) {
          rejectClose(error);
          return;
        }
        resolveClose();
      });
    });
  }

  /**
   * Dispatches one HTTP request by method on the configured single endpoint.
   */
  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (requestUrl.pathname !== this.config.path) {
      response.writeHead(404).end();
      return;
    }

    if (request.method === "GET") {
      this.handleGet(request, response, requestUrl);
      return;
    }

    if (request.method === "POST") {
      await this.handlePost(request, response, requestUrl);
      return;
    }

    response.writeHead(405, {
      "Allow": "GET, POST"
    }).end();
  }

  /**
   * Opens one SSE session for downstream messages.
   */
  private handleGet(request: IncomingMessage, response: ServerResponse, requestUrl: URL): void {
    const sessionId = getSessionId(request, requestUrl) ?? randomUUID();
    this.sessions.set(sessionId, response);

    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Mcp-Session-Id": sessionId
    });
    response.write(":\n\n");

    writeSseEvent(response, "endpoint", this.config.path);

    request.on("close", () => {
      if (this.sessions.get(sessionId) === response) {
        this.sessions.delete(sessionId);
      }
    });
  }

  /**
   * Handles one JSON-RPC POST request.
   */
  private async handlePost(request: IncomingMessage, response: ServerResponse, requestUrl: URL): Promise<void> {
    const message = await readJsonRpcMessage(request);
    const result = await this.engine.handleMessage(message);
    if (!result) {
      response.writeHead(202).end();
      return;
    }

    const sessionId = getSessionId(request, requestUrl);
    const session = sessionId ? this.sessions.get(sessionId) : null;
    if (!this.config.enableJsonResponse && session) {
      writeSseEvent(session, "message", JSON.stringify(result));
      response.writeHead(202, {
        "Content-Type": "application/json"
      }).end(JSON.stringify({ accepted: true }));
      return;
    }

    writeJson(response, 200, result);
  }
}

/**
 * Reads one JSON-RPC message from a bounded HTTP request body.
 */
async function readJsonRpcMessage(request: IncomingMessage): Promise<JsonRpcMessage> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    totalBytes += buffer.byteLength;
    if (totalBytes > MAX_POST_BODY_BYTES) {
      throw new Error(`HTTP request body exceeded ${MAX_POST_BODY_BYTES} bytes.`);
    }
    chunks.push(buffer);
  }

  const text = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(text) as JsonRpcMessage;
}

/**
 * Extracts the MCP session id from header or query string.
 */
function getSessionId(request: IncomingMessage, requestUrl: URL): string | null {
  const header = request.headers["mcp-session-id"];
  if (typeof header === "string" && header.trim() !== "") {
    return header;
  }
  const query = requestUrl.searchParams.get("sessionId");
  return query && query.trim() !== "" ? query : null;
}

/**
 * Writes one JSON response.
 */
function writeJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(payload));
}

/**
 * Writes one Server-Sent Event.
 */
function writeSseEvent(response: ServerResponse, eventName: string, data: string): void {
  response.write(`event: ${eventName}\n`);
  for (const line of data.split(/\r?\n/)) {
    response.write(`data: ${line}\n`);
  }
  response.write("\n");
}
