# edge-tts 探针（.NET WebSocket，SChannel 栈）
# 目的：确认 403 是不是 node 的 TLS 指纹问题
param(
  [string]$Text = '哦鲸鲸，这是 edge 的声音，先养着吧。',
  [string]$Voice = 'zh-CN-XiaoxiaoNeural',
  [string]$Out = 'E:\DSH_Work\plugins\dsh-voice-bridge\lib\tts\out\edge-ps.wav'
)
$ErrorActionPreference = 'Stop'

$Trusted = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'
function Get-SecMsGec {
  $winEpoch = 11644473600
  $ticks = [int64]((([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() / 1000) + $winEpoch) * 1e7)
  $ticks -= ($ticks % 3000000000)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $bytes = [Text.Encoding]::UTF8.GetBytes([string]$ticks + $Trusted)
  return ([BitConverter]::ToString($sha.ComputeHash($bytes)) -replace '-', '')
}

$connId = [guid]::NewGuid().ToString()
$gec = Get-SecMsGec
$url = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=$Trusted&Sec-MS-GEC=$gec&Sec-MS-GEC-Version=1-130.0.2849.68&ConnectionId=$connId"

$ws = [System.Net.WebSockets.ClientWebSocket]::new()
$ws.Options.SetRequestHeader('Origin', 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold')
# 跳过 UA（ClientWebSocket 不允许改 UA 这种受限头）
$ws.Options.SetRequestHeader('Pragma', 'no-cache')
$ws.Options.SetRequestHeader('Cache-Control', 'no-cache')

$cts = [System.Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds(15))
try {
  $ws.ConnectAsync([Uri]$url, $cts.Token).Wait()
  Write-Output "CONNECT OK state=$($ws.State)"
} catch {
  Write-Output "CONNECT FAIL: $($_.Exception.GetBaseException().Message)"
  exit 1
}

function Send-Text($s) {
  $bytes = [Text.Encoding]::UTF8.GetBytes($s)
  $seg = [ArraySegment[byte]]::new($bytes)
  $ws.SendAsync($seg, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, [System.Threading.CancellationToken]::None).Wait()
}

$rid = [guid]::NewGuid().ToString('N')
$ts = [DateTime]::UtcNow.ToString('r')
Send-Text "X-Timestamp:$ts`r`nContent-Type:application/json; charset=utf-8`r`nPath:speech.config`r`n`r`n{""context"":{""synthesis"":{""audio"":{""metadataoptions"":{""sentenceBoundaryEnabled"":""false"",""wordBoundaryEnabled"":""false""},""outputFormat"":""riff-24khz-16bit-mono-pcm""}}}}"
$ssml = "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'><voice name='$Voice'><prosody rate='+0%' pitch='+0Hz'>$Text</prosody></voice></speak>"
Send-Text "X-RequestId:$rid`r`nContent-Type:application/ssml+xml`r`nX-Timestamp:$([DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ'))`r`nPath:ssml`r`n`r`n$ssml"

$buf = New-Object byte[] 65536
$audio = New-Object System.Collections.Generic.List[byte]
$deadline = [DateTime]::UtcNow.AddSeconds(15)
while ([DateTime]::UtcNow -lt $deadline) {
  $ms = [System.IO.MemoryStream]::new()
  $tok = [System.Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds(8))
  try {
    do {
      $res = $ws.ReceiveAsync([ArraySegment[byte]]::new($buf), $tok.Token).Result
      if ($res.Count -gt 0) { $ms.Write($buf, 0, $res.Count) }
    } while (-not $res.EndOfMessage)
  } catch { Write-Output "RECV END: $($_.Exception.GetBaseException().Message)"; break }
  $data = $ms.ToArray()
  if ($data.Length -le 2) { continue }
  $hlen = [BitConverter]::ToUInt16($data, 0)
  $hdr = [Text.Encoding]::UTF8.GetString($data, 2, $hlen)
  if ($hdr -match 'Path:audio') {
    $audio.AddRange([byte[]]$data[($hlen + 2)..($data.Length - 1)])
  } elseif ($hdr -match 'Path:turn.end') {
    break
  }
}
$ws.Dispose()
Write-Output "AUDIO BYTES: $($audio.Count)"
if ($audio.Count -gt 0) {
  [System.IO.File]::WriteAllBytes($Out, $audio.ToArray())
  Write-Output "WROTE $Out"
}
