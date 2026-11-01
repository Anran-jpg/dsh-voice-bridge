/**
 * 实测 edge 合成：改端点之后到底出不出音频
 * 用法：node tests/edge-synth-check.mjs
 */
import fs from 'node:fs'
import * as edge from '../lib/tts/edge.js'

const tag = '改端点后实测'

const av = await edge.available()
console.log('available =', JSON.stringify(av.ok ? { ok: true } : av, null, 0))

if (!av.ok) process.exit(1)

const t0 = Date.now()
const out = await edge.synth(tag, { voice: process.argv[2] || 'zh-CN-XiaoxiaoNeural', speed: Number(process.argv[3] || 1.05) })
const size = fs.statSync(out.file).size
const head = fs.readFileSync(out.file).subarray(0, 12)
const riff = head.subarray(0, 4).toString() + '/' + head.subarray(8, 12).toString()
const sec = out.audioSec
console.log(`ok file=${out.file} bytes=${size} 头部=${riff} 约${sec.toFixed(2)}s 用时${((Date.now() - t0) / 1000).toFixed(2)}s`)
