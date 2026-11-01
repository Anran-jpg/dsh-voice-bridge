// 实验：edge-tts 握手 403，逐个变量试
import crypto from 'node:crypto'
import tls from 'node:tls'

const TRUSTED = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'
const HOST = 'speech.platform.bing.com'
const PATH = '/consumer/speech/synthesize/readaloud/edge/v1'
const ORIGIN = 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold'
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').toUpperCase()

function secMsGec() {
  let ticks = Math.floor((Date.now() / 1000 + 11644473600) * 1e7)
  ticks -= ticks % 3e9
  return sha(String(ticks) + TRUSTED)
}

function tryHandshake(name, url, headers) {
  return new Promise((resolve) => {
    const u = new URL(url)
    const sock = tls.connect({ host: u.hostname, port: 443, servername: u.hostname })
    let buf = Buffer.alloc(0)
    const done = (msg) => {
      try { sock.destroy() } catch (e) {}
      resolve(name + ': ' + msg)
    }
    const timer = setTimeout(() => done('超时'), 8000)
    sock.on('error', (e) => { clearTimeout(timer); done('错误 ' + e.message) })
    sock.on('secureConnect', () => {
      sock.write(
        'GET ' + u.pathname + u.search + ' HTTP/1.1\r\n' +
          Object.entries(headers).map(([k, v]) => k + ': ' + v + '\r\n').join('') +
          '\r\n',
      )
    })
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      const idx = buf.indexOf('\r\n\r\n')
      if (idx < 0) return
      clearTimeout(timer)
      done(buf.subarray(0, idx).toString('latin1').split('\r\n').slice(0, 3).join(' | '))
    })
  })
}

const baseHeaders = (ua) => ({
  Host: HOST,
  Upgrade: 'websocket',
  Connection: 'Upgrade',
  'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
  'Sec-WebSocket-Version': '13',
  Origin: ORIGIN,
  'User-Agent': ua,
  Pragma: 'no-cache',
  'Cache-Control': 'no-cache',
})

const UA_EDGE = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0'
const UA_OLD = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0'

const variants = [
  ['A 全参数+UUID ' + UA_EDGE.slice(-20), `wss://${HOST}${PATH}?TrustedClientToken=${TRUSTED}&Sec-MS-GEC=${secMsGec()}&Sec-MS-GEC-Version=1-130.0.2849.68&ConnectionId=${crypto.randomUUID()}`, baseHeaders(UA_EDGE)],
  ['B 无 ConnectionId', `wss://${HOST}${PATH}?TrustedClientToken=${TRUSTED}&Sec-MS-GEC=${secMsGec()}&Sec-MS-GEC-Version=1-130.0.2849.68`, baseHeaders(UA_EDGE)],
  ['C 无 GEC 参数', `wss://${HOST}${PATH}?TrustedClientToken=${TRUSTED}&ConnectionId=${crypto.randomUUID()}`, baseHeaders(UA_EDGE)],
  ['D 旧 UA', `wss://${HOST}${PATH}?TrustedClientToken=${TRUSTED}&Sec-MS-GEC=${secMsGec()}&Sec-MS-GEC-Version=1-130.0.2849.68&ConnectionId=${crypto.randomUUID()}`, baseHeaders(UA_OLD)],
  ['E 去掉 Origin', `wss://${HOST}${PATH}?TrustedClientToken=${TRUSTED}&Sec-MS-GEC=${secMsGec()}&Sec-MS-GEC-Version=1-130.0.2849.68&ConnectionId=${crypto.randomUUID()}`, (() => { const h = baseHeaders(UA_EDGE); delete h.Origin; return h })()],
  ['F 无版本号参数', `wss://${HOST}${PATH}?TrustedClientToken=${TRUSTED}&Sec-MS-GEC=${secMsGec()}&ConnectionId=${crypto.randomUUID()}`, baseHeaders(UA_EDGE)],
]

for (const [name, url, headers] of variants) console.log(await tryHandshake(name, url, headers))
