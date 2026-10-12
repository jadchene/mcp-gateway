import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { SdkHttpError } from "@modelcontextprotocol/client";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { McpServer } from "@modelcontextprotocol/server";
import { ConfigLoader } from "../src/config.ts";
import { Logger } from "../src/logger.ts";
import { StreamableHttpClient } from "../src/mcp/http-client.ts";
import { ServiceRegistry } from "../src/service-registry.ts";
import type { ServiceConfig } from "../src/types.ts";

const EXPIRED_RESPONSES = [
  { status: 400, body: { jsonrpc: "2.0", error: { code: -32000, message: "Bad Request" }, id: null } },
  { status: 400, body: { error: "Invalid or missing session ID" } },
  { status: 404, body: { jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null } }
];

for (const expired of EXPIRED_RESPONSES) {
  const label = `${expired.status} ${JSON.stringify(expired.body)}`;
  test(`HTTP recovery reconnects after ${label} without replaying a tool`, async () => {
    const server = await startRestartableServer(expired);
    const client = new StreamableHttpClient(server.config, new Logger());
    try {
      await client.getMetadata();
      await client.callTool("write_once", {});
      await server.restart();
      await assert.rejects(client.callTool("write_once", {}), /session expired.*did not replay.*next call will reconnect/);
      assert.equal(server.toolRequests(), 2);
      assert.equal(server.executions(), 1);
      assert.equal(server.initializations(), 1);
      await client.callTool("write_once", {});
      assert.equal(server.initializations(), 2);
      assert.equal(server.toolRequests(), 3);
      assert.equal(server.executions(), 2);
      assert.ok(server.authPreserved());
    } finally {
      await client.dispose();
      await server.close();
    }
  });

  test(`HTTP metadata automatically recovers after ${label}`, async () => {
    const server = await startRestartableServer(expired);
    const client = new StreamableHttpClient(server.config, new Logger());
    try {
      await client.getMetadata();
      await server.restart();
      assert.equal((await client.getMetadata()).tools[0]?.name, "write_once");
      assert.equal(server.initializations(), 2);
      assert.equal(server.executions(), 0);
      assert.ok(server.authPreserved());
    } finally {
      await client.dispose();
      await server.close();
    }
  });
}

for (const fault of [
  { status: 401, body: { error: "Invalid MCP token" } },
  { status: 403, body: { error: "Client not authorized" } },
  { status: 400, body: { jsonrpc: "2.0", error: { code: -32602, message: "Invalid params" }, id: null } },
  { status: 400, body: "Bad Request" },
  { status: 400, body: { jsonrpc: "2.0", error: { code: -32000, message: "Bad Request" }, id: 123 } }
]) {
  test(`HTTP recovery preserves unrelated ${fault.status} errors: ${JSON.stringify(fault.body)}`, async () => {
    const server = await startRestartableServer(EXPIRED_RESPONSES[0]);
    const client = new StreamableHttpClient(server.config, new Logger());
    try {
      await client.getMetadata();
      server.failNextRequest(fault);
      await assert.rejects(client.callTool("write_once", {}), (error: unknown) =>
        error instanceof SdkHttpError && error.status === fault.status);
      assert.equal(server.toolRequests(), 1);
      assert.equal(server.executions(), 0);
      await client.callTool("write_once", {});
      assert.equal(server.initializations(), 1);
      assert.equal(server.executions(), 1);
    } finally {
      await client.dispose();
      await server.close();
    }
  });
}

test("ServiceRegistry restores availability on the next tool call after a downstream restart", async (t) => {
  const server = await startRestartableServer(EXPIRED_RESPONSES[0]);
  const loader = new ConfigLoader();
  t.mock.method(loader, "load", async () => ({ services: [server.config], logging: { enable: false, path: null } }));
  const registry = new ServiceRegistry("http-recovery-fixture.json", loader, new Logger());
  try {
    await registry.initialize();
    await server.restart();
    await assert.rejects(registry.callTool(server.config.serviceId, "write_once", {}), /session expired/);
    assert.equal(registry.getService(server.config.serviceId)?.runtime.available, false);
    await registry.callTool(server.config.serviceId, "write_once", {});
    assert.equal(registry.getService(server.config.serviceId)?.runtime.available, true);
    assert.equal(registry.getService(server.config.serviceId)?.runtime.lastError, null);
    assert.equal(server.executions(), 1);
    assert.ok(server.authPreserved());
  } finally {
    await registry.dispose();
    await server.close();
  }
});

test("HTTP metadata does not retry authentication or unrelated request errors", async () => {
  const server = await startRestartableServer(EXPIRED_RESPONSES[0]);
  const client = new StreamableHttpClient(server.config, new Logger());
  try {
    await client.getMetadata();
    for (const status of [400, 401, 403]) {
      server.failNextRequest({ status, body: { error: "Request rejected" } }, "tools/list");
      await assert.rejects(client.listTools(), (error: unknown) =>
        error instanceof SdkHttpError && error.status === status);
      assert.equal(server.initializations(), 1);
    }
    assert.equal((await client.listTools())[0]?.name, "write_once");
  } finally {
    await client.dispose();
    await server.close();
  }
});

test("HTTP recovery clears a closed SDK client before the next call", async () => {
  const server = await startRestartableServer(EXPIRED_RESPONSES[0]);
  const client = new StreamableHttpClient(server.config, new Logger());
  try {
    await client.getMetadata();
    await client.callTool("write_once", {});
    // 模拟 SDK 已经收到传输关闭事件，而网关客户端对象仍然存在。
    await server.restart();
    const sdk = (client as unknown as { client: { close: () => Promise<void> } }).client;
    await sdk.close();
    await client.callTool("write_once", {});
    assert.equal(server.initializations(), 2);
    assert.equal(server.executions(), 2);
  } finally {
    await client.dispose();
    await server.close();
  }
});

/** 创建使用真实 MCP 握手的 HTTP 服务，重启时丢弃会话并保留相同认证要求。 */
async function startRestartableServer(expiredResponse: { status: number; body: unknown }): Promise<{
  config: ServiceConfig;
  restart: () => Promise<void>;
  failNextRequest: (fault: { status: number; body: unknown }, method?: string) => void;
  toolRequests: () => number;
  executions: () => number;
  initializations: () => number;
  authPreserved: () => boolean;
  close: () => Promise<void>;
}> {
  let generation = 0;
  let toolRequests = 0;
  let executions = 0;
  let initializations = 0;
  let authPreserved = true;
  let fault: { status: number; body: unknown } | null = null;
  let faultMethod = "tools/call";
  let transport: NodeStreamableHTTPServerTransport;
  const mcpServers: McpServer[] = [];
  const restart = async (): Promise<void> => {
    generation += 1;
    const sessionId = `recovery-test-session-${generation}`;
    transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: () => sessionId,
      enableJsonResponse: true
    });
    const mcpServer = new McpServer(
      { name: "restartable-http-fixture", version: "1.0.0" },
      { supportedProtocolVersions: ["2025-11-25"] }
    );
    mcpServer.registerTool("write_once", {}, async () => {
      executions += 1;
      return { content: [{ type: "text", text: "written" }] };
    });
    await mcpServer.connect(transport);
    mcpServers.push(mcpServer);
  };
  await restart();
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
    }
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    authPreserved &&= request.headers.authorization === "Bearer recovery-test-token";
    if (body?.method === "initialize") {
      initializations += 1;
    }
    if (body?.method === "tools/call") {
      toolRequests += 1;
    }
    // 独立 SSE 不参与此测试，避免后台重连先于断言清理会话。
    if (request.method === "GET") {
      response.writeHead(405).end();
      return;
    }
    const sessionId = request.headers["mcp-session-id"];
    const failure = body?.method === faultMethod ? fault : null;
    if (failure) {
      fault = null;
    }
    const expired = sessionId && sessionId !== `recovery-test-session-${generation}`;
    const rejected = failure ?? (expired ? expiredResponse : null);
    if (rejected) {
      response.writeHead(rejected.status, { "Content-Type": "application/json" });
      response.end(typeof rejected.body === "string" ? rejected.body : JSON.stringify(rejected.body));
      return;
    }
    await transport.handleRequest(request, response, body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    config: {
      serviceId: "restartable-http",
      name: "Restartable HTTP",
      enable: true,
      callTimeoutMs: 3000,
      transport: {
        type: "http",
        url: `http://127.0.0.1:${address.port}/mcp`,
        headers: { Authorization: "Bearer recovery-test-token" }
      }
    },
    restart,
    failNextRequest: (next, method = "tools/call") => {
      fault = next;
      faultMethod = method;
    },
    toolRequests: () => toolRequests,
    executions: () => executions,
    initializations: () => initializations,
    authPreserved: () => authPreserved,
    close: async () => {
      await Promise.all(mcpServers.map((mcpServer) => mcpServer.close()));
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    }
  };
}
