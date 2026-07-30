import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

const protocolVersion = process.env.MCP_TEST_PROTOCOL_VERSION ?? "2025-06-18";
const server = new McpServer(
  { name: "mcp-2025-test-service", version: "1.0.0" },
  { supportedProtocolVersions: [protocolVersion] }
);

server.registerTool(
  "mcp_2025_echo",
  {
    description: `Echoes through a ${protocolVersion} stdio service.`,
    inputSchema: z.object({
      message: z.string()
    })
  },
  async ({ message }) => ({
    content: [{ type: "text", text: message }],
    structuredContent: { echoed: message }
  })
);

await server.connect(new StdioServerTransport());
