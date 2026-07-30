import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Logger } from "../src/logger.ts";
import { StdioMcpClient } from "../src/mcp/client.ts";

test("StdioMcpClient auto-negotiates MCP 2026-07-28 and calls a modern tool", async () => {
  const client = new StdioMcpClient({
    serviceId: "modern-stdio",
    enable: true,
    name: "Modern stdio",
    transport: {
      type: "stdio",
      command: process.execPath,
      args: ["--experimental-strip-types", "examples/echo-service.ts"],
      cwd: process.cwd()
    }
  }, new Logger());

  try {
    const metadata = await client.getMetadata();
    assert.equal(metadata.protocolEra, "modern");
    assert.equal(metadata.protocolVersion, "2026-07-28");
    assert.equal(metadata.tools[0]?.name, "echo");

    const result = await client.callTool("echo", { message: "modern" });
    assert.deepEqual(result.structuredContent, { echoed: "modern" });
  } finally {
    await client.dispose();
  }
});

test("StdioMcpClient auto-negotiation safely falls back to a 2025-06-18 sibling process", async () => {
  const client = new StdioMcpClient({
    serviceId: "mcp-2025-stdio",
    enable: true,
    name: "MCP 2025 stdio",
    transport: {
      type: "stdio",
      command: process.execPath,
      args: ["--experimental-strip-types", "test/fixtures/mcp-2025-stdio-service.ts"],
      cwd: process.cwd()
    }
  }, new Logger());

  try {
    const metadata = await client.getMetadata();
    assert.equal(metadata.protocolEra, "legacy");
    assert.equal(metadata.protocolVersion, "2025-06-18");
    assert.equal(metadata.tools[0]?.name, "mcp_2025_echo");
    const result = await client.callTool("mcp_2025_echo", { message: "2025" });
    assert.deepEqual(result.structuredContent, { echoed: "2025" });
  } finally {
    await client.dispose();
  }
});

test("StdioMcpClient rejects protocol revisions outside 2026-07-28 and 2025-06-18", async () => {
  const client = new StdioMcpClient({
    serviceId: "unsupported-stdio-version",
    enable: true,
    name: "Unsupported stdio version",
    transport: {
      type: "stdio",
      command: process.execPath,
      args: ["--experimental-strip-types", "test/fixtures/mcp-2025-stdio-service.ts"],
      cwd: process.cwd(),
      env: {
        MCP_TEST_PROTOCOL_VERSION: "2025-03-26"
      }
    }
  }, new Logger());

  try {
    await assert.rejects(client.getMetadata(), /protocol version is not supported: 2025-03-26/);
  } finally {
    await client.dispose();
  }
});

test("gateway CLI serves modern MCP over upstream stdio", async () => {
  await withGatewayProcess(async (client) => {
    assert.equal(client.getProtocolEra(), "modern");
    assert.equal(client.getNegotiatedProtocolVersion(), "2026-07-28");
    assert.equal((await client.listTools()).tools.length, 6);
  }, true);
});

test("gateway CLI keeps legacy MCP working over upstream stdio", async () => {
  await withGatewayProcess(async (client) => {
    assert.equal(client.getProtocolEra(), "legacy");
    assert.equal(client.getNegotiatedProtocolVersion(), "2025-06-18");
    assert.equal((await client.listTools()).tools.length, 6);
  }, false);
});

test("gateway CLI rejects stdio clients that only support an excluded revision", async () => {
  const client = new Client(
    { name: "unsupported-stdio-upstream", version: "1.0.0" },
    { supportedProtocolVersions: ["2025-03-26"] }
  );
  await assert.rejects(
    withGatewayClient(client, async () => undefined),
    /protocol version is not supported: 2025-06-18/
  );
});

test("gateway CLI automatically serves a modern stdio client", async () => {
  await withGatewayProcess(async (client) => {
    assert.equal(client.getProtocolEra(), "modern");
    assert.equal(client.getNegotiatedProtocolVersion(), "2026-07-28");
  }, true);
});

async function withGatewayProcess(
  assertion: (client: Client) => Promise<void>,
  modern: boolean
): Promise<void> {
  const client = new Client(
    { name: modern ? "modern-stdio-upstream" : "legacy-stdio-upstream", version: "1.0.0" },
    modern
      ? { versionNegotiation: { mode: "auto" } }
      : { supportedProtocolVersions: ["2025-06-18"] }
  );
  await withGatewayClient(client, assertion);
}

async function withGatewayClient(
  client: Client,
  assertion: (client: Client) => Promise<void>
): Promise<void> {
  const tempDirectory = await mkdtemp(join(tmpdir(), "mcp-gateway-test-"));
  const configPath = join(tempDirectory, "config.json");
  await writeFile(configPath, JSON.stringify({ services: [] }), "utf8");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      resolve("dist/index.js"),
      "--config",
      configPath
    ],
    cwd: process.cwd(),
    stderr: "pipe"
  });

  try {
    await client.connect(transport);
    await assertion(client);
  } finally {
    await client.close().catch(() => undefined);
    await rm(tempDirectory, { recursive: true, force: true });
  }
}
