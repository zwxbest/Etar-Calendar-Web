<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import TopBar from './components/TopBar.vue'
import DayView from './components/DayView.vue'
import CtxMenu from './components/CtxMenu.vue'
import CreateBar from './components/CreateBar.vue'
import EditDialog from './components/EditDialog.vue'
import PairDialog from './components/PairDialog.vue'
import { SyncClient } from './lib/sync.js'
import { loadConfig, saveConfig, clearConfig } from './lib/store.js'

const sync = new SyncClient()

const config = ref(loadConfig())
const status = ref('idle') // idle | connecting | connected | offline
const transport = ref('mqtt') // 当前数据通道：mqtt 直连 | rtc P2P
const statusText = computed(() => {
  if (status.value === 'connected') return transport.value === 'rtc' ? '已连通·P2P' : '已连通·MQTT'
  return ({ idle: '未连接', connecting: '连接中', offline: '离线' })[status.value]
})
const events = ref([])
const currentDate = ref(todayStr())
const selectedId = ref(null)
const ctxMenu = ref(null) // {event, x, y}
const editTarget = ref(null)
const showPair = ref(false)
const toastText = ref('')
let toastTimer = null

// 创建栏目标时段（分钟偏移 0/30），默认按"当前/下一个30分钟"
const createSlot = ref(defaultSlotMinute())

function todayStr() {
  const d = new Date()
  return fmtDate(d)
}

function fmtDate(d) {
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

function defaultSlotMinute() {
  const now = new Date()
  const cur = Math.floor(now.getMinutes() / 30) * 30
  // 与安卓端"默认建在当前30分钟"设置一致：显示今天时用当前时段
  return cur
}

function parseDay(day) {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d)
}

/** 显示日 + 分钟偏移 → epoch millis（本地时区） */
function slotStartMillis(day, minuteOffset) {
  const d = parseDay(day)
  d.setHours(0, minuteOffset, 0, 0)
  return d.getTime()
}

const displayDateText = computed(() => {
  const d = parseDay(currentDate.value)
  const week = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()]
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 星期${week}`
})

function showToast(text) {
  toastText.value = text
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (toastText.value = ''), 2500)
}

// ---------- 连接与数据 ----------

async function fetchDay() {
  if (status.value !== 'connected') return
  try {
    events.value = await sync.fetchDay(currentDate.value)
    selectedId.value = null
  } catch (e) {
    showToast(e.message)
  }
}

onMounted(() => {
  sync.on('status', (s, tr) => {
    status.value = s
    if (tr) transport.value = tr
    if (s === 'connected') {
      // 配对成功（任一通道首通）后保存安卓 peerId，下次自动重连不用再输码
      if (config.value && config.value.androidPeerId !== sync.androidPeerId) {
        config.value.androidPeerId = sync.androidPeerId
        saveConfig(config.value)
      }
      fetchDay()
    }
  })
  sync.on('push', () => fetchDay())
  sync.on('rtc-open', () => {
    // 配对成功后保存安卓 peerId，下次自动重连不用再输码
    if (config.value && config.value.androidPeerId !== sync.androidPeerId) {
      config.value.androidPeerId = sync.androidPeerId
      saveConfig(config.value)
    }
  })
  sync.on('message', (m) => {
    if (typeof m === 'string') showToast(m)
  })
  if (config.value) {
    sync.connect(config.value)
  } else {
    showPair.value = true
  }
})

onBeforeUnmount(() => sync.disconnect())

function onPaired(newConfig) {
  config.value = newConfig
  saveConfig(newConfig)
  showPair.value = false
  sync.connect(newConfig)
}

function unpair() {
  sync.disconnect()
  clearConfig()
  config.value = null
  events.value = []
  showPair.value = true
}

// ---------- 日期切换 ----------

function goDay(delta) {
  const d = parseDay(currentDate.value)
  d.setDate(d.getDate() + delta)
  currentDate.value = fmtDate(d)
  createSlot.value = defaultSlotMinute()
  fetchDay()
}

// ---------- 任务操作 ----------

async function doAction(fn, successText) {
  try {
    await fn()
    if (successText) showToast(successText)
    await fetchDay()
  } catch (e) {
    showToast(e.message)
    await fetchDay()
  }
}

function onCtxAction({ action, event }) {
  ctxMenu.value = null
  const id = event.id
  switch (action) {
    case 'edit':
      editTarget.value = event
      break
    case 'move-today':
      doAction(() => sync.update(id, { allDay: true, startDayOffset: 0 }), '已移动到今天')
      break
    case 'move-tomorrow':
      doAction(() => sync.update(id, { allDay: true, startDayOffset: 1 }), '已移动到明天')
      break
    case 'toggle-flexible':
      doAction(
        () => sync.update(id, { flexible: !event.flexible }),
        event.flexible ? '已取消弹性任务' : '已设为弹性任务'
      )
      break
    case 'toggle-priority':
      doAction(
        () => sync.update(id, { priority: event.priority === 1 ? 0 : 1 }),
        event.priority === 1 ? '已取消高优先级' : '已设为高优先级'
      )
      break
    case 'fill':
      doAction(() => sync.update(id, { flexible: true }), '已补满')
      break
    case 'delete':
      doAction(() => sync.remove(id), '已删除')
      break
  }
}

function onAdjustDuration(event, minutes) {
  ctxMenu.value = null
  doAction(() => sync.update(event.id, { colSpan: Math.round(minutes / 2.5) }), `已调整为${minutes}分钟`)
}

function onDeleteEvent(event) {
  ctxMenu.value = null
  doAction(() => sync.remove(event.id), '已删除')
}

function onEditSave(payload) {
  const event = editTarget.value
  editTarget.value = null
  if (!event) return
  doAction(() => sync.update(event.id, payload), '已保存')
}

// 单击任务：未选中则选中；已选中则把选中的任务移动到该任务所在时段
function onEventClick(event) {
  ctxMenu.value = null
  if (selectedId.value == null) {
    selectedId.value = event.id
    return
  }
  if (selectedId.value === event.id) {
    selectedId.value = null
    return
  }
  moveSelectedTo(event.start)
}

// 单击空白时段：已选中任务则移动过去，否则设为创建目标时段
function onSlotClick(minuteOffset) {
  ctxMenu.value = null
  if (selectedId.value != null) {
    moveSelectedTo(slotStartMillis(currentDate.value, minuteOffset))
  } else {
    createSlot.value = minuteOffset
  }
}

function moveSelectedTo(targetStart) {
  const ev = events.value.find((e) => e.id === selectedId.value)
  selectedId.value = null
  if (!ev || ev.allDay) return
  const delta = targetStart - ev.start
  if (delta === 0) return
  doAction(
    () => sync.update(ev.id, { start: ev.start + delta, end: ev.end + delta }),
    '已移动'
  )
}

function onEventCtx(event, x, y) {
  selectedId.value = null
  ctxMenu.value = { event, x, y }
}

async function onCreate({ title, priority, flexible, minutes }) {
  const slotStart = slotStartMillis(currentDate.value, createSlot.value)
  const payload = {
    title,
    start: slotStart,
    end: slotStart + 29 * 60 * 1000,
    allDay: false,
    priority,
    flexible,
    colSpan: flexible ? 0 : Math.round(minutes / 2.5),
  }
  try {
    await sync.add(payload)
    showToast('已创建')
    // 若建在空时段会占满，创建栏默认项要跟着变
    createSlot.value = nextFreshSlot()
  } catch (e) {
    showToast(e.message)
  }
  await fetchDay()
}

// 创建后自动跳到下一个还有空位的时段（今天范围内）
function nextFreshSlot() {
  if (currentDate.value !== todayStr()) return createSlot.value
  let minute = createSlot.value + 30
  if (minute >= 24 * 60) return createSlot.value
  const start = slotStartMillis(currentDate.value, minute)
  const occupied = events.value.some((e) => !e.allDay && e.start >= start && e.start < start + 30 * 60 * 1000)
  return occupied ? createSlot.value : minute
}

// 创建栏默认选中项：目标时段为空（第一个任务）→ 补满，否则 2 分钟
const createSlotEmpty = computed(() => {
  const start = slotStartMillis(currentDate.value, createSlot.value)
  return !events.value.some((e) => !e.allDay && e.start >= start && e.start < start + 30 * 60 * 1000)
})

function openSettings() {
  showPair.value = true
}

function closePair() {
  // 未配对时不允许关闭配对弹窗
  if (config.value) showPair.value = false
}
</script>

<template>
  <TopBar
    :date-text="displayDateText"
    :status="statusText"
    :status-class="status"
    @prev="goDay(-1)"
    @next="goDay(1)"
    @settings="openSettings"
  />

  <DayView
    :events="events"
    :selected-id="selectedId"
    :is-today="currentDate === todayStr()"
    :create-slot="createSlot"
    @event-click="onEventClick"
    @event-ctx="onEventCtx"
    @event-dblclick="onDeleteEvent"
    @slot-click="onSlotClick"
    @adjust-duration="onAdjustDuration"
  />

  <CreateBar
    :slot-minute="createSlot"
    :default-flexible="createSlotEmpty"
    @create="onCreate"
  />

  <CtxMenu
    v-if="ctxMenu"
    :menu="ctxMenu"
    @action="onCtxAction"
    @adjust="onAdjustDuration"
    @close="ctxMenu = null"
  />

  <EditDialog v-if="editTarget" :event="editTarget" @save="onEditSave" @close="editTarget = null" />

  <PairDialog
    v-if="showPair"
    :existing="config"
    @paired="onPaired"
    @unpair="unpair"
    @close="closePair"
  />

  <div v-if="toastText" class="toast">{{ toastText }}</div>
</template>
