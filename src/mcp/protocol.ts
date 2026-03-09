import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import type { StdioFraming } from "../types.ts";

/**
 * Describes a generic JSON-RPC identifier.
 */
export type JsonRpcId = string | number;

/**
 * Describes a JSON-RPC request message.
 */
export interface JsonRpcRequest {
  /**
   * Declares the JSON-RPC protocol version.
   */
  jsonrpc: "2.0";
  /**
   * Provides the request identifier.
   */
  id: JsonRpcId;
  /**
   * Provides the remote method name.
   */
  method: string;
  /**
   * Provides optional request parameters.
   */
  params?: unknown;
}

/**
 * Describes a JSON-RPC notification message.
 */
export interface JsonRpcNotification {
  /**
   * Declares the JSON-RPC protocol version.
   */
  jsonrpc: "2.0";
  /**
   * Provides the remote method name.
   */
  method: string;
  /**
   * Provides optional notification parameters.
   */
  params?: unknown;
}

/**
 * Describes a JSON-RPC success response.
 */
export interface JsonRpcSuccess {
  /**
   * Declares the JSON-RPC protocol version.
   */
  jsonrpc: "2.0";
  /**
   * Provides the response identifier.
   */
  id: JsonRpcId;
  /**
   * Provides the response payload.
   */
  result: unknown;
}

/**
 * Describes a JSON-RPC error response.
 */
export interface JsonRpcFailure {
  /**
   * Declares the JSON-RPC protocol version.
   */
  jsonrpc: "2.0";
  /**
   * Provides the response identifier.
   */
  id: JsonRpcId | null;
  /**
   * Provides error details.
   */
  error: {
    /**
     * Provides the JSON-RPC or application error code.
     */
    code: number;
    /**
     * Provides the human-readable error message.
     */
    message: string;
    /**
     * Provides optional structured error details.
     */
    data?: unknown;
  };
}

/**
 * Represents any inbound or outbound JSON-RPC message used by the gateway.
 */
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcSuccess | JsonRpcFailure;

/**
 * Declares the framing selection accepted by the message reader.
 */
export type ReaderFramingMode = StdioFraming | "auto";

/**
 * Provides a framed MCP stdio message reader compatible with both line-delimited and Content-Length transports.
 */
export class McpMessageReader extends EventEmitter {
  /**
   * Stores raw bytes that have not yet formed a complete frame.
   */
  private buffer = Buffer.alloc(0);

  /**
   * Stores the configured framing preference.
   */
  private readonly preferredMode: ReaderFramingMode;

  /**
   * Stores the framing mode detected from the incoming stream.
   */
  private detectedMode: StdioFraming | null = null;

  /**
   * Starts reading from the provided stream immediately.
   */
  public constructor(stream: Readable, preferredMode: ReaderFramingMode = "auto") {
    super();
    this.preferredMode = preferredMode;
    stream.on("data", (chunk: Buffer | string) => {
      const next = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      this.buffer = Buffer.concat([this.buffer, next]);
      this.consumeFrames();
    });
    stream.on("error", (error) => this.emit("error", error));
    stream.on("close", () => this.emit("close"));
  }

  /**
   * Returns the currently selected framing mode when known.
   */
  public get framingMode(): StdioFraming | null {
    return this.preferredMode === "auto" ? this.detectedMode : this.preferredMode;
  }

  /**
   * Attempts to parse as many complete frames as possible from the current buffer.
   */
  private consumeFrames(): void {
    while (true) {
      const framingMode = this.resolveFramingMode();
      if (!framingMode) {
        return;
      }

      try {
        const payload = framingMode === "content-length"
          ? this.readContentLengthPayload()
          : this.readLinePayload();

        if (payload === null) {
          return;
        }

        const message = JSON.parse(payload) as JsonRpcMessage;
        this.emit("message", message);
      } catch (error) {
        this.emit("error", error);
      }
    }
  }

  /**
   * Resolves the framing mode using the configured preference or buffered bytes.
   */
  private resolveFramingMode(): StdioFraming | null {
    if (this.preferredMode !== "auto") {
      return this.preferredMode;
    }

    if (this.detectedMode) {
      return this.detectedMode;
    }

    const sample = this.buffer.toString("utf8");
    const trimmed = sample.trimStart();
    if (trimmed.startsWith("Content-Length:")) {
      this.detectedMode = "content-length";
      return this.detectedMode;
    }

    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      this.detectedMode = "line";
      return this.detectedMode;
    }

    return null;
  }

  /**
   * Reads one Content-Length framed payload when available.
   */
  private readContentLengthPayload(): string | null {
    const headerEnd = this.buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) {
      return null;
    }

    const headerText = this.buffer.subarray(0, headerEnd).toString("utf8");
    const lengthMatch = /Content-Length:\s*(\d+)/i.exec(headerText);
    if (!lengthMatch) {
      throw new Error("Missing Content-Length header.");
    }

    const contentLength = Number(lengthMatch[1]);
    const frameStart = headerEnd + 4;
    const frameEnd = frameStart + contentLength;
    if (this.buffer.length < frameEnd) {
      return null;
    }

    const payload = this.buffer.subarray(frameStart, frameEnd).toString("utf8");
    this.buffer = this.buffer.subarray(frameEnd);
    return payload;
  }

  /**
   * Reads one newline-delimited JSON payload when available.
   */
  private readLinePayload(): string | null {
    const lineEnd = this.buffer.indexOf("\n");
    if (lineEnd < 0) {
      return null;
    }

    const payload = this.buffer.toString("utf8", 0, lineEnd).replace(/\r$/, "");
    this.buffer = this.buffer.subarray(lineEnd + 1);
    return payload;
  }
}

/**
 * Provides a framed MCP stdio message writer compatible with line-delimited and Content-Length transports.
 */
export class McpMessageWriter {
  /**
   * Stores the target writable stream.
   */
  private readonly stream: Writable;

  /**
   * Stores the active framing mode used for outbound messages.
   */
  private mode: StdioFraming;

  /**
   * Creates a writer bound to one writable stream.
   */
  public constructor(stream: Writable, mode: StdioFraming = "line") {
    this.stream = stream;
    this.mode = mode;
  }

  /**
   * Updates the framing mode used for future outbound messages.
   */
  public setFramingMode(mode: StdioFraming): void {
    this.mode = mode;
  }

  /**
   * Writes one framed JSON-RPC message to the target stream.
   */
  public write(message: JsonRpcMessage): void {
    const payload = Buffer.from(JSON.stringify(message), "utf8");
    if (this.mode === "content-length") {
      const header = Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, "utf8");
      this.stream.write(Buffer.concat([header, payload]));
      return;
    }

    this.stream.write(Buffer.concat([payload, Buffer.from("\n", "utf8")]));
  }
}

/**
 * Creates a typed message reader.
 */
export function createMessageReader(stream: Readable, preferredMode: ReaderFramingMode = "auto"): McpMessageReader {
  return new McpMessageReader(stream, preferredMode);
}

/**
 * Creates a typed message writer.
 */
export function createMessageWriter(stream: Writable, mode: StdioFraming = "line"): McpMessageWriter {
  return new McpMessageWriter(stream, mode);
}

/**
 * Builds one JSON-RPC success response.
 */
export function jsonRpcResult(id: JsonRpcId, result: unknown): JsonRpcSuccess {
  return {
    jsonrpc: "2.0",
    id,
    result
  };
}

/**
 * Builds one JSON-RPC error response.
 */
export function jsonRpcError(id: JsonRpcId | null, code: number, message: string, data?: unknown): JsonRpcFailure {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      data
    }
  };
}
