import http, { type IncomingMessage, type ServerResponse } from "node:http";

import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, rename, unlink, stat } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { resolveWebOptions } from "./options.ts";
import { configSchema, validateFormTypes, type Project } from "./schema.ts";

/** 配置服务的项目适配入口。
 * @author chenjd
 * @created 2026-11-17 16:00:00
 */
export interface ConfigWebAdapter {
  /** 当前项目。 */
  project: Project;
  /** 固定的配置文件路径。 */
  configPath: string;
  /** 原始命令行。 */
  args: string[];
  /** 项目默认 Web 端口。 */
  defaultPort: number;
  /** 无副作用的原有配置校验。 */
  validate: (raw: unknown) => unknown;
  /** 完成后返回成功，失败必须抛出异常。 */
  reload: () => Promise<unknown> | unknown;
  /** 额外的只读启动信息，不包含凭据。 */
  startup?: unknown;
}

/** 为固定配置文件提供受保护的管理页面。
 * @author chenjd
 * @created 2026-11-17 16:00:00
 */
export class ConfigWebServer {
  /** 底层监听器。 */
  private server?: http.Server;
  /** 串行保存链。 */
  private saving: Promise<unknown> = Promise.resolve();
  /** 配置服务适配器。 */
  private readonly adapter: ConfigWebAdapter;
  /** 构造时仅记录参数，不监听端口。 */
  constructor(adapter: ConfigWebAdapter) {
    this.adapter = adapter;
  }

  /** 读取文件版本和未做环境替换的配置。 */
  private async snapshot() {
    const text = await readFile(this.adapter.configPath, "utf8");
    return {
      config: JSON.parse(text) as Record<string, unknown>,
      revision: createHash("sha256").update(text).digest("hex"),
    };
  }

  /** 校验草稿并阻止修改启动字段。 */
  private validate(config: unknown, current: Record<string, unknown>): void {
    if (!config || typeof config !== "object" || Array.isArray(config))
      throw new Error("配置必须是 JSON 对象");
    if (
      !isDeepStrictEqual((config as Record<string, unknown>).web, current.web)
    )
      throw new Error("web 启动设置只读，请编辑文件后重启");
    validateFormTypes(config, configSchema(this.adapter.project));
    this.adapter.validate(config);
  }

  /** 启动独立端口；禁用时不创建服务器。 */
  async start(): Promise<void> {
    const initial = await this.snapshot();
    const { effective, sources } = resolveWebOptions(
      initial.config.web,
      this.adapter.args,
      this.adapter.defaultPort,
    );
    if (!effective.enabled) return;
    const scheme = "http";
    const url = `http://127.0.0.1:${effective.port}`;
    const allowedHosts = new Set([
      `127.0.0.1:${effective.port}`,
      `localhost:${effective.port}`,
    ]);
    let staticRoot = fileURLToPath(new URL("../web-ui/", import.meta.url));
    try {
      await stat(resolve(staticRoot, "index.html"));
    } catch {
      // 源码开发模式复用已构建页面，避免另外启动前端服务。
      staticRoot = fileURLToPath(
        new URL("../../dist/web-ui/", import.meta.url),
      );
      await stat(resolve(staticRoot, "index.html"));
    }
    const handler = (request: IncomingMessage, response: ServerResponse) => {
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("Referrer-Policy", "no-referrer");
      response.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
      );
      const reply = (status: number, value: unknown) => {
        response
          .writeHead(status, {
            "Content-Type": "application/json; charset=utf-8",
          })
          .end(JSON.stringify(value));
      };
      void (async () => {
        if (!allowedHosts.has(request.headers.host ?? ""))
          return reply(403, { error: "Host rejected" });
        const origin = request.headers.origin;
        if (
          origin &&
          ![...allowedHosts].some((value) => origin === `${scheme}://${value}`)
        )
          return reply(403, { error: "Origin rejected" });
        if (request.headers["sec-fetch-site"] === "cross-site")
          return reply(403, { error: "Cross-site request rejected" });
        const pathname = new URL(request.url ?? "/", url).pathname;
        if (!pathname.startsWith("/api/")) {
          if (request.method !== "GET")
            return reply(405, { error: "Method not allowed" });
          if (pathname !== "/" && !/^\/assets\/[a-zA-Z0-9_.-]+$/.test(pathname))
            return reply(404, { error: "Not found" });
          const file = resolve(
            staticRoot,
            pathname === "/" ? "index.html" : pathname.slice(1),
          );
          const data = await readFile(file);
          const contentType =
            (
              {
                ".html": "text/html",
                ".js": "text/javascript",
                ".css": "text/css",
                ".svg": "image/svg+xml",
              } as Record<string, string>
            )[extname(file)] ?? "application/octet-stream";
          response
            .writeHead(200, { "Content-Type": `${contentType}; charset=utf-8` })
            .end(data);
          return;
        }
        if (pathname === "/api/config" && request.method === "GET") {
          const current = await this.snapshot();
          return reply(200, {
            ...current,
            project: this.adapter.project,
            configPath: resolve(this.adapter.configPath),
            schema: configSchema(this.adapter.project),
            startup: this.adapter.startup,
            web: {
              effective,
              sources,
              restartRequired: !isDeepStrictEqual(
                current.config.web,
                initial.config.web,
              ),
            },
          });
        }
        if (
          !["/api/config", "/api/validate"].includes(pathname) ||
          request.method !== "POST"
        )
          return reply(404, { error: "Not found" });
        if (
          !origin ||
          !request.headers["content-type"]?.startsWith("application/json")
        )
          return reply(403, { error: "JSON and same-origin request required" });
        const body = await readBody(request);
        const run = async () => {
          const current = await this.snapshot();
          if (body.revision !== current.revision)
            return reply(409, {
              error: "配置文件已被修改，请保留草稿并重新加载核对",
            });
          this.validate(body.config, current.config);
          if (pathname === "/api/validate") return reply(200, { valid: true });
          const temp = `${this.adapter.configPath}.${randomUUID()}.tmp`;
          try {
            const existing = await stat(this.adapter.configPath);
            await writeFile(temp, `${JSON.stringify(body.config, null, 2)}\n`, {
              encoding: "utf8",
              mode: existing.mode & 0o777,
            });
            if ((await this.snapshot()).revision !== current.revision)
              return reply(409, { error: "配置文件已被修改，请重新加载核对" });
            await rename(temp, this.adapter.configPath);
          } finally {
            await unlink(temp).catch(() => undefined);
          }
          let loaded = true;
          let loadError: string | undefined;
          try {
            await this.adapter.reload();
          } catch (error) {
            loaded = false;
            loadError = error instanceof Error ? error.message : "加载失败";
          }
          const savedText = `${JSON.stringify(body.config, null, 2)}\n`;
          return reply(200, {
            saved: true,
            loaded,
            loadError,
            config: body.config,
            revision: createHash("sha256").update(savedText).digest("hex"),
          });
        };
        const pending = this.saving.catch(() => undefined).then(run);
        this.saving = pending;
        await pending;
      })().catch((error) => {
        if (!response.headersSent && !response.destroyed)
          reply(400, {
            error: error instanceof Error ? error.message : "配置操作失败",
          });
      });
    };
    this.server = http.createServer(handler);
    this.server.requestTimeout = 15000;
    await new Promise<void>((accept, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(effective.port, "127.0.0.1", () => {
        this.server!.off("error", reject);
        accept();
      });
    });
    process.stderr.write(`Configuration Web: ${url} (local only)\n`);
  }

  /** 停止入口并等待已开始的保存完成。 */
  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((accept) => server.close(() => accept()));
    await this.saving.catch(() => undefined);
  }
}

/** 有界读取请求，避免配置接口无限缓冲。 */
const readBody = async (
  request: IncomingMessage,
): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new Error("配置请求不能超过 2 MiB");
    chunks.push(Buffer.from(chunk));
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("请求必须是 JSON 对象");
  return value as Record<string, unknown>;
};
