// 配置持久化：配对码 + 安卓 peerId + 网页 peerId，保存在 localStorage
// 网页不持久保存日程，日程一律实时从安卓拉取

// 信令服务器（MQTT broker）地址固定内置，用户无需配置，见 MQTT信令协议.md §1
// 用 EMQX 国内公共节点（实测比国际节点 broker.emqx.io 快 ~40%：连接 2.2s vs 3.6s）
export const DEFAULT_SIGNAL_URL = 'wss://broker-cn.emqx.io:8084/mqtt'

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
