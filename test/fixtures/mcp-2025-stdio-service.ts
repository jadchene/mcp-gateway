import { McpServer, acceptedContent, inputRequired } from "@modelcontextprotocol/server";
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

server.registerTool(
  "mcp_2025_confirm",
  {
    description: `Requests form confirmation through MCP ${protocolVersion}.`,
    inputSchema: z.object({
      operation: z.string()
    })
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
        requestState: "stdio-downstream-state-v1"
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

await server.connect(new StdioServerTransport());
