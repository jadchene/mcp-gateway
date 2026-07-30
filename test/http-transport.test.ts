import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  createMcpHandler,
  legacyStatelessFallback,
  McpServer,
  PROTOCOL_VERSION_META_KEY
} from "@modelcontextprotocol/server";
import { NodeStreamableHTTPServerTransport, toNodeHandler } from "@modelcontextprotocol/node";
import { McpGatewayEngine } from "../src/gateway-engine.ts";
import { StreamableHttpGatewayServer } from "../src/http-server.ts";
import { Logger } from "../src/logger.ts";
import { StreamableHttpClient } from "../src/mcp/http-client.ts";
import type { ServiceRuntimeSnapshot, ToolDefinition } from "../src/types.ts";

test("StreamableHttpGatewayServer serves MCP 2026-07-28 without protocol sessions", async () => {
  const server = createGatewayServer();
  await server.start();
  const client = new Client(
    { name: "modern-http-test", version: "1.0.0" },
    { versionNegotiation: { mode: "auto" } }
  );
  const transport = new StreamableHTTPClientTransport(new URL(server.url));

  try {
    await client.connect(transport);
    assert.equal(client.getProtocolEra(), "modern");
    assert.equal(client.getNegotiatedProtocolVersion(), "2026-07-28");

    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name),
      [
        "gateway_list_services",
        "gateway_get_service",
        "gateway_list_tools",
        "gateway_get_tool_schema",
        "gateway_manage_service",
        "gateway_call_tool"
      ]
    );

    const called = await client.callTool({
      name: "gateway_list_services",
      arguments: {}
    });
    assert.deepEqual(called.structuredContent, {
      services: [
        {
          serviceId: "demo",
          description: "Demo service.",
          available: true
        }
      ]
    });

    const get = await fetch(server.url, { method: "GET" });
    assert.equal(get.status, 405);
    assert.equal(get.headers.has("mcp-session-id"), false);
    const remove = await fetch(server.url, { method: "DELETE" });
    assert.equal(remove.status, 405);
  } finally {
    await client.close().catch(() => undefined);
    await server.stop();
  }
});

for (const protocolVersion of ["2025-11-25", "2025-06-18"] as const) {
  test(`StreamableHttpGatewayServer serves MCP ${protocolVersion} on the same endpoint`, async () => {
    const server = createGatewayServer();
    await server.start();
    const client = new Client(
      { name: `http-${protocolVersion}-test`, version: "1.0.0" },
      { supportedProtocolVersions: [protocolVersion] }
    );
    const transport = new StreamableHTTPClientTransport(new URL(server.url));

    try {
      await client.connect(transport);
      assert.equal(client.getProtocolEra(), "legacy");
      assert.equal(client.getNegotiatedProtocolVersion(), protocolVersion);
      assert.equal((await client.listTools()).tools.length, 6);
      const called = await client.callTool({
        name: "gateway_list_services",
        arguments: {}
      });
      assert.deepEqual(called.structuredContent, {
        services: [
          {
            serviceId: "demo",
            description: "Demo service.",
            available: true
          }
        ]
      });
    } finally {
      await client.close().catch(() => undefined);
      await server.stop();
    }
  });
}

test("StreamableHttpGatewayServer rejects clients that only support an excluded revision", async () => {
  const server = createGatewayServer();
  await server.start();
  const client = new Client(
    { name: "unsupported-http-upstream", version: "1.0.0" },
    { supportedProtocolVersions: ["2025-03-26"] }
  );
  try {
    await assert.rejects(
      client.connect(new StreamableHTTPClientTransport(new URL(server.url))),
      /protocol version is not supported: 2025-11-25/
    );
  } finally {
    await client.close().catch(() => undefined);
    await server.stop();
  }
});

test("StreamableHttpGatewayServer rejects an untrusted browser Origin", async () => {
  const server = createGatewayServer();
  await server.start();
  try {
    const response = await fetch(server.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://attacker.example"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "origin-test", version: "1.0.0" }
        }
      })
    });
    assert.equal(response.status, 403);
  } finally {
    await server.stop();
  }
});

test("StreamableHttpGatewayServer rejects modern HTTP header and body mismatches", async () => {
  const server = createGatewayServer();
  await server.start();
  try {
    const response = await fetch(server.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tools/list"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 17,
        method: "server/discover",
        params: {
          _meta: {
            [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
            [CLIENT_INFO_META_KEY]: { name: "header-test", version: "1.0.0" },
            [CLIENT_CAPABILITIES_META_KEY]: {}
          }
        }
      })
    });
    assert.equal(response.status, 400);
    const failure = await response.json() as { id?: number; error?: { code?: number } };
    assert.equal(failure.id, 17);
    assert.equal(failure.error?.code, -32020);
  } finally {
    await server.stop();
  }
});

test("StreamableHttpGatewayServer returns the standard unsupported-version error", async () => {
  const server = createGatewayServer();
  await server.start();
  try {
    const response = await fetch(server.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2099-01-01",
        "Mcp-Method": "server/discover"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 18,
        method: "server/discover",
        params: {
          _meta: {
            [PROTOCOL_VERSION_META_KEY]: "2099-01-01",
            [CLIENT_INFO_META_KEY]: { name: "future-test", version: "1.0.0" },
            [CLIENT_CAPABILITIES_META_KEY]: {}
          }
        }
      })
    });
    assert.equal(response.status, 400);
    const failure = await response.json() as {
      error?: { code?: number; data?: { supported?: string[]; requested?: string } };
    };
    assert.equal(failure.error?.code, -32022);
    assert.equal(failure.error?.data?.requested, "2099-01-01");
    assert.deepEqual(failure.error?.data?.supported, ["2026-07-28"]);
  } finally {
    await server.stop();
  }
});

test("StreamableHttpGatewayServer automatically returns JSON for a non-streaming exchange", async () => {
  const server = createGatewayServer();
  await server.start();
  try {
    const response = await fetch(server.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "server/discover"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 19,
        method: "server/discover",
        params: {
          _meta: {
            [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
            [CLIENT_INFO_META_KEY]: { name: "json-mode-test", version: "1.0.0" },
            [CLIENT_CAPABILITIES_META_KEY]: {}
          }
        }
      })
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^application\/json/);
    const payload = await response.json() as { result?: { supportedVersions?: string[] } };
    assert.deepEqual(payload.result?.supportedVersions, ["2026-07-28"]);
  } finally {
    await server.stop();
  }
});

test("StreamableHttpClient negotiates modern HTTP and preserves full tool metadata", async () => {
  const server = createGatewayServer();
  await server.start();
  const client = new StreamableHttpClient({
    serviceId: "http-demo",
    enable: true,
    name: "HTTP Demo",
    transport: {
      type: "http",
      url: server.url
    }
  }, new Logger());

  try {
    const metadata = await client.getMetadata();
    assert.equal(metadata.protocolEra, "modern");
    assert.equal(metadata.protocolVersion, "2026-07-28");
    assert.equal(metadata.tools.length, 6);
    assert.equal(metadata.tools[0]?.name, "gateway_list_services");
    assert.equal(typeof metadata.tools[0]?.outputSchema, "object");
  } finally {
    await client.dispose();
    await server.stop();
  }
});

for (const protocolVersion of ["2025-11-25", "2025-06-18"] as const) {
  test(`StreamableHttpClient automatically negotiates ${protocolVersion} Streamable HTTP`, async () => {
    const server = await startLegacyStreamableHttpServer(protocolVersion);
    const client = new StreamableHttpClient({
      serviceId: `http-${protocolVersion}-demo`,
      enable: true,
      name: `HTTP ${protocolVersion} Demo`,
      transport: {
        type: "http",
        url: server.url
      }
    }, new Logger());
    try {
      const metadata = await client.getMetadata();
      assert.equal(metadata.protocolEra, "legacy");
      assert.equal(metadata.protocolVersion, protocolVersion);
      assert.equal(metadata.tools.length, 1);
      assert.equal(metadata.tools[0]?.name, "mcp_2025_echo");
      if (protocolVersion === "2025-11-25") {
        assert.deepEqual(metadata.tools[0]?.icons, [{
          src: "https://example.com/mcp-2025-echo.svg",
          mimeType: "image/svg+xml",
          sizes: ["any"]
        }]);
      }
      const result = await client.callTool("mcp_2025_echo", {});
      assert.deepEqual(result.structuredContent, { echoed: "2025" });
    } finally {
      await client.dispose();
      await server.close();
    }
  });

  test(`StreamableHttpClient preserves a standard ${protocolVersion} HTTP session`, async () => {
    const server = await startSessionful2025HttpServer(protocolVersion);
    const client = new StreamableHttpClient({
      serviceId: `sessionful-http-${protocolVersion}`,
      enable: true,
      name: `Sessionful HTTP ${protocolVersion}`,
      transport: {
        type: "http",
        url: server.url
      }
    }, new Logger());
    try {
      const metadata = await client.getMetadata();
      assert.equal(metadata.protocolVersion, protocolVersion);
      assert.equal(metadata.tools[0]?.name, "session_echo");
      assert.equal(server.generatedSessions(), 1);
      assert.ok(server.sessionRequests() >= 1);
    } finally {
      await client.dispose();
      await server.close();
    }
  });
}

test("StreamableHttpClient rejects HTTP protocol revisions outside the allow-list", async () => {
  const server = await startLegacyStreamableHttpServer("2025-03-26");
  const client = new StreamableHttpClient({
    serviceId: "unsupported-http-version",
    enable: true,
    name: "Unsupported HTTP version",
    transport: {
      type: "http",
      url: server.url
    }
  }, new Logger());
  try {
    await assert.rejects(client.getMetadata(), /protocol version is not supported: 2025-03-26/);
  } finally {
    await client.dispose();
    await server.close();
  }
});

test("StreamableHttpClient never opens the removed standalone SSE endpoint", async () => {
  const failureServer = await startFailureServer(404);
  const client = new StreamableHttpClient({
    serviceId: "streamable-http-only",
    enable: true,
    name: "Modern-only HTTP",
    transport: {
      type: "http",
      url: failureServer.url
    }
  }, new Logger());
  try {
    await assert.rejects(client.getMetadata());
    assert.equal(failureServer.getRequests(), 0);
  } finally {
    await client.dispose();
    await failureServer.close();
  }
});

test("SDK list caching honors TTL and keeps private caches client-local", async () => {
  const downstream = await startCacheHintServer();
  const first = new Client(
    { name: "cache-client-1", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } }
  );
  const second = new Client(
    { name: "cache-client-2", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } }
  );

  try {
    await first.connect(new StreamableHTTPClientTransport(new URL(downstream.url)));
    await first.listTools();
    const afterFirstList = downstream.requestCount();
    await first.listTools();
    assert.equal(downstream.requestCount(), afterFirstList, "the second list call should use its unexpired cache");

    await second.connect(new StreamableHTTPClientTransport(new URL(downstream.url)));
    await second.listTools();
    assert.ok(
      downstream.requestCount() > afterFirstList,
      "a second client must not reuse another client's private response cache"
    );
  } finally {
    await first.close().catch(() => undefined);
    await second.close().catch(() => undefined);
    await downstream.close();
  }
});

function createGatewayServer(): StreamableHttpGatewayServer {
  const logger = new Logger();
  const engine = new McpGatewayEngine(createRegistryStub() as never, logger);
  return new StreamableHttpGatewayServer({
    enable: true,
    host: "127.0.0.1",
    port: 0,
    path: "/mcp"
  }, engine, logger);
}

function createRegistryStub(): {
  listServices: () => ServiceRuntimeSnapshot[];
  getService: (serviceId: string) => ServiceRuntimeSnapshot | null;
  listTools: (serviceId: string) => ToolDefinition[];
  getTool: (serviceId: string, toolName: string) => ToolDefinition | null;
  callTool: () => Promise<{ result: { content: never[] }; durationMs: number; restartAttempts: number }>;
  manageService: () => Promise<{ serviceId: string; action: "reconnect"; enabled: boolean; available: boolean }>;
} {
  const snapshot: ServiceRuntimeSnapshot = {
    config: {
      serviceId: "demo",
      enable: true,
      name: "Demo",
      description: "Demo service.",
      transport: {
        type: "stdio",
        command: "node"
      }
    },
    metadata: {
      protocolVersion: "2026-07-28",
      protocolEra: "modern",
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
    callTool: async () => ({ result: { content: [] }, durationMs: 0, restartAttempts: 0 }),
    manageService: async () => ({ serviceId: "demo", action: "reconnect", enabled: true, available: true })
  };
}

async function startLegacyStreamableHttpServer(protocolVersion: string): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const handler = legacyStatelessFallback(() => {
    const server = new McpServer(
      { name: "mcp-2025-test", version: "1.0.0" },
      { supportedProtocolVersions: [protocolVersion] }
    );
    server.registerTool("mcp_2025_echo", {
      icons: [{
        src: "https://example.com/mcp-2025-echo.svg",
        mimeType: "image/svg+xml",
        sizes: ["any"]
      }]
    }, async () => ({
      content: [{ type: "text", text: "2025" }],
      structuredContent: { echoed: "2025" }
    }));
    return server;
  });
  const nodeHandler = toNodeHandler({ fetch: handler });
  const server = http.createServer((request, response) => void nodeHandler(request, response));
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (typeof address !== "object" || !address) {
    throw new Error("MCP 2025 test server did not expose a TCP address.");
  }
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: async () => {
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => error ? rejectClose(error) : resolveClose());
        server.closeAllConnections();
      });
    }
  };
}

async function startSessionful2025HttpServer(protocolVersion: "2025-11-25" | "2025-06-18"): Promise<{
  url: string;
  generatedSessions: () => number;
  sessionRequests: () => number;
  close: () => Promise<void>;
}> {
  let generatedSessions = 0;
  let sessionRequests = 0;
  const transport = new NodeStreamableHTTPServerTransport({
    sessionIdGenerator: () => {
      generatedSessions += 1;
      return "mcp-2025-test-session";
    }
  });
  const mcpServer = new McpServer(
    { name: "sessionful-mcp-2025-test", version: "1.0.0" },
    { supportedProtocolVersions: [protocolVersion] }
  );
  mcpServer.registerTool("session_echo", {}, async () => ({
    content: [{ type: "text", text: "session" }]
  }));
  await mcpServer.connect(transport);

  const server = http.createServer((request, response) => {
    if (request.headers["mcp-session-id"]) {
      sessionRequests += 1;
    }
    void transport.handleRequest(request, response);
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (typeof address !== "object" || !address) {
    throw new Error("Sessionful MCP 2025 test server did not expose a TCP address.");
  }
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    generatedSessions: () => generatedSessions,
    sessionRequests: () => sessionRequests,
    close: async () => {
      await mcpServer.close().catch(() => undefined);
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => error ? rejectClose(error) : resolveClose());
        server.closeAllConnections();
      });
    }
  };
}

async function startCacheHintServer(): Promise<{
  url: string;
  requestCount: () => number;
  close: () => Promise<void>;
}> {
  let requests = 0;
  const handler = createMcpHandler(() => {
    requests += 1;
    const mcpServer = new McpServer(
      { name: "cache-hint-test", version: "1.0.0" },
      {
        supportedProtocolVersions: ["2026-07-28"],
        cacheHints: {
          "server/discover": { ttlMs: 5_000, cacheScope: "private" },
          "tools/list": { ttlMs: 5_000, cacheScope: "private" }
        }
      }
    );
    mcpServer.registerTool("cached_tool", {}, async () => ({
      content: [{ type: "text", text: "cached" }]
    }));
    return mcpServer;
  }, { legacy: "reject" });
  const nodeHandler = toNodeHandler(handler);
  const server = http.createServer((request, response) => void nodeHandler(request, response));
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (typeof address !== "object" || !address) {
    throw new Error("Cache test server did not expose a TCP address.");
  }
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    requestCount: () => requests,
    close: async () => {
      await handler.close();
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => error ? rejectClose(error) : resolveClose());
        server.closeAllConnections();
      });
    }
  };
}

async function startFailureServer(status: number): Promise<{
  url: string;
  getRequests: () => number;
  close: () => Promise<void>;
}> {
  let getRequests = 0;
  const server = http.createServer((request, response) => {
    if (request.method === "GET") {
      getRequests += 1;
    }
    response.writeHead(status).end();
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (typeof address !== "object" || !address) {
    throw new Error("HTTP failure test server did not expose a TCP address.");
  }
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    getRequests: () => getRequests,
    close: async () => {
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => error ? rejectClose(error) : resolveClose());
        server.closeAllConnections();
      });
    }
  };
}
