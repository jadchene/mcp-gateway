<script setup>
import { computed, ref } from "vue";
import { ElMessageBox } from "element-plus";
import FieldInput from "./FieldInput.vue";
const props = defineProps({
  modelValue: { type: [Object, Array], default: () => ({}) },
  label: { type: String, default: "自定义连接选项" },
});
const emit = defineEmits(["update:modelValue"]);
const name = ref("");
const error = ref("");
const editing = ref(null);
const isList = computed(() => Array.isArray(props.modelValue));
const rows = computed(() => Object.entries(props.modelValue));
const kind = (value) =>
  value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
const types = [
  { value: "string", label: "文本" },
  { value: "number", label: "数字" },
  { value: "boolean", label: "开关" },
  { value: "array", label: "列表" },
  { value: "object", label: "选项组" },
  { value: "null", label: "空值" },
];
const set = (key, value) => {
  const next = isList.value ? [...props.modelValue] : { ...props.modelValue };
  Object.defineProperty(next, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
  emit("update:modelValue", next);
};
const add = () => {
  const key = isList.value
    ? String(props.modelValue.length)
    : name.value.trim();
  if (!key || Object.hasOwn(props.modelValue, key)) {
    error.value = "请输入不重复的选项名称";
    return;
  }
  set(key, "");
  name.value = "";
  error.value = "";
};
const remove = (key) => {
  if (isList.value)
    emit(
      "update:modelValue",
      props.modelValue.filter((_, index) => String(index) !== key),
    );
  else {
    const next = { ...props.modelValue };
    delete next[key];
    emit("update:modelValue", next);
  }
};
const changeType = async (key, type) => {
  try {
    await ElMessageBox.confirm(
      "更换值类型将清空该选项当前的值，是否继续？",
      "更换类型",
      { confirmButtonText: "更换", cancelButtonText: "取消" },
    );
  } catch {
    return;
  }
  set(
    key,
    {
      string: "",
      number: 0,
      boolean: false,
      array: [],
      object: {},
      null: null,
    }[type],
  );
};
</script>
<template>
  <div class="option-editor">
    <div v-for="[key, value] in rows" :key="key" class="option-row">
      <strong>{{ isList ? Number(key) + 1 : key }}</strong><el-select
        :model-value="kind(value)"
        @change="changeType(key, $event)"
        aria-label="选项类型"
        ><el-option
          v-for="type in types"
          :key="type.value"
          :value="type.value"
          :label="type.label" /></el-select
      ><FieldInput
        v-if="kind(value) === 'string'"
        required
        :label="`${label} ${key}`"
        :model-value="value"
        @update:model-value="set(key, $event)"
        :type="
          /^(key|privateKey)$/i.test(isList ? label : key)
            ? 'private-key'
            : /password|secret|passphrase/i.test(isList ? label : key)
              ? 'password'
              : /^(ca|cert|certificate)$/i.test(isList ? label : key) ||
                  value.includes('\n')
                ? 'textarea'
                : 'text'
        "
        :aria-label="`${label} ${key}`"
      /><el-input-number
        v-else-if="kind(value) === 'number'"
        :model-value="value"
        @update:model-value="set(key, $event ?? 0)"
        :aria-label="`${label} ${key}`"
      /><el-switch
        v-else-if="kind(value) === 'boolean'"
        :model-value="value"
        @update:model-value="set(key, $event)"
        :aria-label="`${label} ${key}`"
      /><el-button v-else-if="value !== null" @click="editing = key"
        >编辑 {{ Object.keys(value).length }} 项</el-button
      ><span v-else class="field-hint">空值</span
      ><button
        class="icon-action danger"
        @click="remove(key)"
        aria-label="移除选项"
      >
        ×
      </button>
    </div>
    <div class="kv-add">
      <el-input
        v-if="!isList"
        v-model="name"
        placeholder="选项名称"
        aria-label="自定义选项名称"
        @keyup.enter="add"
      /><el-button @click="add"
        >＋ 添加{{ isList ? "条目" : "选项" }}</el-button
      >
    </div>
    <p v-if="error" class="error">{{ error }}</p>
    <el-dialog
      :model-value="editing !== null"
      @update:model-value="!$event && (editing = null)"
      :title="`${label} · ${editing ?? ''}`"
      width="min(720px, 90vw)"
      append-to-body
      ><OptionEditor
        v-if="editing !== null && modelValue[editing]"
        :label="String(editing)"
        :model-value="modelValue[editing]"
        @update:model-value="set(editing, $event)"
      /><template #footer
        ><el-button type="primary" @click="editing = null"
          >完成</el-button
        ></template
      ></el-dialog
    >
  </div>
</template>
