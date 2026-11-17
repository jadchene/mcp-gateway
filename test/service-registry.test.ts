import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { ConfigLoader } from "../src/config.ts";
import { Logger } from "../src/logger.ts";
import { ServiceRegistry } from "../src/service-registry.ts";

test("ServiceRegistry surfaces an invalid initial config", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "mcp-gateway-"));
  const configPath = join(tempDir, "config.json");
  await writeFile(configPath, "{ invalid", "utf8");
  const registry = new ServiceRegistry(configPath, new ConfigLoader(), new Logger());
  await assert.rejects(registry.initialize(), /JSON/);
});

test("ServiceRegistry loads metadata and routes downstream tool calls", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "mcp-gateway-"));
  const configPath = join(tempDir, "config.json");
  const echoServicePath = join(process.cwd(), "examples", "echo-service.ts");

  await writeFile(
    configPath,
    JSON.stringify({
      services: [
        {
          serviceId: "demo-echo",
          name: "Demo Echo",
          transport: {
            type: "stdio",
            command: "node",
            args: ["--experimental-strip-types", echoServicePath],
            cwd: process.cwd()
          }
        }
      ]
    }),
    "utf8"
  );

  const registry = new ServiceRegistry(configPath, new ConfigLoader(), new Logger());
  await registry.initialize();

  const services = registry.listServices();
  assert.equal(services.length, 1);
  assert.equal(services[0]?.metadata.tools[0]?.name, "echo");
  assert.deepEqual(registry.listTools("demo-echo", ["ECHO"]).map((tool) => tool.name), ["echo"]);
  assert.deepEqual(registry.listTools("demo-echo", ["missing", "ECHO"]).map((tool) => tool.name), ["echo"]);
  assert.deepEqual(registry.listTools("demo-echo", undefined, ["OVIDED MESS"]).map((tool) => tool.name), ["echo"]);
  assert.deepEqual(registry.listTools("demo-echo", ["missing"], ["vided messa"]).map((tool) => tool.name), ["echo"]);
  assert.deepEqual(registry.listTools("demo-echo", ["missing"], ["absent description"]).map((tool) => tool.name), []);
  assert.deepEqual(registry.listTools("demo-echo", ["missing"]), []);

  const call = await registry.callTool("demo-echo", "echo", { message: "hello" });
  assert.equal(call.restartAttempts, 0);

  const downstream = call.result as { structuredContent?: { echoed?: string } };
  assert.equal(downstream.structuredContent?.echoed, "hello");

  await registry.dispose();
});

test("ServiceRegistry hides and rejects tools matching disabledTools", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "mcp-gateway-"));
  const configPath = join(tempDir, "config.json");
  const echoServicePath = join(process.cwd(), "examples", "echo-service.ts");

  await writeFile(configPath, JSON.stringify({
    services: [{
      serviceId: "demo-echo",
      name: "Demo Echo",
      disabledTools: ["ec?o"],
      transport: {
        type: "stdio",
        command: "node",
        args: ["--experimental-strip-types", echoServicePath],
        cwd: process.cwd()
      }
    }]
  }), "utf8");

  const registry = new ServiceRegistry(configPath, new ConfigLoader(), new Logger());
  await registry.initialize();
  try {
    assert.deepEqual(registry.listTools("demo-echo"), []);
    assert.deepEqual(registry.listTools("demo-echo", ["echo"]), []);
    assert.equal(registry.getTool("demo-echo", "echo"), null);
    await assert.rejects(
      () => registry.callTool("demo-echo", "echo", { message: "blocked" }),
      /Tool 'echo'.*is disabled by gateway configuration/
    );
    assert.equal(registry.getService("demo-echo")?.runtime.available, true);
  } finally {
    await registry.dispose();
  }
});

test("ServiceRegistry removes disabled services on reload", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "mcp-gateway-"));
  const configPath = join(tempDir, "config.json");
  const echoServicePath = join(process.cwd(), "examples", "echo-service.ts");

  await writeFile(
    configPath,
    JSON.stringify({
      services: [
        {
          serviceId: "demo-echo",
          name: "Demo Echo",
          transport: {
            type: "stdio",
            command: "node",
            args: ["--experimental-strip-types", echoServicePath],
            cwd: process.cwd()
          }
        }
      ]
    }),
    "utf8"
  );

  const registry = new ServiceRegistry(configPath, new ConfigLoader(), new Logger());
  await registry.initialize();
  assert.equal(registry.listServices().length, 1);

  await writeFile(
    configPath,
    JSON.stringify({
      services: [
        {
          serviceId: "demo-echo",
          enable: false,
          name: "Demo Echo",
          transport: {
            type: "stdio",
            command: "node",
            args: ["--experimental-strip-types", echoServicePath],
            cwd: process.cwd()
          }
        }
      ]
    }),
    "utf8"
  );

  await registry.reload();

  assert.equal(registry.listServices().length, 0);
  assert.equal(registry.getService("demo-echo"), null);

  await registry.dispose();
});

test("ServiceRegistry can disable and re-enable a service through manageService", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "mcp-gateway-"));
  const configPath = join(tempDir, "config.json");
  const echoServicePath = join(process.cwd(), "examples", "echo-service.ts");

  await writeFile(
    configPath,
    JSON.stringify({
      services: [
        {
          serviceId: "demo-echo",
          name: "Demo Echo",
          transport: {
            type: "stdio",
            command: "node",
            args: ["--experimental-strip-types", echoServicePath],
            cwd: process.cwd()
          }
        }
      ]
    }),
    "utf8"
  );

  const registry = new ServiceRegistry(configPath, new ConfigLoader(), new Logger());
  await registry.initialize();

  const disabled = await registry.manageService("demo-echo", "disable");
  assert.deepEqual(disabled, {
    serviceId: "demo-echo",
    action: "disable",
    enabled: false,
    available: false
  });
  assert.equal(registry.getService("demo-echo"), null);

  const enabled = await registry.manageService("demo-echo", "enable");
  assert.equal(enabled.serviceId, "demo-echo");
  assert.equal(enabled.action, "enable");
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.available, true);
  assert.equal(registry.getService("demo-echo")?.runtime.available, true);

  await registry.dispose();
});

test("ServiceRegistry can reconnect an unavailable service", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "mcp-gateway-"));
  const configPath = join(tempDir, "config.json");
  const echoServicePath = join(process.cwd(), "examples", "echo-service.ts");

  await writeFile(
    configPath,
    JSON.stringify({
      services: [
        {
          serviceId: "demo-echo",
          name: "Demo Echo",
          transport: {
            type: "stdio",
            command: "node",
            args: ["--experimental-strip-types", echoServicePath],
            cwd: process.cwd()
          }
        }
      ]
    }),
    "utf8"
  );

  const registry = new ServiceRegistry(configPath, new ConfigLoader(), new Logger());
  await registry.initialize();

  const snapshot = registry.getService("demo-echo");
  assert.ok(snapshot);
  snapshot.runtime.available = false;
  snapshot.runtime.lastError = "forced test failure";

  const result = await registry.manageService("demo-echo", "reconnect");
  assert.deepEqual(result, {
    serviceId: "demo-echo",
    action: "reconnect",
    enabled: true,
    available: true
  });
  assert.equal(registry.getService("demo-echo")?.runtime.available, true);
  assert.equal(registry.getService("demo-echo")?.runtime.lastError, null);

  await registry.dispose();
});

test("ServiceRegistry restores the previous stdio configuration when replacement reconnect fails", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "mcp-gateway-"));
  const configPath = join(tempDir, "config.json");
  const echoServicePath = join(process.cwd(), "examples", "echo-service.ts");

  await writeFile(configPath, JSON.stringify({
    services: [{
      serviceId: "demo-echo",
      name: "Demo Echo",
      transport: {
        type: "stdio",
        command: "node",
        args: ["--experimental-strip-types", echoServicePath],
        cwd: process.cwd()
      }
    }]
  }), "utf8");

  const registry = new ServiceRegistry(configPath, new ConfigLoader(), new Logger());
  await registry.initialize();
  try {
    const snapshot = registry.getService("demo-echo");
    assert.ok(snapshot);
    assert.equal(snapshot.config.transport.type, "stdio");
    snapshot.runtime.available = false;
    snapshot.runtime.lastError = "forced unavailable state";
    snapshot.config.transport.command = "definitely-missing-mcp-gateway-command";

    const result = await registry.manageService("demo-echo", "reconnect");
    assert.deepEqual(result, {
      serviceId: "demo-echo",
      action: "reconnect",
      enabled: true,
      available: true
    });
    assert.equal(registry.getService("demo-echo")?.runtime.available, true);
    assert.match(registry.getService("demo-echo")?.runtime.lastError ?? "", /previous configuration restored/);

    const call = await registry.callTool("demo-echo", "echo", { message: "still-alive" });
    const downstream = call.result as { structuredContent?: { echoed?: string } };
    assert.equal(downstream.structuredContent?.echoed, "still-alive");
  } finally {
    await registry.dispose();
  }
});

test("ServiceRegistry hot reload updates the active log file target", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "mcp-gateway-"));
  const configPath = join(tempDir, "config.json");
  const firstLogPath = join(tempDir, "logs", "first.log");
  const secondLogPath = join(tempDir, "logs", "second.log");
  const echoServicePath = join(process.cwd(), "examples", "echo-service.ts");

  await writeFile(
    configPath,
    JSON.stringify({
      logging: {
        enable: true,
        path: "./logs/first.log"
      },
      services: [
        {
          serviceId: "demo-echo",
          name: "Demo Echo",
          transport: {
            type: "stdio",
            command: "node",
            args: ["--experimental-strip-types", echoServicePath],
            cwd: process.cwd()
          }
        }
      ]
    }),
    "utf8"
  );

  const registry = new ServiceRegistry(configPath, new ConfigLoader(), new Logger());
  await registry.initialize();

  const firstLogContent = await readFile(firstLogPath, "utf8");
  assert.match(firstLogContent, /config\.reload\.succeeded/);

  await writeFile(
    configPath,
    JSON.stringify({
      logging: {
        enable: true,
        path: "./logs/second.log"
      },
      services: [
        {
          serviceId: "demo-echo",
          name: "Demo Echo",
          transport: {
            type: "stdio",
            command: "node",
            args: ["--experimental-strip-types", echoServicePath],
            cwd: process.cwd()
          }
        }
      ]
    }),
    "utf8"
  );

  await registry.reload();

  const secondLogContent = await readFile(secondLogPath, "utf8");
  assert.match(secondLogContent, /config\.reload\.succeeded/);

  await registry.dispose();
});

test("ServiceRegistry reuses presentation changes and releases stdio ports before replacements", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "mcp-gateway-port-"));
  const configPath = join(tempDir, "config.json");
  const reservation = createServer();
  await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const port = (reservation.address() as import("node:net").AddressInfo).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const service = {
    serviceId: "web-service", name: "Web service", webUrl: "", callTimeoutMs: 120000,
    transport: {
      type: "stdio", command: process.execPath,
      args: [join(process.cwd(), "test/fixtures/port-owning-service.ts")],
      env: { MCP_TEST_WEB_PORT: String(port) }
    }
  };
  const save = () => writeFile(configPath, JSON.stringify({services: [service]}));
  const pid = async () => (await fetch(`http://127.0.0.1:${port}`, {signal: AbortSignal.timeout(3000)})).text();
  const registry = new ServiceRegistry(configPath, new ConfigLoader(), new Logger());
  try {
    await save();
    await registry.initialize();
    assert.equal(registry.getService(service.serviceId)?.runtime.available, true);
    const originalPid = await pid();
    service.webUrl = `http://127.0.0.1:${port}`;
    service.name = "Renamed";
    await save();
    await registry.reloadStrict();
    assert.equal(await pid(), originalPid);
    service.callTimeoutMs = 60000;
    await save();
    await registry.reloadStrict();
    assert.equal(registry.getService(service.serviceId)?.runtime.available, true);
    const replacedPid = await pid();
    assert.notEqual(replacedPid, originalPid);
    const results = await Promise.all([
      registry.manageService(service.serviceId, "reconnect"),
      registry.manageService(service.serviceId, "reconnect")
    ]);
    assert.ok(results.every(result => result.available));
    assert.notEqual(await pid(), replacedPid);
    const originalConfig = await readFile(configPath, "utf8");
    await registry.controlService(service.serviceId, "stop");
    assert.equal(registry.listServiceStates()[0]?.status, "stopped");
    await assert.rejects(pid());
    await assert.rejects(registry.callTool(service.serviceId, "echo", {message: "blocked"}), /stopped/);
    await registry.reloadStrict();
    assert.equal(registry.listServiceStates()[0]?.status, "stopped");
    await assert.rejects(pid());
    await registry.controlService(service.serviceId, "start");
    assert.equal(registry.listServiceStates()[0]?.status, "running");
    const startedPid = await pid();
    await registry.controlService(service.serviceId, "start");
    assert.equal(await pid(), startedPid);
    await registry.controlService(service.serviceId, "restart");
    assert.notEqual(await pid(), startedPid);
    assert.equal(await readFile(configPath, "utf8"), originalConfig);
    await assert.rejects(registry.controlService("unknown-service", "start"), /Unknown/);
  } finally {
    await registry.dispose();
  }
  await assert.rejects(pid());
});
