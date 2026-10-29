// 同步客户端：MQTT 加密直连为唯一数据通道（协议 §9 v3）
//
// 策略：信令连上、对端在场后，日程数据直接经 MQTT 加密信封（type="data"）收发。
// WebRTC/ICE 路径已整体移除（v3）：NAT 穿透复杂度换来的收益不抵维护成本，
// 公共 broker 的出站长连接在各类网络环境下都稳定可用。
//
// 数据协议：
// 网页 → 安卓：
//   {"type":"fetch_day","day":"2026-10-28"}
//   {"type":"add","payload":{...}}
//   {"type":"update","id":"123","payload":{...}}
//   {"type":"delete","id":"123"}
//   {"type":"ping"}
// 安卓 → 网页：
//   {"type":"day","day":"...","events":[...]}
//   {"type":"result","ok":true|false,"action":"...","error":"..."}
//   {"type":"push_change","payload":{}}       安卓本地变更，网页收到后刷新当前显示日
//   {"type":"pong"}
//
// 状态机：idle(未配对) → connecting(连接中) → connected(已连通) → 离线自动重试
// 可靠性：双向 25s 心跳 ping/pong，90s 无入站数据判定通道死亡（协议 §9.3）

import { Signaling } from './signal.js'
import { loadOrCreatePeerId, DEFAULT_SIGNAL_URL } from './store.js'

const HEARTBEAT_INTERVAL = 25000
const RESPONSE_TIMEOUT = 15000
// 心跳丢失判定：超过此时长没有任何入站数据（含 pong）→ 通道死亡（容忍浏览器后台节流到 1 次/分钟）
const DATA_DEAD_MS = 90000
const DEAD_CHECK_INTERVAL = 30000

export class SyncClient {
  constructor() {
    this.signaling = null
    this.status = 'idle'
    // 网页 peerId 持久化：配对后安卓只认这个 id，刷新不能变
    this.myPeerId = loadOrCreatePeerId()
    this.androidPeerId = null
    this.pending = new Map() // id -> {resolve, reject, timer}
    this.reqSeq = 0
    // 请求 id = <sid>-<seq>：sid 每次页面加载随机，防止与安卓侧去重缓存跨页面撞号
    this.sid = Math.random().toString(16).slice(2, 6)
    this.lastInboundAt = 0 // 最近一次收到任何数据（含 pong）的时刻，心跳看门狗用
    this.heartbeatTimer = null
    this.deadTimer = null
    this.watchdogTimer = null
    this.handlers = { status: [], push: [], message: [] }
    this.wantConnection = false
  }

  on(type, cb) {
    if (!this.handlers[type]) this.handlers[type] = []
    this.handlers[type].push(cb)
    return this
  }

  emit(type, ...args) {
    for (const cb of this.handlers[type] || []) cb(...args)
  }

  setStatus(status) {
    if (this.status !== status) {
      console.info(`[sync] 状态 ${this.status} → ${status}`)
      this.status = status
      this.emit('status', status)
      this.watchdog(status)
    }
  }

  /** 停在 connecting 超过 10s 就打印诊断信息，方便定位卡在哪一环 */
  watchdog(status) {
    clearTimeout(this.watchdogTimer)
    if (status !== 'connecting') return
    this.watchdogTimer = setTimeout(() => {
      if (this.status !== 'connecting') return
      const mqtt = this.signaling && this.signaling.client ? (this.signaling.client.connected ? '已连接' : '连接中') : '未启动'
      console.warn(
        `[sync] 已等待 10s 仍未连上手机：mqtt=${mqtt}，对端=${this.androidPeerId || '未知'}。` +
          '请确认：手机 Etar 前台服务在运行、配对码一致、双方网络可达',
      )
    }, 10000)
  }

  /**
   * 开始连接（配对或重连都走这里）
   * @param {object} config {code, androidPeerId}，信令地址用内置默认值
   */
  connect(config) {
    this.config = config
    this.androidPeerId = config.androidPeerId
    this.wantConnection = true
    this.lastInboundAt = 0
    this.teardownPending()
    if (this.signaling) this.signaling.close()
    this.signaling = new Signaling(DEFAULT_SIGNAL_URL, `pair-${config.code}`)
    this.signaling.on('status', (s) => {
      if (s === 'connecting') this.setStatus('connecting')
      if (s === 'closed') this.setStatus('offline')
    })
    this.signaling.on('message', (msg) => this.onSignalingMessage(msg))
    this.signaling.connect(this.myPeerId)
  }

  async onSignalingMessage(msg) {
    if (msg.type === 'joined') {
      // 已保存过对端 peerId 时只认它；全新配对则接受房间里的第一个 android-*
      const android = msg.peers.find((p) => p.startsWith('android-'))
      const target = this.androidPeerId || android
      if (msg.peers.length > 0 && target && msg.peers.includes(target)) {
        this.onPeerPresent(target)
      } else if (msg.peers.length > 0) {
        console.warn(`[sync] 房间里的手机 ${android} 与已记住的 ${this.androidPeerId} 不一致，忽略（换过手机需清除配对）`)
      }
    } else if (msg.type === 'peer-joined') {
      if (msg.peerId.startsWith('android-') && (!this.androidPeerId || this.androidPeerId === msg.peerId)) {
        this.onPeerPresent(msg.peerId)
      }
    } else if (msg.type === 'data') {
      // MQTT 数据（已解密）
      if (this.androidPeerId && msg.from !== this.androidPeerId) return
      this.onData(msg.data)
    } else if (msg.type === 'peer-left') {
      // 一对一：陌生人发的 leave 不影响已配对状态（协议 §6）
      if (this.androidPeerId && msg.peerId && msg.peerId !== this.androidPeerId) return
      console.warn(`[sync] 手机已离线（${msg.peerId}）`)
      this.setStatus(this.wantConnection ? 'connecting' : 'idle')
    } else if (msg.type === 'error') {
      this.emit('message', msg.message)
    }
  }

  /** 对端在场：数据通道就是 MQTT，直接可用，无需额外握手 */
  onPeerPresent(peerId) {
    if (this.androidPeerId !== peerId) this.androidPeerId = peerId
    console.info(`[sync] 手机在场（${peerId}），MQTT 数据通道就绪`)
  }

  /** 统一数据入口 */
  onData(raw) {
    let msg
    try {
      msg = typeof raw === 'string' ? JSON.parse(raw) : raw
    } catch (e) {
      return
    }
    // 任何入站数据（含 pong）都证明通道活着
    this.lastInboundAt = Date.now()
    if (this.status !== 'connected') {
      this.setStatus('connected')
      this.startHeartbeat()
    }
    if (msg.type === 'pong') return
    // 安卓侧也会周期 ping（对称心跳，协议 §9.3），这里必须回 pong
    if (msg.type === 'ping') {
      this.send({ type: 'pong', id: msg.id })
      return
    }
    console.info(`[sync] 收到 ${msg.type}${msg.day ? `(${msg.day})` : ''}`)
    if (msg.type === 'push_change') {
      this.emit('push', msg.payload || {})
      return
    }
    // result / day：按请求 id 配对
    const id = msg.id != null ? String(msg.id) : null
    const p = id ? this.pending.get(id) : null
    if (p) {
      this.pending.delete(id)
      clearTimeout(p.timer)
      if (msg.type === 'result') {
        if (msg.ok) p.resolve(msg)
        else p.reject(new Error(msg.error || '操作失败'))
      } else if (msg.type === 'day') {
        p.resolve(msg.events || [])
      }
      return
    }
    this.emit('message', msg)
  }

  /** 发送数据（唯一通道：MQTT 加密信封）。返回是否已交给 broker */
  send(obj) {
    if (!this.signaling) return Promise.resolve(false)
    return this.signaling.sendData(obj)
  }

  /** 发送请求并等待响应（按 id 配对） */
  request(obj, expectType) {
    return new Promise(async (resolve, reject) => {
      if (!this.signaling || !this.signaling.client || !this.signaling.client.connected) {
        reject(new Error('未连接到手机'))
        return
      }
      const id = `${this.sid}-${++this.reqSeq}`
      obj.id = id
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('等待手机响应超时'))
      }, RESPONSE_TIMEOUT)
      this.pending.set(id, { resolve, reject, timer })
      const sent = await this.send(obj)
      if (!sent) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new Error('发送失败'))
      }
    })
  }

  fetchDay(day) {
    return this.request({ type: 'fetch_day', day }, 'day')
  }

  add(payload) {
    return this.request({ type: 'add', payload })
  }

  update(id, payload) {
    return this.request({ type: 'update', id: String(id), payload })
  }

  remove(id) {
    return this.request({ type: 'delete', id: String(id) })
  }

  /** 心跳：周期 ping 保活 + 看门狗监测入站数据，90s 无回包判定通道死亡 */
  startHeartbeat() {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      this.send({ type: 'ping' })
    }, HEARTBEAT_INTERVAL)
    this.deadTimer = setInterval(() => {
      if (this.status !== 'connected' || !this.lastInboundAt) return
      const idle = Date.now() - this.lastInboundAt
      if (idle > DATA_DEAD_MS) {
        console.warn(`[sync] 数据通道 ${Math.round(idle / 1000)}s 无任何回包，判定通道死亡，回落 connecting`)
        this.stopHeartbeat()
        this.lastInboundAt = 0
        this.setStatus('connecting')
      }
    }, DEAD_CHECK_INTERVAL)
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    if (this.deadTimer) {
      clearInterval(this.deadTimer)
      this.deadTimer = null
    }
  }

  /** 让所有等待中的请求立刻失败 */
  teardownPending() {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new Error('连接已断开'))
    }
    this.pending.clear()
  }

  disconnect() {
    this.wantConnection = false
    clearTimeout(this.watchdogTimer)
    this.stopHeartbeat()
    this.teardownPending()
    if (this.signaling) {
      this.signaling.close()
      this.signaling = null
    }
    this.setStatus('idle')
  }
}
