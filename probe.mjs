// MQTT broker 连通性探针：连接 WSS → 订阅 → 自发自收 → 报告耗时
const url = process.argv[2]
if (!url) { console.log('usage: node probe.mjs <wss-url>'); process.exit(1) }
const mqtt = (await import('mqtt')).default
const t0 = Date.now()
const topic = 'etar-probe/' + Math.random().toString(16).slice(2, 8)
console.log(`connecting ${url} ...`)
const c = mqtt.connect(url, {
  clientId: 'probe-' + Math.random().toString(16).slice(2, 10),
  clean: true, keepalive: 15, connectTimeout: 8000, reconnectPeriod: 0,
})
c.on('connect', () => {
  console.log(`connected in ${Date.now() - t0} ms`)
  c.subscribe(topic, { qos: 1 }, (err) => {
    if (err) { console.log('subscribe failed:', err.message); process.exit(1) }
    c.publish(topic, 'ping', { qos: 1 })
  })
})
c.on('message', (t, m) => {
  console.log(`roundtrip ok: "${m.toString()}" in ${Date.now() - t0} ms`)
  c.end(true); process.exit(0)
})
c.on('error', (e) => { console.log('error:', e.message || e); process.exit(1) })
setTimeout(() => { console.log('TIMEOUT 12s'); process.exit(2) }, 12000)
