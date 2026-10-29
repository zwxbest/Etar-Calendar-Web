// 日程数据的对称加密（AES-256-GCM），协议见 MQTT信令协议.md §9
// 密钥 = SHA-256("etar-sync-data-v1:" + 配对码)，两端各自从配对码派生，不走网络
// 信封 = base64(iv(12B) || ciphertext || tag(16B))，GCM tag 固定 128bit

const te = new TextEncoder()
const td = new TextDecoder()

/** 从配对码派生 AES-256 密钥（WebCrypto，要求安全上下文） */
export async function deriveDataKey(code) {
  const digest = await crypto.subtle.digest('SHA-256', te.encode('etar-sync-data-v1:' + code))
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

/** JSON 对象 → base64(iv||ct||tag)；与安卓 DataCrypto.kt 逐字节互通 */
export async function encryptJson(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(JSON.stringify(obj))))
  const buf = new Uint8Array(iv.length + ct.length)
  buf.set(iv, 0)
  buf.set(ct, iv.length)
  // 分块转字符串，避免大数组 spread 爆栈
  let s = ''
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000))
  return btoa(s)
}

/** base64(iv||ct||tag) → JSON 对象；解密失败（密钥不符/被篡改）抛异常 */
export async function decryptJson(key, b64) {
  const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  if (raw.length < 12 + 16) throw new Error('密文太短')
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.subarray(0, 12) }, key, raw.subarray(12))
  return JSON.parse(td.decode(pt))
}
