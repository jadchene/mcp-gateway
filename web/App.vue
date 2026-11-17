<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import ResourceEditor from "./ResourceEditor.vue";
import GlobalSettings from "./GlobalSettings.vue";
import UiIcon from "./UiIcon.vue";
import RuntimeInfo from "./RuntimeInfo.vue";
import { validateFormTypes } from "../src/web-config/schema.ts";
const appVersion = __APP_VERSION__;

const data = ref(null);
const draft = ref({});
const selected = ref("");
const section = ref("resources");
const query = ref("");
const error = ref("");
const notice = ref("");
const busy = ref(false);
const baseline = ref("");
const revision = ref("");
const operation = ref("");
const resourceEditor = ref(null);
const dirty = computed(() => JSON.stringify(draft.value) !== baseline.value);
const project = computed(() => data.value?.project ?? "gateway");
const meta = computed(
  () =>
    ({
      gateway: {
        title: "MCP Gateway",
        resource: "服务配置",
        singular: "服务",
        icon: "gateway",
      },
      ssh: {
        title: "MCP SSH",
        resource: "主机配置",
        singular: "主机",
        icon: "ssh",
      },
      database: {
        title: "MCP Database",
        resource: "数据源配置",
        singular: "数据源",
        icon: "database",
      },
    })[project.value],
);
const collectionKey = computed(
  () =>
    ({ gateway: "services", ssh: "servers", database: "databases" })[
      project.value
    ],
);
const entries = computed(() =>
  Object.entries(draft.value[collectionKey.value] ?? {}).map(
    ([key, value]) => ({
      key,
      value,
      name:
        project.value === "gateway"
          ? value.name || value.serviceId || "未命名服务"
          : project.value === "ssh"
            ? value.desc || key
            : value.key || "未命名数据源",
      subtitle:
        project.value === "gateway"
          ? value.transport?.type === "http"
            ? value.transport.url
            : value.transport?.command
          : project.value === "ssh"
            ? value.host
            : value.connection?.host || "连接 URL",
      badge:
        project.value === "gateway"
          ? value.transport?.type || "stdio"
          : project.value === "ssh"
            ? "SSH"
            : value.type,
    }),
  ),
);
const visible = computed(() =>
  entries.value.filter((item) =>
    `${item.name} ${item.key} ${item.value.serviceId ?? ""} ${item.subtitle} ${item.badge}`
      .toLowerCase()
      .includes(query.value.trim().toLowerCase()),
  ),
);
const active = computed(() =>
  entries.value.find((item) => item.key === selected.value),
);
const enabledCount = computed(
  () => entries.value.filter((item) => item.value.enable !== false).length,
);
const savedUrl = computed(() =>
  project.value === "gateway" && active.value
    ? data.value.config.services?.find(
        (item) => item.serviceId === active.value.value.serviceId,
      )?.webUrl
    : undefined,
);
const configFileName = computed(() =>
  data.value?.configPath.split(/[\\/]/).pop(),
);
const showConfigFile = async () => {
  section.value = "startup";
  await nextTick();
  const card = document.getElementById("config-file-info");
  card?.scrollIntoView({ behavior: "smooth", block: "center" });
  card?.focus({ preventScroll: true });
};
const clone = (value) => JSON.parse(JSON.stringify(value));
const modified = (item) => {
  const saved = data.value.config[collectionKey.value];
  const original = Array.isArray(saved)
    ? saved.find((value) =>
        project.value === "gateway"
          ? value.serviceId === item.value.serviceId
          : value.key === item.value.key,
      )
    : saved?.[item.key];
  return JSON.stringify(item.value) !== JSON.stringify(original);
};
const focusEditor = async () => {
  await nextTick();
  const element = resourceEditor.value?.$el;
  element
    ?.querySelector(".detail-content input")
    ?.focus({ preventScroll: true });
  element?.scrollIntoView({ block: "start", behavior: "smooth" });
};

/** 文件内容不写入浏览器持久存储。 */
const api = async (path, body) => {
  const response = await fetch(path, {
    method: body ? "POST" : "GET",
    cache: "no-store",
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
};
const run = async (action, name) => {
  if (busy.value) return;
  operation.value = name;
  error.value = "";
  notice.value = "";
  busy.value = true;
  try {
    await action();
  } catch (reason) {
    error.value = reason.message;
    ElMessage({
      message: reason.message,
      type: "error",
      duration: 5000,
      showClose: true,
    });
  } finally {
    busy.value = false;
  }
};
const confirm = async (message, title) => {
  try {
    await ElMessageBox.confirm(message, title, {
      confirmButtonText: "确定",
      cancelButtonText: "取消",
      type: "warning",
    });
    return true;
  } catch {
    return false;
  }
};
const load = () =>
  run(async () => {
    if (
      data.value &&
      dirty.value &&
      !(await confirm("放弃未保存的修改，重新读取配置文件？", "重新加载配置"))
    )
      return;
    const result = await api("/api/config");
    data.value = result;
    draft.value = clone(result.config);
    baseline.value = JSON.stringify(result.config);
    revision.value = result.revision;
    if (!entries.value.some((item) => item.key === selected.value))
      selected.value = entries.value[0]?.key ?? "";
  }, "load");
const save = () =>
  run(async () => {
    validateFormTypes(draft.value, data.value.schema);
    const result = await api("/api/config", {
      config: draft.value,
      revision: revision.value,
    });
    draft.value = clone(result.config);
    data.value.config = clone(result.config);
    baseline.value = JSON.stringify(result.config);
    revision.value = result.revision;
    notice.value = result.loaded
      ? "配置已保存，服务已加载最新设置。"
      : `文件已保存，但加载失败，运行配置可能仍为旧值：${result.loadError}`;
    if (result.loaded) ElMessage({ message: notice.value, type: "success" });
  }, "save");
const discard = async () => {
  if (
    busy.value ||
    !(await confirm(
      "放弃全部未保存的修改，恢复到上次加载或保存的配置？",
      "撤销修改",
    ))
  )
    return;
  draft.value = clone(data.value.config);
  error.value = "";
  notice.value = "";
  if (!entries.value.some((item) => item.key === selected.value))
    selected.value = entries.value[0]?.key ?? "";
};
const shortcut = async (event) => {
  if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "s")
    return;
  event.preventDefault();
  if (!data.value || busy.value || document.querySelector(".el-message-box"))
    return;
  document.activeElement?.blur();
  await nextTick();
  if (dirty.value) save();
};
const updateResource = (value) => {
  const collection = Array.isArray(draft.value[collectionKey.value])
    ? [...draft.value[collectionKey.value]]
    : { ...draft.value[collectionKey.value] };
  collection[selected.value] = value;
  draft.value = { ...draft.value, [collectionKey.value]: collection };
};
const rename = (value) => {
  if (!value || value === selected.value) return;
  const collection = draft.value.servers;
  if (Object.hasOwn(collection, value)) {
    error.value = "主机标识已存在，请使用其他名称。";
    return;
  }
  const next = { ...collection, [value]: collection[selected.value] };
  delete next[selected.value];
  draft.value = { ...draft.value, servers: next };
  selected.value = value;
};
const add = () => {
  const prefix = { gateway: "service", ssh: "server", database: "database" }[
    project.value
  ];
  let index = 1;
  while (
    entries.value.some(
      (item) =>
        item.key === `${prefix}-${index}` ||
        item.value.key === `${prefix}-${index}` ||
        item.value.serviceId === `${prefix}-${index}`,
    )
  )
    index++;
  const id = `${prefix}-${index}`;
  if (project.value === "ssh") {
    draft.value = {
      ...draft.value,
      servers: {
        ...draft.value.servers,
        [id]: { enable: false, host: "", username: "" },
      },
    };
    selected.value = id;
  } else {
    const value =
      project.value === "gateway"
        ? {
            serviceId: id,
            name: "新服务",
            enable: false,
            transport: { type: "stdio", command: "", args: [] },
          }
        : {
            key: id,
            type: "mysql",
            enable: false,
            readonly: true,
            connection: { host: "", databaseName: "", user: "", password: "" },
          };
    const collection = [...(draft.value[collectionKey.value] ?? []), value];
    draft.value = { ...draft.value, [collectionKey.value]: collection };
    selected.value = String(collection.length - 1);
  }
  query.value = "";
  section.value = "resources";
  void focusEditor();
};
const remove = async () => {
  if (
    !(await confirm(
      `删除“${active.value.name}”？点击保存配置后生效。`,
      `删除${meta.value.singular}`,
    ))
  )
    return;
  const collection = draft.value[collectionKey.value];
  let next;
  if (Array.isArray(collection))
    next = collection.filter((_, index) => String(index) !== selected.value);
  else {
    next = { ...collection };
    delete next[selected.value];
  }
  draft.value = { ...draft.value, [collectionKey.value]: next };
  selected.value = entries.value[0]?.key ?? "";
};
const beforeUnload = (event) => {
  if (dirty.value && data.value) {
    event.preventDefault();
    event.returnValue = "";
  }
};
onMounted(load);
window.addEventListener("keydown", shortcut);
window.addEventListener("beforeunload", beforeUnload);
onBeforeUnmount(() => {
  window.removeEventListener("beforeunload", beforeUnload);
  window.removeEventListener("keydown", shortcut);
});
</script>

<template>
  <div v-if="!data" class="login-page" v-loading="busy">
    <div class="login-brand">
      <span class="brand-symbol"><UiIcon name="gateway" /></span
      ><span>MCP 配置</span>
    </div>
    <section class="login-panel">
      <h1>{{ error ? "配置加载失败" : "正在加载配置" }}</h1>
      <p>配置页面仅在本机提供访问。</p>
      <el-button v-if="error" @click="load">重新加载</el-button>
      <el-alert
        v-if="error"
        :title="error"
        type="error"
        :closable="false"
        show-icon
      />
    </section>
  </div>
  <div v-else class="app-shell">
    <aside class="sidebar">
      <div class="brand">
        <span class="brand-symbol"><UiIcon :name="meta.icon" /></span>
        <div>
          <strong>{{ meta.title }}</strong><span
            class="app-version"
            :aria-label="`版本 ${appVersion}`"
            >v{{ appVersion }}</span
          ><small>配置管理</small>
        </div>
      </div>
      <nav class="primary-nav">
        <button
          :class="{ active: section === 'resources' }"
          @click="section = 'resources'"
        >
          <UiIcon :name="meta.icon" />
          {{ meta.resource
          }}<span class="nav-count">{{ entries.length }}</span></button
        ><button
          :class="{ active: section === 'general' }"
          @click="section = 'general'"
        >
          <UiIcon name="settings" />通用设置</button
        ><button
          :class="{ active: section === 'startup' }"
          @click="section = 'startup'"
        >
          <UiIcon name="info" />运行信息
        </button>
      </nav>
      <div class="sidebar-footer"><span class="status-dot" />本地配置</div>
    </aside>
    <div class="workspace">
      <header class="workspace-header">
        <div class="breadcrumbs">
          <h1>
            {{
              section === "resources"
                ? meta.resource
                : section === "general"
                  ? "通用设置"
                  : "运行信息"
            }}
          </h1>
          <span v-if="section === 'resources'" class="resource-total"
            >{{ entries.length }} 项配置 · {{ enabledCount }} 项启用</span
          >
        </div>
        <div class="header-actions">
          <span
            v-if="section !== 'startup' || dirty"
            class="save-state"
            :class="{ dirty }"
            ><span class="status-dot" />{{
              dirty ? "有未保存修改" : "已同步"
            }}</span
          ><el-button
            v-if="dirty"
            @click="discard"
            :disabled="busy"
            class="discard-button"
            ><UiIcon name="undo" />撤销修改</el-button
          ><el-button
            @click="load"
            :disabled="busy"
            :loading="busy && operation === 'load'"
            title="从配置文件重新读取"
            ><UiIcon name="refresh" />{{
              section === "startup" ? "刷新信息" : "重新加载"
            }}</el-button
          ><el-button
            v-if="section !== 'startup' || dirty"
            type="primary"
            @click="save"
            :disabled="!dirty || busy"
            :loading="busy && operation === 'save'"
            title="保存全部修改（Ctrl / ⌘ + S）"
            ><UiIcon name="check" />保存配置</el-button
          >
        </div>
      </header>
      <div class="workspace-body" v-loading="busy">
        <el-alert
          v-if="error"
          :title="error"
          type="error"
          :closable="false"
          show-icon
          class="message"
        /><el-alert
          v-if="notice && notice.includes('失败')"
          :title="notice"
          :type="notice.includes('失败') ? 'warning' : 'success'"
          :closable="false"
          show-icon
          class="message"
        />
        <template v-if="section === 'resources'"
          ><div class="resource-layout">
            <aside class="resource-list">
              <div class="list-heading">
                <strong>全部{{ meta.singular }}</strong
                ><button
                  class="add-icon"
                  @click="add"
                  :aria-label="`添加${meta.singular}`"
                  :title="`添加${meta.singular}`"
                >
                  <UiIcon name="plus" />
                </button>
              </div>
              <div class="list-search">
                <el-input
                  v-model="query"
                  :placeholder="`搜索${meta.singular}…`"
                  clearable
                  :aria-label="`搜索${meta.singular}`"
                  ><template #prefix><UiIcon name="search" /></template
                ></el-input>
              </div>
              <div class="list-items">
                <button
                  v-for="item in visible"
                  :key="item.key"
                  class="resource-row"
                  :class="{ selected: selected === item.key }"
                  @click="selected = item.key"
                >
                  <div class="row-top">
                    <strong>{{ item.name }}</strong><span
                      v-if="modified(item)"
                      class="modified-label"
                      title="此条目有未保存修改"
                      aria-label="未保存修改"
                      >未保存</span
                    ><span
                      class="resource-dot"
                      :class="{ enabled: item.value.enable !== false }"
                      :title="item.value.enable !== false ? '已启用' : '未启用'"
                    />
                  </div>
                  <div class="row-meta">
                    <span class="row-badge">{{ item.badge }}</span>
                    <p>{{ item.subtitle || "尚未配置连接" }}</p>
                  </div>
                </button>
                <div v-if="!visible.length" class="list-empty">
                  <UiIcon :name="query ? 'search' : meta.icon" />
                  <p>{{ query ? "没有匹配的配置" : "还没有配置" }}</p>
                  <button
                    class="text-action"
                    @click="query ? (query = '') : add()"
                  >
                    {{ query ? "清除搜索" : `添加${meta.singular}` }}
                  </button>
                </div>
              </div>
            </aside>
            <ResourceEditor
              v-if="active"
              ref="resourceEditor"
              :key="active.key"
              :project="project"
              :alias="active.key"
              :model-value="active.value"
              :saved-url="savedUrl"
              @update:model-value="updateResource"
              @rename="rename"
              @remove="remove"
            />
            <div v-else class="empty-detail">
              <UiIcon :name="meta.icon" />
              <h2>添加第一个{{ meta.singular }}</h2>
              <p>填写连接信息，保存后即可使用。</p>
              <el-button type="primary" @click="add"
                >＋ 添加{{ meta.singular }}</el-button
              >
            </div>
          </div>
        </template>
        <GlobalSettings
          v-else-if="section === 'general'"
          :project="project"
          v-model="draft"
        />
        <RuntimeInfo v-else :data="data" />
        <footer v-if="section !== 'startup'" class="workspace-footer">
          <button
            class="config-file-link"
            @click="showConfigFile"
            title="查看配置文件位置"
          >
            <UiIcon name="file" /><span>当前配置</span
            ><strong>{{ configFileName }}</strong
            ><UiIcon name="info" />
          </button>
        </footer>
      </div>
    </div>
  </div>
</template>
