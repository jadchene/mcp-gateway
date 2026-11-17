<script setup>
import { computed } from "vue";
import { ElMessage } from "element-plus";
import UiIcon from "./UiIcon.vue";
const props = defineProps({ data: Object });
const fileName = computed(() => props.data.configPath.split(/[\\/]/).pop());
const webAddress = computed(
  () =>
    `http://${props.data.web.effective.host}:${props.data.web.effective.port}`,
);
const http = computed(() => props.data.startup?.mcpHttp);
const rows = computed(() => [
  {
    label: "Web 页面",
    current: props.data.web.effective.enabled ? "已开启" : "已关闭",
    file:
      props.data.config.web?.enabled === undefined
        ? "未配置"
        : props.data.config.web.enabled
          ? "已开启"
          : "已关闭",
    source: props.data.web.sources.enabled,
  },
  {
    label: "监听端口",
    current: props.data.web.effective.port,
    file: props.data.config.web?.port ?? "未配置",
    source: props.data.web.sources.port,
  },
  {
    label: "监听地址",
    current: props.data.web.effective.host,
    file: props.data.config.web?.host ?? "未配置",
    source: "固定本机",
  },
]);
const copy = async (text, label) => {
  try {
    await navigator.clipboard.writeText(text);
    ElMessage.success(`${label}已复制`);
  } catch {
    ElMessage.error("复制失败，请选中内容手动复制");
  }
};
</script>
<template>
  <section class="settings-page runtime-page">
    <p class="runtime-intro">
      查看当前运行方式与配置文件。修改启动参数后需重启服务。
    </p>
    <el-alert
      v-if="data.web.restartRequired"
      type="warning"
      title="Web 设置已在文件中修改"
      description="当前仍使用启动时的设置。重启服务后应用新设置，命令行参数仍优先于文件。"
      show-icon
      :closable="false"
      class="message"
    />
    <section class="settings-card runtime-card">
      <header class="runtime-card-heading">
        <span class="runtime-icon"><UiIcon name="external" /></span>
        <div>
          <h2>Web 配置页面</h2>
          <p>仅在本机访问，无需登录</p>
        </div>
        <span class="runtime-badge"><span class="status-dot" />运行中</span>
      </header>
      <div class="runtime-value-row">
        <div>
          <span class="runtime-label">访问地址</span
          ><code class="runtime-address">{{ webAddress }}</code>
        </div>
        <el-button @click="copy(webAddress, '访问地址')"
          ><UiIcon name="copy" />复制地址</el-button
        >
      </div>
      <details class="runtime-details">
        <summary>查看配置来源<UiIcon name="down" /></summary>
        <div class="runtime-details-body">
          <p>当前值以本次启动为准；未配置的项目使用默认值或命令行参数。</p>
          <table class="startup-table">
            <thead>
              <tr>
                <th>设置</th>
                <th>当前值</th>
                <th>文件中的值</th>
                <th>当前来源</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in rows" :key="row.label">
                <td>{{ row.label }}</td>
                <td>{{ row.current }}</td>
                <td>{{ row.file }}</td>
                <td>
                  <span class="source-tag">{{ row.source }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </details>
    </section>
    <section class="settings-card runtime-card">
      <header class="runtime-card-heading">
        <span class="runtime-icon"><UiIcon name="gateway" /></span>
        <div>
          <h2>MCP 连接</h2>
          <p>供 MCP 客户端使用，与 Web 配置页面独立</p>
        </div>
      </header>
      <dl class="runtime-facts">
        <div>
          <dt>连接方式</dt>
          <dd>
            <span class="connection-tag">stdio</span
            ><span v-if="http?.enable" class="connection-tag">HTTP</span>
          </dd>
        </div>
        <div>
          <dt>通信方式</dt>
          <dd>由客户端通过标准输入输出通信</dd>
        </div>
        <template v-if="http?.enable"
          ><div>
            <dt>HTTP 监听</dt>
            <dd>
              <code>{{ http.host }}:{{ http.port }}</code>
            </dd>
          </div>
          <div>
            <dt>HTTP 路径</dt>
            <dd>
              <code>{{ http.path }}</code>
            </dd>
          </div>
          <div>
            <dt>HTTP 认证</dt>
            <dd>{{ http.authToken }}</dd>
          </div></template
        >
      </dl>
    </section>
    <section
      id="config-file-info"
      tabindex="-1"
      class="settings-card runtime-card config-file-card"
    >
      <header class="runtime-card-heading">
        <span class="runtime-icon"><UiIcon name="file" /></span>
        <div>
          <h2>当前配置文件</h2>
          <p>页面读取和保存的文件</p>
        </div>
      </header>
      <div class="config-file-summary">
        <strong>{{ fileName }}</strong><el-button
          @click="copy(data.configPath, '文件路径')"
          ><UiIcon name="copy" />复制路径</el-button
        >
      </div>
      <div class="config-file-path">
        <code>{{ data.configPath }}</code>
      </div>
      <p class="runtime-footnote">
        由启动参数 <code>--config</code> 指定。更换文件需修改启动参数并重启。
      </p>
    </section>
  </section>
</template>
