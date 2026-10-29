// MQTT 信令客户端：协议见 MQTT信令协议.md
// 用公共 broker 的 pub/sub 替代原 Worker 房间转发：
//   只往自己的角色主题发布、只订阅对端的角色主题，主题本身完成寻址
// 对外接口保持不变：connect(peerId) / on('status'|'message') / signal(to, data) / close()

import mqtt from 'mqtt'
import { deriveDataKey, encryptJson, decryptJson } from './crypto.js'

const RECONNECT_BASE = 2000
const RECONNECT_MAX = 30000
const KEEPALIVE = 30
const CONNECT_TIMEOUT = 10000
const PROTOCOL_VERSION = 1
const ROLE = 'web' // 本端角色主题；对端是 android

// 房间标识：sha256("etar-sync-v1:" + 配对码) 前 16 位 hex
// 两端各自派生，主题里不出现裸配对码（协议 §2）
async function deriveRoomHash(code) {
  const bytes = new TextEncoder().encode('etar-sync-v1:' + code)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16)
}

export class Signaling {
  /**
   * @param {string} url    broker 地址，内置在 store.js，用户无需配置
   * @param {string} roomId 房间名 pair-<配对码>
   */
  constructor(url, roomId) {
    this.url = url
    this.roomId = roomId
    this.client = null
    this.peerId = null
    this.pubTopic = null // 自己发布：etar/cal/<T>/web
    this.subTopic = null // 对端发布：etar/cal/<T>/android
    this.closedByUser = false
    this.reconnectDelay = RECONNECT_BASE
    this.reconnectTimer = null
    this.peerLeftAt = 0 // 对端最近一次离开的时刻，用于丢弃过期信令
    this.dataKey = null // 日程数据加密密钥（配对码派生，协议 §9）
    this.handlers = { message: [], status: [] }
  }

  on(type, cb) {
    if (!this.handlers[type]) this.handlers[type] = []
    this.handlers[type].push(cb)
    return this
  }

  emit(type, ...args) {
    for (const cb of this.handlers[type] || []) cb(...args)
  }

  async connect(peerId) {
    this.peerId = peerId
    this.closedByUser = false
    this.reconnectDelay = RECONNECT_BASE
    this.emit('status', 'connecting')
    let room
    let code
    try {
      code = this.roomId.startsWith('pair-') ? this.roomId.slice(5) : this.roomId
      room = await deriveRoomHash(code)
    } catch (e) {
      // crypto.subtle 只在安全上下文可用
      this.emit('message', { type: 'error', message: '无法生成房间标识：请用 https 或 localhost 访问' })
      this.emit('status', 'closed')
      return
    }
    if (this.closedByUser) return
    this.dataKey = await deriveDataKey(code) // 日程数据加密密钥（协议 §9）
    this.pubTopic = 'etar/cal/' + room + '/' + ROLE
    this.subTopic = 'etar/cal/' + room + '/android'
    console.info(`[signal] 连接 broker ${this.url}，房间 ${room}，本端 peerId=${peerId}`)
    this.open()
  }

  open() {
    if (this.closedByUser || this.client) return
    const suffix = (Math.random().toString(16).slice(2, 8) + '000000').slice(0, 6)
    const client = mqtt.connect(this.url, {
      // clientId 带随机后缀：公共 broker 上同 id 会互踢（协议 §1）
      clientId: 'etar-w-' + this.peerId + '-' + suffix,
      clean: true,
      keepalive: KEEPALIVE,
      connectTimeout: CONNECT_TIMEOUT,
      reconnectPeriod: 0, // 断线由本类自己按 2s→30s 指数退避重连
      resubscribe: false, // 每次连上都重新订阅（reconnectPeriod=0 时 mqtt.js 不记订阅表）
      queueQoSZero: false,
      will: {
        // 异常断线时由 broker 代发，对端据此立刻知道我们掉线（协议 §3）
        topic: this.pubTopic,
        payload: JSON.stringify({ v: PROTOCOL_VERSION, type: 'peer-left', peerId: this.peerId }),
        qos: 1,
        retain: false,
      },
    })
    this.client = client

    client.on('connect', () => {
      if (this.client !== client) return
      this.reconnectDelay = RECONNECT_BASE
      // 先订阅对端主题、拿到 SUBACK 再宣告在线，避免错过对方的 here（协议 §4 时序）
      client.subscribe(this.subTopic, { qos: 1 }, (err) => {
        if (this.client !== client) return
        if (err) {
          console.warn('[signaling] subscribe failed:', err.message || err)
          client.end(true) // 断开后由 close 事件走退避重连
          return
        }
        this.publish({ v: PROTOCOL_VERSION, type: 'join', peerId: this.peerId, ts: Date.now() })
        this.emit('status', 'open')
      })
    })
    client.on('message', (topic, payload) => {
      if (this.client !== client || topic !== this.subTopic) return
      this.onMessage(payload)
    })
    client.on('close', () => {
      if (this.client !== client) return
      this.emit('status', 'closed')
      this.scheduleReconnect()
    })
    client.on('error', (e) => {
      // 浏览器拿不到多数底层错误，重连只认 close 事件
      console.warn('[signaling] mqtt error:', (e && e.message) || e)
    })
  }

  /** 收到对端主题上的消息，翻译成 sync.js 认识的旧事件（协议 §8） */
  onMessage(payload) {
    let msg
    try {
      msg = JSON.parse(payload.toString())
    } catch (e) {
      return
    }
    if (!msg || msg.v !== PROTOCOL_VERSION) return // 版本不符直接忽略
    const peer = msg.peerId || msg.from
    // 一对一：只认安卓端，其他订阅者发的一律丢弃（协议 §6）
    if (typeof peer !== 'string' || !peer.startsWith('android-')) return
    const brief = msg.type === 'signal' && msg.data ? `(${msg.data.kind})` : ''
    console.info(`[signal] 收到 ${msg.type}${brief} from ${peer}`)

    switch (msg.type) {
      case 'join':
        // 收到 join 必答 here；here 不再触发回复，最多两跳、不成环（协议 §4）
        this.publish({ v: PROTOCOL_VERSION, type: 'here', peerId: this.peerId })
        this.emit('message', { type: 'joined', peers: [peer] })
        break
      case 'here':
        this.emit('message', { type: 'peer-joined', peerId: peer })
        break
      case 'leave':
      case 'peer-left':
        // 优雅下线与 LWT 兜底，对客户端等价
        this.peerLeftAt = msg.ts || Date.now()
        this.emit('message', { type: 'peer-left', peerId: peer })
        break
      case 'signal':
        // 丢弃对端离开之前发出的过期信令
        if (msg.ts && this.peerLeftAt && msg.ts < this.peerLeftAt) return
        this.emit('message', { type: 'signal', from: peer, data: msg.data })
        break
      case 'data':
        // 日程数据（加密信封，协议 §9）：解密后交给 sync.js（与 DataChannel 消息同一处理入口）
        if (msg.ts && this.peerLeftAt && msg.ts < this.peerLeftAt) return
        if (typeof msg.d !== 'string') return
        decryptJson(this.dataKey, msg.d)
          .then((plain) => this.emit('message', { type: 'data', from: peer, data: plain }))
          .catch((e) => console.warn('[signal] 数据消息解密失败（配对码不一致或被篡改）:', e && e.message))
        break
      default:
        // 未知类型忽略，协议演进时老客户端不报错
        break
    }
  }

  /** 发布到自己的角色主题（QoS1、一律不用 retain，协议 §1） */
  publish(msg) {
    const client = this.client
    if (!client || !client.connected) return false
    client.publish(this.pubTopic, JSON.stringify(msg), { qos: 1, retain: false }, (err) => {
      if (err) console.warn('[signaling] publish failed:', err.message || err)
    })
    return true
  }

  scheduleReconnect() {
    if (this.closedByUser || this.reconnectTimer) return
    const delay = this.reconnectDelay
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX)
    console.warn(`[signal] 连接断开，${delay / 1000}s 后重连（第 ${Math.round(Math.log2(delay / RECONNECT_BASE)) + 1} 次退避）`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.closedByUser || !this.client) return
      this.emit('status', 'connecting')
      this.client.reconnect()
    }, delay)
  }

  /** 转发信令给对端（to 仅为接口兼容保留：MQTT 下只有一条对端主题） */
  signal(to, data) {
    this.publish({ v: PROTOCOL_VERSION, type: 'signal', from: this.peerId, data, ts: Date.now() })
  }

  /** 日程数据直连（协议 §9）：加密后发布到自己的角色主题。返回是否已交给 broker */
  async sendData(obj) {
    if (!this.dataKey) return false
    try {
      const d = await encryptJson(this.dataKey, obj)
      return this.publish({ v: PROTOCOL_VERSION, type: 'data', from: this.peerId, ts: Date.now(), d })
    } catch (e) {
      console.warn('[signal] 数据加密失败:', e && e.message)
      return false
    }
  }

  close() {
    this.closedByUser = true
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    const client = this.client
    this.client = null // 旧 client 之后发出的事件全部失效
    if (client) {
      if (client.connected) {
        // 先宣告下线再断开，对端立刻感知；异常断线由 LWT 兜底
        client.publish(
          this.pubTopic,
          JSON.stringify({ v: PROTOCOL_VERSION, type: 'leave', peerId: this.peerId }),
          { qos: 1, retain: false },
          () => client.end()
        )
        setTimeout(() => {
          try {
            client.end(true)
          } catch (e) {
            /* ignore */
          }
        }, 1000)
      } else {
        try {
          client.end(true)
        } catch (e) {
          /* ignore */
        }
      }
    }
    this.emit('status', 'closed')
  }
}
