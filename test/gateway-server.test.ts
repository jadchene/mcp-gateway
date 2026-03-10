import test from "node:test";
import assert from "node:assert/strict";
import { GatewayServer } from "../src/gateway-server.ts";
import { Logger } from "../src/logger.ts";
import type { ServiceRuntimeSnapshot, ToolDefinition } from "../src/types.ts";

test("GatewayServer returns a compact tool schema payload", () => {
  const tool: ToolDefinition = {
    name: "browser_tabs",
    description: "List tabs",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string" }
      },
      required: ["action"]
    },
    outputSchema: null
  };
  const registry = createRegistryStub({
    tools: [tool]
  });
  const server = createGatewayServerForTest(registry);

  const result = (server as unknown as { getToolSchema: (args: Record<string, unknown>) => unknown }).getToolSchema({
    serviceId: "playwright",
    toolName: "browser_tabs"
  }) as { structuredContent?: Record<string, unknown> };

  assert.deepEqual(result.structuredContent, {
    inputSchema: tool.inputSchema,
    outputSchema: null
  });
});

test("GatewayServer returns a minimal service list payload", () => {
  const registry = createRegistryStub({
    tools: []
  });
  const server = createGatewayServerForTest(registry);

  const result = (server as unknown as { handleToolCall: (request: { params: Record<string, unknown> }) => Promise<unknown> }).handleToolCall({
    params: {
      name: "gateway.listServices",
      arguments: {}
    }
  }) as Promise<{ structuredContent?: { services?: Array<Record<string, unknown>> } }>;

  return result.then((payload) => {
    assert.deepEqual(payload.structuredContent, {
      services: [
        {
          serviceId: "playwright",
          description: "Browser automation MCP service.",
          available: true
        }
      ]
    });
  });
});

test("GatewayServer forwards downstream tool results without extra gateway wrapping", async () => {
  const downstreamResult = {
    content: [
      {
        type: "text",
        text: "ok"
      }
    ],
    structuredContent: {
      echoed: "ok"
    }
  };

  const registry = createRegistryStub({
    callTool: async () => ({
      result: downstreamResult,
      durationMs: 1,
      restartAttempts: 0
    })
  });
  const server = createGatewayServerForTest(registry);

  const result = await (server as unknown as { callDownstreamTool: (args: Record<string, unknown>) => Promise<unknown> }).callDownstreamTool({
    serviceId: "demo",
    toolName: "echo",
    arguments: {
      message: "ok"
    }
  });

  assert.deepEqual(result, downstreamResult);
});

test("GatewayServer waits for the startup barrier before handling tool calls", async () => {
  let releaseBarrier: (() => void) | null = null;
  const startupBarrier = new Promise<void>((resolve) => {
    releaseBarrier = resolve;
  });
  let called = false;
  let wroteResponse = false;

  const registry = createRegistryStub({
    callTool: async () => {
      called = true;
      return {
        result: {
          content: []
        },
        durationMs: 0,
        restartAttempts: 0
      };
    }
  });
  const server = createGatewayServerForTest(registry) as GatewayServer & {
    startupBarrier: Promise<void>;
    writer: { write: (message: unknown) => void };
    handleRequest: (request: {
      jsonrpc: "2.0";
      id: number;
      method: string;
      params: Record<string, unknown>;
    }) => Promise<void>;
  };

  server.startupBarrier = startupBarrier;
  server.writer = {
    write: () => {
      wroteResponse = true;
    }
  };

  const pending = server.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "gateway.callTool",
      arguments: {
        serviceId: "demo",
        toolName: "echo",
        arguments: {}
      }
    }
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(called, false);
  assert.equal(wroteResponse, false);

  releaseBarrier?.();
  await pending;

  assert.equal(called, true);
  assert.equal(wroteResponse, true);
});

test("GatewayServer exposes a compact manageService payload", async () => {
  const registry = createRegistryStub({
    manageService: async () => ({
      serviceId: "idea",
      action: "reconnect",
      enabled: true,
      available: false
    })
  });
  const server = createGatewayServerForTest(registry);

  const result = await (server as unknown as { manageService: (args: Record<string, unknown>) => Promise<{ structuredContent?: Record<string, unknown> }> }).manageService({
    serviceId: "idea",
    action: "reconnect"
  });

  assert.deepEqual(result.structuredContent, {
    serviceId: "idea",
    action: "reconnect",
    enabled: true,
    available: false
  });
});

function createRegistryStub(overrides: {
  tools?: ToolDefinition[];
  callTool?: (serviceId: string, toolName: string, args: Record<string, unknown>) => Promise<{
    result: unknown;
    durationMs: number;
    restartAttempts: number;
  }>;
  manageService?: (serviceId: string, action: "reconnect" | "enable" | "disable") => Promise<{
    serviceId: string;
    action: "reconnect" | "enable" | "disable";
    enabled: boolean;
    available: boolean;
  }>;
}): {
  listServices: () => ServiceRuntimeSnapshot[];
  getService: (serviceId: string) => ServiceRuntimeSnapshot | null;
  listTools: (serviceId: string) => ToolDefinition[];
  getTool: (serviceId: string, toolName: string) => ToolDefinition | null;
  callTool: (serviceId: string, toolName: string, args: Record<string, unknown>) => Promise<{
    result: unknown;
    durationMs: number;
    restartAttempts: number;
  }>;
  manageService: (serviceId: string, action: "reconnect" | "enable" | "disable") => Promise<{
    serviceId: string;
    action: "reconnect" | "enable" | "disable";
    enabled: boolean;
    available: boolean;
  }>;
} {
  const snapshot: ServiceRuntimeSnapshot = {
    config: {
      serviceId: "playwright",
      name: "Playwright",
      description: "Browser automation MCP service.",
      transport: {
        type: "stdio",
        command: "node"
      }
    },
    metadata: {
      protocolVersion: "2025-06-18",
      serverInfo: null,
      tools: overrides.tools ?? [],
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
    getService: (serviceId: string) => serviceId === snapshot.config.serviceId ? snapshot : null,
    listTools: (serviceId: string) => serviceId === snapshot.config.serviceId ? snapshot.metadata.tools : [],
    getTool: (serviceId: string, toolName: string) => (
      serviceId === snapshot.config.serviceId
        ? snapshot.metadata.tools.find((tool) => tool.name === toolName) ?? null
        : null
    ),
    callTool: overrides.callTool ?? (async () => ({
      result: {},
      durationMs: 0,
      restartAttempts: 0
    })),
    manageService: overrides.manageService ?? (async (serviceId, action) => ({
      serviceId,
      action,
      enabled: action !== "disable",
      available: false
    }))
  };
}

function createGatewayServerForTest(registry: ReturnType<typeof createRegistryStub>): GatewayServer {
  const server = Object.create(GatewayServer.prototype) as GatewayServer & {
    registry: ReturnType<typeof createRegistryStub>;
    logger: Logger;
    startupBarrier: Promise<void>;
  };
  server.registry = registry;
  server.logger = new Logger();
  server.startupBarrier = Promise.resolve();
  return server;
}
