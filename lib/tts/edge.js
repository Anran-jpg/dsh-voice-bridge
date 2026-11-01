/**
 * edge-tts provider（微软 Edge 朗读服务，免费、不用 key）
 *
 * 音色多、质量好，但要联网。产出 mp3（新端点不再支持 riff/wav），播放交给 tts-server 的 /play。
 * 不引第三方依赖：需要 WebSocket，就自己用 tls 实现一个够用的最小客户端。
 */
import crypto from 'node:crypto'
import tls from 'node:tls'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const id = 'edge'
export const label = 'edge-tts（免费·联网）'
export const produces = 'mp3'

/**
 * 2026-10 微软把「朗读」的**合成** WebSocket 从 v1 迁到了 v2：
 *   旧 speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1（现在 403）
 *   新 api.msedgeservices.com/tts/cognitiveservices/websocket/v1
 * 令牌值没变，但参数名从 TrustedClientToken 换成了 Ocp-Apim-Subscription-Key。
 * 新版端点在 Sec-MS-GEC-Version 写 2-xxx 时要求新版令牌格式（16位-64位），
 * 而旧版 1-xxx 仍接受老的 64 位令牌 —— 所以这里继续用 1-143 这一档。
 * 语音列表接口没迁移，仍留在旧主机上。
 */
const TRUSTED = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'
const HOST = 'api.msedgeservices.com'
const PATH = '/tts/cognitiveservices/websocket/v1'
const GEC_VERSION = '1-143.0.3650.75'
const ORIGIN = 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0'
const OUTPUT_FORMAT = 'audio-24khz-96kbitrate-mono-mp3'

export const VOICES = [
  { id: 'zh-CN-XiaoxiaoNeural', label: '晓晓 · 温柔女声', lang: 'zh-CN', sex: '女' },
  { id: 'zh-CN-XiaoyiNeural', label: '晓伊 · 活泼女声', lang: 'zh-CN', sex: '女' },
  { id: 'zh-CN-YunxiNeural', label: '云希 · 阳光男声', lang: 'zh-CN', sex: '男' },
  { id: 'zh-CN-YunjianNeural', label: '云健 · 浑厚男声', lang: 'zh-CN', sex: '男' },
  { id: 'zh-CN-YunxiaNeural', label: '云夏 · 少年音', lang: 'zh-CN', sex: '男' },
  { id: 'zh-CN-YunyangNeural', label: '云扬 · 新闻男声', lang: 'zh-CN', sex: '男' },
  { id: 'zh-CN-liaoning-XiaobeiNeural', label: '晓北 · 东北女声', lang: 'zh-CN', sex: '女' },
  { id: 'zh-CN-shaanxi-XiaoniNeural', label: '晓妮 · 陕西女声', lang: 'zh-CN', sex: '女' },
  { id: 'zh-HK-HiuGaaiNeural', label: '曉佳 · 粤语女声', lang: 'zh-HK', sex: '女' },
  { id: 'zh-TW-HsiaoChenNeural', label: '曉臻 · 台湾女声', lang: 'zh-TW', sex: '女' },
  { id: 'zh-TW-HsiaoYuNeural', label: '曉雨 · 台湾女声', lang: 'zh-TW', sex: '女' },
  { id: 'ja-JP-NanamiNeural', label: '七海 · 日语女声', lang: 'ja-JP', sex: '女' },
  { id: 'en-US-AriaNeural', label: 'Aria · 英语女声', lang: 'en-US', sex: '女' },
  { id: 'en-US-GuyNeural', label: 'Guy · 英语男声', lang: 'en-US', sex: '男' },
]

export function listVoices() {
  return VOICES
}

const sha256Upper = (s) => crypto.createHash('sha256').update(s).digest('hex').toUpperCase()

/** 微软 2024 年起要求的 DRM 参数：按 5 分钟取整的时间戳 + 受信 token 做 SHA256 */
function secMsGec() {
  const winEpoch = 11644473600
  let ticks = Math.floor((Date.now() / 1000 + winEpoch) * 1e7)
  ticks -= ticks % 3e9
  return sha256Upper(String(ticks) + TRUSTED)
}

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function buildUrl(connId) {
  return (
    'wss://' + HOST + PATH +
    '?Ocp-Apim-Subscription-Key=' + TRUSTED +
    '&Sec-MS-GEC=' + secMsGec() +
    '&Sec-MS-GEC-Version=' + GEC_VERSION +
    '&ConnectionId=' + connId
  )
}

/** 够用的 WebSocket 客户端：text/binary 帧收发，ping→pong，close 清理 */
function wsConnect(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const sock = tls.connect({ host: u.hostname, port: 443, servername: u.hostname })
    const pool = Buffer.alloc(0)
    const onMessage = []
    const onClose = []
    let handshaken = false
    let buf = pool

    const ws = {
      send(text) {
        const payload = Buffer.from(text, 'utf8')
        const mask = crypto.randomBytes(4)
        let header
        if (payload.length < 126) {
          header = Buffer.from([0x81, 0x80 | payload.length])
        } else if (payload.length < 65536) {
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
      },
      on(ev, fn) {
        if (ev === 'message') onMessage.push(fn)
        else if (ev === 'close') onClose.push(fn)
      },
      close() {
        try {
          sock.end()
        } catch (e) {}
      },
    }

    sock.on('error', (e) => (handshaken ? onClose.forEach((f) => f(e)) : reject(e)))
    sock.on('close', () => onClose.forEach((f) => f()))

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
        const head = buf.subarray(0, idx).toString('latin1')
        if (!/^HTTP\/1\.1 101/.test(head)) return reject(new Error('WebSocket 握手失败：' + head.split('\r\n')[0]))
        handshaken = true
        buf = buf.subarray(idx + 4)
        resolve(ws)
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
        let payload = buf.subarray(off + (masked ? 4 : 0), off + (masked ? 4 : 0) + len)
        buf = buf.subarray(off + (masked ? 4 : 0) + len)
        if (opcode === 0x8) {
          const code = payload.length >= 2 ? payload.readUInt16BE(0) : 0
          const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : ''
          const err = new Error('服务端关闭连接 ' + code + (reason ? '：' + reason : ''))
          err.closeCode = code
          err.closeReason = reason
          onClose.forEach((f) => f(err))
          return
        }
        if (opcode === 0x9) continue // ping 忽略
        const copy = Buffer.from(payload)
        onMessage.forEach((f) => f(copy))
      }
    })
  })
}

let probeCache = { at: 0, result: null }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 新端点比旧端点脆：约 1/10 的连接会在 TLS 握手阶段被掐断（ECONNRESET），
 * 密集调用还会 429。这两种都值得等一会儿再试，放弃就白搭。
 */
async function connectRetry(url, attempts = 3) {
  let last
  for (let i = 0; i < attempts; i++) {
    try {
      return await wsConnect(url)
    } catch (e) {
      last = e
      const msg = String((e && (e.code || e.message)) || e)
      const retryable = /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|socket hang up|429/.test(msg)
      if (!retryable || i === attempts - 1) throw e
      await sleep(2000 * 2 ** i)
    }
  }
  throw last
}

/** 真连一次（握手成功即算可用）；结果缓存 10 分钟，免得每次状态查询都握手 */
export async function available() {
  if (probeCache.result && Date.now() - probeCache.at < 10 * 60 * 1000) return probeCache.result
  let result
  try {
    const ws = await connectRetry(buildUrl(crypto.randomUUID().replace(/-/g, '')))
    ws.close()
    result = { ok: true, voices: VOICES }
  } catch (e) {
    const msg = String((e && e.message) || e)
    result = {
      ok: false,
      reason: /403/.test(msg) ? '微软拒连（403）。这台网络下用不了，换个网络/代理再试' : msg,
      voices: VOICES,
    }
  }
  probeCache = { at: Date.now(), result }
  return result
}

/**
 * 合成的整体重试：新端点偶尔在发完 SSML 后直接把连接掐掉（没有 close 码、
 * 也没回音频），这种一次性的抖动重开一条就能过；连续两次都不行才报错。
 */
export async function synth(text, opts = {}) {
  try {
    return await synthOnce(text, opts)
  } catch (e) {
    const msg = String((e && e.message) || e)
    if (!/连接被关闭|没返回音频|超时|429/.test(msg)) throw e
    await sleep(900)
    return await synthOnce(text, opts)
  }
}

async function synthOnce(text, opts = {}) {
  const voice = opts.voice || 'zh-CN-XiaoxiaoNeural'
  const out = opts.outFile || path.join(os.tmpdir(), 'vb-edge-' + Date.now() + '.mp3')
  const speed = Number(opts.speed) || 1
  const rate = Math.round((speed - 1) * 100)
  const rateStr = (rate >= 0 ? '+' : '') + rate + '%'
  const requestId = crypto.randomUUID().replace(/-/g, '')

  const ws = await connectRetry(buildUrl(requestId))
  const chunks = []

  const finished = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('edge-tts 超时（20 秒没出结果）')), 20000)
    ws.on('message', (buf) => {
      if (buf.length <= 2) return
      const headerLen = buf.readUInt16BE(0)
      const header = buf.subarray(2, 2 + headerLen).toString('utf8')
      if (header.includes('Path:audio')) chunks.push(buf.subarray(2 + headerLen))
      else if (header.includes('Path:turn.end')) {
        clearTimeout(timer)
        resolve()
      }
    })
    ws.on('close', (e) => {
      clearTimeout(timer)
      reject(e && e.message ? e : new Error('edge-tts 连接被关闭'))
    })
  })

  ws.send(
    'X-Timestamp:' + new Date().toUTCString() + '\r\n' +
      'Content-Type:application/json; charset=utf-8\r\n' +
      'Path:speech.config\r\n\r\n' +
      JSON.stringify({
        context: {
          synthesis: {
            audio: {
              metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' },
              outputFormat: OUTPUT_FORMAT,
            },
          },
        },
      }),
  )

  ws.send(
    'X-RequestId:' + requestId + '\r\n' +
      'Content-Type:application/ssml+xml\r\n' +
      'X-Timestamp:' + new Date().toISOString() + 'Z\r\n' +
      'Path:ssml\r\n\r\n' +
      "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'>" +
      "<voice name='" + esc(voice) + "'><prosody rate='" + rateStr + "' pitch='+0Hz'>" + esc(text) + '</prosody></voice></speak>',
  )

  await finished
  try {
    ws.close()
  } catch (e) {}
  if (!chunks.length) throw new Error('edge-tts 没返回音频（可能被限流）')
  const audio = Buffer.concat(chunks)
  fs.writeFileSync(out, audio)
  // 96 kbps CBR：按字节数折成功率秒数，气泡就按这个长度挂
  const audioSec = Math.round(((audio.length * 8) / 96000) * 100) / 100
  return { file: out, mime: 'audio/mpeg', audioSec }
}
