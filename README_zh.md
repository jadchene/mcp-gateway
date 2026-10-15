[English](./README.md) | 简体中文

# MCP Gateway

## 简介

MCP Gateway 把多个 MCP 服务收拢到一个入口。Agent 连接网关后最多只会看到 6 个路由工具，具体的下游服务、工具和 schema 在需要时再查询。

支持 stdio 和 Streamable HTTP，兼容 MCP `2026-07-28`、`2025-11-25` 和 `2025-06-18`；不支持旧式 `/sse` 入口。

## 快速开始

### 安装

需要 Node.js 24 或更高版本。

```bash
npm install -g @jadchene/mcp-gateway-service
```

按照[配置文件示例](#配置文件)创建 `config.json`，将下游命令、参数和路径替换为已经安装的 MCP 服务配置。

### Stdio

网关进程由 Agent 启动，不需要单独运行启动命令。

Codex：

```bash
codex mcp add gateway -- mcp-gateway-service --config /absolute/path/config.json
```

Claude Code：

```bash
claude mcp add gateway -- mcp-gateway-service --config /absolute/path/config.json
```

请将 `/absolute/path/config.json` 替换为刚创建的配置文件路径。Windows 可使用 `C:/mcp/gateway/config.json` 这样的写法。使用绝对路径可避免依赖客户端的工作目录。

### Streamable HTTP

启动网关：

```bash
mcp-gateway-service --http --config ./config.json
```

默认地址为 `http://127.0.0.1:3000/mcp`。
HTTP 默认隐藏 `gateway_manage_service`。监听非回环地址时，必须通过 `MCP_GATEWAY_AUTH_TOKEN` 配置 Bearer Token。

Codex：

```bash
codex mcp add gateway --url http://127.0.0.1:3000/mcp
```

Claude Code：

```bash
claude mcp add --transport http gateway http://127.0.0.1:3000/mcp
```

## 配置与工具

### 启动参数

| 参数 | 说明 | 默认值 |
| --- | --- | --- |
| `--config <path>` | 配置文件路径。 | `MCP_GATEWAY_CONFIG`，其次为 `./config.json` |
| `--http` | 启用 Streamable HTTP。 | 不启用 |
| `--host <host>` | HTTP 监听地址。 | `127.0.0.1` |
| `--port <port>` | HTTP 监听端口。 | `3000` |
| `--path <path>` | HTTP endpoint 路径。 | `/mcp` |
| `--auth-token-env <名称>` | 保存 HTTP Bearer Token 的环境变量名。 | `MCP_GATEWAY_AUTH_TOKEN` |
| `--http-admin-tools` | 在已认证 HTTP 入口暴露 `gateway_manage_service`。 | 不启用 |
| `--max-concurrent-requests <数量>` | HTTP 并发请求上限。 | `64` |
| `--max-request-body-bytes <字节数>` | HTTP 请求体字节上限，最大可配置为 64 MiB，超限返回 `413`。 | `16777216`（16 MiB） |
| `--max-legacy-sessions <数量>` | 有状态旧版 HTTP 会话的保留上限。 | `256` |
| `--version`、`-v` | 输出已安装版本。 | — |

启用 `--http` 后，stdio 入口仍然可用。

### 配置文件

```json
{
  "logging": {
    "enable": false,
    "path": "./logs/mcp-gateway.log",
    "maxBytes": 10485760
  },
  "services": [
    {
      "serviceId": "local-tools",
      "enable": true,
      "name": "Local Tools",
      "description": "Local MCP service",
      "callTimeoutMs": 120000,
      "confirmationRequiredTools": ["delete_*", "deploy_?"],
      "codexAutoReview": false,
      "disabledTools": ["internal_*", "legacy_tool"],
      "transport": {
        "type": "stdio",
        "command": "your-mcp-service",
        "args": ["--config", "/absolute/path/service/config.json"],
        "cwd": "/absolute/path/service",
        "env": {},
        "inheritEnv": false,
        "envAllowlist": []
      }
    },
    {
      "serviceId": "remote-tools",
      "enable": false,
      "name": "Remote Tools",
      "description": "Remote MCP service",
      "callTimeoutMs": 120000,
      "confirmationRequiredTools": [],
      "codexAutoReview": false,
      "disabledTools": [],
      "transport": {
        "type": "http",
        "url": "http://127.0.0.1:3200/mcp",
        "headers": {
          "Authorization": "Bearer replace-with-token"
        }
      }
    }
  ]
}
```

按需配置并启用使用的服务；HTTP 服务无需 Token 认证时，删除 `Authorization`。

| 配置 | 使用说明 |
| --- | --- |
| `serviceId` | 每个服务的唯一标识。 |
| `confirmationRequiredTools` | 完整工具名的匹配规则，区分大小写；`*` 匹配任意数量字符，`?` 匹配一个字符。匹配的调用须确认后执行。 |
| `disabledTools` | 使用相同匹配规则，隐藏并禁止调用匹配工具，优先于确认规则。 |
| `transport.cwd`、`transport.args` | 建议使用绝对路径；相对工作目录以网关进程目录为基准。 |
| `transport.env`、`transport.envAllowlist` | 分别提供环境变量值或允许传递的变量名。默认不继承自定义变量；`inheritEnv: true` 才继承完整环境。配置字符串不展开 `${VAR}`。 |
| `logging.path`、`logging.maxBytes` | 日志路径以配置目录为基准，达到大小上限时轮转。 |

配置会自动重载，无效更新保留上一份有效配置。完整示例也可直接复制 [config.example.json](config.example.json)。

### 网关工具

| 工具 | 说明 |
| --- | --- |
| `gateway_list_services` | 按服务标识或描述搜索已启用服务，并可按可用状态筛选。 |
| `gateway_get_service` | 查看服务连接状态、协议版本、服务端信息和最近一次错误。 |
| `gateway_list_tools` | 按名称或描述搜索服务中的工具，可同时返回 schema。 |
| `gateway_get_tool_schema` | 获取准确工具名称对应的 schema。 |
| `gateway_manage_service` | 重连服务，或在配置文件中启用、禁用服务。 |
| `gateway_call_tool` | 调用一个下游工具并返回 MCP 结果。 |

通常按 `gateway_list_services` → `gateway_list_tools` → 按需调用 `gateway_get_tool_schema` → `gateway_call_tool` 的顺序使用。下游工具没有参数时，`gateway_call_tool` 的 `arguments` 传 `{}`。

确认界面会展示服务、工具和参数，客户端须支持交互确认。执行结果不确定时不会自动重试。

需要 Codex 自动审查时，在指定服务的 `services[]` 配置块中设置 `"codexAutoReview": true`，并通过 `codex -c approvals_reviewer=auto_review` 启动 Codex。该设置作用于网关确认，下游服务自己的审批需独立配置。其他情况使用 Accept / Decline / Cancel 确认，是否批准仍由 Codex 策略决定。

支持 Skills 的 Agent 可以使用仓库内置的 [MCP Gateway Skill](./skills/mcp-gateway/SKILL.md) 完成工具发现和调用。

## 开发

```bash
git clone https://github.com/jadchene/mcp-gateway.git
cd mcp-gateway
npm install
npm run verify
```

按上文创建 `config.json` 后，启动开发服务：

```bash
npm run dev -- --config ./config.json
```

`npm run verify` 会构建服务；之后可用 `npm start -- --config ./config.json` 运行编译产物。

## 版权声明

[MIT](./LICENSE)
