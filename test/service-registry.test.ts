import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigLoader } from "../src/config.ts";
import { Logger } from "../src/logger.ts";
import { ServiceRegistry } from "../src/service-registry.ts";

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

  const call = await registry.callTool("demo-echo", "echo", { message: "hello" });
  assert.equal(call.restartAttempts, 0);

  const downstream = call.result as { structuredContent?: { echoed?: string } };
  assert.equal(downstream.structuredContent?.echoed, "hello");

  await registry.dispose();
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
