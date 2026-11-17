<script setup>
defineProps({ name: String });
const paths = {
  file: ["M14 3H5v18h14V8l-5-5Z", "M14 3v5h5M8 12h8M8 16h6"],
  copy: ["M8 8h12v13H8z", "M16 8V3H3v13h5"],
  undo: ["M9 5 4 10l5 5", "M4 10h10a6 6 0 0 1 6 6v3"],
  trash: ["M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7M14 10v7"],
  up: ["m7 14 5-5 5 5"],
  down: ["m7 10 5 5 5-5"],
  shield: ["M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6l-8-3Z", "m8 12 3 3 5-6"],
  gateway: [
    "M5 6h14v5H5z",
    "M5 16h4v4H5zM15 16h4v4h-4z",
    "M12 11v3M7 14h10M7 14v2M17 14v2",
  ],
  ssh: ["M4 5h16v14H4z", "m8 9 3 3-3 3M13 15h3"],
  database: [
    "M20 6c0 2-3.6 3.5-8 3.5S4 8 4 6s3.6-3.5 8-3.5S20 4 20 6Z",
    "M4 6v12c0 2 3.6 3.5 8 3.5s8-1.5 8-3.5V6M4 12c0 2 3.6 3.5 8 3.5s8-1.5 8-3.5",
  ],
  settings: ["M4 7h16M4 17h16", "M8 4v6M16 14v6"],
  info: ["M12 16v-4M12 8h.01", "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0"],
  search: ["M10.5 17a6.5 6.5 0 1 1 0-13 6.5 6.5 0 0 1 0 13Zm5-1 4.5 4.5"],
  plus: ["M12 5v14M5 12h14"],
  refresh: [
    "M20 7v5h-5M4 17v-5h5",
    "M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1",
  ],
  check: ["m5 12 4 4L19 6"],
  external: ["M14 4h6v6M20 4 10 14", "M10 4H4v16h16v-6"],
};
</script>
<template>
  <svg
    class="ui-icon"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path
      v-for="(path, index) in paths[name] || paths.settings"
      :key="index"
      :d="path"
    />
  </svg>
</template>
