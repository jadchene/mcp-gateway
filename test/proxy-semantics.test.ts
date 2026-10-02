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
  type ElicitRequestFormParams,
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
import {
  createGatewayMcpServer,
  normalizeLegacyFormElicitationCapability
} from "../src/mcp/server.ts";
import { ServiceRegistry } from "../src/service-registry.ts";

test("gateway returns actionable input errors over modern HTTP", async () => {
  await withProxy(async ({ client }) => {
    for (const [name, args, expected] of [
      ["gateway_list_services", { serviceId: "demo" }, /Unsupported parameter "serviceId".*serviceIdFilter/],
      ["gateway_list_tools", { serviceId: "downstream", toolNameFilter: [] }, /toolNameFilter: Array must not be empty/]
    ] as const) {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, true);
      const text = result.content.filter(item => item.type === "text").map(item => item.text).join("\n");
      assert.match(text, expected);
      assert.doesNotMatch(text, /anyOf/);
    }
  });
});

test("gateway discovery returns one structured copy and retains partial schema results over HTTP", async () => {
  await withProxy(async ({ client }) => {
    const services = await client.callTool({ name: "gateway_list_services", arguments: {} });
    assert.deepEqual(services.content, []);
    assert.ok(services.structuredContent);
    const result = await client.callTool({
      name: "gateway_get_tool_schema",
      arguments: { serviceId: "downstream", toolName: ["arbitrary_json", "missing_tool"] }
    });
    assert.deepEqual(result.content, []);
    assert.notEqual(result.isError, true);
    const data = result.structuredContent as { schemas: Record<string, unknown>; errors: Record<string, string> };
    assert.ok(data.schemas.arbitrary_json);
    assert.ok(data.errors.missing_tool);
  });
});

for (const protocolVersion of ["2025-11-25", "2025-06-18"] as const) {
  test(`gateway returns structured discovery and partial schemas on ${protocolVersion}`, async () => {
    await withLegacyInMemoryProxy(async ({ client }) => {
      const services = await client.callTool({ name: "gateway_list_services", arguments: {} });
      assert.deepEqual(services.content, []);
      assert.ok(services.structuredContent);
      const result = await client.callTool({
        name: "gateway_get_tool_schema",
        arguments: { serviceId: "downstream", toolName: ["arbitrary_json", "missing_tool"] }
      });
      assert.deepEqual(result.content, []);
      assert.notEqual(result.isError, true);
      const data = result.structuredContent as { schemas: Record<string, unknown>; errors: Record<string, string> };
      assert.ok(data.schemas.arbitrary_json);
      assert.ok(data.errors.missing_tool);
    }, protocolVersion);
  });
}

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

for (const clientName of ["proxy-test", "codex-mcp-client"]) {
  test(`gateway requires configured tool confirmation for ${clientName}`, async () => {
    await withProxy(async ({ client }) => {
      const call = {
        name: "gateway_call_tool",
        arguments: {
          serviceId: "downstream",
          toolName: "arbitrary_json",
          arguments: {}
        }
      };
      const first = await client.callTool(call, { allowInputRequired: true }) as unknown as InputRequiredResult;
      assert.equal(isInputRequiredResult(first), true);
      assert.ok(first.requestState);
      assert.match(first.requestState, /^mcp-gateway-tool-confirmation-v1\./);
      assert.equal(first.inputRequests?.confirm?.method, "elicitation/create");
      const confirmationParams = first.inputRequests?.confirm?.params as {
        message?: string;
        requestedSchema?: { properties?: Record<string, unknown>; required?: string[] };
      } | undefined;
      assert.match(confirmationParams?.message ?? "", /Tool: "arbitrary_json"/);
      assert.match(confirmationParams?.message ?? "", /Arguments:\n\{\}/);
      assert.deepEqual(confirmationParams?.requestedSchema?.properties, {});
      assert.equal(confirmationParams?.requestedSchema?.required, undefined);
      const meta = (first.inputRequests?.confirm?.params as { _meta?: Record<string, unknown> })._meta;
      assert.equal(meta?.codex_strict_auto_review, clientName === "codex-mcp-client" ? true : undefined);
      if (meta) {
        assert.equal(meta.codex_request_type, "approval_request");
        assert.equal(meta.codex_approval_kind, "mcp_tool_call");
        assert.equal(meta.codex_sensitive_action, true);
        assert.equal(meta.tool_name, "arbitrary_json");
        assert.deepEqual(meta.tool_params, {});
        assert.equal(meta.persist, undefined);
      }

      const second = await client.callTool({
        ...call,
        requestState: first.requestState,
        inputResponses: {
          confirm: { action: "accept", content: {} }
        }
      } as unknown as CallToolRequestParams, { allowInputRequired: true }) as CallToolResult;
      assert.deepEqual(second.structuredContent, [1, true, null, { nested: "value" }]);
    }, () => undefined, "2026-07-28", ["arbitrary_*"], [], clientName);
  });
}

for (const clientName of ["proxy-test", "codex-mcp-client"]) {
  for (const downstreamVersion of ["2026-07-28", "2025-11-25", "2025-06-18"] as const) {
    test(`modern gateway forwards ${downstreamVersion} approvals for ${clientName}`, async () => {
      await withProxy(async ({ client }) => {
        const toolName = downstreamVersion === "2026-07-28" ? "needs_approval" : "mcp_2025_approval";
        const call = {
          name: "gateway_call_tool",
          arguments: { serviceId: "downstream", toolName, arguments: { operation: "deploy-test" } }
        };
        for (const action of ["accept", "decline", "cancel"] as const) {
          const first = await client.callTool(call, { allowInputRequired: true }) as unknown as InputRequiredResult;
          assert.equal(isInputRequiredResult(first), true);
          const [key, request] = Object.entries(first.inputRequests ?? {})[0]!;
          assertApprovalRequest(request.params, clientName, toolName, { operation: "deploy-test" });
          const result = await client.callTool({
            ...call, requestState: first.requestState,
            inputResponses: { [key]: action === "accept" ? { action, content: {} } : { action } }
          } as unknown as CallToolRequestParams, { allowInputRequired: true }) as CallToolResult;
          assert.equal(result.isError, action !== "accept");
          assert.deepEqual(result.structuredContent, { operation: "deploy-test", executed: action === "accept" });
        }
      }, () => undefined, downstreamVersion, [], [], clientName);
    });
  }
}

for (const clientName of ["proxy-test", "codex-mcp-client"]) {
  for (const upstreamVersion of ["2025-11-25", "2025-06-18"] as const) {
    for (const downstreamVersion of ["2026-07-28", "2025-11-25", "2025-06-18"] as const) {
      test(`${upstreamVersion} gateway forwards ${downstreamVersion} approvals for ${clientName}`, async () => {
        await withLegacyInMemoryProxy(async ({ client }) => {
          const toolName = downstreamVersion === "2026-07-28" ? "needs_approval" : "mcp_2025_approval";
          let action: "accept" | "decline" | "cancel" = "accept";
          let requests = 0;
          client.setRequestHandler("elicitation/create", async (request) => {
            requests += 1;
            assertApprovalRequest(request.params, clientName, toolName, { operation: "deploy-test" });
            return action === "accept" ? { action, content: {} } : { action };
          });
          for (action of ["accept", "decline", "cancel"] as const) {
            const result = await client.callTool({
              name: "gateway_call_tool",
              arguments: { serviceId: "downstream", toolName, arguments: { operation: "deploy-test" } }
            });
            assert.equal(result.isError, action !== "accept");
            assert.deepEqual(result.structuredContent, { operation: "deploy-test", executed: action === "accept" });
          }
          assert.equal(requests, 3);
        }, upstreamVersion, downstreamVersion, false, [], clientName);
      });
    }
  }
}

/** 核对实际经过 SDK 和传输层的审批请求，而非仅检查构造函数。 */
function assertApprovalRequest(
  value: unknown, clientName: string, toolName: string, toolParams: Record<string, unknown>
): void {
  const params = value as ElicitRequestFormParams;
  assert.equal(params.mode, "form");
  assert.deepEqual(params.requestedSchema.properties, {});
  assert.ok(params._meta?.trace);
  if (clientName === "codex-mcp-client") {
    assert.equal(params._meta?.codex_request_type, "approval_request");
    assert.equal(params._meta?.codex_approval_kind, "mcp_tool_call");
    assert.equal(params._meta?.codex_strict_auto_review, true);
    assert.equal(params._meta?.codex_sensitive_action, true);
    assert.equal(params._meta?.tool_name, toolName);
    assert.deepEqual(params._meta?.tool_params, toolParams);
    assert.equal(params._meta?.persist, undefined);
  } else {
    assert.equal(params._meta?.codex_request_type, undefined);
  }
}

test("gateway hides schemas and rejects calls for configured disabled tools", async () => {
  await withProxy(async ({ client }) => {
    const listed = await client.callTool({
      name: "gateway_list_tools",
      arguments: { serviceId: "downstream" }
    });
    const tools = (listed.structuredContent as { tools?: Array<{ name?: string }> } | undefined)?.tools ?? [];
    assert.equal(tools.some((tool) => tool.name === "arbitrary_json"), false);

    const schema = await client.callTool({
      name: "gateway_get_tool_schema",
      arguments: { serviceId: "downstream", toolName: ["arbitrary_json"] }
    });
    assert.equal(schema.isError, true);
    assert.deepEqual(schema.structuredContent, { schemas: {}, errors: { arbitrary_json: "Unknown tool in service 'downstream'." } });

    const call = await client.callTool({
      name: "gateway_call_tool",
      arguments: {
        serviceId: "downstream",
        toolName: "arbitrary_json",
        arguments: {}
      }
    });
    assert.equal(call.isError, true);
    assert.match(call.content.find((item) => item.type === "text")?.text ?? "", /is disabled by gateway configuration/);
  }, () => undefined, "2026-07-28", [], ["arbitrary_*"]);
});

for (const protocolVersion of ["2025-11-25", "2025-06-18"] as const) {
  test(`MCP ${protocolVersion} legacy elicitation shorthand is normalized to elicitation.form`, () => {
    const capabilities = { elicitation: {} };
    normalizeLegacyFormElicitationCapability(capabilities);
    assert.deepEqual(capabilities, { elicitation: { form: {} } });
  });

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
    }, protocolVersion, "2026-07-28", true);
  });
}

for (const protocolVersion of ["2025-11-25", "2025-06-18"] as const) {
  test(`MCP ${protocolVersion} upstream completes configured gateway confirmation`, async () => {
    await withLegacyInMemoryProxy(async ({ client }) => {
      const result = await client.callTool({
        name: "gateway_call_tool",
        arguments: {
          serviceId: "downstream",
          toolName: "mcp_2025_echo",
          arguments: { message: "confirmed" }
        }
      });
      assert.deepEqual(result.structuredContent, { echoed: "confirmed" });
    }, protocolVersion, protocolVersion, false, ["mcp_2025_echo"]);
  });
}

test("gateway proxies a modern upstream call to an MCP 2025-11-25 stdio service", async () => {
  await withProxy(async ({ client }) => {
    const result = await client.callTool({
      name: "gateway_call_tool",
      arguments: {
        serviceId: "downstream",
        toolName: "mcp_2025_echo",
        arguments: { message: "legacy-stdio" }
      }
    });
    assert.deepEqual(result.structuredContent, { echoed: "legacy-stdio" });
  }, () => undefined, "2025-11-25");
});

for (const protocolVersion of ["2025-11-25", "2025-06-18"] as const) {
  test(`gateway converts MCP ${protocolVersion} downstream form elicitation for a modern upstream client`, async () => {
    const operation = `${protocolVersion}-modern-upstream`;
    await withProxy(async ({ client }) => {
      const first = await callGatewayConfirmation(client, operation);
      assert.equal(isInputRequiredResult(first), true);
      const inputRequiredResult = first as InputRequiredResult;
      assert.ok(inputRequiredResult.requestState);
      assert.match(inputRequiredResult.requestState, /^mcp-gateway-form-elicitation-v1\./);
      assert.equal(inputRequiredResult.inputRequests?.form?.method, "elicitation/create");
      assert.equal(
        (inputRequiredResult.inputRequests?.form?.params as { message?: string } | undefined)?.message,
        `Confirm ${operation}`
      );

      const second = await callGatewayConfirmation(client, operation, {
        requestState: inputRequiredResult.requestState,
        inputResponses: {
          form: {
            action: "accept",
            content: { confirmed: true }
          }
        }
      });
      assert.equal(isInputRequiredResult(second), false);
      assert.deepEqual((second as CallToolResult).structuredContent, {
        operation,
        confirmed: true,
        state: "stdio-downstream-state-v1"
      });
    }, () => undefined, protocolVersion);
  });

  test(`MCP ${protocolVersion} upstream form elicitation is forwarded directly to a matching downstream service`, async () => {
    const operation = `${protocolVersion}-direct`;
    await withLegacyInMemoryProxy(async ({ client }) => {
      const result = await client.callTool({
        name: "gateway_call_tool",
        arguments: {
          serviceId: "downstream",
          toolName: "mcp_2025_confirm",
          arguments: { operation }
        }
      });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      assert.deepEqual(result.structuredContent, {
        operation,
        confirmed: true,
        state: "stdio-downstream-state-v1"
      });
    }, protocolVersion, protocolVersion);
  });
}

test("gateway serializes overlapping modern calls while an MCP 2025 downstream form is parked", async () => {
  await withProxy(async ({ client }) => {
    const first = await callGatewayConfirmation(client, "first");
    assert.equal(isInputRequiredResult(first), true);
    const firstInput = first as InputRequiredResult;
    assert.ok(firstInput.requestState);

    let secondSettled = false;
    const secondPending = callGatewayConfirmation(client, "second").finally(() => {
      secondSettled = true;
    });
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    assert.equal(secondSettled, false);

    const firstCompleted = await callGatewayConfirmation(client, "first", {
      requestState: firstInput.requestState,
      inputResponses: {
        form: { action: "accept", content: { confirmed: true } }
      }
    });
    assert.deepEqual((firstCompleted as CallToolResult).structuredContent, {
      operation: "first",
      confirmed: true,
      state: "stdio-downstream-state-v1"
    });

    const second = await secondPending;
    assert.equal(isInputRequiredResult(second), true);
    const secondInput = second as InputRequiredResult;
    assert.ok(secondInput.requestState);
    assert.notEqual(secondInput.requestState, firstInput.requestState);
    const secondCompleted = await callGatewayConfirmation(client, "second", {
      requestState: secondInput.requestState,
      inputResponses: {
        form: { action: "accept", content: { confirmed: false } }
      }
    });
    assert.deepEqual((secondCompleted as CallToolResult).structuredContent, {
      operation: "second",
      confirmed: false,
      state: "stdio-downstream-state-v1"
    });
  }, () => undefined, "2025-11-25");
});

test("gateway rejects a mismatched MCP 2025 form continuation without losing the parked call", async () => {
  await withProxy(async ({ client }) => {
    const first = await callGatewayConfirmation(client, "original");
    assert.equal(isInputRequiredResult(first), true);
    const inputRequiredResult = first as InputRequiredResult;
    assert.ok(inputRequiredResult.requestState);

    const mismatch = await callGatewayConfirmation(client, "different", {
      requestState: inputRequiredResult.requestState,
      inputResponses: {
        form: { action: "accept", content: { confirmed: true } }
      }
    });
    assert.equal((mismatch as CallToolResult).isError, true);
    assert.match(
      (mismatch as CallToolResult).content.find((item) => item.type === "text")?.text ?? "",
      /does not match the original downstream tool call/
    );

    const completed = await callGatewayConfirmation(client, "original", {
      requestState: inputRequiredResult.requestState,
      inputResponses: {
        form: { action: "accept", content: { confirmed: true } }
      }
    });
    assert.deepEqual((completed as CallToolResult).structuredContent, {
      operation: "original",
      confirmed: true,
      state: "stdio-downstream-state-v1"
    });
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
  downstreamProtocolVersion: "2026-07-28" | "2025-11-25" | "2025-06-18" = "2026-07-28",
  confirmationRequiredTools: string[] = [],
  disabledTools: string[] = [],
  clientName = "proxy-test"
): Promise<void> {
  const downstream = downstreamProtocolVersion === "2026-07-28"
    ? await startDownstream(onDownstreamCancelled)
    : null;
  const tempDirectory = await mkdtemp(join(tmpdir(), "mcp-gateway-proxy-"));
  const configPath = join(tempDirectory, "config.json");
  await writeFile(configPath, JSON.stringify({
    services: [
      {
        serviceId: "downstream",
        name: "Downstream",
        confirmationRequiredTools,
        disabledTools,
        transport: downstream
          ? {
              type: "http",
              url: downstream.url
            }
          : createLegacyStdioTransport(downstreamProtocolVersion)
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

  const client = new Client({ name: clientName, version: "1.0.0" }, {
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
    await downstream?.close();
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

async function withLegacyInMemoryProxy(
  assertion: (context: { client: Client }) => Promise<void>,
  protocolVersion: "2025-11-25" | "2025-06-18",
  downstreamProtocolVersion: "2026-07-28" | "2025-11-25" | "2025-06-18" = "2026-07-28",
  useLegacyElicitationShorthand = false,
  confirmationRequiredTools: string[] = [],
  clientName = `${protocolVersion}-proxy-test`
): Promise<void> {
  const downstream = downstreamProtocolVersion === "2026-07-28"
    ? await startDownstream(() => undefined)
    : null;
  const tempDirectory = await mkdtemp(join(tmpdir(), "mcp-gateway-legacy-proxy-"));
  const configPath = join(tempDirectory, "config.json");
  await writeFile(configPath, JSON.stringify({
    services: [
      {
        serviceId: "downstream",
        name: "Downstream",
        confirmationRequiredTools,
        transport: downstream
          ? {
              type: "http",
              url: downstream.url
            }
          : createLegacyStdioTransport(downstreamProtocolVersion)
      }
    ]
  }), "utf8");

  const logger = new Logger();
  const registry = new ServiceRegistry(configPath, new ConfigLoader(), logger);
  await registry.initialize();
  const gatewayServer = createGatewayMcpServer(new McpGatewayEngine(registry, logger));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: clientName, version: "1.0.0" }, {
    capabilities: useLegacyElicitationShorthand
      ? { elicitation: {} }
      : { elicitation: { form: {} } },
    supportedProtocolVersions: [protocolVersion]
  });
  client.setRequestHandler("elicitation/create", async (request) => {
    const usesConfirmed = "requestedSchema" in request.params
      && Object.hasOwn(request.params.requestedSchema.properties, "confirmed");
    const content: Record<string, string | number | boolean | string[]> = usesConfirmed ? { confirmed: true } : {};
    return {
      action: "accept",
      content
    };
  });

  try {
    await gatewayServer.connect(serverTransport);
    await client.connect(clientTransport);
    await assertion({ client });
  } finally {
    await client.close().catch(() => undefined);
    await gatewayServer.close().catch(() => undefined);
    await registry.dispose();
    await downstream?.close();
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

async function startDownstream(
  onCancelled: (cancelled: boolean) => void
): Promise<{ url: string; close: () => Promise<void> }> {
  const protocolVersion = "2026-07-28" as const;
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
      "needs_approval",
      { inputSchema: z.object({ operation: z.string() }) },
      async ({ operation }, context) => {
        const response = context.mcpReq.inputResponses?.confirm as { action?: string } | undefined;
        if (!response) {
          return inputRequired({
            inputRequests: {
              confirm: inputRequired.elicit({
                message: `Execute ${operation}`,
                requestedSchema: z.object({}),
                _meta: { trace: "modern-approval" }
              })
            },
            requestState: "modern-approval-v1"
          });
        }
        return {
          content: [],
          isError: response.action !== "accept",
          structuredContent: { operation, executed: response.action === "accept" }
        };
      }
    );
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
  }, { legacy: "reject", responseMode: "sse" });
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

function createLegacyStdioTransport(
  protocolVersion: "2026-07-28" | "2025-11-25" | "2025-06-18"
): Record<string, unknown> {
  if (protocolVersion === "2026-07-28") {
    throw new Error("A modern downstream fixture must use HTTP.");
  }
  return {
    type: "stdio",
    command: process.execPath,
    args: ["--experimental-strip-types", "test/fixtures/mcp-2025-stdio-service.ts"],
    cwd: process.cwd(),
    env: {
      MCP_TEST_PROTOCOL_VERSION: protocolVersion
    }
  };
}

async function callGatewayConfirmation(
  client: Client,
  operation: string,
  continuation: {
    requestState?: string;
    inputResponses?: Record<string, unknown>;
  } = {}
): Promise<CallToolResult | InputRequiredResult> {
  const params = {
    name: "gateway_call_tool",
    arguments: {
      serviceId: "downstream",
      toolName: "mcp_2025_confirm",
      arguments: { operation }
    },
    ...continuation
  } as unknown as CallToolRequestParams;
  return client.callTool(params, { allowInputRequired: true }) as Promise<CallToolResult | InputRequiredResult>;
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
