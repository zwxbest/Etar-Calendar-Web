<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import EventBlock from './EventBlock.vue'

const props = defineProps({
  events: { type: Array, default: () => [] },
  selectedId: [Number, String],
  isToday: Boolean,
  createSlot: Number,
  // 网页端展示顺序提示：{ [被移动任务id]: 锚点任务id } 表示"排到锚点前面"（纯前端规则，不落手机库）
  orderHint: { type: Object, default: () => ({}) },
})
const emit = defineEmits(['event-click', 'event-ctx', 'event-dblclick', 'slot-click', 'ruler-dblclick'])

const BASE_HOUR_HEIGHT = 64 // px，基准小时高度
const MIN_EVENT_HEIGHT = 22
const ZOOM_MIN = 0.4
const ZOOM_MAX = 4 // 最大放大 4x（在 1x 基础上再放大两倍）

// 初始即最大放大倍数（打开/刷新就是 4x），ctrl+滚轮可再缩小
const zoom = ref(ZOOM_MAX)
const HOUR_HEIGHT = computed(() => Math.round(BASE_HOUR_HEIGHT * zoom.value))

const gridEl = ref(null)
const alldayEl = ref(null)
const alldayH = ref(0) // 全天任务条实际高度：网格整体下移该距离，避免挡住 00:00/01:00
const nowMinute = ref(new Date().getHours() * 60 + new Date().getMinutes())
// 红线（当前时刻）是否在可视区域内：不在 → 按钮显示"现在"；在 → 变成"顶部"
const nowInView = ref(false)
let timer = null

/** 测量全天条实际高度（任务换行时会变高） */
function measureAllday() {
  alldayH.value = alldayEl.value ? alldayEl.value.offsetHeight : 0
}
watch(() => props.events, () => nextTick(measureAllday), { flush: 'post' })

/** ctrl+滚轮：拦截浏览器整页缩放，只缩放中间时间任务区域（时间密度 0.4x~4x）。
 *  以鼠标所在行为锚点：缩放后该时间点保持在视口原位，不产生滚动/漂移感。 */
function onGlobalWheel(e) {
  if (!e.ctrlKey) return
  e.preventDefault()
  e.stopImmediatePropagation() // 彻底吃掉该事件：不滚动视图、不触发其它监听
  const grid = gridEl.value
  if (!grid) return
  const rect = grid.getBoundingClientRect()
  // 鼠标位置对应的时间（小时，浮点）：缩放前后保持它停留在同一视口位置
  // 注意全天条高度固定不随缩放变化，先扣除再换算
  const innerY = grid.scrollTop + e.clientY - rect.top - alldayH.value
  const anchorHour = innerY / HOUR_HEIGHT.value
  const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom.value - e.deltaY * 0.002))
  zoom.value = Math.round(next * 100) / 100
  nextTick(() => {
    grid.scrollTop = Math.max(alldayH.value + anchorHour * HOUR_HEIGHT.value - (e.clientY - rect.top), 0)
  })
}

/** 定位到现在：滚动到红线（当前时刻）居中显示 */
function scrollToNow() {
  const grid = gridEl.value
  if (!grid) return
  const top = Math.max(
    (nowMinute.value / 60) * HOUR_HEIGHT.value + alldayH.value - grid.clientHeight / 2,
    0,
  )
  grid.scrollTo({ top, behavior: 'smooth' })
}

/** 滚动条回到最顶部 */
function scrollToTop() {
  const grid = gridEl.value
  if (!grid) return
  grid.scrollTo({ top: 0, behavior: 'smooth' })
}

/** 红线（当前时刻）是否在视野内：内容坐标 = 线的位置（含全天条高度），与可视区间比对 */
function updateNowInView() {
  const grid = gridEl.value
  if (!grid || !props.isToday) {
    nowInView.value = false
    return
  }
  const lineY = (nowMinute.value / 60) * HOUR_HEIGHT.value + alldayH.value
  nowInView.value = lineY >= grid.scrollTop && lineY <= grid.scrollTop + grid.clientHeight
}

onMounted(() => {
  // 每 30 秒刷新当前时间线
  timer = setInterval(() => {
    const d = new Date()
    nowMinute.value = d.getHours() * 60 + d.getMinutes()
  }, 30000)
  window.addEventListener('wheel', onGlobalWheel, { passive: false, capture: true })
  gridEl.value?.addEventListener('scroll', updateNowInView, { passive: true })
  measureAllday()
  // 打开时滚动到当前时间附近（今天）或 8 点（内容坐标含全天条高度）
  const target = props.isToday ? Math.max(nowMinute.value - 60, 0) : 8 * 60
  if (gridEl.value) gridEl.value.scrollTop = (target / 60) * HOUR_HEIGHT.value + alldayH.value
  updateNowInView()
})

// 时间线/缩放/全天条高度变化后，红线位置会变，重新判断是否在视野内
watch([nowMinute, zoom, alldayH], () => nextTick(updateNowInView))

onBeforeUnmount(() => {
  clearInterval(timer)
  window.removeEventListener('wheel', onGlobalWheel, { capture: true })
  gridEl.value?.removeEventListener('scroll', updateNowInView)
})

const alldayEvents = computed(() => props.events.filter((e) => e.allDay))
const timedEvents = computed(() => props.events.filter((e) => !e.allDay))

/** 任务所属 30 分钟时段的起始毫秒 */
function slotOf(e) {
  const d = new Date(e.start)
  const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  return e.start - ((e.start - dayStart) % (30 * 60 * 1000))
}

/**
 * 布局：一个 30 分钟时段 = 12 个宽度单位（1 单位 = 2.5 分钟）。
 * 同时段内按 sortId 从左到右累计 colSpan 摆放，与安卓端 Event.doComputePositions 一致；
 * 之后套用网页端顺序提示（orderHint：把被移动的任务排到锚点任务前面）。
 */
const layoutEvents = computed(() => {
  const slotColumns = new Map() // slotStart -> 累计列数
  const sorted = [...timedEvents.value].sort((a, b) => {
    if (a.sortId !== b.sortId) return a.sortId - b.sortId
    return b.id - a.id
  })
  // 按时段分组 → 组内套用顺序提示（被移动的任务插到锚点当前位置之前）
  const bySlot = new Map()
  for (const e of sorted) {
    const s = slotOf(e)
    if (!bySlot.has(s)) bySlot.set(s, [])
    bySlot.get(s).push(e)
  }
  const hint = props.orderHint || {}
  for (const list of bySlot.values()) {
    for (const e of [...list]) {
      const anchorId = hint[e.id]
      if (anchorId == null) continue
      const from = list.indexOf(e)
      const to = list.findIndex((x) => x.id === anchorId)
      if (to < 0 || to === from) continue
      list.splice(from, 1)
      list.splice(list.findIndex((x) => x.id === anchorId), 0, e)
    }
  }
  const ordered = []
  for (const list of bySlot.values()) ordered.push(...list)
  return ordered.map((e) => {
    // 本地零点（必须用本地年月日构造；用 epoch%24h 会得到 UTC 零点，整体偏移时区小时数）
    const d = new Date(e.start)
    const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
    let column = slotColumns.get(slotOf(e)) || 0
    const colSpan = Math.min(Math.max(e.colSpan || 1, 1), 12 - column) || 1
    slotColumns.set(slotOf(e), column + colSpan)
    const top = Math.max(((e.start - dayStart) / 3600000) * HOUR_HEIGHT.value, 0)
    const height = Math.max(((e.end - e.start) / 3600000) * HOUR_HEIGHT.value, MIN_EVENT_HEIGHT)
    return { ...e, column, colSpan, top, height }
  })
})

function onGridClick(ev) {
  const grid = gridEl.value
  const rect = grid.getBoundingClientRect()
  const onRuler = ev.clientX - rect.left < 48 // 最左侧时间刻度列
  const t = ev.target
  const onGridArea =
    t === grid ||
    t.classList.contains('grid-inner') ||
    t.classList.contains('events-layer') ||
    t.classList.contains('hour-line') ||
    t.classList.contains('hour-label')
  if (!onRuler && !onGridArea) return
  // 内容坐标 = 视口相对 + 滚动偏移 - 全天条占掉的高度（全天条在文档流里，网格在其下方）
  const y = ev.clientY - rect.top + grid.scrollTop - alldayH.value
  const minute = Math.floor(((y / HOUR_HEIGHT.value) * 60) / 30) * 30
  if (minute < 0 || minute >= 24 * 60) return
  // 第二个参数标记"来自时间刻度"：该时段创建的任务插到时段第一位（协议 firstInSlot）
  emit('slot-click', minute, onRuler)
}

/** 双击时间区任意位置（刻度或网格）：在鼠标位置弹出快捷输入框，在该时段创建 */
function onGridDblClick(ev) {
  const grid = gridEl.value
  const rect = grid.getBoundingClientRect()
  const y = ev.clientY - rect.top + grid.scrollTop - alldayH.value
  const minute = Math.floor(((y / HOUR_HEIGHT.value) * 60) / 30) * 30
  if (minute < 0 || minute >= 24 * 60) return
  emit('ruler-dblclick', minute, ev.clientX, ev.clientY)
}

function formatMinutes(colSpan) {
  // 与安卓 DayView 一致：(int)(colSpan * 2.5f) 截断取整——
  // JS 的 Math.round(2.5)=3 会比安卓的 (int)2.5f=2 多显示 1 分钟
  return Math.floor(colSpan * 2.5)
}
</script>

<template>
  <div class="day-view-wrap">
    <div class="day-view" ref="gridEl" @click="onGridClick" @dblclick="onGridDblClick">
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
        <!-- 小时标签 + 横线（网格已在全天条下方，无需再叠加全天条偏移） -->
        <div
          v-for="h in 24"
          :key="h"
          class="hour-line"
          :style="{ top: (h - 1) * HOUR_HEIGHT + 'px' }"
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
              top: e.top + 'px',
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
          :style="{ top: (nowMinute / 60) * HOUR_HEIGHT + 'px' }"
        ></div>
      </div>
    </div>

    <!-- 定位到现在：红线不在视野内时显示"现在"（点击滚动到红线居中）；
         红线已在视野内时变成"顶部"（点击滚动条回到最顶部） -->
    <button
      v-if="isToday"
      class="now-btn"
      :title="nowInView ? '回到顶部' : '定位到现在'"
      @click.stop="nowInView ? scrollToTop() : scrollToNow()"
    >
      {{ nowInView ? '顶部' : '现在' }}
    </button>
  </div>
</template>

<style scoped>
.day-view-wrap {
  position: relative;
  flex: 1;
  display: flex;
  min-height: 0;
}

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

/* 定位到现在按钮：悬浮在网格右侧垂直居中，不随内容滚动 */
.now-btn {
  position: absolute;
  right: 14px;
  top: 50%;
  transform: translateY(-50%);
  z-index: 6;
  padding: 12px 28px;
  border-radius: 999px;
  border: 1px solid var(--grid-line);
  background: #fff;
  color: var(--color-primary);
  font-size: 26px;
  font-weight: 500;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.18);
  cursor: pointer;
}

.now-btn:hover {
  background: var(--color-primary);
  color: #fff;
}
</style>
