<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
const props = defineProps({ services: {type: Array, default: () => []} });
const states = ref([]);
const error = ref('');
const pending = ref({});
const refreshing = ref(false);
const loaded = ref(false);
const controllers = new Set();
let timer;
let disposed = false;
const request = async (body) => {
  const controller = new AbortController();
  controllers.add(controller);
  try {
    const response = await fetch('/api/services', {signal: controller.signal, ...(body ? {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)} : {})});
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '服务操作失败');
    return result.services;
  } finally { controllers.delete(controller); }
};
const refresh = async () => {
  if (refreshing.value || disposed) return;
  refreshing.value = true;
  try { states.value = await request(); error.value = ''; loaded.value = true; }
  catch (failure) { if (!disposed) error.value = failure.message; }
  finally { refreshing.value = false; }
};
const rows = computed(() => props.services.map(service => {
  const state = states.value.find(item => item.serviceId === service.serviceId);
  const status = pending.value[service.serviceId] || state?.status || (service.enable === false ? 'disabled' : loaded.value ? 'unknown' : 'loading');
  const http = service.transport?.type === 'http';
  const label = {running: http ? '已连接' : '运行中', stopped: http ? '已断开' : '已停止', starting: http ? '连接中' : '启动中', stopping: http ? '断开中' : '停止中', failed: http ? '连接失败 / 已断开' : '启动失败 / 已退出', disabled: '未启用', unknown: '未加载', loading: '读取中'}[status];
  return {...service, ...state, status, label, http, busy: ['starting','stopping'].includes(status), controllable: Boolean(state) && !error.value};
}));
const control = async (row, action) => {
  pending.value[row.serviceId] = action === 'stop' ? 'stopping' : 'starting';
  try {
    states.value = await request({serviceId: row.serviceId, action});
    ElMessage.success(row.http ? '连接状态已更新' : '服务状态已更新');
  } catch (failure) { if (!disposed) ElMessage.error(failure.message); }
  finally { delete pending.value[row.serviceId]; await refresh(); }
};
onMounted(() => { void refresh(); timer = setInterval(refresh, 3000); });
onBeforeUnmount(() => { disposed = true; clearInterval(timer); for (const controller of controllers) controller.abort(); });
</script>

<template>
  <section class="services-panel">
    <div class="services-toolbar"><div><h2>下游服务</h2><p>操作已保存的配置，不修改启用开关。状态每 3 秒刷新。</p></div><el-button :loading="refreshing" @click="refresh">刷新状态</el-button></div>
    <el-alert v-if="error" :title="`状态获取失败：${error}`" type="error" :closable="false" show-icon />
    <div v-if="!rows.length" class="list-empty">还没有服务，请先添加并保存服务配置。</div>
    <article v-for="row in rows" :key="row.serviceId" class="service-state-card">
      <div class="service-state-main"><div class="service-state-title"><strong>{{ row.name || row.serviceId }}</strong><span class="row-badge">{{ row.transport?.type }}</span></div><span class="service-state-id">{{ row.serviceId }}</span></div>
      <div class="service-state-label" :class="row.status" role="status">{{ row.label }}</div>
      <div class="service-state-actions">
        <el-button :disabled="!row.controllable || row.busy || row.status === 'running'" @click="control(row, 'start')">{{ row.http ? '连接' : '启动' }}</el-button>
        <el-button :disabled="!row.controllable || row.busy || row.status === 'stopped'" :title="row.http ? '断开 Gateway 连接，远端服务继续运行' : '停止子进程，会中断正在执行的请求'" @click="control(row, 'stop')">{{ row.http ? '断开' : '停止' }}</el-button>
        <el-button :disabled="!row.controllable || row.busy || row.status !== 'running'" @click="control(row, 'restart')">{{ row.http ? '重连' : '重启' }}</el-button>
      </div>
      <div class="service-state-facts"><span v-if="row.status === 'running'">{{ row.toolCount }} 个工具</span><span v-if="row.lastConnectedAt">最近连接 {{ new Date(row.lastConnectedAt).toLocaleString() }}</span><span v-if="row.status === 'disabled'">请在服务配置中启用并保存</span><span v-if="row.status === 'stopped'">下次 Gateway 启动时按配置加载</span></div>
      <details v-if="row.lastError" class="service-state-error"><summary>查看失败原因</summary><p>{{ row.lastError }}</p></details>
    </article>
  </section>
</template>

<style scoped>
.services-panel {display: grid; gap: 16px; max-width: 1100px; margin: 0 auto;}
.services-toolbar {display: flex; align-items: center; justify-content: space-between; gap: 16px;}
.services-toolbar h2 {font-size: 16px; margin: 0 0 8px;}
.services-toolbar p {font-size: 13px; color: #667085; margin: 0;}
.service-state-card {display: grid; grid-template-columns: minmax(160px, 1fr) auto auto; align-items: center; gap: 14px 24px; padding: 20px 24px; background: #fff; border: 1px solid #e0e5ed; border-radius: 12px;}
.service-state-title {display: flex; gap: 10px; align-items: center;}
.service-state-title strong {font-size: 14px; overflow-wrap: anywhere;}
.service-state-id {display: block; color: #667085; font-size: 12px; margin-top: 6px; overflow-wrap: anywhere;}
.service-state-label {font-size: 13px; color: #667085;}
.service-state-label.running {color: #178451;}
.service-state-label.failed {color: #b54736;}
.service-state-label.starting,.service-state-label.stopping {color: #4169e1;}
.service-state-actions {display: flex; align-items: center; flex-wrap: wrap; gap: 10px;}
.service-state-actions :deep(.el-button) {min-width: 72px; margin: 0;}
.service-state-facts {grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 10px 24px; color: #667085; font-size: 12px;}
.service-state-error {grid-column: 1 / -1; font-size: 13px; color: #b54736;}
.service-state-error summary {cursor: pointer;}
.service-state-error p {white-space: pre-wrap; overflow-wrap: anywhere; margin: 10px 0 0;}
@media(max-width: 900px) {.service-state-card {grid-template-columns: minmax(0, 1fr) auto; padding: 18px;} .service-state-actions {grid-column: 1 / -1;} .services-toolbar {align-items: flex-start;} }
@media(max-width: 480px) {.service-state-actions :deep(.el-button) {flex: 1;} }
</style>
