<script setup>
import { nextTick, ref } from "vue";
import UiIcon from "./UiIcon.vue";
const props = defineProps({
  modelValue: Array,
  label: String,
  hint: String,
  placeholder: String,
  secret: Boolean,
});
const emit = defineEmits(["update:modelValue"]);
const container = ref(null);
const add = async () => {
  emit("update:modelValue", [...(props.modelValue ?? []), ""]);
  await nextTick();
  const inputs = container.value?.querySelectorAll("input");
  inputs?.[inputs.length - 1]?.focus();
};
const change = (index, value) => {
  const next = [...props.modelValue];
  next[index] = value;
  emit("update:modelValue", next);
};
const remove = (index) =>
  emit(
    "update:modelValue",
    props.modelValue.filter((_, key) => key !== index),
  );
const move = (index, offset) => {
  const next = [...props.modelValue];
  [next[index], next[index + offset]] = [next[index + offset], next[index]];
  emit("update:modelValue", next);
};
</script>
<template>
  <div class="collection-field" ref="container">
    <div class="collection-title">
      <label
        >{{ label }}
        <span v-if="modelValue?.length" class="count">{{
          modelValue.length
        }}</span></label
      ><button class="text-action" @click="add">
        <UiIcon name="plus" />添加
      </button>
    </div>
    <p v-if="hint" class="field-hint">{{ hint }}</p>
    <div v-if="!modelValue?.length" class="collection-empty">
      <span>暂无{{ label }}</span
      ><button class="text-action" @click="add">添加第一项</button>
    </div>
    <div v-for="(value, index) in modelValue" :key="index" class="list-row">
      <span class="row-index">{{ index + 1 }}</span><el-input
        :model-value="value"
        @update:model-value="change(index, $event)"
        :placeholder="placeholder || '请输入内容'"
        :type="secret ? 'password' : 'text'"
        :show-password="secret"
        :aria-label="`${label} ${index + 1}`"
      />
      <button
        class="icon-action"
        :disabled="index === 0"
        @click="move(index, -1)"
        aria-label="上移"
        title="上移"
      >
        <UiIcon name="up" /></button
      ><button
        class="icon-action"
        :disabled="index === modelValue.length - 1"
        @click="move(index, 1)"
        aria-label="下移"
        title="下移"
      >
        <UiIcon name="down" /></button
      ><button
        class="icon-action danger"
        @click="remove(index)"
        aria-label="移除条目"
        title="移除条目"
      >
        <UiIcon name="trash" />
      </button>
    </div>
    <button
      v-if="modelValue !== undefined"
      class="text-action muted"
      @click="emit('update:modelValue', undefined)"
    >
      恢复未设置
    </button>
  </div>
</template>
