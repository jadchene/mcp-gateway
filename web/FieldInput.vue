<script setup>
import { computed, ref, useId } from "vue";

const props = defineProps({
  modelValue: {},
  label: String,
  type: { type: String, default: "text" },
  options: Array,
  placeholder: String,
  hint: String,
  required: Boolean,
  defaultValue: {},
  min: Number,
  max: Number,
  wide: Boolean,
  commit: Boolean,
});
const emit = defineEmits(["update:modelValue"]);
const revealed = ref(false);
const inputId = useId();
const effective = computed(() => props.modelValue ?? props.defaultValue);
/** 清空可选字段时恢复未设置状态，不向文件自动补默认值。 */
const update = (value) =>
  emit(
    "update:modelValue",
    value === "" && !props.required ? undefined : (value ?? undefined),
  );
</script>

<template>
  <div
    class="form-field"
    :class="{ 'span-two': wide, 'switch-field': type === 'switch' }"
  >
    <div class="label-line">
      <label :for="inputId"
        >{{ label
        }}<span v-if="required && type !== 'switch'" class="required"
          >*</span
        ></label
      ><button
        v-if="!required && modelValue !== undefined"
        class="reset-field"
        type="button"
        @click="update(undefined)"
        :title="`${label}：恢复未设置状态`"
        :aria-label="`清除${label}的自定义值`"
      >
        {{ defaultValue !== undefined ? "恢复默认" : "清除" }}
      </button>
    </div>
    <el-switch
      v-if="type === 'switch'"
      :id="inputId"
      :model-value="Boolean(effective)"
      @update:model-value="update"
      :aria-label="label"
    />
    <el-select
      v-else-if="type === 'select'"
      :id="inputId"
      :model-value="effective"
      @update:model-value="update"
      :placeholder="placeholder || '请选择'"
      :aria-label="label"
    >
      <el-option
        v-for="item in options"
        :key="typeof item === 'string' ? item : item.value"
        :value="typeof item === 'string' ? item : item.value"
        :label="typeof item === 'string' ? item : item.label"
      />
    </el-select>
    <el-input-number
      v-else-if="type === 'number'"
      :id="inputId"
      :model-value="modelValue"
      @update:model-value="update"
      :min="min"
      :max="max"
      :precision="0"
      controls-position="right"
      :placeholder="
        placeholder ||
        (defaultValue !== undefined ? `默认 ${defaultValue}` : '未设置')
      "
      :aria-label="label"
    />
    <template v-else-if="type === 'private-key'">
      <el-input
        v-if="revealed"
        :id="inputId"
        :model-value="modelValue ?? ''"
        @update:model-value="update"
        type="textarea"
        :rows="5"
        :aria-label="label"
        placeholder="粘贴 PEM 格式私钥"
      />
      <div v-else class="secret-placeholder">
        {{ modelValue ? "已配置私钥内容" : "尚未配置私钥内容" }}
      </div>
      <button class="text-action" @click="revealed = !revealed">
        {{ revealed ? "隐藏内容" : "查看 / 编辑内容" }}
      </button>
    </template>
    <el-input
      v-else
      :id="inputId"
      :aria-describedby="hint ? `${inputId}-hint` : undefined"
      :model-value="modelValue ?? ''"
      @update:model-value="!commit && update($event)"
      @change="commit && update($event)"
      :type="
        type === 'password'
          ? 'password'
          : type === 'textarea'
            ? 'textarea'
            : 'text'
      "
      :rows="3"
      :show-password="type === 'password'"
      :placeholder="placeholder || (required ? '请输入' : '选填')"
      :aria-label="label"
      autocomplete="off"
    />
    <p v-if="hint" :id="`${inputId}-hint`" class="field-hint">{{ hint }}</p>
  </div>
</template>
