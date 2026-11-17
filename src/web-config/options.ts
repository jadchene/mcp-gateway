/** Web 启动配置；仅从文件和命令行读取。
 * @author chenjd
 * @created 2026-11-17 16:00:00
 */
export interface WebConfig {
  /** 是否启用配置页面。 */
  enabled?: boolean;
  /** 监听地址。 */
  host?: string;
  /** 独立监听端口。 */
  port?: number;
}

/** 检查 Web 文件配置，未设置时保持禁用。 */
export const validateWebConfig = (input: unknown): WebConfig => {
  if (input === undefined) return {};
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("web must be an object");
  const value = input as Record<string, unknown>;
  for (const key of Object.keys(value)) {
    if (!["enabled", "host", "port"].includes(key))
      throw new Error(`Unknown web.${key}`);
  }
  if (value.enabled !== undefined && typeof value.enabled !== "boolean")
    throw new Error("web.enabled must be boolean");
  if (
    value.port !== undefined &&
    (!Number.isInteger(value.port) ||
      Number(value.port) < 1 ||
      Number(value.port) > 65535)
  )
    throw new Error("web.port must be 1–65535");
  if (value.host !== undefined && value.host !== "127.0.0.1")
    throw new Error(
      "Web only supports 127.0.0.1; remote listening is disabled",
    );
  return value as WebConfig;
};

/** 分离 Web 参数，不改变原有 MCP 参数的含义。 */
export const parseWebArgs = (args: string[]) => {
  const remaining: string[] = [];
  const overrides: WebConfig = {};
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (!["--web", "--no-web", "--web-host", "--web-port"].includes(arg)) {
      remaining.push(arg);
      continue;
    }
    if (seen.has(arg)) throw new Error(`Duplicate option ${arg}`);
    seen.add(arg);
    if (arg === "--web" || arg === "--no-web")
      overrides.enabled = arg === "--web";
    else {
      const value = args[++index];
      if (!value || value.startsWith("--"))
        throw new Error(`${arg} requires a value`);
      if (arg === "--web-host") overrides.host = value;
      else overrides.port = Number(value);
    }
  }
  if (seen.has("--web") && seen.has("--no-web"))
    throw new Error("--web and --no-web cannot be combined");
  validateWebConfig(overrides);
  return { remaining, overrides };
};

/** 合并默认值、文件值和本次进程覆盖，并提供可展示的来源。 */
export const resolveWebOptions = (
  raw: unknown,
  args: string[],
  port: number,
) => {
  const file = validateWebConfig(raw);
  const { overrides } = parseWebArgs(args);
  const defaults = { enabled: false, host: "127.0.0.1", port };
  const effective = { ...defaults, ...file, ...overrides, host: "127.0.0.1" };
  const sources = Object.fromEntries(
    Object.keys(effective).map((key) => [
      key,
      key === "host"
        ? "固定本机"
        : Object.hasOwn(overrides, key)
          ? "命令行"
          : Object.hasOwn(file, key)
            ? "配置文件"
            : "默认值",
    ]),
  );
  return { effective, sources };
};
