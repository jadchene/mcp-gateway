import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { SUPPORTED_MCP_PROTOCOL_VERSIONS } from "../src/mcp/versions.ts";

/**
 * Creates the dual-era demo echo service used by local smoke tests.
 */
function createEchoServer(): McpServer {
  const server = new McpServer(
    { name: "demo-echo-service", version: "0.2.0" },
    {
      supportedProtocolVersions: [...SUPPORTED_MCP_PROTOCOL_VERSIONS],
      cacheHints: {
        "server/discover": { ttlMs: 60_000, cacheScope: "public" },
        "tools/list": { ttlMs: 300_000, cacheScope: "public" }
      }
    }
  );
  server.registerTool(
    "echo",
    {
      description: "Returns the provided message.",
      inputSchema: z.object({
        message: z.string().describe("Message to echo back.")
      }),
      outputSchema: z.object({
        echoed: z.string()
      })
    },
    async ({ message }) => ({
      content: [{ type: "text", text: message }],
      structuredContent: { echoed: message }
    })
  );
  return server;
}

serveStdio(createEchoServer, {
  legacy: "serve",
  onerror: (error) => process.stderr.write(`[echo-service] ${error.message}\n`)
});
