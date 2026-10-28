<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import EventBlock from './EventBlock.vue'

const props = defineProps({
  events: { type: Array, default: () => [] },
  selectedId: [Number, String],
  isToday: Boolean,
  createSlot: Number,
})
const emit = defineEmits(['event-click', 'event-ctx', 'event-dblclick', 'slot-click'])

const HOUR_HEIGHT = 64 // px，与 App 默认一致
const MIN_EVENT_HEIGHT = 22

const gridEl = ref(null)
const nowMinute = ref(new Date().getHours() * 60 + new Date().getMinutes())
let timer = null

onMounted(() => {
  // 每分钟刷新当前时间线
  timer = setInterval(() => {
    const d = new Date()
    nowMinute.value = d.getHours() * 60 + d.getMinutes()
  }, 30000)
  // 打开时滚动到当前时间附近（今天）或 8 点
  const target = props.isToday ? Math.max(nowMinute.value - 60, 0) : 8 * 60
  if (gridEl.value) gridEl.value.scrollTop = (target / 60) * HOUR_HEIGHT
})

onBeforeUnmount(() => clearInterval(timer))

const alldayEvents = computed(() => props.events.filter((e) => e.allDay))
const timedEvents = computed(() => props.events.filter((e) => !e.allDay))

/**
 * 布局：一个 30 分钟时段 = 12 个宽度单位（1 单位 = 2.5 分钟）。
 * 同时段内按 sortId 从左到右累计 colSpan 摆放，与安卓端 Event.doComputePositions 一致。
 */
const layoutEvents = computed(() => {
  const slotColumns = new Map() // slotStart -> 累计列数
  const sorted = [...timedEvents.value].sort((a, b) => {
    if (a.sortId !== b.sortId) return a.sortId - b.sortId
    return b.id - a.id
  })
  return sorted.map((e) => {
    const d = new Date(e.start)
    const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
    const slotStart = e.start - ((e.start - dayStart) % (30 * 60 * 1000))
    let column = slotColumns.get(slotStart) || 0
    const colSpan = Math.min(Math.max(e.colSpan || 1, 1), 12 - column) || 1
    slotColumns.set(slotStart, column + colSpan)
    const top = Math.max(((e.start - dayStart) / 3600000) * HOUR_HEIGHT, 0)
    const height = Math.max(((e.end - e.start) / 3600000) * HOUR_HEIGHT, MIN_EVENT_HEIGHT)
    return { ...e, column, colSpan, top, height }
  })
})

function onGridClick(ev) {
  if (ev.target !== gridEl.value && !ev.target.classList.contains('grid-inner') && !ev.target.classList.contains('hour-line')) {
    return
  }
  const rect = gridEl.value.getBoundingClientRect()
  const y = ev.clientY - rect.top + gridEl.value.scrollTop
  const minute = Math.floor((y / HOUR_HEIGHT) * 60 / 30) * 30
  if (minute < 0 || minute >= 24 * 60) return
  emit('slot-click', minute)
}

function formatMinutes(colSpan) {
  return Math.round(colSpan * 2.5)
}
</script>

<template>
  <div class="day-view" ref="gridEl" @click="onGridClick">
    <div class="grid-inner" :style="{ height: HOUR_HEIGHT * 24 + 'px' }">
      <!-- 全天任务条 -->
      <div v-if="alldayEvents.length" class="allday-row">
        <EventBlock
          v-for="e in alldayEvents"
          :key="e.id"
          :event="e"
          :allday="true"
          :selected="e.id === selectedId"
          :minutes-text="''"
          @click.stop="emit('event-click', e)"
          @ctxmenu.prevent.stop="emit('event-ctx', e, $event.clientX, $event.clientY)"
          @dblclick.stop="emit('event-dblclick', e)"
        />
      </div>

      <!-- 小时标签 + 横线 -->
      <div
        v-for="h in 24"
        :key="h"
        class="hour-line"
        :style="{ top: (h - 1) * HOUR_HEIGHT + 'px' }"
      >
        <span class="hour-label">{{ String(h - 1).padStart(2, '0') }}:00</span>
      </div>

      <!-- 任务块 -->
      <EventBlock
        v-for="e in layoutEvents"
        :key="e.id"
        :event="e"
        :style="{
          top: e.top + 'px',
          height: e.height + 'px',
          left: `calc(${(e.column / 12) * 100}% + 48px)`,
          width: `calc(${(e.colSpan / 12) * 100}% - 50px)`,
        }"
        :selected="e.id === selectedId"
        :minutes-text="formatMinutes(e.colSpan)"
        @click.stop="emit('event-click', e)"
        @ctxmenu.prevent.stop="emit('event-ctx', e, $event.clientX, $event.clientY)"
        @dblclick.stop="emit('event-dblclick', e)"
      />

      <!-- 当前时间线 -->
      <div
        v-if="isToday"
        class="now-line"
        :style="{ top: (nowMinute / 60) * HOUR_HEIGHT + 'px' }"
      ></div>
    </div>
  </div>
</template>

<style scoped>
.day-view {
  flex: 1;
  overflow-y: auto;
  background: #fff;
  position: relative;
}

.grid-inner {
  position: relative;
  min-height: 100%;
  padding-left: 48px;
}

.hour-line {
  position: absolute;
  left: 48px;
  right: 0;
  height: 1px;
  background: var(--grid-line);
}

.hour-label {
  position: absolute;
  left: -48px;
  top: -7px;
  width: 44px;
  text-align: right;
  font-size: 12px;
  color: var(--hour-label);
}

.allday-row {
  position: absolute;
  top: 0;
  left: 48px;
  right: 0;
  height: 30px;
  border-bottom: 1px solid var(--grid-line);
  background: #fff;
  z-index: 3;
}

.now-line {
  position: absolute;
  left: 44px;
  right: 0;
  height: 2px;
  background: #b01b1b;
  z-index: 4;
  pointer-events: none;
}

.now-line::before {
  content: '';
  position: absolute;
  left: 0;
  top: -4px;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #b01b1b;
}
</style>
