import test from "node:test";
import assert from "node:assert/strict";
import { McpGatewayEngine } from "../src/gateway-engine.ts";
import { Logger } from "../src/logger.ts";
import type { ServiceRuntimeSnapshot, ToolDefinition } from "../src/types.ts";

test("McpGatewayEngine returns a compact tool schema payload", () => {
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
  const engine = createGatewayEngineForTest(registry);

  const result = engine.getToolSchema({
    serviceId: "playwright",
    toolName: "browser_tabs"
  }) as { structuredContent?: Record<string, unknown> };

  assert.deepEqual(result.structuredContent, {
    inputSchema: tool.inputSchema,
    outputSchema: null
  });
});

test("McpGatewayEngine returns a minimal service list payload", () => {
  const registry = createRegistryStub({
    tools: []
  });
  const engine = createGatewayEngineForTest(registry);

  const result = engine.handleToolCall({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
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

test("McpGatewayEngine filters listed tools by tool name keyword", () => {
  const registry = createRegistryStub({
    tools: [
      {
        name: "database_list_tables",
        description: "List database tables",
        inputSchema: null,
        outputSchema: null
      },
      {
        name: "database_describe_table",
        description: "Describe one table",
        inputSchema: null,
        outputSchema: null
      },
      {
        name: "gitea_search_issues",
        description: "Search issues",
        inputSchema: null,
        outputSchema: null
      }
    ]
  });
  const engine = createGatewayEngineForTest(registry);

  const result = engine.listTools({
    serviceId: "playwright",
    toolName: "table"
  }) as { structuredContent?: { tools?: Array<Record<string, unknown>> } };

  assert.deepEqual(result.structuredContent, {
    tools: [
      {
        name: "database_list_tables",
        description: "List database tables"
      },
      {
        name: "database_describe_table",
        description: "Describe one table"
      }
    ]
  });
});

test("McpGatewayEngine filters listed tools by multiple tool name keywords", () => {
  const registry = createRegistryStub({
    tools: [
      {
        name: "database_list_tables",
        description: "List database tables",
        inputSchema: null,
        outputSchema: null
      },
      {
        name: "database_describe_table",
        description: "Describe one table",
        inputSchema: null,
        outputSchema: null
      },
      {
        name: "gitea_search_issues",
        description: "Search issues",
        inputSchema: null,
        outputSchema: null
      }
    ]
  });
  const engine = createGatewayEngineForTest(registry);

  const result = engine.listTools({
    serviceId: "playwright",
    toolName: ["describe", "issues"]
  }) as { structuredContent?: { tools?: Array<Record<string, unknown>> } };

  assert.deepEqual(result.structuredContent, {
    tools: [
      {
        name: "database_describe_table",
        description: "Describe one table"
      },
      {
        name: "gitea_search_issues",
        description: "Search issues"
      }
    ]
  });
});

test("McpGatewayEngine forwards downstream tool results without extra gateway wrapping", async () => {
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
  const engine = createGatewayEngineForTest(registry);

  const result = await engine.callDownstreamTool({
    serviceId: "demo",
    toolName: "echo",
    arguments: {
      message: "ok"
    }
  });

  assert.deepEqual(result, downstreamResult);
});

test("McpGatewayEngine waits for the startup barrier before handling tool calls", async () => {
  let releaseBarrier: (() => void) | null = null;
  const startupBarrier = new Promise<void>((resolve) => {
    releaseBarrier = resolve;
  });
  let called = false;

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
  const engine = createGatewayEngineForTest(registry);
  engine.setStartupBarrier(startupBarrier);

  let settled = false;
  const pending = engine.handleRequest({
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
  }).then((response) => {
    settled = true;
    return response;
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(called, false);
  assert.equal(settled, false);

  releaseBarrier?.();
  const response = await pending;

  assert.equal(called, true);
  assert.equal(response?.id, 1);
});

test("McpGatewayEngine exposes a compact manageService payload", async () => {
  const registry = createRegistryStub({
    manageService: async () => ({
      serviceId: "idea",
      action: "reconnect",
      enabled: true,
      available: false
    })
  });
  const engine = createGatewayEngineForTest(registry);

  const result = await engine.manageService({
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
  listTools: (serviceId: string, toolName?: string | string[]) => ToolDefinition[];
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
    listTools: (serviceId: string, toolName?: string | string[]) => {
      if (serviceId !== snapshot.config.serviceId) {
        return [];
      }

      const keywords = (Array.isArray(toolName) ? toolName : [toolName])
        .filter((value): value is string => typeof value === "string" && value.trim() !== "")
        .map((value) => value.toLowerCase());

      if (keywords.length === 0) {
        return snapshot.metadata.tools;
      }

      return snapshot.metadata.tools.filter((tool) => {
        const normalizedName = tool.name.toLowerCase();
        return keywords.some((keyword) => normalizedName.includes(keyword));
      });
    },
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

function createGatewayEngineForTest(registry: ReturnType<typeof createRegistryStub>): McpGatewayEngine {
  return new McpGatewayEngine(registry as never, new Logger());
}
