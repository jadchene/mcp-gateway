import { appendFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

const pidFile = process.env.MCP_TEST_PID_FILE;
if (pidFile) {
  appendFileSync(pidFile, `${process.pid}\n`, "utf8");
}

const server = new McpServer(
  { name: "windows-stdio-shim-fixture", version: "1.0.0" },
  { supportedProtocolVersions: ["2025-11-25"] }
);
server.registerTool(
  "echo",
  {
    inputSchema: z.object({ message: z.string() })
  },
  async ({ message }) => ({
    content: [{ type: "text", text: message }],
    structuredContent: { echoed: message }
  })
);

await server.connect(new StdioServerTransport());
