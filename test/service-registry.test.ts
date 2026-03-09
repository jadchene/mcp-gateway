import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
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
