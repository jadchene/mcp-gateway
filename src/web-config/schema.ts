/** 可视化字段描述；保持原始配置，不补写默认值。
 * @author chenjd
 * @created 2026-11-17 16:00:00
 */
export interface Field {
  /** 字段类型，可选联合类型。 */
  type: string;
  /** 中文说明。 */
  label?: string;
  /** 已知对象字段。 */
  properties?: Record<string, Field>;
  /** 数组项或映射值的描述。 */
  item?: Field;
  /** 可选枚举值。 */
  options?: string[];
  /** 必填字段。 */
  required?: boolean;
  /** 默认值提示。 */
  default?: unknown;
  /** 数值下限。 */
  min?: number;
  /** 数值上限。 */
  max?: number;
  /** 密码控件。 */
  secret?: boolean;
  /** 多行输入。 */
  multiline?: boolean;
  /** 根据父对象 type 选择字段结构。 */
  variants?: Record<string, Field>;
}

/** 支持的项目标识。 */
export type Project = "gateway" | "ssh" | "database";
const string = (label: string, required = false): Field => ({
  type: "string",
  label,
  required,
});
const bool = (label: string, value = false): Field => ({
  type: "boolean",
  label,
  default: value,
});
const number = (
  label: string,
  min: number,
  max: number,
  value?: number,
): Field => ({ type: "number", label, min, max, default: value });
const object = (
  label: string,
  properties: Record<string, Field>,
  required = false,
): Field => ({ type: "object", label, properties, required });
const array = (label: string, item: Field, required = false): Field => ({
  type: "array",
  label,
  item,
  required,
});
const map = (label: string, item: Field): Field => ({
  type: "map",
  label,
  item,
});
const enumeration = (label: string, options: string[]): Field => ({
  type: "string",
  label,
  options,
  required: true,
});
const password = (label: string, required = false): Field => ({
  ...string(label, required),
  secret: true,
});
const strings = (label: string): Field => array(label, string("值"));
const port = (value?: number): Field => number("端口", 1, 65535, value);
const timeout = (label = "连接超时（毫秒）"): Field =>
  number(label, 1, 2147483647);
const sessionFields = {
  sessionIdleTimeoutMs: number("会话空闲超时（毫秒）", 100, 86400000, 1800000),
  maxSessions: number("会话上限", 1, 1024, 32),
};
const access = {
  enable: bool("启用", true),
  codexAutoReview: bool("Codex 自动审批"),
  dangerMode: bool("Full Access"),
};
const identity = {
  host: string("主机", true),
  port: port(22),
  username: string("用户名", true),
  password: password("密码"),
  privateKeyPath: string("私钥文件路径"),
  privateKey: { ...password("私钥内容"), multiline: true },
  passphrase: password("私钥口令"),
  strictHostKeyChecking: bool("校验主机密钥", true),
  hostKeySha256: {
    type: "string|array",
    label: "主机 SHA-256 指纹",
    item: string("指纹"),
  },
};
const sqlConnection = {
  host: string("主机", true),
  port: port(),
  databaseName: string("数据库名", true),
  user: string("用户名", true),
  password: password("密码", true),
  connectTimeoutMs: timeout(),
  ssl: {
    type: "boolean|map",
    label: "SSL",
    item: { type: "any", label: "SSL 选项" },
  },
};

/** 根据原有配置结构提供完整字段表；web 由只读启动区域展示。 */
export const configSchema = (project: Project): Field => {
  if (project === "gateway")
    return object("Gateway 配置", {
      logging: object("日志", {
        enable: bool("启用文件日志"),
        path: string("日志路径"),
        maxBytes: number(
          "单文件字节上限",
          1024,
          Number.MAX_SAFE_INTEGER,
          10485760,
        ),
      }),
      services: array(
        "下游 MCP 服务",
        object("服务", {
          serviceId: string("服务标识", true),
          name: string("名称", true),
          description: string("描述"),
          enable: bool("启用", true),
          webUrl: string("Web 配置地址"),
          codexAutoReview: bool("Codex 自动审批"),
          callTimeoutMs: number("调用超时（毫秒）", 1, 86400000),
          confirmationRequiredTools: strings("需要确认的工具"),
          disabledTools: strings("禁用工具"),
          transport: { ...object("传输配置", {}, true), variants: {} },
        }),
        true,
      ),
    });
  if (project === "ssh")
    return object("SSH 配置", {
      ...sessionFields,
      logDir: string("日志目录"),
      defaultTimeout: number("命令超时（毫秒）", 100, 3600000, 60000),
      commandBlacklist: strings("命令黑名单正则"),
      commandWhitelist: strings("命令白名单正则"),
      allowedLocalRoots: strings("允许的本地目录"),
      servers: {
        ...map(
          "SSH 主机",
          object("主机", {
            ...identity,
            ...access,
            readOnly: bool("只读模式"),
            desc: string("描述"),
            allowedRemoteRoots: strings("允许删除的远程根目录"),
            workingDirectories: map(
              "工作目录",
              object("目录", {
                path: string("路径", true),
                desc: string("描述", true),
              }),
            ),
            proxyJump: object("跳板机", identity),
          }),
        ),
        required: true,
      },
    });
  return object("Database 配置", {
    ...sessionFields,
    logging: object("日志", {
      enabled: bool("启用文件日志"),
      directory: string("日志目录"),
    }),
    query: object("查询设置", { timeoutMs: timeout("查询超时（毫秒）") }),
    databases: array(
      "数据源",
      object("数据库", {
        key: string("标识", true),
        type: enumeration("数据库类型", [
          "mysql",
          "oracle",
          "postgresql",
          "redis",
        ]),
        readonly: { ...bool("只读模式", true), required: true },
        ...access,
        connection: {
          ...object("连接配置", {}, true),
          variants: {
            mysql: object("MySQL 连接", { ...sqlConnection, port: port(3306) }),
            postgresql: object("PostgreSQL 连接", {
              ...sqlConnection,
              port: port(5432),
            }),
            oracle: object("Oracle 连接", {
              host: string("主机", true),
              port: port(1521),
              serviceName: string("服务名"),
              sid: string("SID"),
              user: string("用户名", true),
              password: password("密码", true),
              connectTimeoutMs: timeout(),
              clientMode: {
                ...enumeration("客户端模式", ["thin", "thick"]),
                required: false,
              },
              clientLibDir: string("客户端库目录"),
            }),
            redis: object("Redis 连接", {
              url: password("连接 URL"),
              host: string("主机"),
              port: port(6379),
              databaseName: number("数据库编号", 0, Number.MAX_SAFE_INTEGER),
              username: string("用户名"),
              password: password("密码"),
              connectTimeoutMs: timeout(),
            }),
          },
        },
      }),
      true,
    ),
  });
};

/** 传输类型从自身读取，连接类型从父级读取；无关字段仍留在草稿中。 */
export const resolveField = (
  field: Field,
  value: unknown,
  parent?: Record<string, unknown>,
): Field => {
  if (field.label === "传输配置") {
    const type = (value as Record<string, unknown> | undefined)?.type;
    return object(
      "传输配置",
      {
        type: enumeration("传输类型", ["stdio", "http"]),
        ...(type === "http"
          ? {
              url: string("MCP HTTP 地址", true),
              headers: map("请求头", password("值")),
            }
          : {
              command: string("启动命令", true),
              args: strings("命令参数"),
              cwd: string("工作目录"),
              env: map("环境变量", password("值")),
              inheritEnv: bool("继承全部环境变量"),
              envAllowlist: strings("允许继承的环境变量"),
            }),
      },
      true,
    );
  }
  return field.variants?.[String(parent?.type)] ?? field;
};

/** 验证已知字段的类型，未知字段交给项目原有规则处理。 */
export const validateFormTypes = (
  value: unknown,
  raw: Field,
  path = "",
  parent?: Record<string, unknown>,
): void => {
  const field = resolveField(raw, value, parent);
  if (value === undefined) return;
  if (field.type === "any") return;
  const type = Array.isArray(value)
    ? "array"
    : value !== null && typeof value === "object"
      ? "object"
      : typeof value;
  if (
    !field.type
      .split("|")
      .map((item) => (item === "map" ? "object" : item))
      .includes(type)
  )
    throw new Error(`${path || "配置"}: 应为 ${field.type}`);
  if (field.options && !field.options.includes(String(value)))
    throw new Error(`${path}: 可选值为 ${field.options.join(", ")}`);
  if (
    type === "number" &&
    (!Number.isInteger(value) ||
      Number(value) < (field.min ?? -Infinity) ||
      Number(value) > (field.max ?? Infinity))
  )
    throw new Error(`${path}: 数值超出允许范围`);
  if (type === "array")
    (value as unknown[]).forEach((item, index) =>
      validateFormTypes(
        item,
        field.item ?? { type: "any" },
        `${path}[${index}]`,
      ),
    );
  if (type === "object") {
    for (const [key, child] of Object.entries(
      value as Record<string, unknown>,
    )) {
      const descriptor =
        field.properties && Object.hasOwn(field.properties, key)
          ? field.properties[key]
          : field.item;
      if (descriptor)
        validateFormTypes(
          child,
          descriptor,
          path ? `${path}.${key}` : key,
          value as Record<string, unknown>,
        );
    }
  }
};
