import {
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
