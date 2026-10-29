// 同步客户端：组合信令 + DataChannel，实现日程同步协议
//
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
// 状态机：idle(未配对) → signaling(连接中) → connected(已连通) → 离线自动回 signaling 重试

import { Signaling } from './signal.js'
import { RtcLink } from './rtc.js'
import { loadOrCreatePeerId, DEFAULT_SIGNAL_URL } from './store.js'

const HEARTBEAT_INTERVAL = 25000
const RESPONSE_TIMEOUT = 15000

export class SyncClient {
  constructor() {
    this.signaling = null
    this.rtc = null
    this.status = 'idle'
    // 网页 peerId 持久化：安卓配对后只认这个 id，刷新不能变
    this.myPeerId = loadOrCreatePeerId()
    this.androidPeerId = null
    this.pending = new Map() // id -> {resolve, reject, timer}
    this.reqSeq = 0
    this.heartbeatTimer = null
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
      const rtcDesc = this.rtc
        ? `channel=${this.rtc.channel ? this.rtc.channel.readyState : '未建立'}, pc=${this.rtc.pc ? this.rtc.pc.connectionState : '未建立'}`
        : '未建立'
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
    this.teardownRtc()
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
        console.info(`[sync] 手机在场（${target}），发起 RTC offer`)
        await this.startRtc(target)
      } else if (msg.peers.length > 0) {
        console.warn(`[sync] 房间里的手机 ${android} 与已记住的 ${this.androidPeerId} 不一致，忽略（换过手机需清除配对）`)
      }
    } else if (msg.type === 'peer-joined') {
      if (msg.peerId.startsWith('android-') && (!this.androidPeerId || this.androidPeerId === msg.peerId)) {
        console.info(`[sync] 手机加入（${msg.peerId}），发起 RTC offer`)
        await this.startRtc(msg.peerId)
      }
    } else if (msg.type === 'signal') {
      if (this.androidPeerId && msg.from !== this.androidPeerId) return
      if (!this.rtc) await this.startRtc(msg.from, true)
      await this.rtc.acceptSignal(msg.from, msg.data)
    } else if (msg.type === 'peer-left') {
      // 一对一：陌生人发的 leave 不影响已配对的连接（协议 §6）
      if (this.androidPeerId && msg.peerId && msg.peerId !== this.androidPeerId) return
      console.warn(`[sync] 手机已离线（${msg.peerId}）`)
      this.teardownRtc()
      this.setStatus(this.wantConnection ? 'connecting' : 'idle')
    } else if (msg.type === 'error') {
      this.emit('message', msg.message)
    }
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
      onData: (text) => this.onData(text),
      onOpen: () => {
        this.setStatus('connected')
        this.startHeartbeat()
        this.emit('rtc-open')
      },
      onClose: () => {
        this.stopHeartbeat()
        this.teardownRtc()
        if (this.wantConnection) this.setStatus('connecting')
      },
    })
    this.rtc = rtc
    if (!passive) {
      // 网页永远是 offerer
      await rtc.start(remotePeerId)
    }
  }

  onData(text) {
    let msg
    try {
      msg = JSON.parse(text)
    } catch (e) {
      return
    }
    if (msg.type === 'pong') return
    console.info(`[sync] DataChannel 收到 ${msg.type}${msg.day ? `(${msg.day})` : ''}`)
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

  /** 发送请求并等待响应 */
  request(obj, expectType) {
    return new Promise((resolve, reject) => {
      if (!this.rtc || !this.rtc.channel || this.rtc.channel.readyState !== 'open') {
        reject(new Error('未连接到手机'))
        return
      }
      const id = String(++this.reqSeq)
      obj.id = id
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('等待手机响应超时'))
      }, RESPONSE_TIMEOUT)
      this.pending.set(id, { resolve, reject, timer })
      this.rtc.send(obj)
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

  startHeartbeat() {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      this.rtc && this.rtc.send({ type: 'ping' })
    }, HEARTBEAT_INTERVAL)
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  teardownRtc() {
    this.stopHeartbeat()
    if (this.rtc) {
      this.rtc.destroy()
      this.rtc = null
    }
    // 超时未响应的请求直接失败
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new Error('连接已断开'))
    }
    this.pending.clear()
  }

  disconnect() {
    this.wantConnection = false
    clearTimeout(this.watchdogTimer)
    this.teardownRtc()
    if (this.signaling) {
      this.signaling.close()
      this.signaling = null
    }
    this.setStatus('idle')
  }
}
