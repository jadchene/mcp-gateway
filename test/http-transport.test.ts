import test from "node:test";
import assert from "node:assert/strict";
import http, { type ServerResponse } from "node:http";
import { McpGatewayEngine } from "../src/gateway-engine.ts";
import { StreamableHttpGatewayServer } from "../src/http-server.ts";
import { Logger } from "../src/logger.ts";
import { StreamableHttpClient } from "../src/mcp/http-client.ts";
import type { ServiceRuntimeSnapshot, ToolDefinition } from "../src/types.ts";

test("StreamableHttpGatewayServer uses Mcp-Session-Id header and sends responses over SSE", async () => {
  const engine = new McpGatewayEngine(createRegistryStub() as never, new Logger());
  const server = new StreamableHttpGatewayServer({
    enable: true,
    host: "127.0.0.1",
    port: 0,
    path: "/mcp",
    enableJsonResponse: false
  }, engine, new Logger());

  await server.start();
  try {
    const stream = await fetch(server.url, {
      method: "GET",
      headers: {
        Accept: "text/event-stream"
      }
    });
    assert.equal(stream.status, 200);
    const sessionId = stream.headers.get("mcp-session-id");
    assert.ok(sessionId);

    const reader = stream.body?.getReader();
    assert.ok(reader);
    const endpointEvent = await readUntil(reader, "event: endpoint");
    assert.match(endpointEvent, /data: \/mcp/);
    assert.doesNotMatch(endpointEvent, /sessionId=/);

    const post = await fetch(server.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Mcp-Session-Id": sessionId
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {}
      })
    });
    assert.equal(post.status, 202);

    const messageEvent = await readUntil(reader, "event: message");
    assert.match(messageEvent, /gateway_list_services/);
    await reader.cancel();
  } finally {
    await server.stop();
  }
});

test("StreamableHttpClient posts downstream requests with Mcp-Session-Id header", async () => {
  let sessionHeaderSeen = false;
  const server = http.createServer((request, response) => {
    void handleDownstreamRequest(request, response, (sawSessionHeader) => {
      sessionHeaderSeen ||= sawSessionHeader;
    });
  });

  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  const client = new StreamableHttpClient({
    serviceId: "http-demo",
    enable: true,
    name: "HTTP Demo",
    transport: {
      type: "http",
      url: `http://127.0.0.1:${address.port}/mcp`
    }
  }, new Logger());

  try {
    const metadata = await client.getMetadata();
    assert.equal(metadata.tools[0]?.name, "echo");
    assert.equal(sessionHeaderSeen, true);
  } finally {
    await client.dispose();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
});

function createRegistryStub(): {
  listServices: () => ServiceRuntimeSnapshot[];
  getService: (serviceId: string) => ServiceRuntimeSnapshot | null;
  listTools: (serviceId: string) => ToolDefinition[];
  getTool: (serviceId: string, toolName: string) => ToolDefinition | null;
  callTool: () => Promise<{ result: unknown; durationMs: number; restartAttempts: number }>;
  manageService: () => Promise<{ serviceId: string; action: "reconnect"; enabled: boolean; available: boolean }>;
} {
  const snapshot: ServiceRuntimeSnapshot = {
    config: {
      serviceId: "demo",
      enable: true,
      name: "Demo",
      transport: {
        type: "stdio",
        command: "node"
      }
    },
    metadata: {
      protocolVersion: "2025-06-18",
      serverInfo: null,
      tools: [],
      refreshedAt: null
    },
    runtime: {
      available: true,
      lastError: null,
      lastConnectedAt: null,
      restartAttempts: 0
    }
  };

  return {
    listServices: () => [snapshot],
    getService: (serviceId) => serviceId === "demo" ? snapshot : null,
    listTools: () => [],
    getTool: () => null,
    callTool: async () => ({ result: {}, durationMs: 0, restartAttempts: 0 }),
    manageService: async () => ({ serviceId: "demo", action: "reconnect", enabled: true, available: true })
  };
}

async function handleDownstreamRequest(
  request: http.IncomingMessage,
  response: ServerResponse,
  markSessionHeader: (seen: boolean) => void
): Promise<void> {
  if (request.method === "GET") {
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Mcp-Session-Id": "downstream-session"
    });
    response.write("event: endpoint\ndata: /mcp\n\n");
    activeDownstreamStream = response;
    return;
  }

  if (request.method !== "POST") {
    response.writeHead(405).end();
    return;
  }

  markSessionHeader(request.headers["mcp-session-id"] === "downstream-session");
  const message = JSON.parse(await readBody(request)) as { id?: number; method?: string };
  if (message.method === "initialize") {
    writeSseMessage({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2025-06-18",
        serverInfo: {
          name: "test-http"
        }
      }
    });
  } else if (message.method === "tools/list") {
    writeSseMessage({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [
          {
            name: "echo",
            inputSchema: {
              type: "object"
            }
          }
        ]
      }
    });
  }
  response.writeHead(202).end();
}

let activeDownstreamStream: ServerResponse | null = null;

function writeSseMessage(payload: unknown): void {
  activeDownstreamStream?.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
}

async function readBody(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, pattern: string): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes(pattern)) {
    const read = await reader.read();
    if (read.done) {
      break;
    }
    text += decoder.decode(read.value, { stream: true });
  }
  return text;
}
