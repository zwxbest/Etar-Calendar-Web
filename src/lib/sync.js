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
import { loadOrCreatePeerId, SIGNAL_URLS } from './store.js'

const HEARTBEAT_INTERVAL = 25000
const RESPONSE_TIMEOUT = 15000
// 心跳丢失判定：超过此时长没有任何入站数据（含 pong）→ 通道死亡（容忍浏览器后台节流到 1 次/分钟）
const DATA_DEAD_MS = 90000
const DEAD_CHECK_INTERVAL = 30000

export class SyncClient {
  constructor() {
    // 双 broker 连接（国内 + 国际节点）：任一可达即连通，兼容写死单一 broker 的新旧手机 APK
    this.signallings = []
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

  /** 任一 broker 已连通 */
  anyConnected() {
    return this.signallings.some((s) => s && s.client && s.client.connected)
  }

  /** 双 broker 状态合并：任一路连上就算可用；全断才 offline */
  recomputeStatus() {
    if (this.signallings.length === 0) return
    if (this.anyConnected()) {
      if (this.status === 'offline') this.setStatus('connecting')
    } else if (this.status !== 'offline' && this.status !== 'idle') {
      this.setStatus('offline')
    }
  }

  /** 停在 connecting 超过 10s 就打印诊断信息，方便定位卡在哪一环 */
  watchdog(status) {
    clearTimeout(this.watchdogTimer)
    if (status !== 'connecting') return
    this.watchdogTimer = setTimeout(() => {
      if (this.status !== 'connecting') return
      const mqtt = this.anyConnected() ? '已连接' : '连接中'
      console.warn(
        `[sync] 已等待 10s 仍未连上手机：mqtt=${mqtt}，对端=${this.androidPeerId || '未知'}。` +
          '请确认：手机 Etar 前台服务在运行、配对码一致、手机 APK 与网页均已更新到最新版',
      )
    }, 10000)
  }

  /**
   * 开始连接（配对或重连都走这里）
   * @param {object} config {code, androidPeerId}
   */
  connect(config) {
    this.config = config
    this.androidPeerId = config.androidPeerId
    this.wantConnection = true
    this.lastInboundAt = 0
    this.teardownPending()
    for (const s of this.signallings) s.close()
    // 双 broker 并行：旧手机 APK 写死 broker.emqx.io、新包写死 broker-cn，两边都连保证都能配对
    this.signallings = SIGNAL_URLS.map((url) => {
      const s = new Signaling(url, `pair-${config.code}`)
      s.on('status', () => this.recomputeStatus())
      s.on('message', (msg) => this.onSignalingMessage(msg))
      s.connect(this.myPeerId)
      return s
    })
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
    console.info(`[sync] 手机在场（${peerId}），MQTT 数据通道就绪，发起首次拉取`)
    // 立刻通知上层发首个请求（fetch_day）：不能等 connected ——
    // connected 由入站数据触发，而入站数据要先有请求才有响应，会死锁
    this.emit('peer', peerId)
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

  /** 发送数据（唯一通道：MQTT 加密信封）。在所有已连通的 broker 上同时发——
   *  手机只在其中一个 broker 上，另一条路的重复投递由安卓按请求 id 去重 */
  async send(obj) {
    const conns = this.signallings.filter((s) => s && s.client && s.client.connected)
    if (conns.length === 0) return false
    const results = await Promise.all(conns.map((s) => s.sendData(obj)))
    return results.some(Boolean)
  }

  /** 发送请求并等待响应（按 id 配对） */
  request(obj, expectType) {
    return new Promise(async (resolve, reject) => {
      if (!this.anyConnected()) {
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

  /** 上层发起请求的前置条件：任一 broker 已连接且对端已知（不要求 connected，后者要等首个回包） */
  ready() {
    return !!(this.anyConnected() && this.androidPeerId)
  }

  add(payload) {
    return this.request({ type: 'add', payload })
  }

  update(id, payload) {
    // 任务 id 用独立字段 eventId：request() 会统一给 obj.id 盖请求关联号，
    // 之前复用 id 字段导致安卓端拿到的是 "sid-1" 之类无法解析的值（delete/update 一直失败）
    return this.request({ type: 'update', eventId: String(id), payload })
  }

  remove(id) {
    return this.request({ type: 'delete', eventId: String(id) })
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
    for (const s of this.signallings) s.close()
    this.signallings = []
    this.setStatus('idle')
  }
}
