import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  Client,
  isInputRequiredResult,
  type CallToolResult,
  type InputRequiredResult
} from "@modelcontextprotocol/client";
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

for (const protocolVersion of ["2025-11-25", "2025-06-18"] as const) {
  test(`StdioMcpClient auto-negotiation safely falls back to a ${protocolVersion} sibling process`, async () => {
    const client = new StdioMcpClient({
      serviceId: `mcp-${protocolVersion}-stdio`,
      enable: true,
      name: `MCP ${protocolVersion} stdio`,
      transport: {
        type: "stdio",
        command: process.execPath,
        args: ["--experimental-strip-types", "test/fixtures/mcp-2025-stdio-service.ts"],
        cwd: process.cwd(),
        env: {
          MCP_TEST_PROTOCOL_VERSION: protocolVersion
        }
      }
    }, new Logger());

    try {
      const metadata = await client.getMetadata();
      assert.equal(metadata.protocolEra, "legacy");
      assert.equal(metadata.protocolVersion, protocolVersion);
      assert.deepEqual(metadata.tools.map((tool) => tool.name), ["mcp_2025_echo", "mcp_2025_confirm"]);
      const result = await client.callTool("mcp_2025_echo", { message: protocolVersion });
      assert.deepEqual(result.structuredContent, { echoed: protocolVersion });

      const first = await client.callTool("mcp_2025_confirm", { operation: protocolVersion });
      assert.equal(isInputRequiredResult(first), true);
      const inputRequiredResult = first as InputRequiredResult;
      assert.ok(inputRequiredResult.requestState);
      assert.match(inputRequiredResult.requestState, /^mcp-gateway-form-elicitation-v1\./);
      assert.equal(inputRequiredResult.inputRequests?.form?.method, "elicitation/create");

      const second = await client.callTool(
        "mcp_2025_confirm",
        { operation: protocolVersion },
        {
          requestState: inputRequiredResult.requestState,
          inputResponses: {
            form: {
              action: "accept",
              content: { confirmed: true }
            }
          }
        }
      ) as CallToolResult | InputRequiredResult;
      assert.equal(isInputRequiredResult(second), false);
      assert.deepEqual((second as CallToolResult).structuredContent, {
        operation: protocolVersion,
        confirmed: true,
        state: "stdio-downstream-state-v1"
      });
    } finally {
      await client.dispose();
    }
  });
}

test("StdioMcpClient rejects protocol revisions outside the three-version allow-list", async () => {
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
  }, "2026-07-28");
});

for (const protocolVersion of ["2025-11-25", "2025-06-18"] as const) {
  test(`gateway CLI serves MCP ${protocolVersion} over upstream stdio`, async () => {
    await withGatewayProcess(async (client) => {
      assert.equal(client.getProtocolEra(), "legacy");
      assert.equal(client.getNegotiatedProtocolVersion(), protocolVersion);
      assert.equal((await client.listTools()).tools.length, 6);
      const result = await client.callTool({
        name: "gateway_list_services",
        arguments: {}
      });
      assert.deepEqual(result.structuredContent, { services: [] });
    }, protocolVersion);
  });
}

test("gateway CLI rejects stdio clients that only support an excluded revision", async () => {
  const client = new Client(
    { name: "unsupported-stdio-upstream", version: "1.0.0" },
    { supportedProtocolVersions: ["2025-03-26"] }
  );
  await assert.rejects(
    withGatewayClient(client, async () => undefined),
    /protocol version is not supported: 2025-11-25/
  );
});

test("gateway CLI automatically serves a modern stdio client", async () => {
  await withGatewayProcess(async (client) => {
    assert.equal(client.getProtocolEra(), "modern");
    assert.equal(client.getNegotiatedProtocolVersion(), "2026-07-28");
  }, "2026-07-28");
});

async function withGatewayProcess(
  assertion: (client: Client) => Promise<void>,
  protocolVersion: "2026-07-28" | "2025-11-25" | "2025-06-18"
): Promise<void> {
  const modern = protocolVersion === "2026-07-28";
  const client = new Client(
    { name: modern ? "modern-stdio-upstream" : "legacy-stdio-upstream", version: "1.0.0" },
    modern
      ? { versionNegotiation: { mode: "auto" } }
      : { supportedProtocolVersions: [protocolVersion] }
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
