// 同步客户端：MQTT 数据直连优先，60s 无回包再升级 WebRTC DataChannel（协议 §9）
//
// 传输策略：
//   1. 信令连接成功后，日程数据直接经 MQTT 加密信封（type="data"）收发，不等 WebRTC
//   2. 对端在场但 60s 内没有任何数据回包 → 升级尝试 WebRTC（ICE 自身按 host/IPv6 → STUN → TURN 降级）
//   3. DataChannel 打开后数据改走 P2P；RTC 断线时自动回落 MQTT（数据不断线）
//
// 数据协议（两条传输通道上完全一致）：
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
// 状态机：idle(未配对) → connecting(连接中) → connected(已连通·MQTT|P2P) → 离线自动重试

import { Signaling } from './signal.js'
import { RtcLink } from './rtc.js'
import { loadOrCreatePeerId, DEFAULT_SIGNAL_URL } from './store.js'

const HEARTBEAT_INTERVAL = 25000
const RESPONSE_TIMEOUT = 15000
// 心跳丢失判定：超过此时长没有任何入站数据（含 pong）→ 通道死亡（容忍浏览器后台节流到 1 次/分钟）
const DATA_DEAD_MS = 90000
const DEAD_CHECK_INTERVAL = 30000
// MQTT 数据无回包多久后升级 WebRTC（用户定义：1 分钟）
const RTC_ESCALATE_MS = 60000

export class SyncClient {
  constructor() {
    this.signaling = null
    this.rtc = null
    this.status = 'idle'
    // 网页 peerId 持久化：配对后安卓只认这个 id，刷新不能变
    this.myPeerId = loadOrCreatePeerId()
    this.androidPeerId = null
    this.pending = new Map() // id -> {resolve, reject, timer}
    this.reqSeq = 0
    // 请求 id = <sid>-<seq>：sid 每次页面加载随机，防止与安卓侧去重缓存跨页面撞号
    this.sid = Math.random().toString(16).slice(2, 6)
    this.dataOk = false // 任一传输通道成功收发过数据
    this.transport = null // 'mqtt' | 'rtc'，当前数据通道
    this.lastInboundAt = 0 // 最近一次收到任何数据（含 pong）的时刻，心跳看门狗用
    this.escalateTimer = null
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

  /** 状态迁移；transport 标明当前数据通道（'mqtt' | 'rtc'）供 UI 显示 */
  setStatus(status, transport) {
    if (this.status !== status) {
      console.info(`[sync] 状态 ${this.status} → ${status}${transport ? `（${transport}）` : ''}`)
      this.status = status
      this.emit('status', status, transport || this.transport)
      this.watchdog(status)
    } else if (transport && transport !== this.transport) {
      // 已 connected 但通道切换（mqtt↔rtc），通知 UI 更新显示
      this.emit('status', status, transport)
    }
    if (transport) this.transport = transport
  }

  /** 停在 connecting 超过 10s 就打印诊断信息，方便定位卡在哪一环 */
  watchdog(status) {
    clearTimeout(this.watchdogTimer)
    if (status !== 'connecting') return
    this.watchdogTimer = setTimeout(() => {
      if (this.status !== 'connecting') return
      const mqtt = this.signaling && this.signaling.client ? (this.signaling.client.connected ? '已连接' : '连接中') : '未启动'
      const rtcDesc = this.rtc
        ? `channel=${this.rtc.channel ? this.rtc.channel.readyState : '未建立'}, pc=${this.rtc.pc ? this.rtc.pc.connectionState : '未建立'}`
        : '未启动（MQTT 直连模式，60s 无回包会自动升级）'
      console.warn(
        `[sync] 已等待 10s 仍未连上手机：mqtt=${mqtt}，rtc=${rtcDesc}，对端=${this.androidPeerId || '未知'}。` +
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
    this.dataOk = false
    this.transport = null
    this.lastInboundAt = 0
    clearTimeout(this.escalateTimer)
    this.escalateTimer = null
    this.teardownRtc()
    if (this.signaling) this.signaling.close()
    this.signaling = new Signaling(DEFAULT_SIGNAL_URL, `pair-${config.code}`)
    this.signaling.on('status', (s) => {
      if (s === 'connecting') this.setStatus('connecting')
      if (s === 'closed') {
        // 信令断开：数据状态作废，重连后由在场宣告重新评估是否升级 RTC
        this.dataOk = false
        clearTimeout(this.escalateTimer)
        this.escalateTimer = null
        this.setStatus('offline')
      }
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
      // MQTT 数据直连（已解密），与 DataChannel 数据走同一入口
      if (this.androidPeerId && msg.from !== this.androidPeerId) return
      this.onData(msg.data, 'mqtt')
    } else if (msg.type === 'signal') {
      if (this.androidPeerId && msg.from !== this.androidPeerId) return
      if (!this.rtc) await this.startRtc(msg.from, true)
      await this.rtc.acceptSignal(msg.from, msg.data)
    } else if (msg.type === 'peer-left') {
      // 一对一：陌生人发的 leave 不影响已配对的连接（协议 §6）
      if (this.androidPeerId && msg.peerId && msg.peerId !== this.androidPeerId) return
      console.warn(`[sync] 手机已离线（${msg.peerId}）`)
      this.dataOk = false
      clearTimeout(this.escalateTimer)
      this.escalateTimer = null
      this.teardownRtc()
      this.setStatus(this.wantConnection ? 'connecting' : 'idle')
    } else if (msg.type === 'error') {
      this.emit('message', msg.message)
    }
  }

  /** 对端在场：先走 MQTT 数据直连，60s 无回包再升级 WebRTC（协议 §9） */
  onPeerPresent(peerId) {
    if (this.androidPeerId !== peerId) this.androidPeerId = peerId
    console.info(`[sync] 手机在场（${peerId}）：先用 MQTT 数据直连，${RTC_ESCALATE_MS / 1000}s 无回包再升级 WebRTC`)
    this.armEscalation()
  }

  /** 布置 60s 升级定时器：已通数据或已在建 RTC 时不布置 */
  armEscalation() {
    if (this.dataOk || this.escalateTimer || this.rtc) return
    if (!this.signaling || !this.signaling.client || !this.signaling.client.connected) return
    this.escalateTimer = setTimeout(() => this.escalateToRtc(), RTC_ESCALATE_MS)
    console.info(`[sync] 已布置 ${RTC_ESCALATE_MS / 1000}s WebRTC 升级定时器`)
  }

  escalateToRtc() {
    this.escalateTimer = null
    if (this.dataOk || this.rtc) return
    if (!this.androidPeerId) return
    console.warn('[sync] MQTT 数据 60s 无回包，升级尝试 WebRTC（ICE 依次试 host/IPv6 → STUN → TURN）')
    this.startRtc(this.androidPeerId)
  }

  /** 发起（或被动应答式创建）RtcLink */
  async startRtc(remotePeerId, passive = false) {
    // 已有到该 peer 的连接（握手中或已建立）时不重建：MQTT 下重复的 join/here
    // 会连续触发，避免无谓的 offer 重协商（协议 §5）
    if (this.rtc && !this.rtc.closed && this.rtc.remotePeerId === remotePeerId) {
      const channelOpen = this.rtc.channel && this.rtc.channel.readyState === 'open'
      const negotiated = this.rtc.pc && this.rtc.pc.remoteDescription
      if (channelOpen || negotiated) return
    }
    this.androidPeerId = remotePeerId
    this.teardownRtc()
    const rtc = new RtcLink({
      onSignal: (to, data) => this.signaling.signal(to, data),
      onData: (text) => this.onData(text, 'rtc'),
      onOpen: () => {
        console.info('[sync] DataChannel 打开，数据通道切换为 P2P')
        this.setStatus('connected', 'rtc')
        this.startHeartbeat()
        this.emit('rtc-open')
      },
      onClose: () => {
        this.teardownRtc()
        const mqttAlive = this.signaling && this.signaling.client && this.signaling.client.connected
        if (this.dataOk && mqttAlive) {
          // RTC 断了但 MQTT 还活着：数据回落 MQTT，不断线
          console.warn('[sync] RTC 断开，数据自动回落 MQTT 通道')
          this.setStatus('connected', 'mqtt')
        } else if (this.wantConnection) {
          this.stopHeartbeat()
          this.setStatus('connecting')
          this.armEscalation() // peer 仍在场的话 60s 后重试
        }
      },
    })
    this.rtc = rtc
    if (!passive) {
      // 网页永远是 offerer
      await rtc.start(remotePeerId)
    }
  }

  /** 统一数据入口：MQTT（已解密对象）与 DataChannel（JSON 文本）汇合 */
  onData(raw, via) {
    let msg
    try {
      msg = typeof raw === 'string' ? JSON.parse(raw) : raw
    } catch (e) {
      return
    }
    // 任何入站数据（含 pong）都证明通道活着
    this.lastInboundAt = Date.now()
    // 任一通道成功收到数据 → 标记数据已通、取消 RTC 升级
    const firstOk = !this.dataOk
    this.dataOk = true
    clearTimeout(this.escalateTimer)
    this.escalateTimer = null
    if (this.status !== 'connected') {
      this.setStatus('connected', via)
      this.startHeartbeat()
    } else if (this.transport !== via) {
      this.setStatus('connected', via)
    } else {
      this.transport = via
    }
    if (msg.type === 'pong') return
    // 安卓侧也会周期 ping（对称心跳，协议 §9.3），这里必须回 pong
    if (msg.type === 'ping') {
      this.sendObj({ type: 'pong', id: msg.id })
      return
    }
    console.info(`[sync] 收到 ${msg.type}${msg.day ? `(${msg.day})` : ''} [${via}]${firstOk ? '（数据通道首通）' : ''}`)
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

  /** 当前可用的数据发送通道：RTC 优先，回落 MQTT */
  async sendObj(obj) {
    if (this.rtc && this.rtc.channel && this.rtc.channel.readyState === 'open') {
      return this.rtc.send(obj)
    }
    if (this.signaling) return this.signaling.sendData(obj)
    return false
  }

  /** 发送请求并等待响应（两条通道透明，响应按 id 配对，与来源通道无关） */
  request(obj, expectType) {
    return new Promise(async (resolve, reject) => {
      const canRtc = this.rtc && this.rtc.channel && this.rtc.channel.readyState === 'open'
      const canMqtt = this.signaling && this.signaling.client && this.signaling.client.connected
      if (!canRtc && !canMqtt) {
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
      const sent = await this.sendObj(obj)
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
      this.sendObj({ type: 'ping' })
    }, HEARTBEAT_INTERVAL)
    this.deadTimer = setInterval(() => {
      if (this.status !== 'connected' || !this.lastInboundAt) return
      const idle = Date.now() - this.lastInboundAt
      if (idle > DATA_DEAD_MS) {
        console.warn(`[sync] 数据通道 ${Math.round(idle / 1000)}s 无任何回包，判定通道死亡，回落 connecting 并重试`)
        this.dataOk = false
        this.stopHeartbeat()
        this.setStatus('connecting')
        this.armEscalation() // 信令还在的话 60s 后重试 RTC
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

  teardownRtc() {
    if (this.rtc) {
      this.rtc.destroy()
      this.rtc = null
    }
    // 注意：不清理 pending —— 新设计下请求与通道无关（协议 §9），
    // RTC 断开时 MQTT 可能仍会把响应送回来；真死掉的请求由各自的 15s 超时兜底
  }

  disconnect() {
    this.wantConnection = false
    clearTimeout(this.watchdogTimer)
    clearTimeout(this.escalateTimer)
    this.escalateTimer = null
    this.teardownRtc()
    this.stopHeartbeat()
    // 彻底断开：让所有等待中的请求立刻失败
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new Error('连接已断开'))
    }
    this.pending.clear()
    if (this.signaling) {
      this.signaling.close()
      this.signaling = null
    }
    this.setStatus('idle')
  }
}
