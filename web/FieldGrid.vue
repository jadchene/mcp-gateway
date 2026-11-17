<script setup>
import FieldInput from "./FieldInput.vue";
const props = defineProps({ modelValue: Object, fields: Array });
const emit = defineEmits(["update:modelValue"]);
const update = (key, value) => {
  const next = { ...props.modelValue };
  if (value === undefined) delete next[key];
  else next[key] = value;
  emit("update:modelValue", next);
};
const inputType = (field) =>
  field.options
    ? "select"
    : field.type === "boolean"
      ? "switch"
      : field.type === "number"
        ? "number"
        : field.secret
          ? field.multiline
            ? "private-key"
            : "password"
          : field.multiline
            ? "textarea"
            : "text";
</script>
<template>
  <div class="form-grid">
    <FieldInput
      v-for="field in fields"
      :key="field.key"
      :model-value="modelValue?.[field.key]"
      @update:model-value="update(field.key, $event)"
      :label="field.label"
      :type="inputType(field)"
      :required="field.required"
      :default-value="field.default"
      :min="field.min"
      :max="field.max"
      :options="field.options"
      :wide="field.wide"
      :hint="field.hint"
      :placeholder="field.placeholder"
    />
  </div>
</template>
