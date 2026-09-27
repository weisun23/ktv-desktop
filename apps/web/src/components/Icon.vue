<template>
  <!--
    统一图标组件。
    为什么不用 emoji（⚙ 🔊 ♥ ★ ✕…）：
      - 不同 Windows 版本 / 字体下字形差别很大，有的还是彩色 emoji，和暗色界面格格不入
      - 字号和对齐要一个个调，换主题时颜色也跟不上
    这里统一成 24×24 的描边 SVG，颜色走 currentColor（自动跟随主题）。
  -->
  <svg
    class="icon"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    :fill="fill ? 'currentColor' : 'none'"
    stroke="currentColor"
    :stroke-width="strokeWidth"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <template v-if="name === 'gear'">
      <circle cx="12" cy="12" r="3.1" />
      <path d="M19.2 14.6a1.6 1.6 0 0 0 .32 1.76l.06.06a1.94 1.94 0 1 1-2.74 2.74l-.06-.06a1.6 1.6 0 0 0-1.76-.32 1.6 1.6 0 0 0-.97 1.46V21a1.94 1.94 0 1 1-3.88 0v-.1a1.6 1.6 0 0 0-1.05-1.46 1.6 1.6 0 0 0-1.76.32l-.06.06a1.94 1.94 0 1 1-2.74-2.74l.06-.06a1.6 1.6 0 0 0 .32-1.76 1.6 1.6 0 0 0-1.46-.97H3a1.94 1.94 0 1 1 0-3.88h.1a1.6 1.6 0 0 0 1.46-1.05 1.6 1.6 0 0 0-.32-1.76l-.06-.06a1.94 1.94 0 1 1 2.74-2.74l.06.06a1.6 1.6 0 0 0 1.76.32H9a1.6 1.6 0 0 0 .97-1.46V3a1.94 1.94 0 1 1 3.88 0v.1a1.6 1.6 0 0 0 .97 1.46 1.6 1.6 0 0 0 1.76-.32l.06-.06a1.94 1.94 0 1 1 2.74 2.74l-.06.06a1.6 1.6 0 0 0-.32 1.76V9a1.6 1.6 0 0 0 1.46.97H21a1.94 1.94 0 1 1 0 3.88h-.1a1.6 1.6 0 0 0-1.46.97z" />
    </template>
    <template v-else-if="name === 'volume'">
      <path d="M11 5 6.5 9H3v6h3.5L11 19z" />
      <path d="M15.5 8.8a4.4 4.4 0 0 1 0 6.4" />
      <path d="M18.4 6a8.2 8.2 0 0 1 0 12" />
    </template>
    <template v-else-if="name === 'heart'">
      <path d="M12 20.3 4.6 13a4.7 4.7 0 0 1 6.6-6.7l.8.8.8-.8A4.7 4.7 0 0 1 19.4 13z" />
    </template>
    <template v-else-if="name === 'heart-filled'">
      <path d="M12 20.3 4.6 13a4.7 4.7 0 0 1 6.6-6.7l.8.8.8-.8A4.7 4.7 0 0 1 19.4 13z" />
    </template>
    <template v-else-if="name === 'star'">
      <path d="m12 3.6 2.6 5.3 5.9.86-4.25 4.14 1 5.87L12 17l-5.25 2.77 1-5.87L3.5 9.76l5.9-.86z" />
    </template>
    <template v-else-if="name === 'star-filled'">
      <path d="m12 3.6 2.6 5.3 5.9.86-4.25 4.14 1 5.87L12 17l-5.25 2.77 1-5.87L3.5 9.76l5.9-.86z" />
    </template>
    <template v-else-if="name === 'chevron-left'"><path d="m14.5 6-6 6 6 6" /></template>
    <template v-else-if="name === 'chevron-right'"><path d="m9.5 6 6 6-6 6" /></template>
    <template v-else-if="name === 'chevrons-left'"><path d="m12.5 6-6 6 6 6" /><path d="m18.5 6-6 6 6 6" /></template>
    <template v-else-if="name === 'chevrons-right'"><path d="m11.5 6 6 6-6 6" /><path d="m5.5 6 6 6-6 6" /></template>
    <template v-else-if="name === 'music'">
      <path d="M9 18V6.5l10-2V16" />
      <circle cx="6.5" cy="18" r="2.5" />
      <circle cx="16.5" cy="16" r="2.5" />
    </template>
    <template v-else-if="name === 'play'"><path d="m8 5 11 7-11 7z" /></template>
    <template v-else-if="name === 'pause'"><path d="M8 5v14M16 5v14" /></template>
    <template v-else-if="name === 'rewind'"><path d="M11 7 5 12l6 5zM19 7l-6 5 6 5z" /></template>
    <template v-else-if="name === 'forward'"><path d="m13 7 6 5-6 5zM5 7l6 5-6 5z" /></template>
    <template v-else-if="name === 'skip-forward'"><path d="m5 6 9 6-9 6zM19 6v12" /></template>
    <template v-else-if="name === 'arrow-up'"><path d="m6 14 6-6 6 6" /></template>
    <template v-else-if="name === 'arrow-down'"><path d="m6 10 6 6 6-6" /></template>
    <template v-else-if="name === 'trash'"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></template>
    <template v-else-if="name === 'plus'"><path d="M12 5v14M5 12h14" /></template>
    <template v-else-if="name === 'expand'"><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5" /></template>
    <template v-else-if="name === 'compress'"><path d="M3 8h5V3M21 8h-5V3M3 16h5v5M21 16h-5v5" /></template>
    <template v-else-if="name === 'cloud'"><path d="M7 18h10a4 4 0 0 0 .7-7.94A6 6 0 0 0 6.2 8.4 4.8 4.8 0 0 0 7 18z" /></template>
    <template v-else-if="name === 'monitor'"><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8M12 17v4" /></template>
    <template v-else-if="name === 'palette'"><path d="M12 3a9 9 0 1 0 0 18h1.5a1.5 1.5 0 0 0 0-3H12a2 2 0 0 1 0-4h2a7 7 0 0 0 7-7c0-2.2-4-4-9-4z" /><circle cx="7.5" cy="10" r=".8" /><circle cx="10" cy="6.8" r=".8" /><circle cx="14.2" cy="6.5" r=".8" /><circle cx="17" cy="9.5" r=".8" /></template>
    <template v-else-if="name === 'activity'"><path d="M3 12h4l2.5-6 5 12 2.5-6H21" /></template>
    <template v-else-if="name === 'folder'"><path d="M3 6h7l2 2h9v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></template>
    <template v-else-if="name === 'hard-drive'"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M7 15h.01M11 15h6" /></template>
    <template v-else-if="name === 'smartphone'"><rect x="7" y="2" width="10" height="20" rx="2" /><path d="M11 18h2" /></template>
    <template v-else-if="name === 'sparkles'"><path d="m12 3 1.4 4.1L17.5 8.5l-4.1 1.4L12 14l-1.4-4.1L6.5 8.5l4.1-1.4z" /><path d="m19 15 .8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" /></template>
    <template v-else-if="name === 'sliders'"><path d="M4 6h16M4 12h16M4 18h16" /><circle cx="9" cy="6" r="2" /><circle cx="15" cy="12" r="2" /><circle cx="7" cy="18" r="2" /></template>
    <template v-else-if="name === 'database'"><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" /></template>
    <template v-else-if="name === 'search'">
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4.5 4.5" />
    </template>
    <template v-else-if="name === 'close'"><path d="M6 6l12 12M18 6L6 18" /></template>
  </svg>
</template>

<script setup>
defineProps({
  name: { type: String, required: true },
  size: { type: [Number, String], default: 16 },
  strokeWidth: { type: [Number, String], default: 1.8 },
  /** 实心图标（收藏/星标选中态） */
  fill: { type: Boolean, default: false },
})
</script>

<style scoped>
.icon { display: block; flex: none; }
</style>