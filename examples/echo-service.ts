import { createMessageReader, createMessageWriter, jsonRpcError, jsonRpcResult, type JsonRpcMessage, type JsonRpcRequest } from "../src/mcp/protocol.ts";

/**
 * Provides a tiny downstream MCP service used for local smoke testing.
 */
class EchoService {
  /**
   * Handles one JSON-RPC request and returns the response payload when needed.
   */
  public async handleRequest(request: JsonRpcRequest): Promise<JsonRpcMessage | null> {
    if (request.method === "initialize") {
      return jsonRpcResult(request.id, {
        protocolVersion: "2025-06-18",
        capabilities: {
          tools: {
            listChanged: false
          }
        },
        serverInfo: {
          name: "demo-echo-service",
          version: "0.1.0"
        }
      });
    }

    if (request.method === "tools/list") {
      return jsonRpcResult(request.id, {
        tools: [
          {
            name: "echo",
            description: "Returns the provided message.",
            inputSchema: {
              type: "object",
              properties: {
                message: {
                  type: "string",
                  description: "Message to echo back."
                }
              },
              required: ["message"],
              additionalProperties: false
            },
            outputSchema: {
              type: "object",
              properties: {
                echoed: {
                  type: "string"
                }
              },
              required: ["echoed"],
              additionalProperties: false
            }
          }
        ]
      });
    }

    if (request.method === "tools/call") {
      const params = (request.params ?? {}) as { name?: string; arguments?: { message?: string } };
      if (params.name !== "echo") {
        return jsonRpcError(request.id, -32601, `Unknown tool: ${String(params.name)}`);
      }

      const message = params.arguments?.message;
      if (typeof message !== "string") {
        return jsonRpcError(request.id, -32602, "The 'message' argument must be a string.");
      }

      return jsonRpcResult(request.id, {
        content: [
          {
            type: "text",
            text: message
          }
        ],
        structuredContent: {
          echoed: message
        }
      });
    }

    if (request.method === "ping") {
      return jsonRpcResult(request.id, {});
    }

    return jsonRpcError(request.id, -32601, `Unsupported method: ${request.method}`);
  }
}

const service = new EchoService();
const reader = createMessageReader(process.stdin, "auto");
const writer = createMessageWriter(process.stdout, "line");

reader.on("message", async (message: JsonRpcMessage) => {
  if ("id" in message && typeof message.method === "string") {
    const response = await service.handleRequest(message as JsonRpcRequest);
    if (response) {
      writer.write(response);
    }
  }
});
