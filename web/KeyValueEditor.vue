<script setup>
import { nextTick, ref } from "vue";
import UiIcon from "./UiIcon.vue";
const props = defineProps({
  modelValue: Object,
  label: String,
  hint: String,
  secret: Boolean,
});
const emit = defineEmits(["update:modelValue"]);
const key = ref("");
const error = ref("");
const container = ref(null);
const inputRevision = ref(0);
const set = (name, value) =>
  emit("update:modelValue", { ...props.modelValue, [name]: value });
const rename = (name, nextName) => {
  if (name === nextName) return;
  if (!nextName.trim() || Object.hasOwn(props.modelValue ?? {}, nextName)) {
    error.value = "名称不能为空或重复";
    inputRevision.value++;
    return;
  }
  const next = { ...props.modelValue, [nextName]: props.modelValue[name] };
  delete next[name];
  error.value = "";
  emit("update:modelValue", next);
};
const add = async () => {
  const name = key.value.trim();
  if (!name || Object.hasOwn(props.modelValue ?? {}, name)) {
    error.value = "请输入不重复的名称";
    return;
  }
  set(name, "");
  key.value = "";
  error.value = "";
  await nextTick();
  const rows = container.value?.querySelectorAll(".kv-row");
  rows?.[rows.length - 1]?.querySelectorAll("input")[1]?.focus();
};
const remove = (name) => {
  const next = { ...props.modelValue };
  delete next[name];
  emit("update:modelValue", next);
};
</script>
<template>
  <div class="collection-field" ref="container">
    <div class="collection-title">
      <label>{{ label }}</label><span class="count"
        >{{ Object.keys(modelValue ?? {}).length }} 项</span
      >
    </div>
    <p v-if="hint" class="field-hint">{{ hint }}</p>
    <div v-if="Object.keys(modelValue ?? {}).length" class="kv-head">
      <span>名称</span><span>值</span><span />
    </div>
    <p v-else class="field-hint">填写名称并添加，然后设置对应的值。</p>
    <div v-for="(value, name) in modelValue" :key="name" class="kv-row">
      <el-input
        :key="`${name}-${inputRevision}`"
        :model-value="name"
        @change="rename(name, $event)"
        :aria-label="`${label} 名称 ${name}`"
      /><el-input
        :model-value="value"
        @update:model-value="set(name, $event)"
        :type="secret ? 'password' : 'text'"
        :show-password="secret"
        :aria-label="`${label} ${name}`"
      /><button
        class="icon-action danger"
        @click="remove(name)"
        aria-label="移除条目"
        title="移除条目"
      >
        <UiIcon name="trash" />
      </button>
    </div>
    <div class="kv-add">
      <el-input
        v-model="key"
        placeholder="输入新名称"
        :aria-label="`${label} 新名称`"
        @keyup.enter="add"
      /><el-button @click="add" :disabled="!key.trim()"
        ><UiIcon name="plus" />添加</el-button
      >
    </div>
    <p v-if="error" class="error">{{ error }}</p>
    <button
      v-if="modelValue !== undefined"
      class="text-action muted"
      @click="emit('update:modelValue', undefined)"
    >
      恢复未设置
    </button>
  </div>
</template>
