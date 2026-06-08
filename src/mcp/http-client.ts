import { Logger } from "../logger.ts";
import type { HttpTransportConfig, ServiceConfig, ServiceMetadata, ToolDefinition } from "../types.ts";
import { VERSION } from "../version.ts";
import type { McpClient } from "./client-types.ts";
import type { JsonRpcFailure, JsonRpcId, JsonRpcMessage, JsonRpcRequest, JsonRpcSuccess } from "./protocol.ts";

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Provides one reusable Streamable HTTP-backed MCP client for a downstream service.
 */
export class StreamableHttpClient implements McpClient {
  /**
   * Stores the bound service config.
   */
  private readonly service: ServiceConfig;

  /**
   * Stores the shared logger instance.
   */
  private readonly logger: Logger;

  /**
   * Stores pending request resolvers keyed by request id.
   */
  private readonly pending = new Map<JsonRpcId, PendingRequest>();

  /**
   * Stores the active stream abort controller.
   */
  private streamAbort: AbortController | null = null;

  /**
   * Stores a promise for the current connection attempt.
   */
  private connectPromise: Promise<void> | null = null;

  /**
   * Tracks whether downstream initialization succeeded.
   */
  private initialized = false;

  /**
   * Stores the endpoint used for POST messages after the SSE handshake.
   */
  private messageEndpoint: string | null = null;

  /**
   * Stores the session id returned by the downstream stream endpoint.
   */
  private sessionId: string | null = null;

  /**
   * Stores the next request id used for downstream calls.
   */
  private nextId = 1;

  /**
   * Stores the downstream server info captured during initialization.
   */
  private serverInfo: Record<string, unknown> | null = null;

  /**
   * Stores the downstream protocol version captured during initialization.
   */
  private protocolVersion: string | null = null;

  /**
   * Counts reconnect attempts after transport-level failures.
   */
  private restartAttempts = 0;

  /**
   * Stores the terminal unavailability reason.
   */
  private unavailableReason: string | null = null;

  /**
   * Creates a client for one Streamable HTTP downstream service.
   */
  public constructor(
    service: ServiceConfig,
    logger: Logger
  ) {
    this.service = service;
    this.logger = logger;
  }

  /**
   * Returns a stable key for logs.
   */
  public get key(): string {
    return this.service.serviceId;
  }

  /**
   * Indicates whether the service has become unavailable after recovery exhaustion.
   */
  public get isUnavailable(): boolean {
    return this.unavailableReason !== null;
  }

  /**
   * Returns the terminal unavailability reason when one exists.
   */
  public get unavailableMessage(): string | null {
    return this.unavailableReason;
  }

  /**
   * Returns the restart attempts consumed by the current lifecycle.
   */
  public get restartCount(): number {
    return this.restartAttempts;
  }

  /**
   * Checks whether the current client still matches a desired service config.
   */
  public matchesConfig(service: ServiceConfig): boolean {
    return JSON.stringify(this.service) === JSON.stringify(service);
  }

  /**
   * Ensures that the downstream HTTP stream is connected and initialized.
   */
  public async ensureConnected(): Promise<void> {
    if (this.unavailableReason) {
      throw new Error(this.unavailableReason);
    }
    if (this.initialized) {
      return;
    }
    const transport = requireHttpTransport(this.service);
    if (transport.enableJsonResponse) {
      this.messageEndpoint = transport.url;
      await this.initialize();
      return;
    }

    if (!this.connectPromise) {
      this.connectPromise = this.connectStream().finally(() => {
        this.connectPromise = null;
      });
    }

    await this.connectPromise;
    await this.initialize();
  }

  /**
   * Stops the downstream HTTP stream and clears runtime error state.
   */
  public async dispose(): Promise<void> {
    this.restartAttempts = 0;
    this.unavailableReason = null;
    this.initialized = false;
    this.messageEndpoint = null;
    this.sessionId = null;
    this.streamAbort?.abort();
    this.streamAbort = null;
    this.failAllPending(new Error("The downstream HTTP client was disposed."));
  }

  /**
   * Refreshes downstream metadata.
   */
  public async getMetadata(): Promise<ServiceMetadata> {
    return this.executeWithRecovery(async () => {
      await this.ensureConnected();
      const tools = await this.requestToolsList();

      return {
        protocolVersion: this.protocolVersion,
        serverInfo: this.serverInfo,
        tools,
        refreshedAt: new Date().toISOString()
      };
    });
  }

  /**
   * Lists tools exposed by the downstream service.
   */
  public async listTools(): Promise<ToolDefinition[]> {
    return this.executeWithRecovery(async () => {
      await this.ensureConnected();
      return this.requestToolsList();
    });
  }

  /**
   * Calls one downstream tool with the provided arguments.
   */
  public async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    return this.executeWithRecovery(async () => {
      await this.ensureConnected();
      return this.request("tools/call", {
        name,
        arguments: args
      });
    });
  }

  /**
   * Opens the SSE read channel and waits for the endpoint event.
   */
  private async connectStream(): Promise<void> {
    const transport = requireHttpTransport(this.service);
    this.streamAbort?.abort();
    this.streamAbort = new AbortController();
    this.messageEndpoint = null;
    this.sessionId = null;

    const response = await fetch(transport.url, {
      method: "GET",
      headers: {
        Accept: "text/event-stream",
        ...transport.headers
      },
      signal: this.streamAbort.signal
    });

    if (!response.ok || !response.body) {
      throw new Error(`Streamable HTTP GET failed for '${this.key}' with status ${response.status}.`);
    }

    this.sessionId = response.headers.get("mcp-session-id") ?? response.headers.get("Mcp-Session-Id");

    void this.readEventStream(response.body).catch((error) => {
      if (this.streamAbort?.signal.aborted) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn("downstream.http_stream_failed", {
        serviceId: this.key,
        message
      });
      this.initialized = false;
      this.messageEndpoint = null;
      this.failAllPending(new Error(message));
    });

    await waitUntil(() => this.messageEndpoint !== null, DEFAULT_REQUEST_TIMEOUT_MS, `Timed out waiting for Streamable HTTP endpoint event from '${this.key}'.`);
  }

  /**
   * Performs the MCP initialization handshake once per stream lifecycle.
   */
  private async initialize(): Promise<void> {
    const result = await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {
        tools: {}
      },
      clientInfo: {
        name: "mcp-gateway",
        version: VERSION
      }
    });

    if (isRecord(result)) {
      this.protocolVersion = typeof result.protocolVersion === "string" ? result.protocolVersion : null;
      this.serverInfo = isRecord(result.serverInfo) ? result.serverInfo : null;
    } else {
      this.protocolVersion = null;
      this.serverInfo = null;
    }

    this.initialized = true;
    void this.postMessage({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {}
    });
  }

  /**
   * Lists tools without applying an extra recovery loop.
   */
  private async requestToolsList(): Promise<ToolDefinition[]> {
    const result = await this.request("tools/list", {});
    if (!isRecord(result) || !Array.isArray(result.tools)) {
      throw new Error(`Downstream service '${this.key}' returned an invalid tools/list payload.`);
    }

    return result.tools.map((tool) => normalizeToolDefinition(this.key, tool));
  }

  /**
   * Runs one downstream operation with one reconnect attempt for transport failures.
   */
  private async executeWithRecovery<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      const normalizedError = normalizeError(error);
      if (normalizedError instanceof DownstreamRpcError) {
        throw normalizedError;
      }

      const nextRestartAttempts = this.restartAttempts + 1;
      await this.dispose();
      this.restartAttempts = nextRestartAttempts;
      this.unavailableReason = null;
      this.logger.warn("downstream.http_reconnect_attempt", {
        serviceId: this.key,
        attempt: this.restartAttempts,
        message: normalizedError.message
      });
      return operation();
    }
  }

  /**
   * Sends one JSON-RPC request and waits for the correlated response.
   */
  private async request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params
    };

    const responsePromise = new Promise<unknown>((resolveResponse, rejectResponse) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectResponse(new Error(`Downstream request '${method}' timed out after ${DEFAULT_REQUEST_TIMEOUT_MS}ms for '${this.key}'.`));
      }, DEFAULT_REQUEST_TIMEOUT_MS);

      this.pending.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolveResponse(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          rejectResponse(error);
        }
      });
    });

    try {
      const directResponse = await this.postMessage(request);
      if (directResponse) {
        this.handleMessage(directResponse);
      }
    } catch (error) {
      this.pending.delete(id);
      throw error;
    }

    return responsePromise;
  }

  /**
   * Sends one JSON-RPC message to the current POST endpoint.
   */
  private async postMessage(message: JsonRpcMessage): Promise<JsonRpcMessage | null> {
    const transport = requireHttpTransport(this.service);
    const endpoint = this.messageEndpoint ?? transport.url;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
        ...transport.headers
      },
      body: JSON.stringify(message)
    });

    if (!response.ok) {
      throw new Error(`Streamable HTTP POST failed for '${this.key}' with status ${response.status}.`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (transport.enableJsonResponse || contentType.includes("application/json")) {
      const text = await response.text();
      if (text.trim() === "") {
        return null;
      }
      return JSON.parse(text) as JsonRpcMessage;
    }

    return null;
  }

  /**
   * Reads and dispatches Server-Sent Events from the downstream response body.
   */
  private async readEventStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const read = await reader.read();
      if (read.done) {
        break;
      }

      buffer += decoder.decode(read.value, { stream: true });
      let boundary = findSseBoundary(buffer);
      while (boundary >= 0) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(skipSseBoundary(buffer, boundary));
        this.handleSseEvent(rawEvent);
        boundary = findSseBoundary(buffer);
      }
    }

    const tail = `${buffer}${decoder.decode()}`.trim();
    if (tail.length > 0) {
      this.handleSseEvent(tail);
    }
  }

  /**
   * Parses one SSE event block and applies endpoint/message events.
   */
  private handleSseEvent(rawEvent: string): void {
    let eventName = "message";
    const dataLines: string[] = [];

    for (const line of rawEvent.split(/\r?\n/)) {
      if (line.startsWith("event:")) {
        eventName = line.slice("event:".length).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trimStart());
      }
    }

    const data = dataLines.join("\n");
    if (eventName === "endpoint") {
      this.messageEndpoint = new URL(data, requireHttpTransport(this.service).url).toString();
      return;
    }
    if (eventName === "message" && data.trim() !== "") {
      this.handleMessage(JSON.parse(data) as JsonRpcMessage);
    }
  }

  /**
   * Routes one inbound response to the matching pending request.
   */
  private handleMessage(message: JsonRpcMessage): void {
    if (!("id" in message) || message.id === null) {
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }

    this.pending.delete(message.id);

    if ("error" in message) {
      const failure = message as JsonRpcFailure;
      pending.reject(new DownstreamRpcError(failure.error.message));
      return;
    }

    const success = message as JsonRpcSuccess;
    pending.resolve(success.result);
  }

  /**
   * Rejects all pending requests after a transport-level failure.
   */
  private failAllPending(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}

/**
 * Describes one pending downstream request.
 */
interface PendingRequest {
  /**
   * Resolves the request with a successful result payload.
   */
  resolve: (result: unknown) => void;
  /**
   * Rejects the request with a terminal error.
   */
  reject: (error: Error) => void;
}

/**
 * Marks a downstream JSON-RPC error response so it is not treated as a transport failure.
 */
class DownstreamRpcError extends Error {}

/**
 * Narrows a service config to its HTTP transport.
 */
function requireHttpTransport(service: ServiceConfig): HttpTransportConfig {
  if (service.transport.type !== "http") {
    throw new Error(`Unsupported transport '${String((service.transport as { type?: unknown }).type)}'.`);
  }
  return service.transport;
}

/**
 * Normalizes one raw downstream tool definition.
 */
function normalizeToolDefinition(clientKey: string, input: unknown): ToolDefinition {
  if (!isRecord(input)) {
    throw new Error(`Downstream tool definition from '${clientKey}' must be an object.`);
  }

  if (typeof input.name !== "string" || input.name.trim() === "") {
    throw new Error(`Downstream tool definition from '${clientKey}' is missing a valid name.`);
  }

  return {
    name: input.name,
    description: typeof input.description === "string" ? input.description : undefined,
    inputSchema: isRecord(input.inputSchema) ? input.inputSchema : undefined,
    outputSchema: isRecord(input.outputSchema) ? input.outputSchema : null
  };
}

/**
 * Normalizes unknown thrown values into Error instances.
 */
function normalizeError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
}

/**
 * Polls until a condition is met or a timeout is reached.
 */
async function waitUntil(condition: () => boolean, timeoutMs: number, timeoutMessage: string): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(timeoutMessage);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Checks whether a value is a plain object record.
 */
function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

/**
 * Finds the next SSE event separator for LF or CRLF streams.
 */
function findSseBoundary(input: string): number {
  const lf = input.indexOf("\n\n");
  const crlf = input.indexOf("\r\n\r\n");
  if (lf < 0) {
    return crlf;
  }
  if (crlf < 0) {
    return lf;
  }
  return Math.min(lf, crlf);
}

/**
 * Returns the index after the detected SSE separator.
 */
function skipSseBoundary(input: string, boundary: number): number {
  return input.startsWith("\r\n\r\n", boundary) ? boundary + 4 : boundary + 2;
}
