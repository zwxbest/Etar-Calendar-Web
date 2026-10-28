// 模拟网页端与安卓 App 做 MQTT 信令互通实测
// 用法: node signaling-test.mjs <pairCode>
const code = process.argv[2] || '437118'

// 与 SignalingClient.kt roomToken() 相同的派生算法
import { createHash } from 'crypto'
const token = createHash('sha256').update(`etar-sync-v1:${code}`).digest('hex').slice(0, 16)
const pub = `etar/cal/${token}/web`     // 网页发布（安卓订阅）
const sub = `etar/cal/${token}/android` // 网页订阅（安卓发布）
console.log(`room token=${token}\n  android topic: ${sub}\n  web topic:     ${pub}`)

const mqtt = (await import('mqtt')).default
const client = mqtt.connect('wss://broker.emqx.io:8084/mqtt', {
  clientId: 'etar-w-test-' + Math.random().toString(16).slice(2, 10),
  clean: true,
  keepalive: 30,
  // 模拟网页异常崩溃：注册 LWT，验证安卓能收到 peer-left
  will: { topic: pub, payload: JSON.stringify({ v: 1, type: 'peer-left', peerId: 'web-test123' }), qos: 1 },
})

const myId = 'web-test123'
const send = (obj) => client.publish(pub, JSON.stringify(obj))

client.on('connect', () => {
  console.log('[web] mqtt connected, subscribing…')
  client.subscribe(sub, { qos: 1 }, (err) => {
    if (err) return console.error('[web] subscribe failed:', err.message)
    console.log('[web] subscribed, >>> join')
    send({ v: 1, type: 'join', peerId: myId })
  })
})

client.on('message', (topic, payload) => {
  const msg = JSON.parse(payload.toString())
  console.log(`[web] <<< ${topic}:`, JSON.stringify(msg))
  if (msg.type === 'join' || msg.type === 'here') {
    // 收到安卓在场宣告，按协议网页是 offerer —— 发一个测试 offer 验证 signal 通路
    console.log('[web] >>> signal(offer, fake-sdp)')
    send({ v: 1, type: 'signal', from: myId, data: { kind: 'offer', sdp: 'v=0\r\nfake-test-offer' } })
    setTimeout(() => {
      console.log('[web] signal path verified, exiting. (下次运行不带 crash 参数可测 leave)')
      process.exit(0)
    }, 2000)
  }
})

client.on('error', (e) => console.error('[web] error:', e.message))
setTimeout(() => { console.error('[web] TIMEOUT: 20s 未完成握手'); process.exit(1) }, 20000)
