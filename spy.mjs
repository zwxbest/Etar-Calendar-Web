// 旁观者：订阅房间的全部流量（etar/cal/<T>/#），只打印不发送
// 用法: node spy.mjs <pairCode>
import { createHash } from 'crypto'
const code = process.argv[2] || '548443'
const token = createHash('sha256').update(`etar-sync-v1:${code}`).digest('hex').slice(0, 16)
console.log(`room token=${token}, spying on etar/cal/${token}/#`)

const mqtt = (await import('mqtt')).default
const client = mqtt.connect('wss://broker.emqx.io:8084/mqtt', {
  clientId: 'etar-spy-' + Math.random().toString(16).slice(2, 10),
  clean: true,
  keepalive: 30,
})

client.on('connect', () => {
  console.log('[spy] connected, subscribing etar/cal/' + token + '/#')
  client.subscribe(`etar/cal/${token}/#`, { qos: 1 }, (err) => {
    if (err) return console.error('[spy] subscribe failed:', err.message)
    console.log('[spy] subscribed, watching…')
  })
})

client.on('message', (topic, payload) => {
  const t = Date.now()
  let msg
  try { msg = JSON.parse(payload.toString()) } catch { msg = payload.toString() }
  // signal 消息只打 kind，SDP/ICE 太长
  if (msg && msg.type === 'signal' && msg.data) {
    const brief = { ...msg, data: { kind: msg.data.kind, sdpLen: msg.data.sdp?.length, cand: msg.data.candidate?.candidate?.slice(0, 40) } }
    console.log(`[${new Date(t).toLocaleTimeString()}] ${topic.split('/').pop()}:`, JSON.stringify(brief))
  } else {
    console.log(`[${new Date(t).toLocaleTimeString()}] ${topic.split('/').pop()}:`, JSON.stringify(msg))
  }
})

client.on('error', (e) => console.error('[spy] error:', e.message))
setTimeout(() => { console.log('[spy] 60s done'); process.exit(0) }, 60000)
