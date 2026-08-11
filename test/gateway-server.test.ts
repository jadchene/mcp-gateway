import test from "node:test";
import assert from "node:assert/strict";
import { buildGatewayTools, McpGatewayEngine } from "../src/gateway-engine.ts";
import { Logger } from "../src/logger.ts";
import { matchesToolNamePattern } from "../src/tool-name-pattern.ts";
import type { ServiceRuntimeSnapshot, ToolDefinition } from "../src/types.ts";

test("matchesToolNamePattern supports exact names and glob wildcards", () => {
  assert.equal(matchesToolNamePattern("deploy", "deploy"), true);
  assert.equal(matchesToolNamePattern("deploy_prod", "deploy*"), true);
  assert.equal(matchesToolNamePattern("delete_file", "*_file"), true);
  assert.equal(matchesToolNamePattern("tool_1", "tool_?"), true);
  assert.equal(matchesToolNamePattern("tool_12", "tool_?"), false);
  assert.equal(matchesToolNamePattern("tool_😀", "tool_?"), true);
  assert.equal(matchesToolNamePattern("anything", "**"), true);
  assert.equal(matchesToolNamePattern("", "*"), true);
  assert.equal(matchesToolNamePattern("deploy", "DEPLOY"), false);
  assert.equal(matchesToolNamePattern("tool.name", "tool.name"), true);
  assert.equal(matchesToolNamePattern("toolXname", "tool.name"), false);
});

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
    toolName: ["browser_tabs"]
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

test("McpGatewayEngine rejects invalid toolName values for schema lookup", () => {
  const engine = createGatewayEngineForTest(createRegistryStub({ tools: [] }));

  assert.throws(
    () => engine.getToolSchema({
      serviceId: "playwright",
      toolName: "browser_tabs"
    }),
    /toolName.*non-empty string array/
  );
  assert.throws(
    () => engine.getToolSchema({
      serviceId: "playwright",
      toolName: []
    }),
    /toolName.*non-empty string array/
  );
  assert.throws(
    () => engine.getToolSchema({
      serviceId: "playwright",
      toolName: ["browser_tabs", "browser_tabs"]
    }),
    /toolName.*unique non-empty string array/
  );
  assert.throws(
    () => engine.getToolSchema({
      serviceId: "playwright",
      toolName: [" "]
    }),
    /toolName.*unique non-empty string array/
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

  const result = engine.executeTool("gateway_list_services", {}) as Promise<{
    structuredContent?: { services?: Array<Record<string, unknown>> };
  }>;

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

test("McpGatewayEngine advertises description keyword filtering on gateway_list_tools", () => {
  const tool = buildGatewayTools().find((candidate) => candidate.name === "gateway_list_tools") as {
    description?: string;
    inputSchema?: {
      properties?: Record<string, unknown>;
    };
  } | undefined;

  assert.equal(tool?.description, "Lists downstream tools by case-insensitive name or description substring filters and optionally includes each matching schema.");
  assert.deepEqual(tool?.inputSchema?.properties?.toolName, {
    type: "array",
    description: "Optional unique name substrings. Matching is case-insensitive; any name or description keyword may match.",
    minItems: 1,
    uniqueItems: true,
    items: {
      type: "string",
      minLength: 1,
      pattern: "\\S"
    }
  });
  assert.deepEqual(tool?.inputSchema?.properties?.desc, {
    type: "array",
    description: "Optional unique literal description substrings. Matching is case-insensitive and may hit negative guidance, so inspect candidate descriptions. Name and description filters use OR.",
    minItems: 1,
    uniqueItems: true,
    items: {
      type: "string",
      minLength: 1,
      pattern: "\\S"
    }
  });
});

test("McpGatewayEngine advertises array-only tool names for gateway_get_tool_schema", () => {
  const tool = buildGatewayTools().find((candidate) => candidate.name === "gateway_get_tool_schema") as {
    description?: string;
    inputSchema?: {
      properties?: Record<string, unknown>;
    };
  } | undefined;

  assert.equal(tool?.description, "Returns schemas for exact, case-sensitive downstream tool names, keyed by name; the whole request fails when any name is unknown.");
  assert.deepEqual(tool?.inputSchema?.properties?.toolName, {
    type: "array",
    description: "Unique exact, case-sensitive downstream tool names returned by gateway_list_tools.",
    minItems: 1,
    uniqueItems: true,
    items: {
      type: "string",
      minLength: 1,
      pattern: "\\S"
    }
  });
});

test("McpGatewayEngine advertises stable output schemas and leaves forwarded results open", () => {
  const tools = Object.fromEntries(buildGatewayTools().map((tool) => [tool.name, tool]));
  const fixedOutputTools = [
    "gateway_list_services",
    "gateway_get_service",
    "gateway_list_tools",
    "gateway_get_tool_schema",
    "gateway_manage_service"
  ];

  for (const toolName of fixedOutputTools) {
    assert.equal(typeof tools[toolName]?.outputSchema, "object", `${toolName} should expose outputSchema`);
  }
  assert.equal(tools.gateway_call_tool?.outputSchema, undefined);

  const serviceOutput = tools.gateway_get_service?.outputSchema as { required?: string[] };
  assert.deepEqual(serviceOutput.required, [
    "serviceId",
    "name",
    "description",
    "available",
    "lastError",
    "lastConnectedAt",
    "protocolVersion",
    "serverInfo"
  ]);

  const schemaOutput = tools.gateway_get_tool_schema?.outputSchema as {
    properties?: {
      schemas?: Record<string, unknown>;
    };
  };
  assert.equal(schemaOutput.properties?.schemas?.minProperties, 1);
});

test("McpGatewayEngine advertises non-blank identifiers and explicit side effects", () => {
  const tools = Object.fromEntries(buildGatewayTools().map((tool) => [tool.name, tool]));
  const getService = tools.gateway_get_service as {
    description?: string;
    inputSchema?: { properties?: Record<string, unknown> };
  };
  const manageService = tools.gateway_manage_service as {
    description?: string;
    inputSchema?: { properties?: Record<string, unknown> };
  };
  const callTool = tools.gateway_call_tool as {
    description?: string;
    inputSchema?: { properties?: Record<string, unknown> };
  };

  assert.equal(getService.description, "Returns one downstream service's configured identity, availability, recent error and connection time, protocol version, and server information.");
  assert.deepEqual(getService.inputSchema?.properties?.serviceId, {
    type: "string",
    description: "Logical downstream service identifier returned by gateway_list_services.",
    minLength: 1,
    pattern: "\\S"
  });
  assert.equal(manageService.description, "Reconnects a downstream service without changing config, or persistently enables or disables it in the gateway config and reloads the registry.");
  assert.deepEqual(manageService.inputSchema?.properties?.action, {
    type: "string",
    description: "reconnect refreshes the connection and metadata without changing config; enable and disable persist the enable flag and reload the registry.",
    enum: ["reconnect", "enable", "disable"]
  });
  assert.equal(callTool.description, "Calls one exact downstream tool and forwards its result unchanged. The downstream tool may have read or write side effects; inspect its schema and service rules first.");
  assert.deepEqual(callTool.inputSchema?.properties?.toolName, {
    type: "string",
    description: "Exact, case-sensitive downstream tool name returned by gateway_list_tools.",
    minLength: 1,
    pattern: "\\S"
  });
  assert.deepEqual(callTool.inputSchema?.properties?.arguments, {
    type: "object",
    description: "Required arguments object built from the downstream inputSchema. Pass an empty object when the tool has no arguments."
  });
});

test("McpGatewayEngine rejects blank service and exact tool identifiers at runtime", async () => {
  const engine = createGatewayEngineForTest(createRegistryStub({}));

  assert.throws(
    () => engine.getService({ serviceId: "   " }),
    /serviceId.*must be a string/
  );
  await assert.rejects(
    () => engine.callDownstreamTool({
      serviceId: "demo",
      toolName: "   ",
      arguments: {}
    }),
    /toolName.*must be a string/
  );
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
    toolName: ["table"]
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

test("McpGatewayEngine rejects invalid toolName values for tool listing", () => {
  const engine = createGatewayEngineForTest(createRegistryStub({ tools: [] }));

  assert.throws(
    () => engine.listTools({
      serviceId: "playwright",
      toolName: "table"
    }),
    /toolName.*non-empty string array/
  );
  assert.throws(
    () => engine.listTools({
      serviceId: "playwright",
      toolName: []
    }),
    /toolName.*non-empty string array/
  );
  assert.throws(
    () => engine.listTools({
      serviceId: "playwright",
      toolName: ["table", "table"]
    }),
    /toolName.*unique non-empty string array/
  );
  assert.throws(
    () => engine.listTools({
      serviceId: "playwright",
      toolName: [" "]
    }),
    /toolName.*unique non-empty string array/
  );
});

test("McpGatewayEngine filters listed tools by description keywords", () => {
  const registry = createRegistryStub({
    tools: [
      {
        name: "database_list_tables",
        description: "List configured database objects",
        inputSchema: null,
        outputSchema: null
      },
      {
        name: "database_describe_table",
        description: "Inspect columns and primary keys",
        inputSchema: null,
        outputSchema: null
      },
      {
        name: "database_ping",
        description: undefined,
        inputSchema: null,
        outputSchema: null
      }
    ]
  });
  const engine = createGatewayEngineForTest(registry);

  const result = engine.listTools({
    serviceId: "playwright",
    desc: ["BASE OBJ", "MARY KE"]
  }) as { structuredContent?: { tools?: Array<Record<string, unknown>> } };

  assert.deepEqual(result.structuredContent, {
    tools: [
      {
        name: "database_list_tables",
        description: "List configured database objects"
      },
      {
        name: "database_describe_table",
        description: "Inspect columns and primary keys"
      }
    ]
  });
});

test("McpGatewayEngine combines name and description filters with OR", () => {
  const registry = createRegistryStub({
    tools: [
      {
        name: "database_list_tables",
        description: "List configured objects",
        inputSchema: null,
        outputSchema: null
      },
      {
        name: "database_describe_table",
        description: "Inspect table columns",
        inputSchema: null,
        outputSchema: null
      },
      {
        name: "gitea_search_issues",
        description: "Search repository tickets",
        inputSchema: null,
        outputSchema: null
      }
    ]
  });
  const engine = createGatewayEngineForTest(registry);

  const result = engine.listTools({
    serviceId: "playwright",
    toolName: ["describe"],
    desc: ["POSITORY TICK"]
  }) as { structuredContent?: { tools?: Array<Record<string, unknown>> } };

  assert.deepEqual(result.structuredContent?.tools?.map((tool) => tool.name), [
    "database_describe_table",
    "gitea_search_issues"
  ]);
});

test("McpGatewayEngine rejects invalid desc arguments", () => {
  const engine = createGatewayEngineForTest(createRegistryStub({ tools: [] }));

  assert.throws(
    () => engine.listTools({
      serviceId: "playwright",
      desc: "database"
    }),
    /desc.*non-empty string array/
  );
  assert.throws(
    () => engine.listTools({
      serviceId: "playwright",
      desc: []
    }),
    /desc.*non-empty string array/
  );
  assert.throws(
    () => engine.listTools({
      serviceId: "playwright",
      desc: ["database", "database"]
    }),
    /desc.*unique non-empty string array/
  );
  assert.throws(
    () => engine.listTools({
      serviceId: "playwright",
      desc: [" "]
    }),
    /desc.*unique non-empty string array/
  );
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

test("McpGatewayEngine requires an explicit downstream arguments object", async () => {
  const engine = createGatewayEngineForTest(createRegistryStub({}));

  await assert.rejects(
    () => engine.callDownstreamTool({
      serviceId: "demo",
      toolName: "echo"
    }),
    /arguments.*must be an object/
  );
});

test("McpGatewayEngine rejects disabled tools before confirmation or downstream invocation", async () => {
  let called = false;
  const engine = createGatewayEngineForTest(createRegistryStub({
    config: {
      disabledTools: ["danger_*"],
      confirmationRequiredTools: ["*"]
    },
    callTool: async () => {
      called = true;
      return {
        result: { content: [] },
        durationMs: 0,
        restartAttempts: 0
      };
    }
  }));

  await assert.rejects(
    () => engine.callDownstreamTool({
      serviceId: "playwright",
      toolName: "danger_delete",
      arguments: {}
    }),
    /is disabled by gateway configuration/
  );
  assert.equal(called, false);
});

test("McpGatewayEngine resumes gateway confirmation state after a config policy reload", async () => {
  let called = false;
  const registry = createRegistryStub({
    config: { confirmationRequiredTools: ["deploy"] },
    callTool: async () => {
      called = true;
      return {
        result: { content: [] },
        durationMs: 0,
        restartAttempts: 0
      };
    }
  });
  const engine = createGatewayEngineForTest(registry);
  const args = {
    serviceId: "playwright",
    toolName: "deploy",
    arguments: {}
  };
  const first = await engine.callDownstreamTool(args, {
    clientCapabilities: { elicitation: { form: {} } }
  }) as { requestState?: string };
  assert.ok(first.requestState);

  const snapshot = registry.getService("playwright");
  assert.ok(snapshot);
  snapshot.config.confirmationRequiredTools = [];

  const completed = await engine.callDownstreamTool(args, {
    clientCapabilities: { elicitation: { form: {} } },
    requestState: first.requestState,
    inputResponses: {
      confirm: { action: "accept", content: { decision: "yes" } }
    }
  });
  assert.deepEqual(completed, { content: [] });
  assert.equal(called, true);
});

test("McpGatewayEngine waits for the startup barrier before handling tool calls", async () => {
  let releaseBarrier: () => void = () => undefined;
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
  const pending = engine.executeTool("gateway_call_tool", {
    serviceId: "demo",
    toolName: "echo",
    arguments: {}
  }).then((response) => {
    settled = true;
    return response;
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(called, false);
  assert.equal(settled, false);

  releaseBarrier();
  const response = await pending;

  assert.equal(called, true);
  assert.deepEqual(response, { content: [] });
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
  config?: Partial<ServiceRuntimeSnapshot["config"]>;
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
  listTools: (serviceId: string, toolName?: string[], desc?: string[]) => ToolDefinition[];
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
      enable: true,
      name: "Playwright",
      description: "Browser automation MCP service.",
      transport: {
        type: "stdio",
        command: "node"
      },
      ...overrides.config
    },
    metadata: {
      protocolVersion: "2025-06-18",
      protocolEra: "legacy",
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
    listTools: (serviceId: string, toolName?: string[], desc?: string[]) => {
      if (serviceId !== snapshot.config.serviceId) {
        return [];
      }

      const nameKeywords = (toolName ?? [])
        .filter((value) => value.trim() !== "")
        .map((value) => value.toLowerCase());
      const descriptionKeywords = (desc ?? [])
        .filter((value) => value.trim() !== "")
        .map((value) => value.toLowerCase());

      if (nameKeywords.length === 0 && descriptionKeywords.length === 0) {
        return snapshot.metadata.tools;
      }

      return snapshot.metadata.tools.filter((tool) => {
        const normalizedName = tool.name.toLowerCase();
        const normalizedDescription = tool.description?.toLowerCase() ?? "";
        return nameKeywords.some((keyword) => normalizedName.includes(keyword))
          || descriptionKeywords.some((keyword) => normalizedDescription.includes(keyword));
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
