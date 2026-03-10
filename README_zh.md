[English](./README.md) | 简体中文

# MCP Gateway

这个项目提供了一个轻量的 MCP 网关，用于实现**按需发现、节省 token**，并为多个下游 MCP 服务提供**统一接入入口**。

它不会在会话开始时把所有下游 MCP 工具一次性暴露给 AI，而是保持一个固定且很小的网关工具集合，让客户端按需：

- 先发现可用服务
- 再查看某个服务的工具列表
- 再查询某个工具的 schema
- 最后转发真实工具调用

## 为什么要用这个网关

这个网关主要解决的是一个很实际的问题：  
当你有多个 MCP 服务、多个 Agent 时，直接让每个 Agent 去分别配置所有 MCP，成本会越来越高。

通常会出现两个核心问题：

1. 工具太多，token 消耗太高
2. MCP 配置重复，维护成本太高

### 1. 降低 token 消耗

很多 MCP 服务本身会暴露几十甚至上百个工具。

如果一个 Agent 直接连接多个 MCP，客户端通常需要在会话开始时就把大量 tool 信息暴露给模型，这会带来：

- prompt 变长
- 工具发现成本变高
- schema 和工具描述反复进入上下文

这个网关的做法不是把所有下游工具都直接展开，而是只暴露一个很小的固定发现接口。

正常调用流程变成：

1. 先查看有哪些服务
2. 再查看某个服务下有哪些工具
3. 再查看某个工具的 schema
4. 最后真正调用这个工具

这样模型只会在需要时看到最少量的 MCP 元数据，更适合“按需发现”的使用方式。

### 2. 给多个 Agent 提供统一的 MCP 接入入口

如果没有网关，每个 Agent 往往都要分别配置多个下游 MCP 服务。

这种方式很快会带来维护问题：

- 下游服务一变，每个 Agent 配置都要改
- 命令路径、环境变量、工作目录会重复出现
- 密钥和本地路径分散在多个客户端配置里
- 不同 Agent 的配置很容易逐渐不一致

用了这个网关之后，下游 MCP 服务池只需要在网关配置里维护一次，多个 Agent 只需要连接这一个网关即可。

这样带来的好处是：

- 多个 MCP 统一成一个入口
- 下游服务的增删改集中在一个地方处理
- 更容易控制哪些服务对 Agent 可见
- 减少本地重复配置
- 更方便在 Codex、Claude Code、Gemini CLI 等不同客户端之间复用

简单说，这个网关的价值不只是“转发调用”，而是把多个 MCP 统一成一个可管理的服务池，同时把模型看到的工具上下文压缩到最小。

## 核心特点

### 按需发现，节省 Token
- 对外只暴露少量固定网关工具。
- 只在真正需要时查询服务工具列表和工具 schema。
- 避免把数百个下游 tool 在初始化阶段全部发给模型。

### 稳定的网关接口
- 不动态展开所有下游工具。
- 服务列表和工具列表返回精简结构。
- `gateway.callTool` 直接透传下游工具返回结果，减少额外包装。

### 实用运维能力
- 从 JSON 配置文件加载静态服务池。
- 监听配置文件变化并自动热刷新。
- 热刷新时会停掉已删除、已禁用或已被替换配置对应的下游进程。
- 下游进程异常时最多自动重启 3 次。
- 配置刷新失败时保留上一版有效快照。

## 快速开始

### 全局安装

```bash
npm install -g @jadchene/mcp-gateway-service
```

启动网关：

```bash
mcp-gateway-service
```

显式指定配置文件：

```bash
mcp-gateway-service --config ./config.json
```

### 从源码运行

先基于 `config.example.json` 自行创建本地 `config.json`，再启动网关：

```bash
npm install
npm run dev
```

默认读取 `./config.json`。
可以通过 `--config <path>` 为当前进程指定配置文件；如果未传 `--config`，则按 `MCP_GATEWAY_CONFIG`，再回退到 `./config.json`。

也可以通过环境变量指定：

```bash
$env:MCP_GATEWAY_CONFIG="config/gateway/config.json"
npm run dev
```

### 查看版本号

```bash
mcp-gateway-service --version
```

短参数：

```bash
mcp-gateway-service -v
```

## 配置格式

当前只支持 `stdio` 类型的下游传输。

只有当 `enable` 未填写或显式为 `true` 时，服务才会被加载；如果 `enable` 为 `false`，网关会跳过该服务。热刷新时，如果某个服务被禁用或从配置中删除，网关也会停掉它当前已启动的下游进程。

- `enable` 可选，不填时默认按启用处理
- `cwd` 可选，不填时使用当前工作目录
- `env` 可选
- `framing` 可选，不填时先尝试 `line`，再尝试 `content-length`

```json
{
  "services": [
    {
      "serviceId": "demo-echo",
      "enable": true,
      "name": "Demo Echo Service",
      "description": "Sample echo MCP service.",
      "transport": {
        "type": "stdio",
        "command": "node",
        "args": [
          "--experimental-strip-types",
          "examples/echo-service.ts"
        ]
      }
    }
  ]
}
```

## 对外网关工具

- `gateway.listServices`
- `gateway.getService`
- `gateway.listTools`
- `gateway.getToolSchema`
- `gateway.callTool`

### 返回结构约定

- `gateway.listServices` 只返回 `serviceId`、`description`、`available`
- `gateway.listTools` 只返回 `name`、`description`
- `gateway.getToolSchema` 只返回 `inputSchema`、`outputSchema`
- `gateway.callTool` 直接返回下游 MCP 的结果，不再额外包一层网关元数据

## 推荐调用流程

为了尽量节省 token，推荐由客户端缓存发现结果，而不是每次都重新调用网关：

1. 会话开始时调用一次 `gateway.listServices`
2. 真正需要某个服务时，再调用 `gateway.listTools(serviceId)`
3. 第一次调用某个工具前，再调用 `gateway.getToolSchema(serviceId, toolName)`
4. 执行时调用 `gateway.callTool(...)`
5. 只有在调用失败、配置变更、或明确需要刷新时才重新发现

## Skill 集成（推荐）

仓库内包含一个面向公开使用者的 skill：

- 路径：`skills/mcp-gateway/SKILL.md`

主要用于指导代理：

- 按需发现服务和工具
- 避免无意义地枚举大量 tool
- 通过网关的最小接口完成下游调用

## MCP 客户端接入示例

下面示例都使用相对路径，方便迁移。

### Codex

`~/.codex/config.toml`

```toml
[mcp_servers.gateway]
command = "mcp-gateway-service"
args = ["--config", "./config.json"]
```

### Gemini CLI

`~/.gemini/settings.json`

```json
{
  "mcpServers": {
    "gateway": {
      "type": "stdio",
      "command": "mcp-gateway-service",
      "args": [
        "--config",
        "./config.json"
      ]
    }
  }
}
```

### Claude Code

`~/.claude.json`

```json
{
  "mcpServers": {
    "gateway": {
      "type": "stdio",
      "command": "mcp-gateway-service",
      "args": [
        "--config",
        "./config.json"
      ]
    }
  }
}
```

## 开发说明

- 仓库只保留 `config.example.json` 作为示例
- 运行前请自行复制一份本地 `config.json`
- 真实本地配置和日志建议放在仓库外
- 只有下游服务自己暴露了 `outputSchema` 时，网关才会返回它
- Windows 下支持解析 PowerShell shim 命令，例如实际落到 `.ps1` 的全局命令
- 在 Windows 上，网关会优先使用 `pwsh` 解析和执行 `.ps1` shim；如果机器上没有 `pwsh`，会自动回退到 `powershell.exe`

## License

项目采用 [MIT License](./LICENSE) 开源。
