import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  Client,
  InMemoryTransport,
  StreamableHTTPClientTransport,
  isInputRequiredResult,
  type CallToolResult,
  type CallToolRequestParams,
  type InputRequiredResult
} from "@modelcontextprotocol/client";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  McpServer,
  PROTOCOL_VERSION_META_KEY,
  acceptedContent,
  createMcpHandler,
  fromJsonSchema,
  inputRequired
} from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { z } from "zod";
import { ConfigLoader } from "../src/config.ts";
import { McpGatewayEngine } from "../src/gateway-engine.ts";
import { StreamableHttpGatewayServer } from "../src/http-server.ts";
import { Logger } from "../src/logger.ts";
import { createGatewayMcpServer } from "../src/mcp/server.ts";
import { ServiceRegistry } from "../src/service-registry.ts";

test("gateway proxies modern MRTR state and input responses across two tool layers", async () => {
  await withProxy(async ({ client }) => {
    const first = await client.callTool({
      name: "gateway_call_tool",
      arguments: {
        serviceId: "downstream",
        toolName: "needs_confirmation",
        arguments: { operation: "deploy" }
      }
    }, { allowInputRequired: true }) as CallToolResult | InputRequiredResult;

    assert.equal(isInputRequiredResult(first), true);
    assert.equal((first as InputRequiredResult).requestState, "downstream-state-v1");
    assert.equal(typeof (first as InputRequiredResult).inputRequests?.confirm, "object");
    assert.equal(
      ((first as InputRequiredResult).inputRequests?.confirm as { method?: string } | undefined)?.method,
      "elicitation/create"
    );

    const secondParams = {
      name: "gateway_call_tool",
      arguments: {
        serviceId: "downstream",
        toolName: "needs_confirmation",
        arguments: { operation: "deploy" }
      },
      requestState: (first as InputRequiredResult).requestState,
      inputResponses: {
        confirm: {
          action: "accept",
          content: { confirmed: true }
        }
      }
    } as unknown as CallToolRequestParams;
    const second = await client.callTool(secondParams, {
      allowInputRequired: true
    }) as CallToolResult | InputRequiredResult;

    assert.equal(isInputRequiredResult(second), false);
    assert.deepEqual((second as CallToolResult).structuredContent, {
      operation: "deploy",
      confirmed: true,
      state: "downstream-state-v1"
    });
  });
});

for (const protocolVersion of ["2025-11-25", "2025-06-18"] as const) {
  test(`MCP ${protocolVersion} upstream clients can complete MRTR against a modern downstream service`, async () => {
    const operation = `${protocolVersion}-deploy`;
    await withLegacyInMemoryProxy(async ({ client }) => {
      const result = await client.callTool({
        name: "gateway_call_tool",
        arguments: {
          serviceId: "downstream",
          toolName: "needs_confirmation",
          arguments: { operation }
        }
      });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      assert.deepEqual(result.structuredContent, {
        operation,
        confirmed: true,
        state: "downstream-state-v1"
      });
    }, protocolVersion);
  });
}

test("gateway proxies a modern upstream call to an MCP 2025-11-25 downstream service", async () => {
  await withProxy(async ({ client }) => {
    const result = await client.callTool({
      name: "gateway_call_tool",
      arguments: {
        serviceId: "downstream",
        toolName: "arbitrary_json",
        arguments: {}
      }
    });
    assert.deepEqual(result.structuredContent, [1, true, null, { nested: "value" }]);
  }, () => undefined, "2025-11-25");
});

test("gateway rejects MRTR when the modern upstream omits the required capability", async () => {
  await withProxy(async ({ gatewayUrl }) => {
    const response = await fetch(gatewayUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tools/call",
        "Mcp-Name": "gateway_call_tool"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 44,
        method: "tools/call",
        params: {
          name: "gateway_call_tool",
          arguments: {
            serviceId: "downstream",
            toolName: "needs_confirmation",
            arguments: { operation: "must-not-auto-confirm" }
          },
          _meta: {
            [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
            [CLIENT_INFO_META_KEY]: { name: "no-capability-test", version: "1.0.0" },
            [CLIENT_CAPABILITIES_META_KEY]: {}
          }
        }
      })
    });
    const failure = await response.json() as { error?: { code?: number } };
    assert.equal(failure.error?.code, -32021, JSON.stringify({ status: response.status, failure }));
    assert.equal(response.status, 400);
  });
});

test("gateway preserves arbitrary JSON structuredContent from a downstream tool", async () => {
  await withProxy(async ({ client }) => {
    const result = await client.callTool({
      name: "gateway_call_tool",
      arguments: {
        serviceId: "downstream",
        toolName: "arbitrary_json",
        arguments: {}
      }
    });
    assert.deepEqual(result.structuredContent, [1, true, null, { nested: "value" }]);
  });
});

test("gateway uses the SDK to mirror downstream x-mcp-header parameters", async () => {
  await withProxy(async ({ client }) => {
    const result = await client.callTool({
      name: "gateway_call_tool",
      arguments: {
        serviceId: "downstream",
        toolName: "header_mirror",
        arguments: { trace: "追踪-123" }
      }
    });
    assert.deepEqual(result.structuredContent, {
      argument: "追踪-123",
      header: "=?base64?6L+96LiqLTEyMw==?="
    });
  });
});

test("gateway propagates upstream cancellation to the active downstream HTTP call", async () => {
  let downstreamCancelled = false;
  await withProxy(async ({ client }) => {
    const abortController = new AbortController();
    const pending = client.callTool({
      name: "gateway_call_tool",
      arguments: {
        serviceId: "downstream",
        toolName: "wait_for_cancel",
        arguments: {}
      }
    }, { signal: abortController.signal });
    setTimeout(() => abortController.abort(), 50);
    await assert.rejects(pending);
    await waitUntil(() => downstreamCancelled, 2_000);
    assert.equal(downstreamCancelled, true);
  }, (cancelled) => {
    downstreamCancelled = cancelled;
  });
});

async function withProxy(
  assertion: (context: { client: Client; gatewayUrl: string }) => Promise<void>,
  onDownstreamCancelled: (cancelled: boolean) => void = () => undefined,
  downstreamProtocolVersion: "2026-07-28" | "2025-11-25" = "2026-07-28"
): Promise<void> {
  const downstream = await startDownstream(onDownstreamCancelled, downstreamProtocolVersion);
  const tempDirectory = await mkdtemp(join(tmpdir(), "mcp-gateway-proxy-"));
  const configPath = join(tempDirectory, "config.json");
  await writeFile(configPath, JSON.stringify({
    services: [
      {
        serviceId: "downstream",
        name: "Downstream",
        transport: {
          type: "http",
          url: downstream.url
        }
      }
    ]
  }), "utf8");

  const logger = new Logger();
  const registry = new ServiceRegistry(configPath, new ConfigLoader(), logger);
  await registry.initialize();
  const engine = new McpGatewayEngine(registry, logger);
  const gateway = new StreamableHttpGatewayServer({
    enable: true,
    host: "127.0.0.1",
    port: 0,
    path: "/mcp"
  }, engine, logger);
  await gateway.start();

  const client = new Client({ name: "proxy-test", version: "1.0.0" }, {
    capabilities: { elicitation: { form: {} } },
    versionNegotiation: { mode: { pin: "2026-07-28" } },
    supportedProtocolVersions: ["2026-07-28"],
    inputRequired: { autoFulfill: false }
  });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(gateway.url)));
    await assertion({ client, gatewayUrl: gateway.url });
  } finally {
    await client.close().catch(() => undefined);
    await gateway.stop();
    await registry.dispose();
    await downstream.close();
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

async function withLegacyInMemoryProxy(
  assertion: (context: { client: Client }) => Promise<void>,
  protocolVersion: "2025-11-25" | "2025-06-18"
): Promise<void> {
  const downstream = await startDownstream(() => undefined);
  const tempDirectory = await mkdtemp(join(tmpdir(), "mcp-gateway-legacy-proxy-"));
  const configPath = join(tempDirectory, "config.json");
  await writeFile(configPath, JSON.stringify({
    services: [
      {
        serviceId: "downstream",
        name: "Downstream",
        transport: {
          type: "http",
          url: downstream.url
        }
      }
    ]
  }), "utf8");

  const logger = new Logger();
  const registry = new ServiceRegistry(configPath, new ConfigLoader(), logger);
  await registry.initialize();
  const gatewayServer = createGatewayMcpServer(new McpGatewayEngine(registry, logger));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: `${protocolVersion}-proxy-test`, version: "1.0.0" }, {
    capabilities: { elicitation: { form: {} } },
    supportedProtocolVersions: [protocolVersion]
  });
  client.setRequestHandler("elicitation/create", async () => ({
    action: "accept",
    content: { confirmed: true }
  }));

  try {
    await gatewayServer.connect(serverTransport);
    await client.connect(clientTransport);
    await assertion({ client });
  } finally {
    await client.close().catch(() => undefined);
    await gatewayServer.close().catch(() => undefined);
    await registry.dispose();
    await downstream.close();
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

async function startDownstream(
  onCancelled: (cancelled: boolean) => void,
  protocolVersion: "2026-07-28" | "2025-11-25" = "2026-07-28"
): Promise<{ url: string; close: () => Promise<void> }> {
  const handler = createMcpHandler(() => {
    const server = new McpServer(
      { name: "proxy-downstream", version: "1.0.0" },
      {
        supportedProtocolVersions: [protocolVersion],
        ...(protocolVersion === "2026-07-28"
          ? {
              cacheHints: {
                "server/discover": { ttlMs: 1_000, cacheScope: "private" as const },
                "tools/list": { ttlMs: 1_000, cacheScope: "private" as const }
              }
            }
          : {})
      }
    );
    server.registerTool(
      "needs_confirmation",
      {
        inputSchema: z.object({ operation: z.string() })
      },
      async ({ operation }, context) => {
        const response = acceptedContent<{ confirmed: boolean }>(context.mcpReq.inputResponses, "confirm");
        if (!response) {
          return inputRequired({
            inputRequests: {
              confirm: inputRequired.elicit({
                message: `Confirm ${operation}`,
                requestedSchema: z.object({ confirmed: z.boolean() })
              })
            },
            requestState: "downstream-state-v1"
          });
        }
        return {
          content: [{ type: "text", text: `${operation}:${String(response.confirmed)}` }],
          structuredContent: {
            operation,
            confirmed: response.confirmed,
            state: context.mcpReq.requestState<string>()
          }
        };
      }
    );
    server.registerTool("arbitrary_json", { inputSchema: z.object({}) }, async () => ({
      content: [{ type: "text", text: "arbitrary" }],
      structuredContent: [1, true, null, { nested: "value" }]
    }));
    server.registerTool(
      "header_mirror",
      {
        inputSchema: fromJsonSchema<{ trace: string }>({
          type: "object",
          properties: {
            trace: {
              type: "string",
              "x-mcp-header": "X-Trace-Value"
            }
          },
          required: ["trace"],
          additionalProperties: false
        } as never)
      },
      async ({ trace }, context) => ({
        content: [{ type: "text", text: trace }],
        structuredContent: {
          argument: trace,
          header: context.http?.req?.headers.get("mcp-param-x-trace-value")
        }
      })
    );
    server.registerTool("wait_for_cancel", { inputSchema: z.object({}) }, async (_args, context) => {
      await new Promise<void>((resolveWait) => {
        context.mcpReq.signal.addEventListener("abort", () => {
          onCancelled(true);
          resolveWait();
        }, { once: true });
      });
      return { content: [{ type: "text", text: "cancelled" }] };
    });
    return server;
  }, protocolVersion === "2026-07-28"
    ? { legacy: "reject", responseMode: "sse" }
    : { legacy: "stateless" });
  const nodeHandler = toNodeHandler(handler);
  const server = http.createServer((request, response) => void nodeHandler(request, response));
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (typeof address !== "object" || !address) {
    throw new Error("Downstream test server did not expose a TCP address.");
  }
  const port = address.port;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: async () => {
      await handler.close();
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => error ? rejectClose(error) : resolveClose());
        server.closeAllConnections();
      });
    }
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for cancellation propagation.");
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
}
