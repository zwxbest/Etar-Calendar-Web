// 配置持久化：配对码 + 安卓 peerId + 网页 peerId，保存在 localStorage
// 日程的离线缓存（当天基准 / 待同步队列 / 在途批次）在 lib/cache.js，
// 展示顺序提示（etar_web_order_hint）也在本文件——网页端只是"本地操作层 + 缓存"，
// 数据权威始终是手机本地库

// 信令服务器（MQTT broker）地址固定内置，用户无需配置，见 MQTT信令协议.md §1
// 指向 192.168.96.58（TCP 1883 给安卓、WebSocket 8083 给网页），换机器时两端常量同步改。
export const SIGNAL_URLS = ['ws://192.168.96.58:8083/mqtt']

const KEY = 'etar_web_sync_config'
const PEER_ID_KEY = 'etar_web_peer_id'

export function loadConfig() {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? JSON.parse(raw) : null
  } catch (e) {
    return null
  }
}

export function saveConfig(config) {
  try {
    localStorage.setItem(KEY, JSON.stringify(config))
  } catch (e) {
    /* 隐私模式/配额超限：本轮不持久化，下次打开需重新输码（不打断使用） */
  }
}

export function clearConfig() {
  localStorage.removeItem(KEY)
}

export function randomPeerId() {
  const bytes = new Uint8Array(4)
  crypto.getRandomValues(bytes)
  return 'web-' + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// ---------- 网页端展示顺序提示 ----------
// { [被移动任务id]: 锚点任务id }：把被移动任务排到锚点前面（纯前端展示规则，不写手机库）
const ORDER_HINT_KEY = 'etar_web_order_hint'

export function loadOrderHint() {
  try {
    const raw = localStorage.getItem(ORDER_HINT_KEY)
    const obj = raw ? JSON.parse(raw) : {}
    return obj && typeof obj === 'object' ? obj : {}
  } catch (e) {
    return {}
  }
}

export function saveOrderHint(hint) {
  try {
    localStorage.setItem(ORDER_HINT_KEY, JSON.stringify(hint))
  } catch (e) {
    /* ignore */
  }
}

// 网页 peerId 持久化：配对后安卓只认这个 id，刷新页面不能变（协议 §8）
export function loadOrCreatePeerId() {
  try {
    const saved = localStorage.getItem(PEER_ID_KEY)
    if (saved && saved.startsWith('web-')) return saved
    const fresh = randomPeerId()
    localStorage.setItem(PEER_ID_KEY, fresh)
    return fresh
  } catch (e) {
    return randomPeerId()
  }
}
