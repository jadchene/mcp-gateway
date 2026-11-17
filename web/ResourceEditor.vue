<script setup>
import { computed, ref, watch } from "vue";
import { ElMessageBox } from "element-plus";
import FieldInput from "./FieldInput.vue";
import FieldGrid from "./FieldGrid.vue";
import ListEditor from "./ListEditor.vue";
import KeyValueEditor from "./KeyValueEditor.vue";
import SshConnection from "./SshConnection.vue";
import OptionEditor from "./OptionEditor.vue";
import UiIcon from "./UiIcon.vue";
import { configSchema, resolveField } from "../src/web-config/schema";
const props = defineProps({
  project: String,
  modelValue: Object,
  alias: String,
  savedUrl: String,
});
const emit = defineEmits(["update:modelValue", "rename", "remove"]);
const tab = ref("connection");
watch(
  () => props.alias,
  () => {
    tab.value = "connection";
  },
);
const base = computed(() => {
  const root = configSchema(props.project).properties;
  return props.project === "gateway"
    ? root.services.item.properties
    : props.project === "ssh"
      ? root.servers.item.properties
      : root.databases.item.properties;
});
const pick = (source, keys) => keys.map((key) => ({ key, ...source[key] }));
const connection = computed(
  () =>
    props.modelValue?.[
      props.project === "gateway" ? "transport" : "connection"
    ] ?? {},
);
const connectionSchema = computed(
  () =>
    resolveField(
      base.value[props.project === "gateway" ? "transport" : "connection"] ??
        {},
      connection.value,
      props.modelValue,
    ).properties ?? {},
);
const update = (key, value) => {
  const next = { ...props.modelValue };
  if (value === undefined) delete next[key];
  else next[key] = value;
  emit("update:modelValue", next);
};
const updateConnection = (value) =>
  update(props.project === "gateway" ? "transport" : "connection", value);
const connectionValue = (key, value) => {
  const next = { ...connection.value };
  if (value === undefined) delete next[key];
  else next[key] = value;
  updateConnection(next);
};
const title = computed(() =>
  props.project === "gateway"
    ? props.modelValue.name || "未命名服务"
    : props.project === "ssh"
      ? props.modelValue.desc || props.alias
      : props.modelValue.key || "未命名数据源",
);
const identifier = computed(() =>
  props.project === "gateway"
    ? props.modelValue.serviceId
    : props.project === "database"
      ? props.modelValue.key
      : props.alias,
);
const typeLabel = computed(() =>
  props.project === "gateway"
    ? connection.value.type === "http"
      ? "HTTP 服务"
      : "本地进程"
    : props.project === "ssh"
      ? "SSH 主机"
      : (props.modelValue.type || "数据库").toUpperCase(),
);
/** 数据库类型切换只替换连接字段，先明确提示用户会清理当前连接配置。 */
const changeDatabase = async (type) => {
  try {
    await ElMessageBox.confirm(
      "更换数据库类型将重置连接参数。其他设置会保留，保存后生效。",
      "更换数据库类型",
      { confirmButtonText: "更换并重置", cancelButtonText: "取消" },
    );
  } catch {
    return;
  }
  emit("update:modelValue", {
    ...props.modelValue,
    type,
    connection:
      type === "redis"
        ? { host: "" }
        : type === "oracle"
          ? { host: "", user: "", password: "", serviceName: "" }
          : { host: "", databaseName: "", user: "", password: "" },
  });
};
const changeTransport = async (type) => {
  try {
    await ElMessageBox.confirm(
      "切换连接方式将清空当前连接参数，包括命令、参数、环境变量或 HTTP 地址、请求头。其他服务设置会保留。",
      "切换连接方式",
      { confirmButtonText: "切换并重置", cancelButtonText: "取消" },
    );
  } catch {
    return;
  }
  updateConnection(
    type === "http" ? { type, url: "" } : { type, command: "", args: [] },
  );
};
const workingDirectories = computed(
  () => props.modelValue.workingDirectories ?? {},
);
const addDirectory = () => {
  let index = 1;
  while (Object.hasOwn(workingDirectories.value, `directory-${index}`)) index++;
  update("workingDirectories", {
    ...workingDirectories.value,
    [`directory-${index}`]: { path: "", desc: "" },
  });
};
const directoryValue = (key, field, value) =>
  update("workingDirectories", {
    ...workingDirectories.value,
    [key]: { ...workingDirectories.value[key], [field]: value },
  });
const renameDirectory = (key, value) => {
  if (!value || value === key) return;
  if (Object.hasOwn(workingDirectories.value, value)) {
    void ElMessageBox.alert("目录名称不能重复", "名称冲突");
    return;
  }
  const next = {
    ...workingDirectories.value,
    [value]: workingDirectories.value[key],
  };
  delete next[key];
  update("workingDirectories", next);
};
const removeDirectory = (key) => {
  const next = { ...workingDirectories.value };
  delete next[key];
  update("workingDirectories", next);
};
const sslEnabled = computed(() => Boolean(connection.value.ssl));
const setSsl = async (enabled) => {
  if (
    !enabled &&
    typeof connection.value.ssl === "object" &&
    Object.keys(connection.value.ssl ?? {}).length
  ) {
    try {
      await ElMessageBox.confirm(
        "关闭或清除 SSL 将移除已配置的证书和 SSL 选项，是否继续？",
        "移除 SSL 配置",
        { confirmButtonText: "移除", cancelButtonText: "取消" },
      );
    } catch {
      return;
    }
  }
  connectionValue(
    "ssl",
    enabled === undefined
      ? undefined
      : enabled
        ? connection.value.ssl || true
        : false,
  );
};
</script>

<template>
  <section class="resource-detail">
    <header class="detail-header">
      <div class="detail-title">
        <span class="resource-symbol"><UiIcon :name="project" /></span>
        <div>
          <h2>{{ title }}</h2>
          <p>
            {{ typeLabel
            }}<template v-if="identifier !== title"
              ><span class="middle-dot">·</span>{{ identifier }}</template
            >
          </p>
        </div>
      </div>
      <div
        class="enable-control"
        :class="{ enabled: modelValue.enable !== false }"
      >
        <span>{{
          modelValue.enable !== false ? "已启用" : "未启用"
        }}</span><el-switch
          :model-value="modelValue.enable !== false"
          @update:model-value="update('enable', $event)"
          aria-label="启用当前配置"
        />
      </div>
    </header>
    <nav class="detail-tabs">
      <button
        :class="{ active: tab === 'connection' }"
        :aria-pressed="tab === 'connection'"
        @click="tab = 'connection'"
      >
        <UiIcon :name="project" />连接设置</button
      ><button
        :class="{ active: tab === 'policy' }"
        :aria-pressed="tab === 'policy'"
        @click="tab = 'policy'"
      >
        <UiIcon name="shield" />访问策略</button
      ><button
        :class="{ active: tab === 'advanced' }"
        :aria-pressed="tab === 'advanced'"
        @click="tab = 'advanced'"
      >
        <UiIcon name="settings" />更多设置
      </button>
    </nav>
    <div class="detail-content">
      <template v-if="tab === 'connection'">
        <section class="form-section">
          <div class="section-heading">
            <h3>基本信息</h3>
            <p>为配置起一个容易识别的名称</p>
          </div>
          <FieldGrid
            v-if="project === 'gateway'"
            :model-value="modelValue"
            @update:model-value="emit('update:modelValue', $event)"
            :fields="
              pick(base, ['name', 'serviceId']).map((field) => ({
                ...field,
                hint:
                  field.key === 'serviceId'
                    ? '供 MCP 客户端识别的唯一名称'
                    : undefined,
              }))
            "
          />
          <div v-else-if="project === 'ssh'" class="form-grid">
            <FieldInput
              label="主机名称"
              :model-value="modelValue.desc"
              @update:model-value="update('desc', $event)"
              placeholder="例如：生产环境 Web 服务器"
            /><FieldInput
              commit
              label="主机标识"
              :model-value="alias"
              @update:model-value="emit('rename', $event)"
              required
              hint="供 MCP 客户端连接使用的唯一名称"
            />
          </div>
          <div v-else class="form-grid">
            <FieldInput
              label="数据源名称"
              :model-value="modelValue.key"
              @update:model-value="update('key', $event)"
              required
              placeholder="例如：业务数据库"
            /><FieldInput
              label="数据库类型"
              type="select"
              :model-value="modelValue.type"
              @update:model-value="changeDatabase"
              :options="[
                { value: 'mysql', label: 'MySQL' },
                { value: 'postgresql', label: 'PostgreSQL' },
                { value: 'oracle', label: 'Oracle' },
                { value: 'redis', label: 'Redis' },
              ]"
              required
            />
          </div>
        </section>
        <section class="form-section">
          <div class="section-heading">
            <h3>
              {{
                project === "gateway"
                  ? "连接方式"
                  : project === "ssh"
                    ? "服务器连接"
                    : "数据库连接"
              }}
            </h3>
            <p>
              {{
                project === "gateway"
                  ? "选择本地启动进程，或连接已有 HTTP 服务"
                  : "凭据仅在保存后应用到服务配置"
              }}
            </p>
          </div>
          <template v-if="project === 'gateway'">
            <div class="connection-choice">
              <button
                :class="{ selected: connection.type !== 'http' }"
                @click="connection.type === 'http' && changeTransport('stdio')"
              >
                <span><UiIcon name="ssh" /></span><strong>本地进程</strong
                ><small>通过命令启动 · stdio</small></button
              ><button
                :class="{ selected: connection.type === 'http' }"
                @click="connection.type !== 'http' && changeTransport('http')"
              >
                <span><UiIcon name="external" /></span><strong>HTTP 服务</strong
                ><small>连接已有的 MCP 地址</small>
              </button>
            </div>
            <FieldGrid
              :model-value="connection"
              @update:model-value="updateConnection"
              :fields="
                pick(
                  connectionSchema,
                  connection.type === 'http' ? ['url'] : ['command', 'cwd'],
                ).map((field) => ({
                  ...field,
                  wide: connection.type === 'http',
                  placeholder:
                    field.key === 'command'
                      ? '例如 npx、node 或可执行文件路径'
                      : field.key === 'url'
                        ? 'https://example.com/mcp'
                        : '可选，以服务运行目录为准',
                }))
              "
            />
            <ListEditor
              v-if="connection.type !== 'http'"
              label="启动参数"
              hint="每行一个参数，按从上到下的顺序传入命令"
              :model-value="connection.args"
              @update:model-value="connectionValue('args', $event)"
              placeholder="例如 --config"
            />
            <KeyValueEditor
              v-else
              label="HTTP 请求头"
              :model-value="connection.headers"
              @update:model-value="connectionValue('headers', $event)"
              secret
            />
          </template>
          <SshConnection
            v-else-if="project === 'ssh'"
            :model-value="modelValue"
            @update:model-value="emit('update:modelValue', $event)"
          />
          <template v-else>
            <FieldGrid
              :model-value="connection"
              @update:model-value="updateConnection"
              :fields="
                pick(
                  connectionSchema,
                  modelValue.type === 'redis'
                    ? ['host', 'port', 'databaseName', 'username', 'password']
                    : modelValue.type === 'oracle'
                      ? [
                          'host',
                          'port',
                          'serviceName',
                          'sid',
                          'user',
                          'password',
                        ]
                      : ['host', 'port', 'databaseName', 'user', 'password'],
                ).map((field) => ({
                  ...field,
                  wide: field.key === 'databaseName',
                }))
              "
            />
            <details
              v-if="modelValue.type === 'redis'"
              class="advanced-section"
            >
              <summary>
                使用连接 URL<span>已设置时由 Redis 客户端使用该 URL</span>
              </summary>
              <div class="advanced-body">
                <FieldInput
                  label="Redis 连接 URL"
                  type="password"
                  :model-value="connection.url"
                  @update:model-value="connectionValue('url', $event)"
                  placeholder="redis://…"
                />
              </div>
            </details>
            <details
              v-if="['mysql', 'postgresql'].includes(modelValue.type)"
              class="advanced-section"
            >
              <summary>
                加密连接<span
                  class="summary-status"
                  :class="{ configured: sslEnabled }"
                  >{{ sslEnabled ? "SSL 已配置" : "未启用 SSL" }}</span
                >
              </summary>
              <div class="advanced-body">
                <FieldInput
                  label="启用 SSL"
                  type="switch"
                  :model-value="
                    connection.ssl === undefined ? undefined : sslEnabled
                  "
                  @update:model-value="setSsl"
                /><template v-if="sslEnabled"
                  ><button
                    v-if="typeof connection.ssl !== 'object'"
                    class="text-action"
                    @click="connectionValue('ssl', {})"
                  >
                    配置证书及验证选项</button
                  ><OptionEditor
                    v-else
                    label="SSL 选项"
                    :model-value="connection.ssl"
                    @update:model-value="connectionValue('ssl', $event)"
                /></template>
              </div>
            </details>
          </template>
        </section>
        <section v-if="project === 'gateway'" class="form-section">
          <div class="section-heading">
            <h3>配置页面入口</h3>
            <p>为这个服务添加可直接打开的 Web 管理地址</p>
          </div>
          <FieldInput
            label="Web 地址"
            :model-value="modelValue.webUrl"
            @update:model-value="update('webUrl', $event)"
            placeholder="http://127.0.0.1:3101"
            hint="地址由浏览器访问；保存后可以从这里直接打开"
          /><a
            v-if="savedUrl"
            class="external-link"
            :href="savedUrl"
            target="_blank"
            rel="noopener noreferrer"
            >打开配置页面 ↗</a
          >
        </section>
        <details v-if="project === 'ssh'" class="advanced-section">
          <summary>
            跳板机<span>{{
              modelValue.proxyJump ? "已配置" : "通过另一台主机中转连接"
            }}</span>
          </summary>
          <div class="advanced-body">
            <template v-if="modelValue.proxyJump"
              ><SshConnection
                :model-value="modelValue.proxyJump"
                @update:model-value="update('proxyJump', $event)"
                jump
              /><button
                class="text-action danger"
                @click="update('proxyJump', undefined)"
              >
                移除跳板机配置
              </button></template
            ><el-button
              v-else
              @click="update('proxyJump', { host: '', username: '' })"
              >配置跳板机</el-button
            >
          </div>
        </details>
      </template>
      <template v-else-if="tab === 'policy'">
        <section class="form-section">
          <div class="section-heading">
            <h3>访问控制</h3>
            <p>
              {{
                project === "gateway"
                  ? "设置工具调用和确认策略"
                  : "设置此连接的操作权限"
              }}
            </p>
          </div>
          <FieldGrid
            :model-value="modelValue"
            @update:model-value="emit('update:modelValue', $event)"
            :fields="
              pick(
                base,
                project === 'gateway'
                  ? ['codexAutoReview']
                  : project === 'ssh'
                    ? ['readOnly', 'codexAutoReview', 'dangerMode']
                    : ['readonly', 'codexAutoReview', 'dangerMode'],
              ).map((field) => ({
                ...field,
                hint: {
                  readOnly: '仅允许读取操作',
                  readonly: '仅允许读取操作',
                  codexAutoReview: '启用 Codex 自动审批策略',
                  dangerMode: '跳过操作审批与只读限制，请谨慎开启',
                }[field.key],
              }))
            "
          />
          <p v-if="modelValue.dangerMode" class="policy-warning">
            Full Access 已开启，将跳过操作审批与只读限制。
          </p>
        </section>
        <template v-if="project === 'gateway'"
          ><ListEditor
            label="需要确认的工具"
            hint="支持工具名称匹配规则"
            :model-value="modelValue.confirmationRequiredTools"
            @update:model-value="
              update('confirmationRequiredTools', $event)
            " /><ListEditor
            label="禁用的工具"
            :model-value="modelValue.disabledTools"
            @update:model-value="update('disabledTools', $event)"
        /></template>
        <ListEditor
          v-if="project === 'ssh'"
          label="允许删除的远程根目录"
          hint="限制文件删除操作的目录范围，使用绝对路径"
          :model-value="modelValue.allowedRemoteRoots"
          @update:model-value="update('allowedRemoteRoots', $event)"
          placeholder="/var/www"
        />
      </template>
      <template v-else>
        <template v-if="project === 'gateway'"
          ><section class="form-section">
            <div class="section-heading"><h3>说明与超时</h3></div>
            <FieldGrid
              :model-value="modelValue"
              @update:model-value="emit('update:modelValue', $event)"
              :fields="
                pick(base, ['description', 'callTimeoutMs']).map((field) => ({
                  ...field,
                  wide: field.key === 'description',
                  multiline: field.key === 'description',
                }))
              "
            />
          </section>
          <template v-if="connection.type !== 'http'"
            ><KeyValueEditor
              label="环境变量"
              :model-value="connection.env"
              @update:model-value="connectionValue('env', $event)"
              secret />
            <details class="advanced-section">
              <summary>
                继承进程环境<span>控制下游可读取的环境变量</span>
              </summary>
              <div class="advanced-body">
                <FieldInput
                  label="继承全部环境变量"
                  type="switch"
                  :model-value="connection.inheritEnv"
                  @update:model-value="connectionValue('inheritEnv', $event)"
                /><ListEditor
                  label="额外允许继承的变量"
                  :model-value="connection.envAllowlist"
                  @update:model-value="connectionValue('envAllowlist', $event)"
                />
              </div></details></template
        ></template>
        <section v-else-if="project === 'ssh'" class="form-section">
          <div class="section-heading">
            <h3>常用工作目录</h3>
            <p>为常用目录设置名称，方便 MCP 客户端切换</p>
          </div>
          <div
            v-for="(directory, key) in workingDirectories"
            :key="key"
            class="directory-row"
          >
            <div class="directory-title">
              <el-input
                :model-value="key"
                @change="renameDirectory(key, $event)"
                aria-label="目录名称"
              /><button
                class="icon-action danger"
                @click="removeDirectory(key)"
              >
                ×
              </button>
            </div>
            <div class="form-grid">
              <FieldInput
                label="远程路径"
                :model-value="directory.path"
                @update:model-value="directoryValue(key, 'path', $event)"
                required
              /><FieldInput
                label="目录说明"
                :model-value="directory.desc"
                @update:model-value="directoryValue(key, 'desc', $event)"
                required
              />
            </div>
          </div>
          <el-button @click="addDirectory">＋ 添加工作目录</el-button
          ><button
            v-if="modelValue.workingDirectories !== undefined"
            class="text-action muted"
            @click="update('workingDirectories', undefined)"
          >
            恢复未设置
          </button>
        </section>
        <section v-else class="form-section">
          <div class="section-heading">
            <h3>客户端选项</h3>
            <p>按数据库驱动设置连接超时和客户端模式</p>
          </div>
          <FieldGrid
            :model-value="connection"
            @update:model-value="updateConnection"
            :fields="
              pick(
                connectionSchema,
                modelValue.type === 'oracle'
                  ? ['connectTimeoutMs', 'clientMode', 'clientLibDir']
                  : ['connectTimeoutMs'],
              )
            "
          />
        </section>
      </template>
      <footer class="detail-footer">
        <span>更改仅在点击“保存配置”后生效</span
        ><button class="text-action danger" @click="emit('remove')">
          <UiIcon name="trash" />删除此配置
        </button>
      </footer>
    </div>
  </section>
</template>
