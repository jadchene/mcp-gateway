import { createApp } from "vue";
import {
  ElAlert,
  ElButton,
  ElCard,
  ElCheckbox,
  ElDialog,
  ElInput,
  ElInputNumber,
  ElOption,
  ElSelect,
  ElSwitch,
  ElTag,
  ElLoading,
} from "element-plus";
import "element-plus/dist/index.css";
import App from "./App.vue";
import "./style.css";

const app = createApp(App);
for (const component of [
  ElAlert,
  ElButton,
  ElCard,
  ElCheckbox,
  ElDialog,
  ElInput,
  ElInputNumber,
  ElOption,
  ElSelect,
  ElSwitch,
  ElTag,
  ElLoading,
])
  app.use(component);
app.mount("#app");
