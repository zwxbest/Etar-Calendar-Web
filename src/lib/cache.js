// 离线缓存与待同步队列（localStorage 持久化，schema v1）
//
// 三类数据：
//   当天基准   etar_events_<yyyy-MM-dd> = {v:1, fetchedAt, events:[...]}
//              存**手机 fetch 回来的原始数据**；只在 fetch 成功时被整体替换，
//              绝不把网页推导出来的结果写回（渲染不变式，见 App.vue rederive）
//   待同步队列 etar_pending = {v:1, ops:[...]}
//              全局（不分天），元素：
//              {type:'add'|'update'|'delete', k, tempId?, eventId?, payload?, local?, applied?}
//              k    = 本地 op 唯一标识（不下发，只用于标记 applied / 折叠锁定）
//              local= 仅网页端渲染用的补丁（color/sortId 等），**不上行手机**
//              applied = 该批已被手机确认执行（保留在队列里，等 fetch 落地后整体清掉）
//              （结构用 {v,ops} 包一层是为了带 schema 版本号；读到不认识的结构当无数据重建）
//   在途批次   etar_inflight = {v:1, batchId, keys:[op.k...]}
//              等待 batch 响应期间持久化：超时/断连/刷新后用**同一个 batch id、同一批 op**
//              原样重发（安卓按 id 整批幂等回缓存，见 MQTT信令协议.md §10）；
//              这批 op 同时是"折叠锁"——新改动绝不并入已发出的批次。
//
// 所有读写都包 try/catch：隐私模式 / 配额超限 → 降级纯内存（mem 写穿）+
// 一次性通知 onStorageUnavailable 回调（App 弹一次 toast），会话内功能照常。

const PENDING_KEY = 'etar_pending'
const INFLIGHT_KEY = 'etar_inflight'
const DAY_PREFIX = 'etar_events_'
const SCHEMA = 1
const KEEP_DAYS = 7 // 只保留最近 7 天的当天基准（队列是全局的，不按天龄删）

// ---------- 存储底座：localStorage + 内存写穿降级 ----------
let canRead = true
let canWrite = true
let notified = false
let storageHook = null
const mem = new Map()

export function onStorageUnavailable(cb) {
  storageHook = cb
}

function notifyStorageBroken() {
  if (notified) return
  notified = true
  try {
    if (storageHook) storageHook()
  } catch (e) {
    /* ignore */
  }
}

function readRaw(key) {
  let ls = null
  if (canRead) {
    try {
      ls = localStorage.getItem(key)
    } catch (e) {
      canRead = false
      canWrite = false
      notifyStorageBroken()
    }
  }
  // 内存里有就用内存（本会话写过、但落盘失败的那份更新）
  return mem.has(key) ? mem.get(key) : ls
}

function writeRaw(key, val) {
  const s = typeof val === 'string' ? val : JSON.stringify(val)
  mem.set(key, s)
  if (!canWrite) return
  try {
    localStorage.setItem(key, s)
  } catch (e) {
    canWrite = false // 配额超限 / 隐私模式：降级纯内存
    notifyStorageBroken()
  }
}

function removeRaw(key) {
  mem.delete(key)
  try {
    localStorage.removeItem(key)
  } catch (e) {
    canRead = false
    canWrite = false
    notifyStorageBroken()
  }
}

function parseJSON(raw) {
  try {
    return JSON.parse(raw)
  } catch (e) {
    return null
  }
}

let seq = 0

function genKey() {
  return `op-${Date.now().toString(36)}-${++seq}-${Math.random().toString(36).slice(2, 8)}`
}

// ---------- 待同步队列（内存为权威，localStorage 只是持久化） ----------

let pending = []
const pendingListeners = new Set()

export function onPendingChange(cb) {
  pendingListeners.add(cb)
  return () => pendingListeners.delete(cb)
}

function emitPending() {
  for (const cb of pendingListeners) cb(pending)
}

export function getPending() {
  return pending
}

function validOp(o) {
  if (!o || typeof o !== 'object') return false
  if (o.type === 'add') return typeof o.tempId === 'string' && o.payload && typeof o.payload === 'object'
  if (o.type === 'update') return o.eventId != null && o.payload && typeof o.payload === 'object'
  if (o.type === 'delete') return o.eventId != null
  return false
}

/** 启动时从 localStorage 载入队列（结构不认识 → 当无数据重建） */
export function loadPending() {
  const raw = readRaw(PENDING_KEY)
  const obj = raw ? parseJSON(raw) : null
  if (!obj || obj.v !== SCHEMA || !Array.isArray(obj.ops)) {
    pending = []
    return pending
  }
  pending = obj.ops.filter(validOp).map((op) => ({ ...op, k: typeof op.k === 'string' ? op.k : genKey() }))
  return pending
}

function savePending() {
  writeRaw(PENDING_KEY, { v: SCHEMA, ops: pending })
}

function persist() {
  savePending()
  emitPending()
}

// ---------- 折叠（只针对同一条任务，见任务说明 C） ----------
// 同一任务的多次本地改动合并成最少的 op：
//   add+update → 并进 add 的 payload（保持未 applied）
//   add+delete → 两条一起丢
//   update+update → 合并 payload（若已 applied 则重新置为未 applied 随下批发出，update 幂等）
//   update+delete → 只留 delete
// 不同任务之间绝不折叠；锁定（已发出、等响应）的 op 绝不并入——否则手机执行的和本地记的会不一致。
function foldPending(list, op) {
  const key = op.type === 'add' ? String(op.tempId) : String(op.eventId)
  const same = (o) => (o.type === 'add' ? String(o.tempId) : String(o.eventId)) === key
  const locked = lockedKeys()

  let addI = -1
  let updI = -1
  let delI = -1
  list.forEach((o, i) => {
    if (!same(o)) return
    if (o.type === 'add') addI = i
    else if (o.type === 'update') updI = i
    else if (o.type === 'delete') delI = i
  })

  const isLocked = (o) => locked.has(o.k)

  if (op.type === 'add') {
    if (addI >= 0) {
      // 同一 tempId 重复 add（防御分支，正常每次创建都是新 uuid）
      const a = list[addI]
      return list.map((o, i) =>
        i === addI
          ? { ...a, payload: { ...a.payload, ...op.payload }, local: { ...(a.local || {}), ...(op.local || {}) } }
          : o,
      )
    }
    return [...list, op]
  }

  if (op.type === 'update') {
    if (delI >= 0) return list // 已排上删除：忽略后续 update
    // add 还没同步 → 合并进那条 add（保持未 applied）。
    // add 已发出/已确认（锁定或 applied）→ 不并入，单独成条：
    // 它带的是假 id，到手机会被拒、再被 fetch 改回——已知且可接受的窗口（不建 uuid→真 id 映射）
    if (addI >= 0 && !list[addI].applied && !isLocked(list[addI])) {
      const a = list[addI]
      return list.map((o, i) =>
        i === addI
          ? {
              ...a,
              applied: false,
              payload: { ...a.payload, ...op.payload },
              local: { ...(a.local || {}), ...(op.local || {}) },
            }
          : o,
      )
    }
    // 已有一条 update → 合并（update 天然幂等，合并后重新置为未 applied 随下一批重发）
    if (updI >= 0 && !isLocked(list[updI])) {
      const u = list[updI]
      return list.map((o, i) =>
        i === updI
          ? {
              ...u,
              applied: false,
              payload: { ...u.payload, ...op.payload },
              local: { ...(u.local || {}), ...(op.local || {}) },
            }
          : o,
      )
    }
    return [...list, op]
  }

  // delete
  if (delI >= 0) return list // 已有待发 delete，去重
  if (addI >= 0 && !list[addI].applied && !isLocked(list[addI])) {
    // add 还没发出去 → add + 它绑定的 update 一起丢，队列里不留痕迹
    return list.filter((o) => !(same(o) && (o.type === 'add' || o.type === 'update')))
  }
  // 其余情况：丢掉还没同步的 update（delete 语义覆盖它），
  // 保留已同步/在途的 add（手机可能已执行，要靠这条 delete 撤销），追加 delete
  const out = list.filter((o) => !(same(o) && o.type === 'update' && !o.applied && !isLocked(o)))
  out.push(op)
  return out
}

/** 把一条本地改动入队（自动折叠）→ 持久化 → 通知重推导 */
export function enqueueOp(op) {
  const full = { k: genKey(), applied: false, ...op }
  pending = foldPending(pending, full)
  persist()
  return full
}

/** 这批 op 已被手机确认执行：标记 applied（仍留在队列里，等 fetch 落地再整体清掉） */
export function markApplied(keys) {
  const set = new Set(keys)
  const next = pending.map((o) => (set.has(o.k) ? { ...o, applied: true } : o))
  if (next.some((o, i) => o !== pending[i])) {
    pending = next
    persist()
  }
}

/** 整批被手机永久拒绝（ok:false）：丢弃这批 op，不重试 */
export function dropByKeys(keys) {
  const set = new Set(keys)
  const next = pending.filter((o) => !set.has(o.k))
  if (next.length !== pending.length) {
    pending = next
    persist()
  }
}

/** 所有基准天都对账成功后：清掉 applied op（uuid 任务整体换成真身） */
export function clearApplied() {
  const next = pending.filter((o) => !o.applied)
  if (next.length !== pending.length) {
    pending = next
    persist()
  }
}

/** 某一天 fetch 成功：清掉该天已 applied 的 add 占位（手机已收下、或校验拒绝了它——两种都以 fetch 结果为准） */
export function clearAppliedAddsForDay(day) {
  const t = dayTime(day)
  if (!t) return
  const next = pending.filter(
    (o) =>
      !(o.type === 'add' && o.applied && typeof o.payload.start === 'number' && o.payload.start >= t.start && o.payload.start < t.end),
  )
  if (next.length !== pending.length) {
    pending = next
    persist()
  }
}

export function hasUnapplied() {
  return pending.some((o) => !o.applied)
}

// ---------- 在途批次（batch id + 折叠锁） ----------

let inflight = null // {batchId, keys:[...]} 内存镜像：折叠锁与同 id 重发都以它为准

/** 启动时恢复在途批次（页面刷新后用同一个 batch id、同一批 op 重发） */
export function initInflight() {
  const raw = readRaw(INFLIGHT_KEY)
  const obj = raw ? parseJSON(raw) : null
  inflight = obj && obj.v === SCHEMA && typeof obj.batchId === 'string' && obj.batchId ? obj : null
}

export function loadInflight() {
  return inflight
}

export function saveInflight(batchId, keys) {
  inflight = { batchId, keys: Array.isArray(keys) ? keys.slice() : [] }
  writeRaw(INFLIGHT_KEY, { v: SCHEMA, batchId: inflight.batchId, keys: inflight.keys })
}

export function clearInflight() {
  if (!inflight) return
  inflight = null
  removeRaw(INFLIGHT_KEY)
}

/** 当前"已发出、等响应"的 op：折叠时绝不并入它们（跨超时/刷新依然有效） */
export function lockedKeys() {
  return new Set((inflight && inflight.keys) || [])
}

// ---------- 当天基准 ----------

function dayTime(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null
  const [y, m, d] = day.split('-').map(Number)
  const start = new Date(y, m - 1, d).getTime()
  return { start, end: start + 86400000 }
}

/** 任务是否属于某一天（重叠判定）：移动到别天的任务不再出现在原天视图 */
export function belongsDay(day, e) {
  const t = dayTime(day)
  if (!t) return true
  return e.end >= t.start && e.start < t.end
}

/** 读某天基准（结构不认识 → 当无数据） */
export function loadDay(day) {
  const raw = readRaw(DAY_PREFIX + day)
  if (!raw) return null
  const obj = parseJSON(raw)
  if (!obj || obj.v !== SCHEMA || !Array.isArray(obj.events)) return null
  return obj
}

/** 替换某天基准——只允许在 fetch 成功时调用（渲染不变式 B：基准绝不由推导结果写回） */
export function saveDay(day, events) {
  writeRaw(DAY_PREFIX + day, { v: SCHEMA, fetchedAt: Date.now(), events })
}

export function listDays() {
  const days = new Set()
  if (canRead) {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)
        if (k && k.startsWith(DAY_PREFIX)) days.add(k.slice(DAY_PREFIX.length))
      }
    } catch (e) {
      canRead = false
      canWrite = false
      notifyStorageBroken()
    }
  }
  for (const k of mem.keys()) if (k.startsWith(DAY_PREFIX)) days.add(k.slice(DAY_PREFIX.length))
  return [...days].filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
}

/** 清理 7 天前的当天基准（防止 localStorage 无限堆积） */
export function pruneOldDays() {
  const d = new Date()
  d.setDate(d.getDate() - KEEP_DAYS)
  const cutoff = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  for (const day of listDays()) {
    if (day <= cutoff) removeRaw(DAY_PREFIX + day)
  }
}

/** 解除配对 = 换设备语义：清掉基准与待同步队列，避免旧手机的改动发到新手机 */
export function clearAllData() {
  for (const day of listDays()) removeRaw(DAY_PREFIX + day)
  if (pending.length) {
    pending = []
    persist()
  } else {
    savePending()
  }
  clearInflight()
}

/** 所有基准天 + 队列里出现过的任务 id（供 orderHint 清理：指向不存在任务的提示删掉） */
export function allIds(ops) {
  const ids = new Set()
  for (const day of listDays()) {
    const rec = loadDay(day)
    if (rec) for (const e of rec.events) if (e && e.id != null) ids.add(String(e.id))
  }
  for (const op of ops || []) {
    if (op.type === 'add') {
      if (op.tempId != null) ids.add(String(op.tempId))
    } else if (op.eventId != null) {
      ids.add(String(op.eventId))
    }
  }
  return ids
}

// ---------- 渲染推导（渲染不变式 B） ----------
// events = 基准(day) + 按序重放 pending；推导结果**永不写回基准**。
// uuid 任务只在它的 add 还在队列里时存在 → batch 成功 + fetch 落地后自然被真身整体替换，
// 不需要任何 uuid→realId 映射表，也不会重复显示。
export function deriveDay(day, baseEvents, ops) {
  let list = (baseEvents || []).map((e) => ({ ...e })) // 浅拷贝：本地改动绝不污染基准
  for (const op of ops || []) {
    if (op.type === 'add') {
      list.push({ id: op.tempId, ...op.payload, ...(op.local || {}) })
    } else if (op.type === 'update') {
      const ev = list.find((x) => String(x.id) === String(op.eventId))
      if (ev) Object.assign(ev, op.payload, op.local || {})
    } else if (op.type === 'delete') {
      list = list.filter((x) => String(x.id) !== String(op.eventId))
    }
  }
  // 按天归属过滤：pending 里的 add 可能属于别天、update 可能把任务移出本天
  return list.filter((e) => belongsDay(day, e))
}
