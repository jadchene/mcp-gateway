import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

const version = process.argv[2];

/** 由测试指令增删真实 SDK 工具，触发下游协议通知。 */
function createServer() {
  const server = new McpServer({ name: "changing-tools", version: "1" }, { supportedProtocolVersions: [version] });
  if (process.argv.includes("--exit-test")) {
    server.registerTool(`process_${process.pid}`, {}, async () => ({ content: [] }));
    server.registerTool("end_session", {}, async () => {
      // 先让 SDK 发送调用结果，再模拟此下游自行退出。
      setTimeout(() => process.exit(0), 100);
      return { content: [] };
    });
  }
  const sample = server.registerTool("sample", {}, async () => ({ content: [] }));
  sample.disable();
  server.registerTool("configure_sample", { inputSchema: z.object({ visible: z.boolean() }) }, async ({ visible }) => {
    if (visible) sample.enable();
    else sample.disable();
    return { content: [] };
  });
  return server;
}

if (version === "2026-07-28") serveStdio(createServer);
else await createServer().connect(new StdioServerTransport());
