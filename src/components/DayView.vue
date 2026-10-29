<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import EventBlock from './EventBlock.vue'

const props = defineProps({
  events: { type: Array, default: () => [] },
  selectedId: [Number, String],
  isToday: Boolean,
  createSlot: Number,
})
const emit = defineEmits(['event-click', 'event-ctx', 'event-dblclick', 'slot-click'])

const BASE_HOUR_HEIGHT = 64 // px，基准小时高度
const MIN_EVENT_HEIGHT = 22
const ZOOM_MIN = 0.4
const ZOOM_MAX = 2

const zoom = ref(1)
const HOUR_HEIGHT = computed(() => Math.round(BASE_HOUR_HEIGHT * zoom.value))

const gridEl = ref(null)
const alldayEl = ref(null)
const alldayH = ref(0) // 全天任务条实际高度：网格整体下移该距离，避免挡住 00:00/01:00
const nowMinute = ref(new Date().getHours() * 60 + new Date().getMinutes())
let timer = null

/** 测量全天条实际高度（任务换行时会变高） */
function measureAllday() {
  alldayH.value = alldayEl.value ? alldayEl.value.offsetHeight : 0
}
watch(() => props.events, () => nextTick(measureAllday), { flush: 'post' })

/** ctrl+滚轮：拦截浏览器整页缩放，只缩放中间时间任务区域（时间密度 0.4x~2x） */
function onGlobalWheel(e) {
  if (!e.ctrlKey) return
  e.preventDefault() // 必须拦截，否则触发浏览器页面缩放
  const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom.value - e.deltaY * 0.002))
  zoom.value = Math.round(next * 100) / 100
}

onMounted(() => {
  // 每 30 秒刷新当前时间线
  timer = setInterval(() => {
    const d = new Date()
    nowMinute.value = d.getHours() * 60 + d.getMinutes()
  }, 30000)
  window.addEventListener('wheel', onGlobalWheel, { passive: false, capture: true })
  measureAllday()
  // 打开时滚动到当前时间附近（今天）或 8 点
  const target = props.isToday ? Math.max(nowMinute.value - 60, 0) : 8 * 60
  if (gridEl.value) gridEl.value.scrollTop = (target / 60) * HOUR_HEIGHT.value
})

onBeforeUnmount(() => {
  clearInterval(timer)
  window.removeEventListener('wheel', onGlobalWheel, { capture: true })
})

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
    const top = Math.max(((e.start - dayStart) / 3600000) * HOUR_HEIGHT.value, 0)
    const height = Math.max(((e.end - e.start) / 3600000) * HOUR_HEIGHT.value, MIN_EVENT_HEIGHT)
    return { ...e, column, colSpan, top, height }
  })
})

function onGridClick(ev) {
  const rect = gridEl.value.getBoundingClientRect()
  const onRuler = ev.clientX - rect.left < 48 // 最左侧时间刻度列
  const t = ev.target
  const onGridArea =
    t === gridEl.value ||
    t.classList.contains('grid-inner') ||
    t.classList.contains('events-layer') ||
    t.classList.contains('hour-line') ||
    t.classList.contains('hour-label')
  if (!onRuler && !onGridArea) return
  // 内容坐标 = 视口相对 + 滚动偏移 - 全天条占掉的高度
  const y = ev.clientY - rect.top + gridEl.value.scrollTop - alldayH.value
  const minute = Math.floor(((y / HOUR_HEIGHT.value) * 60) / 30) * 30
  if (minute < 0 || minute >= 24 * 60) return
  // 第二个参数标记"来自时间刻度"：该时段创建的任务插到时段第一位（协议 firstInSlot）
  emit('slot-click', minute, onRuler)
}

function formatMinutes(colSpan) {
  return Math.round(colSpan * 2.5)
}
</script>

<template>
  <div class="day-view" ref="gridEl" @click="onGridClick">
    <!-- 全天任务条：参与文档流，把下面的网格整体顶下去，不再挡住 00:00/01:00 -->
    <div v-if="alldayEvents.length" class="allday-row" ref="alldayEl">
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

    <div class="grid-inner" :style="{ height: HOUR_HEIGHT * 24 + 'px' }">
      <!-- 小时标签 + 横线 -->
      <div
        v-for="h in 24"
        :key="h"
        class="hour-line"
        :style="{ top: (h - 1) * HOUR_HEIGHT + alldayH + 'px' }"
      >
        <span class="hour-label">{{ String(h - 1).padStart(2, '0') }}:00</span>
      </div>

      <!-- 任务块：独立事件层从刻度右侧开始，列间距 0.5em（半个字宽） -->
      <div class="events-layer">
        <EventBlock
          v-for="e in layoutEvents"
          :key="e.id"
          :event="e"
          :style="{
            top: e.top + alldayH + 'px',
            height: e.height + 'px',
            left: `${(e.column / 12) * 100}%`,
            width: `calc(${(e.colSpan / 12) * 100}% - 0.5em)`,
          }"
          :selected="e.id === selectedId"
          :minutes-text="formatMinutes(e.colSpan)"
          @click.stop="emit('event-click', e)"
          @ctxmenu.prevent.stop="emit('event-ctx', e, $event.clientX, $event.clientY)"
          @dblclick.stop="emit('event-dblclick', e)"
        />
      </div>

      <!-- 当前时间线 -->
      <div
        v-if="isToday"
        class="now-line"
        :style="{ top: (nowMinute / 60) * HOUR_HEIGHT + alldayH + 'px' }"
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

/* 事件层：绝对定位容器从时间刻度右侧开始，任务块按纯百分比排布，
   列间只留 0.5em（半个字宽）的缝；此前每列都叠加 48px 刻度偏移导致间隔过宽 */
.events-layer {
  position: absolute;
  left: 48px;
  right: 0;
  top: 0;
  height: 100%;
  z-index: 2;
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

/* 全天任务条：普通流布局（高度自适应换行），把网格整体顶下去 */
.allday-row {
  position: relative;
  z-index: 3;
  padding-left: 48px;
  border-bottom: 1px solid var(--grid-line);
  background: #fff;
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
