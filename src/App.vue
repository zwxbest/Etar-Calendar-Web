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
const statusText = computed(
  () => ({ idle: '未连接', connecting: '连接中', connected: '已连通', offline: '离线' })[status.value]
)
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
// 目标时段是否插到第一位（点时间刻度设置时段时为 true，见 DayView ruler-click）
const createAtFront = ref(false)

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
  // 按"天内分钟偏移"取当前 30 分钟档（之前只取了分钟数、漏了小时，恒为 00:00/00:30）
  const cur = Math.floor((now.getHours() * 60 + now.getMinutes()) / 30) * 30
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
  // 首个请求由对端在场事件触发（此时还未 connected），其余场景维持原条件
  if (status.value !== 'connected' && !sync.ready()) return
  try {
    events.value = await sync.fetchDay(currentDate.value)
    selectedId.value = null
  } catch (e) {
    showToast(e.message)
  }
}

onMounted(() => {
  sync.on('status', (s) => {
    status.value = s
    if (s === 'connected') {
      // 配对成功后保存安卓 peerId，下次自动重连不用再输码
      if (config.value && config.value.androidPeerId !== sync.androidPeerId) {
        config.value.androidPeerId = sync.androidPeerId
        saveConfig(config.value)
      }
      fetchDay()
    }
  })
  // 手机在场即可发首个 fetch_day（不等 connected，避免互相等待死锁）
  sync.on('peer', () => fetchDay())
  sync.on('push', () => fetchDay())
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
// 乐观更新策略：先在本地渲染改动（UI 立即响应），再异步同步到手机；
// 无论成败最后都 fetchDay 以手机本地库为准对账（失败时即回滚）。

function applyLocal(id, patch) {
  const ev = events.value.find((e) => e.id === id)
  if (ev) Object.assign(ev, patch)
}

function removeLocal(id) {
  events.value = events.value.filter((e) => e.id !== id)
}

async function doAction(fn, successText, optimistic) {
  if (optimistic) optimistic()
  try {
    await fn()
    if (successText) showToast(successText)
  } catch (e) {
    showToast(e.message)
  }
  fetchDay() // 对账：以手机端为准（成功校准细节，失败回滚）
}

function onCtxAction({ action, event }) {
  ctxMenu.value = null
  const id = event.id
  switch (action) {
    case 'edit':
      editTarget.value = event
      break
    case 'move-today':
      doAction(
        () => sync.update(id, { allDay: true, startDayOffset: 0 }),
        '已移动到今天',
        () => applyLocal(id, { allDay: true, flexible: false }),
      )
      break
    case 'move-tomorrow':
      doAction(
        () => sync.update(id, { allDay: true, startDayOffset: 1 }),
        '已移动到明天',
        () => removeLocal(id), // 移到明天：今天视图直接消失
      )
      break
    case 'toggle-flexible':
      doAction(
        () => sync.update(id, { flexible: !event.flexible }),
        event.flexible ? '已取消弹性任务' : '已设为弹性任务',
        () => applyLocal(id, { flexible: !event.flexible }),
      )
      break
    case 'toggle-priority':
      doAction(
        () => sync.update(id, { priority: event.priority === 1 ? 0 : 1 }),
        event.priority === 1 ? '已取消高优先级' : '已设为高优先级',
        () => applyLocal(id, { priority: event.priority === 1 ? 0 : 1 }),
      )
      break
    case 'fill':
      doAction(() => sync.update(id, { flexible: true }), '已补满', () =>
        applyLocal(id, { flexible: true }),
      )
      break
    case 'delete':
      doAction(() => sync.remove(id), '已删除', () => removeLocal(id))
      break
  }
}

function onAdjustDuration(event, minutes) {
  ctxMenu.value = null
  doAction(
    () => sync.update(event.id, { colSpan: Math.round(minutes / 2.5) }),
    `已调整为${minutes}分钟`,
    () => applyLocal(event.id, { colSpan: Math.round(minutes / 2.5) }),
  )
}

// 双击任务：弹编辑弹窗（可修改/删除）
function onEventDblclick(event) {
  ctxMenu.value = null
  editTarget.value = event
}

function onDeleteFromDialog() {
  const event = editTarget.value
  editTarget.value = null
  if (!event) return
  doAction(() => sync.remove(event.id), '已删除', () => removeLocal(event.id))
}

function onEditSave(payload) {
  const event = editTarget.value
  editTarget.value = null
  if (!event) return
  // payload 字段与事件字段同名（title/priority/flexible/colSpan/start/end），直接本地套用
  doAction(() => sync.update(event.id, payload), '已保存', () => applyLocal(event.id, payload))
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
// 点最左侧时间刻度：总是切换创建目标时段，且在该时段创建的任务插到第一位（firstInSlot）
function onSlotClick(minuteOffset, fromRuler) {
  ctxMenu.value = null
  if (fromRuler) {
    createSlot.value = minuteOffset
    createAtFront.value = true
    return
  }
  if (selectedId.value != null) {
    moveSelectedTo(slotStartMillis(currentDate.value, minuteOffset))
  } else {
    createSlot.value = minuteOffset
    createAtFront.value = false
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
    '已移动',
    () => applyLocal(ev.id, { start: ev.start + delta, end: ev.end + delta }),
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
  // 插入位置：点时间刻度设的目标时段 → 插到该时段第一位（firstInSlot，
  // 安卓端按 sortId 排列，见 EventBridge.computeSortId；默认则普通任务排弹性任务前、无弹性追加末尾）
  if (createAtFront.value) {
    payload.firstInSlot = true
  }
  // 乐观占位：立即在本地渲染（temp 事件），不等手机响应；fetchDay 回来后替换为真实数据
  const tempId = `tmp-${Date.now()}`
  events.value = [
    ...events.value,
    {
      id: tempId,
      title,
      start: payload.start,
      end: payload.end,
      allDay: false,
      priority,
      flexible,
      // 弹性任务安卓会算成占满剩余空间；普通任务按所选分钟宽度近似
      colSpan: flexible ? 12 : payload.colSpan,
      sortId: createAtFront.value ? -1 : Number.MAX_SAFE_INTEGER,
    },
  ]
  try {
    await sync.add(payload)
    showToast('已创建')
    // 若建在空时段会占满，创建栏默认项要跟着变
    createSlot.value = nextFreshSlot()
    createAtFront.value = false
  } catch (e) {
    showToast(e.message)
  }
  fetchDay() // 对账：用真实数据（含真实 sortId/宽度/颜色）替换占位
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
    @event-dblclick="onEventDblclick"
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

  <EditDialog
    v-if="editTarget"
    :event="editTarget"
    @save="onEditSave"
    @delete="onDeleteFromDialog"
    @close="editTarget = null"
  />

  <PairDialog
    v-if="showPair"
    :existing="config"
    @paired="onPaired"
    @unpair="unpair"
    @close="closePair"
  />

  <div v-if="toastText" class="toast">{{ toastText }}</div>
</template>
