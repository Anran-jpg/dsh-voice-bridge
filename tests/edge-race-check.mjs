// 复现插件里的真实节奏：先探测（available），紧接着合成长句，中间不喘气。
// 用来抓「edge-tts 连接被关闭」到底是 429 还是 1007。
import * as edge from '../lib/tts/edge.js'

const LONG =
  '很多时候真正让人不安的不是看不清，而是事情就在眼前却觉得无论做什么都没用。'

const tries = Number(process.argv[2] || 3)

for (let i = 1; i <= tries; i++) {
  const t0 = Date.now()
  let probe = 'skip'
  if (i % 2 === 1) {
    try {
      const a = await edge.available({})
      probe = a.ok ? 'ok' : 'fail:' + a.message
    } catch (e) {
      probe = 'throw:' + e.message
    }
  }
  try {
    const out = await edge.synth(LONG, { voice: 'zh-CN-YunxiNeural', speed: 1.05 })
    console.log(
      `#${i} probe=${probe} synth=ok bytes=${out.bytes} sec=${out.audioSec} cost=${Date.now() - t0}ms`,
    )
  } catch (e) {
    console.log(
      `#${i} probe=${probe} synth=FAIL code=${e.closeCode ?? '-'} reason=${JSON.stringify(e.closeReason ?? '')} msg=${e.message} cost=${Date.now() - t0}ms`,
    )
  }
}
