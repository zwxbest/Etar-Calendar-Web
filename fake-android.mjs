// 假安卓端：连指定 broker，扮演手机应答 join/here 与 fetch_day/ping（验证网页双 broker 的任意一条链路）
// 用法: node fake-android.mjs <pairCode> <wssUrl>
import { createHash } from 'crypto'
import { deriveDataKey, encryptJson, decryptJson } from './src/lib/crypto.js'

const code = process.argv[2] || '734521'
const BROKER = process.argv[3] || 'wss://broker.emqx.io:8084/mqtt'
const token = createHash('sha256').update(`etar-sync-v1:${code}`).digest('hex').slice(0, 16)
const pub = `etar/cal/${token}/android`
const sub = `etar/cal/${token}/web`
const myId = 'android-fake01'
const key = await deriveDataKey(code)
console.log(`[fake] broker=${BROKER} room=${token}`)

const mqtt = (await import('mqtt')).default
const c = mqtt.connect(BROKER, {
  clientId: 'fake-android-' + Math.random().toString(16).slice(2, 8),
  clean: true, keepalive: 15, connectTimeout: 8000, reconnectPeriod: 0,
})
const publish = (o) => c.publish(pub, JSON.stringify(o), { qos: 1 })

c.on('connect', () => {
  c.subscribe(sub, { qos: 1 }, () => {
    publish({ v: 1, type: 'join', peerId: myId })
    console.log('[fake] connected + join sent')
  })
})
c.on('message', async (t, payload) => {
  const msg = JSON.parse(payload.toString())
  const from = msg.peerId || msg.from || ''
  if (!from.startsWith('web-')) return
  if (msg.type === 'join') {
    publish({ v: 1, type: 'here', peerId: myId })
    console.log('[fake] <<< join  ->  here')
  }
  if (msg.type === 'data') {
    try {
      const plain = await decryptJson(key, msg.d)
      console.log(`[fake] <<< data: ${plain.type} id=${plain.id}`)
      let reply = null
      if (plain.type === 'fetch_day') reply = { type: 'day', day: plain.day, events: [], id: plain.id }
      else if (plain.type === 'ping') reply = { type: 'pong', id: plain.id }
      else if (plain.type === 'add' || plain.type === 'update' || plain.type === 'delete')
        reply = { type: 'result', action: plain.type, ok: true, id: plain.id }
      if (reply) {
        const d = await encryptJson(key, reply)
        publish({ v: 1, type: 'data', from: myId, ts: Date.now(), d })
        console.log(`[fake] >>> reply ${reply.type}`)
      }
    } catch (e) {
      console.log('[fake] decrypt failed:', e.message)
    }
  }
})
c.on('error', (e) => console.log('[fake] error:', e.message))
setTimeout(() => { console.log('[fake] 120s window done'); process.exit(0) }, 120000)
