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
import {
  loadPending,
  onPendingChange,
  enqueueOp,
  markApplied,
  dropByKeys,
  clearApplied,
  clearAppliedAddsForDay,
  hasUnapplied,
  getPending,
  initInflight,
  loadInflight,
  saveInflight,
  clearInflight,
  loadDay,
  saveDay,
  listDays,
  pruneOldDays,
  clearAllData,
  allIds,
  deriveDay,
  belongsDay,
  onStorageUnavailable,
} from './lib/cache.js'

const sync = new SyncClient()

const config = ref(loadConfig())
const status = ref('idle') // idle | connecting | connected | offline
// 本地队列变化计数：cache.js 的队列不是响应式对象，靠它驱动 computed 重算
const pendingVer = ref(0)
const flushingNow = ref(false) // flush 在途（TopBar 显示"同步中…"）
const hasBaseline = ref(false) // 当前显示日是否已有手机基准
const fetchFailed = ref(false) // 当前显示日拉取失败（占位文案用）
const pendingCount = computed(() => {
  pendingVer.value // 依赖登记：队列任何变化都重算
  return getPending().filter((o) => !o.applied).length
})
const statusText = computed(() => {
  const base = ({ idle: '未连接', connecting: '连接中', connected: '已连通', offline: '离线' })[status.value]
  if (flushingNow.value) return `${base} · 同步中…`
  return pendingCount.value > 0 ? `${base} · ${pendingCount.value} 条待同步` : base
})
const events = ref([])
// 没有基准、又连不上 → 占位提示；绝不能让这天看起来"没任务"
const unsyncedText = computed(() => {
  if (hasBaseline.value || events.value.length > 0) return ''
  if (status.value === 'connected') return fetchFailed.value ? '未同步（拉取失败，稍后自动重试）' : ''
  return '未同步（无法连接手机）'
})
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

// ---------- 渲染不变式：events 永远是"基准(day) + 按序重放 pending"推导出来的 ----------
// 基准只在 fetch 成功时被替换（applyFetchedDay），绝不把推导结果写回 ——
// uuid 占位任务只在它的 add 还在队列里时存在，batch 成功 + fetch 落地后自然被真身整体替换，
// 不需要任何 uuid→realId 映射表，也不会重复显示。
function rederive() {
  const day = currentDate.value
  const rec = loadDay(day)
  const list = deriveDay(day, rec ? rec.events : null, getPending())
  // "从别天移进当前天"的 pending update：当前天基准里没有原身，
  // 去其它天的基准里找出来、套上补丁，属于当前天才补进列表
  for (const op of getPending()) {
    if (op.type !== 'update') continue
    if (list.some((e) => String(e.id) === String(op.eventId))) continue
    const moved = findMovedIn(day, op)
    if (moved) list.push(moved)
  }
  events.value = list
  hasBaseline.value = !!rec
  rebalanceFlexible()
  pruneOrderHint()
}

function findMovedIn(day, op) {
  for (const d of listDays()) {
    if (d === day) continue
    const r = loadDay(d)
    const src = r && r.events.find((e) => String(e.id) === String(op.eventId))
    if (!src) continue
    const ev = { ...src, ...op.payload, ...(op.local || {}) }
    return belongsDay(day, ev) ? ev : null
  }
  return null
}

// ---------- 连接与数据 ----------

/** fetch 成功落地：替换基准（唯一允许写基准的地方）+ 清该天已确认的占位 add + 重推导 */
function applyFetchedDay(day, list) {
  const colored = list.find((e) => typeof e.color === 'number')
  if (colored) lastKnownColor = colored.color
  saveDay(day, list)
  // 该天已 applied 的 uuid 占位 add：手机要么已收下（真身已在 list 里）、要么校验拒绝了它
  // （list 里没有）——两种都以 fetch 结果为准，清掉占位即"对账"
  clearAppliedAddsForDay(day)
  if (day === currentDate.value) rederive()
}

/** 只拉当前显示日（切日/对端在场时的快速路径） */
async function fetchDay() {
  // 首个请求由对端在场事件触发（此时还未 connected），其余场景维持原条件
  if (status.value !== 'connected' && !sync.ready()) return
  try {
    const list = await sync.fetchDay(currentDate.value)
    applyFetchedDay(currentDate.value, list)
    fetchFailed.value = false
    selectedId.value = null
  } catch (e) {
    fetchFailed.value = true
    showToast(e.message)
  }
}

/** 对账拉取：所有已有基准的天 + 当前显示天（重连 / 收到 push / batch 成功后）。
 *  全部成功 → 清掉 applied op（D.5）；某个失败 → 保留 applied 等下次再清，绝不重发 batch（它已执行过） */
async function fetchBaselineDays() {
  const days = new Set(listDays())
  days.add(currentDate.value)
  let allOk = true
  let currentOk = false
  await Promise.all(
    [...days].map(async (day) => {
      try {
        const list = await sync.fetchDay(day)
        applyFetchedDay(day, list)
        if (day === currentDate.value) currentOk = true
      } catch (e) {
        allOk = false
        if (day === currentDate.value) fetchFailed.value = true
        console.warn(`[sync] 对账拉取 ${day} 失败：${e.message}`)
      }
    }),
  )
  if (currentOk) fetchFailed.value = false
  if (allOk) clearApplied()
  rederive()
  return allOk
}

/** 本地操作的统一出口：入队（折叠）→ 订阅回调自动重推导 → 尽力 flush。
 *  离线时不弹任何"未连接到手机"类错误；成功文案照旧（离线时语义即"已存本地"） */
function doAction(op, successText) {
  enqueueOp(op)
  if (successText) showToast(successText)
  scheduleFlush()
}

// ---------- Flush：把待同步队列按批发给手机（batch 整批幂等，MQTT信令协议.md §10） ----------

let flushing = false
let flushTimer = null

function scheduleFlush() {
  if (!sync.ready()) return // 离线：不打扰用户，等 status→connected 触发
  clearTimeout(flushTimer)
  // 防抖 300ms：连续快改攒成一批
  flushTimer = setTimeout(() => {
    flushTimer = null
    flush()
  }, 300)
}

/** 单条 → 协议报文。add 不带 tempId（手机自动生成真实 id）；update/delete 用 eventId。
 *  op.local（color/sortId 等网页端渲染补丁）绝不下发 */
function toWireOp(op) {
  if (op.type === 'add') return { type: 'add', payload: op.payload }
  if (op.type === 'update') return { type: 'update', eventId: String(op.eventId), payload: op.payload }
  return { type: 'delete', eventId: String(op.eventId) }
}

async function flush() {
  if (flushing || !sync.ready()) return
  // 取出待发 op：若上一批还没收到响应，用同一个 batch id、同一批 op 原样重发
  // （安卓按 id 整批幂等回缓存，不重复执行）；否则开新批、生成新 id 并持久化
  let inflight = loadInflight()
  let batchId = null
  let batchOps = null
  if (inflight && inflight.batchId) {
    const keys = new Set(inflight.keys || [])
    batchOps = getPending().filter((o) => keys.has(o.k))
    if (batchOps.length > 0) batchId = inflight.batchId
    else clearInflight() // 原批 op 已全部消失（防御）→ 开新批
  }
  if (!batchId) {
    batchOps = getPending().filter((o) => !o.applied)
    if (batchOps.length === 0) return
    batchId = crypto.randomUUID()
    saveInflight(batchId, batchOps.map((o) => o.k)) // 等待响应期间持久化（刷新/断线不丢）
  }
  flushing = true
  flushingNow.value = true
  const sentKeys = new Set(batchOps.map((o) => o.k))
  let timedOut = false
  try {
    await sync.batch(batchId, batchOps.map(toWireOp))
    // ok:true —— 也可能包含被校验拒绝的单条，不给单条做重试，靠随后的 fetch 对账：
    // 被拒的 add 在拉取结果里不出现（占位随之消失），被拒的 update 被拉取结果改回
    markApplied([...sentKeys]) // 保留在队列里：uuid 任务在 fetch 落地前继续可见
    clearInflight()
    await fetchBaselineDays() // 重拉所有基准天 + 当前天；全部成功才整体清 applied
    // 本批等待期间新入队的 op 不属于这批（折叠锁保证没并进来），留到下一批
    if (hasUnapplied()) scheduleFlush()
  } catch (e) {
    if (e.remoteRejected) {
      // ok:false → 整批被手机永久拒绝：丢弃这批 op，不重试（渲染随下一次推导回退）
      dropByKeys([...sentKeys])
      clearInflight()
      showToast(`同步失败：${e.message}`)
      if (hasUnapplied()) scheduleFlush()
    } else {
      // 超时/断连：op 保持 !applied、inflight 保留 → 下次触发用同一个 id、同一批 op 重发
      timedOut = true
      console.warn(`[sync] batch 未收到响应（${e.message}），保持队列等重连补发`)
    }
  } finally {
    flushing = false
    flushingNow.value = false
  }
}

// ---------- orderHint 清理：删掉指向已不存在任务的提示（防 tempId 残留无限堆积） ----------
function pruneOrderHint() {
  const ids = allIds(getPending())
  const cur = orderHint.value
  const next = {}
  let changed = false
  for (const k of Object.keys(cur)) {
    const v = cur[k]
    if (ids.has(String(k)) && (v == null || ids.has(String(v)))) next[k] = v
    else changed = true
  }
  if (changed) {
    orderHint.value = next
    saveOrderHint(next)
  }
}

onMounted(() => {
  onStorageUnavailable(() => showToast('本地存储不可用，离线改动不会保存'))
  // 1) 先从 localStorage 基准渲染（不等网络），再 connect
  loadPending()
  pendingVer.value++ // 让"待同步 N 条"在首屏就正确（loadPending 不走订阅通知）
  initInflight() // 恢复在途批次：刷新后仍用同一个 batch id 重发
  onPendingChange(() => {
    pendingVer.value++
    rederive()
  })
  pruneOldDays()
  rederive()
  // 2) 连手机
  sync.on('status', (s) => {
    status.value = s
    if (s === 'connected') {
      // 配对成功后保存安卓 peerId，下次自动重连不用再输码
      if (config.value && config.value.androidPeerId !== sync.androidPeerId) {
        config.value.androidPeerId = sync.androidPeerId
        saveConfig(config.value)
      }
      flush() // 离线积压：补发（同 id 幂等）
      fetchBaselineDays() // 对账：所有基准天 + 当前天
    }
  })
  // 手机在场即可发首个 fetch_day（不等 connected，避免互相等待死锁）
  sync.on('peer', () => fetchDay())
  sync.on('push', () => {
    // 网页自己写库也会触发手机的 push_change，这条路径会频繁走到：
    // 渲染是推导出来的（基准 + 重放 pending），绝不会冲掉未同步的 op。
    // flush 在途时跳过——本批改动的回声等 batch 响应后由 flush 自己对账，
    // 避免"占位任务和真身短暂并排"的闪烁
    if (flushing) return
    if (hasUnapplied()) flush()
    fetchBaselineDays()
  })
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
  clearTimeout(flushTimer)
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
  // 解除配对 = 换设备语义：清掉基准缓存与待同步队列，
  // 避免旧手机（或换码前）的改动被发到新手机
  clearAllData()
  config.value = null
  rederive()
  showPair.value = true
}

// ---------- 日期切换 ----------

function goDay(delta) {
  const d = parseDay(currentDate.value)
  d.setDate(d.getDate() + delta)
  currentDate.value = fmtDate(d)
  createSlot.value = defaultSlotMinute()
  rederive() // 先用目标天的本地基准渲染（离线也能看），再联网拉取
  fetchDay()
}

// ---------- 任务操作 ----------
// 本地操作流程：入队 op → 重推导 events（乐观，UI 立即响应）→（已连接则）防抖 flush。
// 手机本地库仍是唯一权威数据源：连上后批量上行 + fetch 对账（被拒的改动自动回退）。

const SLOT_COL_SPAN = 12 // 一个 30 分钟时段 = 12 个宽度单位（1 单位 = 2.5 分钟），与安卓一致

/** 事件起始毫秒 → 所属 30 分钟时段起点（本地日对齐，与 DayView.slotOf 一致） */
function slotStartOf(ms) {
  const d = new Date(ms)
  const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  return ms - ((ms - dayStart) % (30 * 60 * 1000))
}

/** 本地重算所有含弹性任务的时段宽度 = 时段剩余空间。
 *  公式同安卓 FlexibleTaskHelper.rebalance：弹性宽度 = 12 - 其它任务占用（至少 1 单位）。
 *  每次重推导后跑一遍：本地增删改后普通任务改短/消失，弹性任务当场扩宽，
 *  不用等安卓回包再对账；基准里的值本就是同一公式算的，对账后是无变化的幂等重算。 */
function rebalanceFlexible() {
  const bySlot = new Map()
  for (const e of events.value) {
    if (e.allDay) continue
    const s = slotStartOf(e.start)
    if (!bySlot.has(s)) bySlot.set(s, [])
    bySlot.get(s).push(e)
  }
  for (const list of bySlot.values()) {
    const flex = list.find((e) => e.flexible)
    if (!flex) continue
    const used = list.reduce((s, e) => (e === flex ? s : s + (e.colSpan || 1)), 0)
    const width = Math.max(SLOT_COL_SPAN - used, 1)
    if (flex.colSpan !== width) flex.colSpan = width
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
      doAction(
        { type: 'update', eventId: id, payload: { allDay: true, startDayOffset: 0 }, local: { flexible: false } },
        '已移动到今天',
      )
      break
    case 'move-tomorrow':
      // local 把起止推到明天（全天）：推导后的按天过滤让它当场从今天视图消失、
      // 从别天视图（findMovedIn）能看到——与旧 removeLocal 的乐观效果一致；
      // 手机端按 startDayOffset 落到明天，fetch 后用真实值对齐
      doAction(
        {
          type: 'update',
          eventId: id,
          payload: { allDay: true, startDayOffset: 1 },
          local: {
            start: slotStartMillis(currentDate.value, 24 * 60),
            end: slotStartMillis(currentDate.value, 24 * 60) + 24 * 60 * 60 * 1000 - 1,
          },
        },
        '已移动到明天',
      )
      break
    case 'toggle-flexible':
      doAction(
        { type: 'update', eventId: id, payload: { flexible: !event.flexible } },
        event.flexible ? '已取消弹性任务' : '已设为弹性任务',
      )
      break
    case 'toggle-priority':
      doAction(
        { type: 'update', eventId: id, payload: { priority: event.priority === 1 ? 0 : 1 } },
        event.priority === 1 ? '已取消高优先级' : '已设为高优先级',
      )
      break
    case 'fill':
      doAction({ type: 'update', eventId: id, payload: { flexible: true } }, '已补满')
      break
    case 'delete':
      doAction({ type: 'delete', eventId: id }, '已删除')
      break
  }
}

function onAdjustDuration(event, minutes) {
  ctxMenu.value = null
  doAction(
    { type: 'update', eventId: event.id, payload: { colSpan: Math.round(minutes / 2.5) } },
    `已调整为${minutes}分钟`,
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
  doAction({ type: 'delete', eventId: event.id }, '已删除')
}

function onEditSave(payload) {
  const event = editTarget.value
  editTarget.value = null
  if (!event) return
  // payload 字段与事件字段同名（title/priority/flexible/colSpan/start/end），推导时直接套用
  doAction({ type: 'update', eventId: event.id, payload }, '已保存')
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

// 单击空白时段/时间刻度：有选中任务（移动意图）→ 把它移到该时段；
// 无选中 → 取消选中（撤销移动意图），并切换创建目标时段；
// 点最左侧时间刻度时，该时段创建的任务插到第一位（firstInSlot）
function onSlotClick(minuteOffset, fromRuler) {
  ctxMenu.value = null
  const movingId = selectedId.value
  selectedId.value = null
  createSlot.value = minuteOffset
  createAtFront.value = !!fromRuler
  if (movingId == null) return
  const ev = events.value.find((e) => e.id === movingId)
  if (ev && !ev.allDay) moveToSlot(ev, minuteOffset)
}

/** 把任务移到目标 30 分钟时段：只平移起止时间，时长、宽度(colSpan)等参数一律不变 */
function moveToSlot(ev, minuteOffset) {
  const start = slotStartMillis(currentDate.value, minuteOffset)
  if (slotStartOf(ev.start) === start) return // 已在该时段，无需动
  const end = start + (ev.end - ev.start)
  // 换了时段，旧的"排到某任务前面"展示提示已失效，清掉避免回迁时误用
  const next = { ...orderHint.value }
  if (next[ev.id] != null) {
    delete next[ev.id]
    orderHint.value = next
    saveOrderHint(next)
  }
  doAction({ type: 'update', eventId: ev.id, payload: { start, end } }, '已移动到该时段')
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
    { type: 'update', eventId: ev.id, payload: { start: anchor.start, end: anchor.start + dur } },
    '已移动到该任务前面',
  )
}

function onEventCtx(event, x, y) {
  selectedId.value = null
  ctxMenu.value = { event, x, y }
}

/** 创建：入队 add（uuid 占位推导可见）+ 尽力 flush，不等网络（离线也能建） */
async function submitCreate(payload, atFront) {
  const tempId = crypto.randomUUID()
  // 占位沿用当天已有任务的日历色（近似值，fetch 对账后校准），
  // 否则缺失 color 会走 EventBlock 的默认蓝兜底，对账后瞬间变真实颜色造成"闪一下"
  const refEvent = events.value.find((e) => typeof e.color === 'number')
  const refColor = refEvent ? refEvent.color : lastKnownColor
  enqueueOp({
    type: 'add',
    tempId,
    payload, // 上行字段与旧 sync.add() 完全一致（title/start/end/allDay/priority/flexible/colSpan/firstInSlot）
    // local 只用于网页端占位渲染，不下发手机
    local: {
      color: refColor != null ? refColor : undefined,
      sortId: atFront ? -1 : Number.MAX_SAFE_INTEGER,
    },
  })
  showToast('已创建') // 离线时语义 = 已存本地
  scheduleFlush()
  return true
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
    :unsynced-text="unsyncedText"
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
