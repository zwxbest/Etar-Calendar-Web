<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import TopBar from './components/TopBar.vue'
import DayView from './components/DayView.vue'
import CtxMenu from './components/CtxMenu.vue'
import CreateBar from './components/CreateBar.vue'
import EditDialog from './components/EditDialog.vue'
import PairDialog from './components/PairDialog.vue'
import { SyncClient } from './lib/sync.js'
import { loadConfig, saveConfig, clearConfig, loadOrderHint, saveOrderHint } from './lib/store.js'

const sync = new SyncClient()

const config = ref(loadConfig())
const status = ref('idle') // idle | connecting | connected | offline
const statusText = computed(
  () => ({ idle: '未连接', connecting: '连接中', connected: '已连通', offline: '离线' })[status.value]
)
const events = ref([])
// 最近一次对账见过的日历色（会话内记忆），供创建占位兜底，见 fetchDay / submitCreate
let lastKnownColor = null
// 展示顺序提示：{ [任务id]: 锚点id } = 排到锚点前面（纯网页端规则，见 store.js）
const orderHint = ref(loadOrderHint())
const currentDate = ref(todayStr())
const selectedId = ref(null)
const ctxMenu = ref(null) // {event, x, y}
const editTarget = ref(null)
const showPair = ref(false)
const toastText = ref('')
let toastTimer = null

// 时间刻度双击的快捷创建弹窗：{x, y, minute}，视口坐标定位
const quickCreate = ref(null)
const quickTitle = ref('')
const quickInputEl = ref(null)

// 弹窗占位符里显示目标时段，避免"不知道建到哪了"
const quickSlotText = computed(() => {
  if (!quickCreate.value) return ''
  const m = quickCreate.value.minute
  const h = String(Math.floor(m / 60)).padStart(2, '0')
  const mm = String(m % 60).padStart(2, '0')
  const end = m + 29
  return `${h}:${mm} - ${String(Math.floor(end / 60)).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`
})

watch(quickCreate, (v) => {
  if (v) nextTick(() => quickInputEl.value && quickInputEl.value.focus())
})

// 点击任务块以外的区域（时间区域/工具栏/弹窗等）自动取消选中 = 撤销移动意图
// 任务块的点击都带 .stop，不会冒泡到这里
function onWindowClick() {
  selectedId.value = null
}

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
    const list = await sync.fetchDay(currentDate.value)
    // 记住最近见过的日历色：当天没有其他任务时，创建占位也能用它，避免回落默认蓝
    const colored = list.find((e) => typeof e.color === 'number')
    if (colored) lastKnownColor = colored.color
    events.value = list
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
  window.addEventListener('click', onWindowClick)
})

onBeforeUnmount(() => {
  sync.disconnect()
  window.removeEventListener('click', onWindowClick)
})

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

const SLOT_COL_SPAN = 12 // 一个 30 分钟时段 = 12 个宽度单位（1 单位 = 2.5 分钟），与安卓一致

/** 事件起始毫秒 → 所属 30 分钟时段起点（本地日对齐，与 DayView.slotOf 一致） */
function slotStartOf(ms) {
  const d = new Date(ms)
  const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  return ms - ((ms - dayStart) % (30 * 60 * 1000))
}

/** 本地重算某时段弹性任务的宽度 = 时段剩余空间。
 *  公式同安卓 FlexibleTaskHelper.rebalance：弹性宽度 = 12 - 其它任务占用（至少 1 单位）。
 *  乐观更新后立即调用，普通任务改短时弹性任务当场扩宽，不用等安卓回包再对账。 */
function expandFlexible(startMs) {
  const slot = slotStartOf(startMs)
  const inSlot = events.value.filter((e) => !e.allDay && slotStartOf(e.start) === slot)
  const flex = inSlot.find((e) => e.flexible)
  if (!flex) return
  const used = inSlot.reduce((s, e) => (e === flex ? s : s + (e.colSpan || 1)), 0)
  const width = Math.max(SLOT_COL_SPAN - used, 1)
  if (flex.colSpan !== width) flex.colSpan = width
}

function applyLocal(id, patch) {
  const ev = events.value.find((e) => e.id === id)
  if (!ev) return
  const oldStart = ev.start
  Object.assign(ev, patch)
  // 宽度/弹性标记变了 → 本时段弹性任务立即按剩余空间重算
  if ('colSpan' in patch || 'flexible' in patch) expandFlexible(ev.start)
  // 换了时段 → 旧时段腾出的空间、新时段被占用后的剩余，两边都重算
  if ('start' in patch && ev.start !== oldStart) {
    expandFlexible(oldStart)
    expandFlexible(ev.start)
  }
}

function removeLocal(id) {
  const ev = events.value.find((e) => e.id === id)
  events.value = events.value.filter((e) => e.id !== id)
  // 删除腾出空间：弹性任务当场扩宽（安卓删除后也会 rebalance，两边一致）
  if (ev && !ev.allDay) expandFlexible(ev.start)
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

// 单击任务：未选中则选中；已选中则把选中的任务移动到该任务前面
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
  moveBefore(selectedId.value, event)
}

// 单击空白时段/时间刻度：取消选中（撤销移动意图），并切换创建目标时段；
// 点最左侧时间刻度时，该时段创建的任务插到第一位（firstInSlot）
function onSlotClick(minuteOffset, fromRuler) {
  ctxMenu.value = null
  selectedId.value = null
  createSlot.value = minuteOffset
  createAtFront.value = !!fromRuler
}

/** 移动任务到锚点任务前面：时间/时段同步给手机；时段内先后顺序为网页端展示规则 */
function moveBefore(id, anchor) {
  selectedId.value = null
  const ev = events.value.find((e) => e.id === id)
  if (!ev || ev.allDay || anchor.allDay || ev.id === anchor.id) return
  const dur = ev.end - ev.start
  // 顺序提示：网页展示层把 ev 排到 anchor 前面，fetch 对账后依然生效（不写手机库）
  const next = { ...orderHint.value }
  next[ev.id] = anchor.id
  if (next[anchor.id] === ev.id) delete next[anchor.id] // 来回互移时抵消旧提示，避免成环
  orderHint.value = next
  saveOrderHint(next)
  doAction(
    () => sync.update(ev.id, { start: anchor.start, end: anchor.start + dur }),
    '已移动到该任务前面',
    () => applyLocal(ev.id, { start: anchor.start, end: anchor.start + dur }),
  )
}

function onEventCtx(event, x, y) {
  selectedId.value = null
  ctxMenu.value = { event, x, y }
}

/** 创建（乐观占位 + 异步同步 + fetch 对账），供创建栏与刻度快捷弹窗共用 */
async function submitCreate(payload, atFront) {
  const tempId = `tmp-${Date.now()}`
  // 占位沿用当天已有任务的日历色（近似值，fetch 对账后校准），
  // 否则缺失 color 会走 EventBlock 的默认蓝兜底，对账后瞬间变真实颜色造成"闪一下"
  const refEvent = events.value.find((e) => typeof e.color === 'number')
  const refColor = refEvent ? refEvent.color : lastKnownColor
  events.value = [
    ...events.value,
    {
      id: tempId,
      title: payload.title,
      color: refColor != null ? refColor : undefined,
      start: payload.start,
      end: payload.end,
      allDay: false,
      priority: payload.priority,
      flexible: payload.flexible,
      // 弹性任务安卓会算成占满剩余空间；普通任务按所选分钟宽度近似
      colSpan: payload.flexible ? 12 : payload.colSpan,
      sortId: atFront ? -1 : Number.MAX_SAFE_INTEGER,
    },
  ]
  try {
    await sync.add(payload)
    showToast('已创建')
    return true
  } catch (e) {
    showToast(e.message)
    return false
  } finally {
    fetchDay() // 对账：用真实数据（含真实 sortId/宽度/颜色）替换占位
  }
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
  // 插入位置：点时间刻度设的目标时段 → 插到该时段第一位（firstInSlot）
  if (createAtFront.value) {
    payload.firstInSlot = true
  }
  if (await submitCreate(payload, createAtFront.value)) {
    // 若建在空时段会占满，创建栏默认项要跟着变
    createSlot.value = nextFreshSlot()
    createAtFront.value = false
  }
}

// ---------- 时间刻度双击快捷创建 ----------

function onRulerDblclick(minute, x, y) {
  ctxMenu.value = null
  selectedId.value = null
  // 弹窗不超出视口右缘
  quickCreate.value = { minute, x: Math.min(x, window.innerWidth - 270), y }
  quickTitle.value = ''
}

async function onQuickCreateSubmit() {
  const qc = quickCreate.value
  const t = quickTitle.value.trim()
  quickCreate.value = null
  quickTitle.value = ''
  if (!qc || t.length <= 1) return
  const slotStart = slotStartMillis(currentDate.value, qc.minute)
  // 与创建栏默认一致：空时段默认补满，否则 2 分钟普通任务；优先级中；插到时段第一位
  const slotEmpty = !events.value.some(
    (e) => !e.allDay && e.start >= slotStart && e.start < slotStart + 30 * 60 * 1000,
  )
  await submitCreate(
    {
      title: t,
      start: slotStart,
      end: slotStart + 29 * 60 * 1000,
      allDay: false,
      priority: 0,
      flexible: slotEmpty,
      colSpan: slotEmpty ? 0 : 1,
      firstInSlot: true,
    },
    true,
  )
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
    :order-hint="orderHint"
    @event-click="onEventClick"
    @event-ctx="onEventCtx"
    @event-dblclick="onEventDblclick"
    @slot-click="onSlotClick"
    @ruler-dblclick="onRulerDblclick"
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

  <!-- 时间区双击快捷创建：在鼠标位置输入，显示目标时段，回车创建 -->
  <input
    v-if="quickCreate"
    ref="quickInputEl"
    v-model="quickTitle"
    class="quick-create-input"
    :style="{ left: quickCreate.x + 'px', top: quickCreate.y + 'px' }"
    :placeholder="`任务内容（${quickSlotText}）回车创建`"
    @keydown.enter="onQuickCreateSubmit"
    @keydown.esc="quickCreate = null"
    @blur="quickCreate = null"
  />
</template>

<style scoped>
.quick-create-input {
  position: fixed;
  z-index: 100;
  width: 520px;
  padding: 20px 24px;
  font-size: 30px;
  border: 2px solid var(--color-primary);
  border-radius: 16px;
  background: #fff;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.25);
  outline: none;
}
</style>
