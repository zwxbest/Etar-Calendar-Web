<script setup>
import { computed } from 'vue'

const props = defineProps({
  event: { type: Object, required: true },
  selected: Boolean,
  allday: Boolean,
  minutesText: [Number, String],
})

// 配色逻辑与安卓端 DayView.taskBackgroundColor 一致：
// 基础色 = 日历色；高优先级 = 纯紫 #6B21A8（与 --high-priority 一致）；弹性任务与白色各 50%
function intToRgb(color) {
  return [(color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff]
}

function mix(c1, c2, ratio) {
  return c1.map((v, i) => Math.round(v * (1 - ratio) + c2[i] * ratio))
}

const backgroundColor = computed(() => {
  const e = props.event
  let rgb = typeof e.color === 'number' ? intToRgb(e.color) : [63, 81, 181]
  if (e.priority === 1) rgb = [0x6b, 0x21, 0xa8]
  if (e.flexible) rgb = mix(rgb, [255, 255, 255], 0.5)
  return `rgb(${rgb.join(',')})`
})

// 底色浅则黑字，深则白字（对应 Utils.getAdaptiveTextColor）
const textColor = computed(() => {
  const m = backgroundColor.value.match(/\d+/g).map(Number)
  const brightness = (m[0] * 299 + m[1] * 587 + m[2] * 114) / 1000
  return brightness > 140 ? '#212121' : '#ffffff'
})
</script>

<template>
  <div
    class="event-block"
    :class="{ selected, allday }"
    :style="{ background: backgroundColor, color: textColor }"
  >
    <span class="title">{{ event.title }}<template v-if="minutesText !== '' && minutesText != null"> {{ minutesText }}</template></span>
  </div>
</template>

<style scoped>
.event-block {
  position: absolute;
  border: 1px solid rgba(0, 0, 0, 0.18);
  padding: 2px 4px;
  font-size: 12px;
  font-weight: bold;
  overflow: hidden;
  cursor: pointer;
  user-select: none;
  line-height: 1.25;
  word-break: break-all;
}

.event-block.allday {
  position: static;
  display: inline-block;
  max-width: 100%;
  height: 24px;
  margin: 2px 2px;
  vertical-align: top;
}

.event-block.selected::after {
  content: '';
  position: absolute;
  inset: 0;
  background: var(--selected-overlay);
}
</style>
