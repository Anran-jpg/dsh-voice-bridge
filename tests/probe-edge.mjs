/**
 * 探测：微软 Edge 朗读合成端点到底哪条能握手
 *
 * 背景（2026-10 微软把合成接口从 v1 迁到 v2，旧端点开始 403）：
 *   旧 wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=...
 *   新 wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1?Ocp-Apim-Subscription-Key=...
 *
 * 用法：node tests/probe-edge.mjs
 */
import crypto from 'node:crypto'
import tls from 'node:tls'

const TRUSTED = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'
const ORIGIN = 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0'

const sha256Upper = (s) => crypto.createHash('sha256').update(s).digest('hex').toUpperCase()

/** 老的 64 位十六进制令牌（edge-tts 7.2.x 及本插件现在用的算法） */
function gecV1() {
  const winEpoch = 11644473600
  let ticks = Math.floor((Date.now() / 1000 + winEpoch) * 1e7)
  ticks -= ticks % 3e9
  return sha256Upper(String(ticks) + TRUSTED)
}

/** 握手一次，只回报 HTTP 状态行；101 就是通了 */
function handshake(label, url, extraHeaders = {}) {
  return new Promise((resolve) => {
    const u = new URL(url)
    const sock = tls.connect({ host: u.hostname, port: 443, servername: u.hostname })
    let done = false
    const finish = (v) => {
      if (done) return
      done = true
      try {
        sock.destroy()
      } catch (e) {}
      resolve(v)
    }
    const timer = setTimeout(() => finish(`${label}: 超时`), 15000)
    sock.on('error', (e) => {
      clearTimeout(timer)
      finish(`${label}: 连接错误 ${e.code || e.message}`)
    })
    sock.on('secureConnect', () => {
      const headers = {
        Host: u.hostname,
        Upgrade: 'websocket',
        Connection: 'Upgrade',
        'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
        'Sec-WebSocket-Version': '13',
        Origin: ORIGIN,
        'User-Agent': UA,
        ...extraHeaders,
      }
      const head = Object.entries(headers)
        .map(([k, v]) => k + ': ' + v)
        .join('\r\n')
      sock.write('GET ' + u.pathname + u.search + ' HTTP/1.1\r\n' + head + '\r\n\r\n')
    })
    sock.on('data', (chunk) => {
      const text = chunk.toString('latin1')
      const line = text.split('\r\n')[0]
      clearTimeout(timer)
      finish(`${label}: ${line}`)
    })
  })
}

const newBase = 'wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1'
const oldBase = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1'

const cases = [
  ['A 新端点/旧令牌+旧GEC+Version1-130', `${newBase}?Ocp-Apim-Subscription-Key=${TRUSTED}&Sec-MS-GEC=${gecV1()}&Sec-MS-GEC-Version=1-130.0.2849.68`],
  ['B 新端点/旧令牌+旧GEC+Version1-143', `${newBase}?Ocp-Apim-Subscription-Key=${TRUSTED}&Sec-MS-GEC=${gecV1()}&Sec-MS-GEC-Version=1-143.0.3650.75`],
  ['C 新端点/旧令牌+旧GEC+Version2-155', `${newBase}?Ocp-Apim-Subscription-Key=${TRUSTED}&Sec-MS-GEC=${gecV1()}&Sec-MS-GEC-Version=2-155.0.4283.45`],
  ['D 新端点/只要令牌', `${newBase}?Ocp-Apim-Subscription-Key=${TRUSTED}`],
  ['E 旧端点/旧姿势（对照，预期 403）', `${oldBase}?TrustedClientToken=${TRUSTED}&Sec-MS-GEC=${gecV1()}&Sec-MS-GEC-Version=1-130.0.2849.68`],
]

for (const [label, url] of cases) {
  console.log(await handshake(label, url))
}
