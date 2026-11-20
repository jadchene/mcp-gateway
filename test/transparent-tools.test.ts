import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { Client, isInputRequiredResult, StreamableHTTPClientTransport, type CallToolRequestParams } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createMcpHandler, fromJsonSchema, inputRequired, McpServer, ProtocolError } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { ConfigLoader, validateGatewayConfig } from "../src/config.ts";
import { McpGatewayEngine } from "../src/gateway-engine.ts";
import { StreamableHttpGatewayServer } from "../src/http-server.ts";
import { Logger } from "../src/logger.ts";
import { ServiceRegistry } from "../src/service-registry.ts";
import { StreamableHttpClient } from "../src/mcp/http-client.ts";
import { transparentToolName } from "../src/transparent-tools.ts";

const echoService = {
  name: "Echo service",
  transport: { type: "stdio", command: process.execPath, args: [resolve("examples/echo-service.ts")] }
};

/** 客户端收到协议通知后再继续；等待期间不主动读取目录。 */
async function expectToolListChange(recipients: EventTarget[], change: () => void | Promise<unknown>) {
  const signal = AbortSignal.timeout(8000);
  await Promise.all([...recipients.map(events => once(events, "change", { signal })), change()]);
}

/** 使用 SDK 的协议通知入口，关闭自动重读以单独验证通知是否到达。 */
function observeTools(events: EventTarget) {
  return { tools: { autoRefresh: false, debounceMs: 0, onChanged: (error: Error | null) => {
    if (!error) events.dispatchEvent(new Event("change"));
  } } };
}

test("transparent tools require explicit opt-in and generate stable distinct aliases", () => {
  assert.equal(validateGatewayConfig({ services: [] }).transparentTools, false);
  assert.equal(validateGatewayConfig({ transparentTools: false, services: [] }).transparentTools, false);
  for (const invalid of [null, "true", 1]) {
    assert.throws(() => validateGatewayConfig({ transparentTools: invalid, services: [] }), /transparentTools/);
  }
  assert.equal(transparentToolName("my-db", "list_tables"), "my-db__list_tables");
  const pairs = [["a__b", "c"], ["a", "b__c"], ["a_", "c"], ["a", "_c"],
    ["服务", "echo"], ["x".repeat(80), "read"], ["x".repeat(81), "read"]];
  const names = pairs.map(([s, t]) => transparentToolName(s, t));
  assert.equal(new Set(names).size, pairs.length);
  for (const [i, name] of names.entries()) {
    assert.match(name, /^[A-Za-z0-9_-]{1,64}$/);
    assert.equal(name, transparentToolName(pairs[i][0], pairs[i][1]));
  }
});

test("stdio advertises the complete prefixed catalog on first connection and accepts original arguments", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gateway-transparent-"));
  const path = join(dir, "config.json");
  const client = new Client({ name: "stdio-test", version: "1" });
  try {
    await writeFile(path, JSON.stringify({ transparentTools: true, services: [{ ...echoService, serviceId: "first" }] }));
    await client.connect(new StdioClientTransport({
      command: process.execPath, args: [resolve("dist/index.js"), "--config", path], stderr: "pipe"
    }));
    const tools = (await client.listTools()).tools;
    assert.ok(tools.some(tool => tool.name === "first__echo"));
    assert.ok(tools.some(tool => tool.name === "gateway_manage_service"));
    assert.ok(!tools.some(tool => tool.name === "gateway_call_tool"));
    const result = await client.callTool({ name: "first__echo", arguments: { message: "hello" } });
    assert.deepEqual(result.structuredContent, { echoed: "hello" });
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});

for (const version of ["2026-07-28", "2025-11-25", "2025-06-18"]) {
  test(`stdio forwards downstream tool additions and removals to the connected ${version} client`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "gateway-stdio-notify-"));
    const path = join(dir, "config.json");
    const events = new EventTarget();
    const client = new Client({ name: "stdio-notify", version: "1" }, {
      listChanged: observeTools(events),
      supportedProtocolVersions: [version],
      versionNegotiation: { mode: version === "2026-07-28" ? { pin: version } : "legacy" }
    });
    try {
      await writeFile(path, JSON.stringify({ transparentTools: true, services: [{
        serviceId: "example", name: "Example",
        transport: { type: "stdio", command: process.execPath, args: [resolve("test/fixtures/changing-tools-service.ts"), version] }
      }] }));
      await client.connect(new StdioClientTransport({
        command: process.execPath, args: [resolve("dist/index.js"), "--config", path], stderr: "pipe"
      }));
      const hasSample = async () => (await client.listTools()).tools.some(t => t.name === "example__sample");
      assert.equal(await hasSample(), false);
      for (const visible of [true, false]) {
        await expectToolListChange([events], async () => {
          const result = await client.callTool({ name: "example__configure_sample", arguments: { visible } });
          assert.notEqual(result.isError, true);
        });
        assert.equal(await hasSample(), visible);
      }
    } finally {
      await client.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test("stdio completes discovery while a downstream is starting and serves its tool on the first list", async () => {
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  const handler = createMcpHandler(async () => {
    await ready;
    const service = new McpServer({ name: "slow", version: "1" });
    service.registerTool("sample", {}, async () => ({ content: [] }));
    return service;
  });
  const server = http.createServer(toNodeHandler(handler));
  const dir = await mkdtemp(join(tmpdir(), "gateway-slow-start-"));
  const path = join(dir, "config.json");
  const clients = [
    new Client({ name: "early-discover", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } }),
    new Client({ name: "early-initialize", version: "1" }, { versionNegotiation: { mode: "legacy" } })
  ];
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address === "object");
    await writeFile(path, JSON.stringify({ transparentTools: true, services: [{
      serviceId: "slow", name: "Slow", transport: { type: "http", url: `http://127.0.0.1:${address.port}/mcp` }
    }] }));
    for (const client of clients) {
      await client.connect(new StdioClientTransport({
        command: process.execPath, args: [resolve("dist/index.js"), "--config", path], stderr: "pipe"
      }), { timeout: 3000 });
      assert.match(client.getInstructions() ?? "", /slow/);
    }
    const pending = clients.map(client => Promise.all([
      client.listTools(),
      client.callTool({ name: "slow__sample", arguments: {} }, {
        toolDefinition: { name: "slow__sample", inputSchema: { type: "object" } }
      })
    ]));
    // 两个连接都已经握手；下一个事件循环再让下游开始响应。
    setImmediate(release);
    for (const [list, call] of await Promise.all(pending)) {
      assert.ok(list.tools.some(tool => tool.name === "slow__sample"));
      assert.notEqual(call.isError, true);
    }
  } finally {
    release();
    await Promise.all(clients.map(client => client.close()));
    await handler.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test("downstream list changes update metadata and preserve structured results across confirmation rounds", async () => {
  let toolName = "before";
  let failNextList = false;
  let failedLists = 0;
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: "dynamic", version: "1" });
    server.registerTool(toolName, {
      title: "Read sample", description: "Return a confirmed sample",
      annotations: { readOnlyHint: true }, _meta: { example: "metadata" },
      inputSchema: fromJsonSchema({ type: "object" }),
      outputSchema: fromJsonSchema({ type: "object", required: ["read"], properties: { read: { type: "boolean" } } })
    }, async (_args, context) => context.mcpReq.inputResponses?.confirm
      ? { content: [], structuredContent: { read: true } }
      : inputRequired({ inputRequests: { confirm: inputRequired.elicit({
        message: "Read sample?", requestedSchema: { type: "object", properties: {} }
      }) }, requestState: "pending" }));
    if (failNextList) {
      server.server.setRequestHandler("tools/list", () => {
        failNextList = false;
        failedLists++;
        throw new ProtocolError(-32603, "Catalog temporarily unavailable");
      });
    }
    return server;
  });
  const server = http.createServer(toNodeHandler(handler));
  const dir = await mkdtemp(join(tmpdir(), "gateway-catalog-events-"));
  const path = join(dir, "config.json");
  const logger = new Logger();
  const registry = new ServiceRegistry(path, new ConfigLoader(), logger);
  const gateway = new StreamableHttpGatewayServer({ enable: true, host: "127.0.0.1", port: 0, path: "/mcp" },
    new McpGatewayEngine(registry, logger), logger);
  const events = new EventTarget();
  const client = new Client({ name: "confirm-test", version: "1" }, {
    listChanged: observeTools(events),
    versionNegotiation: { mode: { pin: "2026-07-28" } }, capabilities: { elicitation: { form: {} } }
  });
  let confirmations = 0;
  client.setRequestHandler("elicitation/create", () => {
    confirmations++;
    return { action: "accept", content: {} };
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address === "object");
    await writeFile(path, JSON.stringify({ transparentTools: true, services: [{
      serviceId: "dynamic", name: "Dynamic service", transport: { type: "http", url: `http://127.0.0.1:${address.port}/mcp` }
    }] }));
    await registry.initialize();
    await gateway.start();
    await client.connect(new StreamableHTTPClientTransport(new URL(gateway.url)));
    assert.ok((await client.listTools()).tools.some(t => t.name === "dynamic__before"));
    await expectToolListChange([events], () => {
      toolName = "after";
      failNextList = true;
      handler.notify.toolsChanged();
    });
    assert.equal(failedLists, 1);
    const tools = (await client.listTools()).tools;
    assert.ok(!tools.some(t => t.name === "dynamic__before"));
    const tool = tools.find(t => t.name === "dynamic__after")!;
    assert.equal(tool.title, "Read sample");
    assert.equal(tool.annotations?.readOnlyHint, true);
    assert.equal(tool._meta?.example, "metadata");
    assert.deepEqual((await client.callTool({ name: tool.name, arguments: {} })).structuredContent, { read: true });
    assert.equal(confirmations, 1);

    // 切断下游监听连接，故意不发通知，验证重新订阅后的补读和后续推送。
    await expectToolListChange([events], () => {
      server.closeAllConnections();
      toolName = "during_disconnect";
    });
    assert.ok((await client.listTools()).tools.some(t => t.name === "dynamic__during_disconnect"));
    await expectToolListChange([events], () => {
      toolName = "recovered";
      handler.notify.toolsChanged();
    });
    const recovered = (await client.listTools()).tools.map(t => t.name);
    assert.ok(recovered.includes("dynamic__recovered"));
    assert.ok(!recovered.includes("dynamic__during_disconnect"));
  } finally {
    await client.close();
    await gateway.stop();
    await registry.dispose();
    await handler.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failed reload keeps the last catalog with new filters until a background read restores availability", async () => {
  let failList = false;
  let names = ["sample", "hidden"];
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: "reload", version: "1" }, { capabilities: { tools: { listChanged: false } } });
    server.server.setRequestHandler("tools/list", () => {
      if (failList) throw new ProtocolError(-32603, "catalog updating");
      return { tools: names.map(name => ({ name, inputSchema: { type: "object" as const } })) };
    });
    return server;
  });
  const server = http.createServer(toNodeHandler(handler));
  const registry = new ServiceRegistry("unused", new ConfigLoader(), new Logger());
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const config = (disabledTools: string[]) => validateGatewayConfig({ transparentTools: true, services: [{
      serviceId: "demo", name: "Demo", disabledTools, transport: { type: "http", url: `http://127.0.0.1:${address.port}/mcp` }
    }] });
    await registry.initialize(config([]));
    assert.deepEqual([...registry.toolCatalog!.keys()], ["demo__sample", "demo__hidden"]);
    failList = true;
    await registry.reloadStrict(config(["hidden"]));
    assert.deepEqual([...registry.toolCatalog!.keys()], ["demo__sample"]);
    assert.match(registry.getService("demo")!.runtime.lastError!, /catalog updating/);

    await expectToolListChange([registry.catalogEvents], () => {
      names = ["sample", "hidden", "new_tool"];
      failList = false;
    });
    assert.deepEqual([...registry.toolCatalog!.keys()], ["demo__sample", "demo__new_tool"]);
    assert.equal(registry.getService("demo")!.runtime.available, true);
    assert.equal(registry.getService("demo")!.runtime.lastError, null);
  } finally {
    await registry.dispose();
    await handler.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("invalid modern output contracts fail before dispatch and leave the connection usable", async () => {
  let calls = 0;
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: "output-test", version: "1" }, { capabilities: { tools: {} } });
    server.server.setRequestHandler("tools/list", () => ({ tools: ["broken", "valid"].map(name => ({
      name, inputSchema: { type: "object" as const },
      outputSchema: name === "broken" ? { type: "object" as const, $ref: "#/$defs/missing" } : { type: "object" as const }
    })) }));
    server.server.setRequestHandler("tools/call", () => {
      calls++;
      return { content: [], structuredContent: { ok: true } };
    });
    return server;
  });
  const server = http.createServer(toNodeHandler(handler));
  let client: StreamableHttpClient | undefined;
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const config = validateGatewayConfig({ services: [{
      serviceId: "demo", name: "Demo", transport: { type: "http", url: `http://127.0.0.1:${address.port}/mcp` }
    }] });
    client = new StreamableHttpClient(config.services[0], new Logger());
    assert.equal((await client.getMetadata()).protocolEra, "modern");
    await assert.rejects(client.callTool("broken", {}), /invalid outputSchema.*missing/);
    assert.equal(calls, 0);
    assert.equal(client.isConnected, true);
    assert.deepEqual((await client.callTool("valid", {})).structuredContent, { ok: true });
    assert.equal(calls, 1);
  } finally {
    await client?.dispose();
    await handler.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("a stdio process exit withdraws its tools and the next connection publishes a fresh catalog", async () => {
  const logger = new Logger();
  const registry = new ServiceRegistry("unused", new ConfigLoader(), logger);
  const gateway = new StreamableHttpGatewayServer({ enable: true, host: "127.0.0.1", port: 0, path: "/mcp" },
    new McpGatewayEngine(registry, logger), logger);
  const events = new EventTarget();
  const client = new Client({ name: "exit-observer", version: "1" }, {
    listChanged: observeTools(events), versionNegotiation: { mode: { pin: "2026-07-28" } }
  });
  try {
    await registry.initialize(validateGatewayConfig({ transparentTools: true, services: [{
      serviceId: "demo", name: "Demo", transport: { type: "stdio", command: process.execPath,
        args: [resolve("test/fixtures/changing-tools-service.ts"), "2025-11-25", "--exit-test"] }
    }] }));
    await gateway.start();
    await client.connect(new StreamableHTTPClientTransport(new URL(gateway.url)));
    const processTool = async () => (await client.listTools()).tools.find(tool => tool.name.startsWith("demo__process_"))?.name;
    const previous = await processTool();
    assert.ok(previous);
    await expectToolListChange([events], () => client.callTool({ name: "demo__end_session", arguments: {} }));
    await expectToolListChange([events], async () => {
      assert.equal(await processTool(), undefined);
      assert.equal(registry.getService("demo")!.runtime.available, false);
    });
    const replacement = await processTool();
    assert.ok(replacement && replacement !== previous);
    assert.equal(registry.getService("demo")!.runtime.available, true);
  } finally {
    await client.close();
    await gateway.stop();
    await registry.dispose();
  }
});

test("live HTTP clients refresh on mode, service and filter changes and preserve confirmations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gateway-transparent-"));
  const path = join(dir, "config.json");
  const logger = new Logger();
  const registry = new ServiceRegistry(path, new ConfigLoader(), logger);
  const gateway = new StreamableHttpGatewayServer({
    enable: true, host: "127.0.0.1", port: 0, path: "/mcp"
  }, new McpGatewayEngine(registry, logger), logger);
  const services = [
    { ...echoService, serviceId: "one", disabledTools: [] as string[] },
    { ...echoService, serviceId: "two", confirmationRequiredTools: ["echo"] }
  ] as const;
  const save = (transparentTools: boolean) => writeFile(path, JSON.stringify({ services, transparentTools }));
  const clients: Client[] = [];
  const recipients: EventTarget[] = [];
  try {
    await save(false);
    await registry.initialize();
    await gateway.start();
    for (const version of ["2026-07-28", "2025-11-25", "2025-06-18"]) {
      const events = new EventTarget();
      recipients.push(events);
      const client = new Client({ name: "http-test", version: "1" }, {
        supportedProtocolVersions: [version],
        versionNegotiation: { mode: version === "2026-07-28" ? { pin: version } : "legacy" },
        capabilities: { elicitation: { form: {} } },
        inputRequired: { autoFulfill: false },
        listChanged: observeTools(events)
      });
      clients.push(client);
      await client.connect(new StreamableHTTPClientTransport(new URL(gateway.url)));
      assert.ok((await client.listTools()).tools.some(tool => tool.name === "gateway_call_tool"));
    }
    await save(true);
    await expectToolListChange(recipients, () => registry.reloadStrict());
    for (const client of clients) {
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map(tool => tool.name).sort(),
        ["gateway_get_service", "gateway_list_services", "one__echo", "two__echo"]);
      const listed = await client.callTool({ name: "gateway_list_services", arguments: { serviceIdFilter: "one" } });
      const { transparentTools, services: [service] } = listed.structuredContent as {
        transparentTools: boolean; services: { serviceId: string }[]
      };
      assert.equal(transparentTools, true);
      const matches = tools.filter(tool => tool.description?.includes(service.serviceId) && tool.name.includes("echo"));
      assert.deepEqual(matches.map(tool => tool.name), ["one__echo"]);
      const [echo] = matches;
      assert.match(echo.description!, /Echo service.*provided message/);
      assert.deepEqual(echo.inputSchema, registry.getTool("one", "echo")!.inputSchema);
      assert.deepEqual(echo.outputSchema, registry.getTool("one", "echo")!.outputSchema);
      assert.deepEqual((await client.callTool({ name: echo.name, arguments: { message: "direct" } })).structuredContent, { echoed: "direct" });
      assert.equal((await client.callTool({ name: echo.name, arguments: {} })).isError, true);
    }
    const modern = clients[0];
    const call = { name: "two__echo", arguments: { message: "confirmed" } };
    // 中间轮次返回 input_required，最终轮次才应按工具的 outputSchema 校验。
    const first = await modern.request({ method: "tools/call", params: call }, { allowInputRequired: true });
    assert.ok(isInputRequiredResult(first));
    const key = Object.keys(first.inputRequests!)[0];
    const result = await modern.callTool({ ...call, requestState: first.requestState,
      inputResponses: { [key]: { action: "accept", content: {} } }
    } as CallToolRequestParams);
    assert.deepEqual(result.structuredContent, { echoed: "confirmed" });

    await expectToolListChange(recipients, () => registry.controlService("one", "stop"));
    assert.ok(!(await modern.listTools()).tools.some(t => t.name === "one__echo"));
    await expectToolListChange(recipients, () => registry.controlService("one", "start"));
    assert.ok((await modern.listTools()).tools.some(t => t.name === "one__echo"));
    await registry.manageService("one", "reconnect");
    assert.ok((await modern.listTools()).tools.some(t => t.name === "one__echo"));
    services[0].disabledTools.push("ec*");
    await save(true);
    await expectToolListChange(recipients, () => registry.reloadStrict());
    for (const client of clients) {
      assert.ok(!(await client.listTools()).tools.some(t => t.name === "one__echo"));
      await assert.rejects(client.callTool({ name: "one__echo", arguments: { message: "hidden" } }), /not found/i);
    }
    await save(false);
    await expectToolListChange(recipients, () => registry.reloadStrict());
    for (const client of clients) {
      const { tools } = await client.listTools();
      assert.equal(tools.length, 5);
      assert.ok(tools.some(t => t.name === "gateway_call_tool"));
      const empty = await client.callTool({ name: "gateway_list_services", arguments: { serviceIdFilter: "absent" } });
      assert.deepEqual(empty.structuredContent, { transparentTools: false, services: [] });
    }
  } finally {
    await Promise.all(clients.map(client => client.close()));
    await gateway.stop();
    await registry.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
