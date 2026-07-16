import test from "node:test";
import assert from "node:assert/strict";
import { buildGatewayTools, McpGatewayEngine } from "../src/gateway-engine.ts";
import { Logger } from "../src/logger.ts";
import type { ServiceRuntimeSnapshot, ToolDefinition } from "../src/types.ts";

test("McpGatewayEngine returns a tool-name-keyed schema payload for one tool", () => {
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
    schemas: {
      browser_tabs: {
        inputSchema: tool.inputSchema,
        outputSchema: null
      }
    }
  });
});

test("McpGatewayEngine returns schemas for multiple tool names", () => {
  const tools: ToolDefinition[] = [
    {
      name: "browser_tabs",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string" }
        }
      },
      outputSchema: null
    },
    {
      name: "browser_navigate",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string" }
        },
        required: ["url"]
      },
      outputSchema: {
        type: "object",
        properties: {
          title: { type: "string" }
        }
      }
    }
  ];
  const engine = createGatewayEngineForTest(createRegistryStub({ tools }));

  const result = engine.getToolSchema({
    serviceId: "playwright",
    toolName: ["browser_tabs", "browser_navigate"]
  }) as { structuredContent?: Record<string, unknown> };

  assert.deepEqual(result.structuredContent, {
    schemas: {
      browser_tabs: {
        inputSchema: tools[0]?.inputSchema,
        outputSchema: null
      },
      browser_navigate: {
        inputSchema: tools[1]?.inputSchema,
        outputSchema: tools[1]?.outputSchema
      }
    }
  });
});

test("McpGatewayEngine rejects an empty toolName array for schema lookup", () => {
  const engine = createGatewayEngineForTest(createRegistryStub({ tools: [] }));

  assert.throws(
    () => engine.getToolSchema({
      serviceId: "playwright",
      toolName: []
    }),
    /toolName.*non-empty string array/
  );
});

test("McpGatewayEngine rejects a batch schema lookup when any tool is unknown", () => {
  const engine = createGatewayEngineForTest(createRegistryStub({
    tools: [
      {
        name: "browser_tabs",
        inputSchema: { type: "object" },
        outputSchema: null
      }
    ]
  }));

  assert.throws(
    () => engine.getToolSchema({
      serviceId: "playwright",
      toolName: ["browser_tabs", "browser_missing"]
    }),
    /Unknown tool 'browser_missing'/
  );
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
      name: "gateway_list_services",
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

test("McpGatewayEngine advertises includeSchema on gateway_list_tools", () => {
  const tool = buildGatewayTools().find((candidate) => candidate.name === "gateway_list_tools") as {
    inputSchema?: {
      properties?: Record<string, unknown>;
    };
  } | undefined;

  assert.deepEqual(tool?.inputSchema?.properties?.includeSchema, {
    type: "boolean",
    description: "Includes inputSchema and outputSchema in every returned tool when true. Defaults to false."
  });
});

test("McpGatewayEngine advertises string or array tool names for gateway_get_tool_schema", () => {
  const tool = buildGatewayTools().find((candidate) => candidate.name === "gateway_get_tool_schema") as {
    description?: string;
    inputSchema?: {
      properties?: Record<string, unknown>;
    };
  } | undefined;

  assert.equal(tool?.description, "Returns input and output schemas for one or more downstream tools, keyed by tool name.");
  assert.deepEqual(tool?.inputSchema?.properties?.toolName, {
    anyOf: [
      {
        type: "string",
        description: "Downstream tool name.",
        minLength: 1
      },
      {
        type: "array",
        description: "Downstream tool names whose schemas should be returned.",
        minItems: 1,
        items: {
          type: "string",
          minLength: 1
        }
      }
    ]
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

test("McpGatewayEngine includes schemas for every listed tool when requested", () => {
  const tools: ToolDefinition[] = [
    {
      name: "database_list_tables",
      description: "List database tables",
      inputSchema: {
        type: "object",
        properties: {
          database: { type: "string" }
        },
        required: ["database"]
      },
      outputSchema: {
        type: "object",
        properties: {
          tables: {
            type: "array",
            items: { type: "string" }
          }
        }
      }
    },
    {
      name: "database_ping",
      description: undefined,
      inputSchema: undefined,
      outputSchema: null
    }
  ];
  const registry = createRegistryStub({ tools });
  const engine = createGatewayEngineForTest(registry);

  const result = engine.listTools({
    serviceId: "playwright",
    includeSchema: true
  }) as { structuredContent?: { tools?: Array<Record<string, unknown>> } };

  assert.deepEqual(result.structuredContent, {
    tools: [
      {
        name: "database_list_tables",
        description: "List database tables",
        inputSchema: tools[0]?.inputSchema,
        outputSchema: tools[0]?.outputSchema
      },
      {
        name: "database_ping",
        description: null,
        inputSchema: null,
        outputSchema: null
      }
    ]
  });
});

test("McpGatewayEngine rejects a non-boolean includeSchema argument", () => {
  const engine = createGatewayEngineForTest(createRegistryStub({ tools: [] }));

  assert.throws(
    () => engine.listTools({
      serviceId: "playwright",
      includeSchema: "true"
    }),
    /includeSchema.*boolean/
  );
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
      name: "gateway_call_tool",
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
