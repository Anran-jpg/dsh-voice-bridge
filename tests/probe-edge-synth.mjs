/**
 * 璋冭瘯锛氭柊绔偣鎻℃墜閫氳繃涔嬪悗锛屼负浠€涔堜竴鍚堟垚杩炴帴灏辨柇
 * 鎵撳嵃鏈嶅姟绔洖鐨勬瘡涓€甯э紙澶?+ 绫诲瀷锛夛紝浠ュ強 close 鐮? */
import crypto from 'node:crypto'
import tls from 'node:tls'

const TRUSTED = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'
const HOST = 'api.msedgeservices.com'
const PATH = '/tts/cognitiveservices/websocket/v1'
const GEC_VERSION = '1-143.0.3650.75'
const ORIGIN = 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0'
const sha256Upper = (s) => crypto.createHash('sha256').update(s).digest('hex').toUpperCase()

function gec() {
  const winEpoch = 11644473600
  let ticks = Math.floor((Date.now() / 1000 + winEpoch) * 1e7)
  ticks -= ticks % 3e9
  return sha256Upper(String(ticks) + TRUSTED)
}

const requestId = crypto.randomUUID().replace(/-/g, '')
const url =
  `wss://${HOST}${PATH}?Ocp-Apim-Subscription-Key=${TRUSTED}&Sec-MS-GEC=${gec()}&Sec-MS-GEC-Version=${GEC_VERSION}&ConnectionId=${requestId}`

const u = new URL(url)
const sock = tls.connect({ host: u.hostname, port: 443, servername: u.hostname })
let handshaken = false
let buf = Buffer.alloc(0)

function sendFrame(text) {
  const payload = Buffer.from(text, 'utf8')
  const mask = crypto.randomBytes(4)
  let header
  if (payload.length < 126) header = Buffer.from([0x81, 0x80 | payload.length])
  else if (payload.length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 0x80 | 126
    header.writeUInt16BE(payload.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x81
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(payload.length), 2)
  }
  const masked = Buffer.alloc(payload.length)
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4]
  sock.write(Buffer.concat([header, mask, masked]))
}

const ssml =
  "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'>" +
  "<voice name='zh-CN-XiaoxiaoNeural'><prosody rate='+5%' pitch='+0Hz'>绔偣娴嬭瘯</prosody></voice></speak>"

const config = JSON.stringify({
  context: {
    synthesis: {
      audio: {
        metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' },
        outputFormat: process.argv[2] || 'riff-24khz-16bit-mono-pcm',
      },
    },
  },
})

sock.on('error', (e) => console.log('socket error:', e.code, e.message))
sock.on('close', () => console.log('socket closed'))

sock.on('secureConnect', () => {
  sock.write(
    'GET ' + u.pathname + u.search + ' HTTP/1.1\r\n' +
      'Host: ' + u.hostname + '\r\n' +
      'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
      'Sec-WebSocket-Key: ' + crypto.randomBytes(16).toString('base64') + '\r\n' +
      'Sec-WebSocket-Version: 13\r\n' +
      'Origin: ' + ORIGIN + '\r\nUser-Agent: ' + UA + '\r\n\r\n',
  )
})

sock.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk])
  if (!handshaken) {
    const idx = buf.indexOf('\r\n\r\n')
    if (idx < 0) return
    console.log('--- 鎻℃墜鍝嶅簲 ---')
    console.log(buf.subarray(0, idx).toString('latin1'))
    handshaken = true
    buf = buf.subarray(idx + 4)

    sendFrame(
      'X-Timestamp:' + new Date().toUTCString() + '\r\n' +
        'Content-Type:application/json; charset=utf-8\r\n' +
        'Path:speech.config\r\n\r\n' + config,
    )
    sendFrame(
      'X-RequestId:' + requestId + '\r\n' +
        'Content-Type:application/ssml+xml\r\n' +
        'X-Timestamp:' + new Date().toISOString() + 'Z\r\n' +
        'Path:ssml\r\n\r\n' + ssml,
    )
    console.log('--- 宸插彂鍑?speech.config + ssml ---')
  }

  for (;;) {
    if (buf.length < 2) return
    const opcode = buf[0] & 0x0f
    const masked = (buf[1] & 0x80) !== 0
    let len = buf[1] & 0x7f
    let off = 2
    if (len === 126) {
      if (buf.length < 4) return
      len = buf.readUInt16BE(2)
      off = 4
    } else if (len === 127) {
      if (buf.length < 10) return
      len = Number(buf.readBigUInt64BE(2))
      off = 10
    }
    if (buf.length < off + (masked ? 4 : 0) + len) return
    const payload = buf.subarray(off + (masked ? 4 : 0), off + (masked ? 4 : 0) + len)
    buf = buf.subarray(off + (masked ? 4 : 0) + len)

    if (opcode === 0x8) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : -1
      console.log('--- close 甯?--- code=' + code + ' reason=' + payload.subarray(2).toString('utf8'))
      sock.end()
      return
    }
    if (opcode === 0x9) {
      console.log('[ping]')
      continue
    }
    if (opcode === 0x1) {
      const text = payload.toString('utf8')
      const idx = text.indexOf('\r\n\r\n')
      const head = idx >= 0 ? text.slice(0, idx) : text
      console.log('[text ' + payload.length + 'B] ' + head.replace(/\r\n/g, ' | ').slice(0, 300))
    } else if (opcode === 0x2) {
      let headerLen = 0
      let header = ''
      if (payload.length > 2) {
        headerLen = payload.readUInt16BE(0)
        header = payload.subarray(2, 2 + headerLen).toString('utf8')
      }
      console.log('[binary ' + payload.length + 'B] ' + header.replace(/\r\n/g, ' | ').slice(0, 300))
    }
  }
})

setTimeout(() => {
  console.log('--- 25s 鍒帮紝鏀跺伐 ---')
  process.exit(0)
}, 25000)
