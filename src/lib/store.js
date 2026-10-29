// 配置持久化：配对码 + 安卓 peerId + 网页 peerId，保存在 localStorage
// 网页不持久保存日程，日程一律实时从安卓拉取

// 信令服务器（MQTT broker）地址固定内置，用户无需配置，见 MQTT信令协议.md §1
// 双节点同时在线（§9 v4）：网页同时连国内+国际节点，任一可达即连通。
// 兼容不同版本手机 APK 写死的单一 broker（旧包 broker.emqx.io / 新包 broker-cn），
// 同时抗单节点故障；请求在两条链路都发，安卓按请求 id 去重只处理一次。
export const SIGNAL_URLS = [
  'wss://broker-cn.emqx.io:8084/mqtt',
  'wss://broker.emqx.io:8084/mqtt',
]

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
  localStorage.setItem(KEY, JSON.stringify(config))
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
