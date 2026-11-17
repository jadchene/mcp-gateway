<script setup>
import { computed } from "vue";
import { ElMessageBox } from "element-plus";
import FieldGrid from "./FieldGrid.vue";
import FieldInput from "./FieldInput.vue";
import ListEditor from "./ListEditor.vue";
import { configSchema } from "../src/web-config/schema";
const props = defineProps({ modelValue: Object, jump: Boolean });
const emit = defineEmits(["update:modelValue"]);
const schema = configSchema("ssh").properties.servers.item.properties;
const pick = (keys) => keys.map((key) => ({ key, ...schema[key] }));
const authMode = computed(() =>
  props.modelValue?.privateKeyPath !== undefined
    ? "file"
    : props.modelValue?.privateKey !== undefined
      ? "key"
      : "password",
);
const update = (key, value) => {
  const next = { ...props.modelValue };
  if (value === undefined) delete next[key];
  else next[key] = value;
  emit("update:modelValue", next);
};
/** 切换认证方式前明确说明移除旧认证字段，避免保存后仍使用旧密钥。 */
const changeAuth = async (mode) => {
  const fields = {
    file: "privateKeyPath",
    key: "privateKey",
    password: "password",
  };
  try {
    await ElMessageBox.confirm(
      "切换认证方式会移除当前密码或私钥配置。保存后生效，是否继续？",
      "切换认证方式",
      { confirmButtonText: "切换", cancelButtonText: "取消" },
    );
  } catch {
    return;
  }
  const next = { ...props.modelValue };
  for (const key of Object.values(fields))
    if (key !== fields[mode]) delete next[key];
  if (mode === "password") delete next.passphrase;
  next[fields[mode]] ??= "";
  emit("update:modelValue", next);
};
</script>
<template>
  <FieldGrid
    :model-value="modelValue"
    @update:model-value="emit('update:modelValue', $event)"
    :fields="pick(['host', 'port'])"
  />
  <div class="form-grid auth-grid">
    <FieldInput
      label="用户名"
      :model-value="modelValue?.username"
      required
      placeholder="例如 root、ubuntu"
      @update:model-value="update('username', $event)"
    />
    <FieldInput
      label="认证方式"
      type="select"
      :model-value="authMode"
      :options="[
        { value: 'password', label: '密码' },
        { value: 'file', label: '私钥文件' },
        { value: 'key', label: '私钥内容' },
      ]"
      required
      @update:model-value="changeAuth"
    />
    <FieldInput
      v-if="authMode === 'password'"
      wide
      label="登录密码"
      type="password"
      :model-value="modelValue?.password"
      @update:model-value="update('password', $event)"
      placeholder="输入密码或环境变量引用"
    />
    <FieldInput
      v-else-if="authMode === 'file'"
      wide
      label="私钥文件"
      :model-value="modelValue?.privateKeyPath"
      @update:model-value="update('privateKeyPath', $event)"
      placeholder="例如 ./keys/id_ed25519"
      hint="相对路径以配置文件所在目录为基准"
    />
    <FieldInput
      v-else
      label="私钥内容"
      type="private-key"
      :model-value="modelValue?.privateKey"
      @update:model-value="update('privateKey', $event)"
      wide
    />
    <FieldInput
      v-if="authMode !== 'password'"
      label="私钥口令"
      type="password"
      :model-value="modelValue?.passphrase"
      @update:model-value="update('passphrase', $event)"
    />
  </div>
  <details class="advanced-section">
    <summary>
      主机身份验证<span>校验主机密钥，防止连接到错误的服务器</span>
    </summary>
    <div class="advanced-body">
      <FieldInput
        label="严格校验主机密钥"
        type="switch"
        :model-value="modelValue?.strictHostKeyChecking"
        :default-value="true"
        @update:model-value="update('strictHostKeyChecking', $event)"
      />
      <ListEditor
        v-if="Array.isArray(modelValue?.hostKeySha256)"
        label="允许的 SHA-256 指纹"
        :model-value="modelValue.hostKeySha256"
        @update:model-value="update('hostKeySha256', $event)"
      />
      <template v-else
        ><FieldInput
          label="SHA-256 指纹"
          :model-value="modelValue?.hostKeySha256"
          @update:model-value="update('hostKeySha256', $event)"
          placeholder="SHA256:…"
        /><button
          class="text-action"
          @click="
            update(
              'hostKeySha256',
              modelValue?.hostKeySha256 ? [modelValue.hostKeySha256] : [],
            )
          "
        >
          配置多个指纹
        </button></template
      >
    </div>
  </details>
</template>
