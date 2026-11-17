import http from "node:http";

// 模拟提供独立 Web 页面的 stdio 服务，让重复启动暴露端口冲突。
const web = http.createServer((_request, response) => response.end(String(process.pid)));
await new Promise<void>((resolve, reject) => {
  web.once("error", reject);
  web.listen(Number(process.env.MCP_TEST_WEB_PORT), "127.0.0.1", resolve);
});
process.stdin.once("end", () => web.close());
await import("../../examples/echo-service.ts");
