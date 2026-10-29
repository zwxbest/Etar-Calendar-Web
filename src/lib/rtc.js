// WebRTC DataChannel 封装：网页永远是 offerer，安卓是 answerer
//
// ICE 候选尝试顺序由协议栈按候选类型自动排序（RFC 8445 type preference）：
//   1. host      本机内网/公网 IPv6 直连候选，同 WiFi 或有公网 v6 时最快
//   2. srflx     STUN 探测出的公网映射，UDP 打洞（需双方都是锥型 NAT）
//   3. relay     TURN 中继兜底（UDP 80 → TCP 443 → TLS 443 依次放宽防火墙）
// 所以只需把三类服务器都配上，顺序无需自己控制；
// 走到 relay 不再是 P2P，但流量仍经 DTLS 端到端加密，中继方看不到内容。

/** TURN 中继账号（Open Relay 公共免费服务，20GB/月；可换成自建 coturn 的地址和凭据） */
const TURN_USER = 'openrelayproject'
const TURN_PASS = 'openrelayproject'

export const ICE_SERVERS = [
  // srflx：STUN 只用来发现公网映射，不中转数据
  {
    urls: [
      'stun:stun.miwifi.com:3478',
      'stun:stun.chat.bilibili.com:3478',
      'stun:stun.cloudflare.com:3478',
      'stun:stun.l.google.com:19302',
    ],
  },
  // relay：TURN 兜底，UDP 打不通时走 TCP/TLS 443（企业防火墙一般只放 443）
  { urls: 'turn:openrelay.metered.ca:80', username: TURN_USER, credential: TURN_PASS },
  { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: TURN_USER, credential: TURN_PASS },
  { urls: 'turns:openrelay.metered.ca:443?transport=tcp', username: TURN_USER, credential: TURN_PASS },
]

/**
 * 归一化远端 ICE candidate：
 * 浏览器序列化字段名是 candidate，旧版安卓端发的是 sdp，
 * 直接 new RTCIceCandidate(sdp 格式) 会得到空 candidate（等于没传），
 * 这里统一转成 RTCIceCandidateInit，两端任一格式都能通
 */
function normalizeCandidate(raw) {
  if (!raw || typeof raw !== 'object') return null
  const sdp = raw.candidate || raw.sdp
  if (!sdp) return null
  return {
    candidate: sdp,
    sdpMid: raw.sdpMid ?? null,
    sdpMLineIndex: raw.sdpMLineIndex ?? null,
  }
}

export class RtcLink {
  /**
   * @param {object} c
   * @param {(to: string, data: object) => void} c.onSignal  通过信令发送 offer/answer/ice
   * @param {(text: string) => void} c.onData               收到 DataChannel 消息（JSON 字符串）
   * @param {() => void} c.onOpen                           DataChannel 打开
   * @param {() => void} c.onClose                          连接断开
   */
  constructor({ onSignal, onData, onOpen, onClose }) {
    this.onSignal = onSignal
    this.onData = onData
    this.onOpen = onOpen
    this.onClose = onClose
    this.pc = null
    this.channel = null
    this.remotePeerId = null
    this.pendingCandidates = []
    this.closed = false
  }

  createPeer() {
    if (this.pc) return this.pc
    const pc = new RTCPeerConnection({
      iceServers: ICE_SERVERS,
    })
    this.pc = pc
    pc.onicecandidate = (ev) => {
      if (ev.candidate && this.remotePeerId) {
        this.onSignal(this.remotePeerId, { kind: 'ice', candidate: ev.candidate })
      }
    }
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState
      if (s === 'failed' || s === 'closed') this.handleClose()
    }
    pc.ondatachannel = (ev) => this.bindChannel(ev.channel)
    return pc
  }

  bindChannel(channel) {
    this.channel = channel
    channel.onopen = () => {
      if (!this.closed) this.onOpen()
    }
    channel.onclose = () => this.handleClose()
    channel.onerror = () => this.handleClose()
    channel.onmessage = (ev) => this.onData(ev.data)
    // 已经 open 的情况（极少见）
    if (channel.readyState === 'open') this.onOpen()
  }

  /** 网页端主动发起连接：创建 DataChannel + offer */
  async start(remotePeerId) {
    this.remotePeerId = remotePeerId
    this.closed = false
    const pc = this.createPeer()
    this.bindChannel(pc.createDataChannel('sync'))
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    // 必须发 sdp 字符串：直接发 pc.localDescription 会被 JSON.stringify
    // 序列化成 {type,sdp} 对象，安卓端 optString("sdp") 拿到整个对象的
    // JSON 文本，setRemoteDescription 直接失败，永远不会有 answer 回来
    this.onSignal(remotePeerId, { kind: 'offer', sdp: pc.localDescription.sdp })
  }

  /** 处理来自对端的信令消息 */
  async acceptSignal(from, data) {
    this.remotePeerId = from
    const pc = this.createPeer()
    if (data.kind === 'offer') {
      await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: data.sdp }))
      await this.flushCandidates()
      const answer = await pc.createAnswer()
      await pc.setLocalDescription(answer)
      // 同 start()：只发 sdp 字符串，发整个 SessionDescription 对象
      // 会被序列化成 {type,sdp}，对端 optString("sdp") 拿到的是 JSON 文本
      this.onSignal(from, { kind: 'answer', sdp: pc.localDescription.sdp })
    } else if (data.kind === 'answer') {
      await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: data.sdp }))
      await this.flushCandidates()
    } else if (data.kind === 'ice' && data.candidate) {
      const init = normalizeCandidate(data.candidate)
      if (init) {
        if (pc.remoteDescription) {
          try { await pc.addIceCandidate(new RTCIceCandidate(init)) } catch (e) { /* ignore */ }
        } else {
          this.pendingCandidates.push(init)
        }
      }
    }
  }

  async flushCandidates() {
    const pc = this.pc
    for (const c of this.pendingCandidates) {
      try { await pc.addIceCandidate(new RTCIceCandidate(c)) } catch (e) { /* ignore */ }
    }
    this.pendingCandidates = []
  }

  send(obj) {
    if (this.channel && this.channel.readyState === 'open') {
      this.channel.send(JSON.stringify(obj))
      return true
    }
    return false
  }

  handleClose() {
    if (this.closed) return
    this.closed = true
    this.onClose()
    this.destroy()
  }

  destroy() {
    if (this.channel) {
      try { this.channel.close() } catch (e) { /* ignore */ }
      this.channel = null
    }
    if (this.pc) {
      try { this.pc.close() } catch (e) { /* ignore */ }
      this.pc = null
    }
    this.pendingCandidates = []
  }
}
