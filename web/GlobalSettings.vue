<script setup>
import { computed } from "vue";
import FieldGrid from "./FieldGrid.vue";
import ListEditor from "./ListEditor.vue";
import { configSchema } from "../src/web-config/schema";
const props = defineProps({ project: String, modelValue: Object });
const emit = defineEmits(["update:modelValue"]);
const schema = computed(() => configSchema(props.project).properties);
const pick = (source, keys) => keys.map((key) => ({ key, ...source[key] }));
const update = (key, value) => {
  const next = { ...props.modelValue };
  if (value === undefined) delete next[key];
  else next[key] = value;
  emit("update:modelValue", next);
};
</script>
<template>
  <section class="settings-page">
    <div class="page-heading">
      <p>管理当前服务的日志、超时与默认策略</p>
    </div>
    <section v-if="project !== 'gateway'" class="settings-card">
      <div class="section-heading">
        <h3>连接与会话</h3>
        <p>统一控制连接数量和会话有效期</p>
      </div>
      <FieldGrid
        :model-value="modelValue"
        @update:model-value="emit('update:modelValue', $event)"
        :fields="
          pick(
            schema,
            project === 'ssh'
              ? ['maxSessions', 'sessionIdleTimeoutMs', 'defaultTimeout']
              : ['maxSessions', 'sessionIdleTimeoutMs'],
          )
        "
      /><FieldGrid
        v-if="project === 'database'"
        :model-value="modelValue.query ?? {}"
        @update:model-value="update('query', $event)"
        :fields="pick(schema.query.properties, ['timeoutMs'])"
      />
    </section>
    <section class="settings-card">
      <div class="section-heading">
        <h3>日志记录</h3>
        <p>配置日志位置，方便排查服务运行问题</p>
      </div>
      <FieldGrid
        v-if="project === 'ssh'"
        :model-value="modelValue"
        @update:model-value="emit('update:modelValue', $event)"
        :fields="pick(schema, ['logDir'])"
      /><FieldGrid
        v-else
        :model-value="modelValue.logging ?? {}"
        @update:model-value="update('logging', $event)"
        :fields="
          pick(
            schema.logging.properties,
            project === 'gateway'
              ? ['enable', 'path', 'maxBytes']
              : ['enabled', 'directory'],
          )
        "
      />
    </section>
    <template v-if="project === 'ssh'"
      ><section class="settings-card">
        <div class="section-heading">
          <h3>命令策略</h3>
          <p>作用于所有 SSH 主机的命令匹配规则</p>
        </div>
        <ListEditor
          label="命令黑名单"
          hint="匹配的命令将被阻止执行，使用正则表达式"
          :model-value="modelValue.commandBlacklist"
          @update:model-value="update('commandBlacklist', $event)"
        /><ListEditor
          label="命令白名单"
          hint="匹配的命令可跳过确认，但仍受只读等策略约束"
          :model-value="modelValue.commandWhitelist"
          @update:model-value="update('commandWhitelist', $event)"
        />
      </section>
      <section class="settings-card">
        <div class="section-heading">
          <h3>本地文件访问</h3>
          <p>限制上传下载可使用的本地目录</p>
        </div>
        <ListEditor
          label="允许的本地根目录"
          :model-value="modelValue.allowedLocalRoots"
          @update:model-value="update('allowedLocalRoots', $event)"
          placeholder="例如 ./transfer"
        /></section
    ></template>
  </section>
</template>
