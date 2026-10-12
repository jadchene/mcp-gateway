import {
  Client,
  SdkHttpError,
  StreamableHTTPClientTransport,
  type FetchLike
} from "@modelcontextprotocol/client";
import { Logger } from "../logger.ts";
import type { HttpTransportConfig, ServiceConfig } from "../types.ts";
import { SdkMcpClient } from "./sdk-client.ts";

/**
 * Connects to a downstream HTTP MCP service through the official SDK v2.
 */
export class StreamableHttpClient extends SdkMcpClient {
  /**
   * Creates a standards-compliant Streamable HTTP transport.
   */
  public constructor(service: ServiceConfig, logger: Logger) {
    const transport = requireHttpTransport(service);
    const url = new URL(transport.url);
    const fetchWithHeaders = createFetchWithHeaders(transport.headers);

    super(
      service,
      logger,
      () => new StreamableHTTPClientTransport(url, {
        fetch: fetchWithHeaders,
        requestInit: {
          headers: transport.headers
        }
      })
    );
  }

  /** 仅对已建立的旧版 HTTP 会话识别失效响应，不将认证或参数错误视为重连信号。 */
  protected override isSessionExpired(error: Error, client: Client | null): boolean {
    const transport = client?.transport;
    if (!(error instanceof SdkHttpError)
      || !(transport instanceof StreamableHTTPClientTransport)
      || !transport.sessionId
      || client?.getProtocolEra() !== "legacy") {
      return false;
    }
    if (error.status === 404) {
      return true;
    }
    if (error.status !== 400 || typeof error.data.text !== "string") {
      return false;
    }
    try {
      const response = JSON.parse(error.data.text);
      // 微信开发者工具在旧会话不存在时返回通用 Bad Request，且响应不关联请求 ID。
      return response?.error === "Invalid or missing session ID"
        || (response?.jsonrpc === "2.0"
          && response?.id === null
          && response?.error?.code === -32000
          && response?.error?.message === "Bad Request")
        || response?.error?.message === "Session not found";
    } catch {
      return false;
    }
  }
}

/**
 * Applies static configured headers without allowing them to replace per-request SDK headers.
 */
function createFetchWithHeaders(headers: Record<string, string> | undefined): FetchLike {
  return async (input, init) => {
    const merged = new Headers(headers);
    new Headers(init?.headers).forEach((value, name) => merged.set(name, value));
    return fetch(input, {
      ...init,
      headers: merged
    });
  };
}

/**
 * Narrows a service config to HTTP.
 */
function requireHttpTransport(service: ServiceConfig): HttpTransportConfig {
  if (service.transport.type !== "http") {
    throw new Error(`Unsupported transport '${String((service.transport as { type?: unknown }).type)}'.`);
  }
  return service.transport;
}
