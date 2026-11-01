// 手动跑一遍各 provider，验证能不能出音频
// 用法: node test-providers.mjs [sapi|edge|openai|all]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const outDir = path.join(here, 'out')
fs.mkdirSync(outDir, { recursive: true })

const which = process.argv[2] || 'all'

function wavSeconds(file) {
  const buf = fs.readFileSync(file)
  if (buf.toString('latin1', 0, 4) !== 'RIFF') return 0
  const byteRate = buf.readUInt32LE(28)
  return byteRate ? Math.round(((buf.length - 44) / byteRate) * 100) / 100 : 0
}

async function run(name, mod, text, opts) {
  const t0 = Date.now()
  try {
    const out = await mod.synth(text, { ...opts, outFile: path.join(outDir, name + '-' + Date.now() + '.wav') })
    const size = fs.statSync(out.file).size
    console.log(`✓ ${name}: ${out.file}  ${(size / 1024).toFixed(1)}KB  ${wavSeconds(out.file)}s  ${(Date.now() - t0)}ms`)
  } catch (e) {
    console.log(`✗ ${name}: ${(e && e.message) || e}`)
  }
}

const sapi = await import('./sapi.js')
const edge = await import('./edge.js')

if (which === 'sapi' || which === 'all') {
  console.log('sapi voices:', JSON.stringify(await sapi.listVoices()))
  console.log('sapi available:', JSON.stringify(await sapi.available()))
  await run('sapi', sapi, '哦鲸鲸，系统语音也能说话的。')
}

if (which === 'edge' || which === 'all') {
  console.log('edge available:', JSON.stringify(await edge.available()))
  await run('edge', edge, '哦鲸鲸，这是 edge 的声音，先养着吧。', { voice: 'zh-CN-XiaoxiaoNeural' })
}
