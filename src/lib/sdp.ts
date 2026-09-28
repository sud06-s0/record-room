// src/lib/sdp.ts
// Small SDP tweaks so the phone sends near-lossless quality over local WiFi.
// Applied only to the answer we send to the phone (the sender reads them).

function splitSections(sdp: string): string[] {
  return sdp.split(/\r\n(?=m=)/)
}

function payloadTypes(section: string, codecs: RegExp): string[] {
  const out: string[] = []
  for (const m of section.matchAll(/^a=rtpmap:(\d+) ([^/\r\n]+)\//gm)) {
    if (codecs.test(m[2])) out.push(m[1])
  }
  return out
}

function addFmtp(section: string, pt: string, params: string): string {
  const re = new RegExp(`^a=fmtp:${pt} (.*)$`, 'm')
  if (re.test(section)) {
    return section.replace(re, (_, existing: string) => {
      const have = new Set(existing.split(';').map((kv) => kv.split('=')[0].trim()))
      const extra = params.split(';').filter((kv) => !have.has(kv.split('=')[0].trim()))
      return extra.length ? `a=fmtp:${pt} ${existing};${extra.join(';')}` : `a=fmtp:${pt} ${existing}`
    })
  }
  return section.replace(new RegExp(`^(a=rtpmap:${pt} .*)$`, 'm'), `$1\r\na=fmtp:${pt} ${params}`)
}

function setBandwidth(section: string, kbps: number): string {
  const cleaned = section.replace(/^b=(AS|TIAS):.*\r\n/gm, '')
  return cleaned.replace(/^(c=.*)$/m, `$1\r\nb=AS:${kbps}\r\nb=TIAS:${kbps * 1000}`)
}

export interface QualityHints {
  videoMaxKbps: number
  videoStartKbps: number
  videoMinKbps: number
  audioKbps: number
}

export const HIGH_QUALITY: QualityHints = {
  videoMaxKbps: 25_000,
  videoStartKbps: 12_000,
  videoMinKbps: 4_000,
  audioKbps: 128,
}

export function boostSdp(sdp: string, q: QualityHints = HIGH_QUALITY): string {
  return splitSections(sdp)
    .map((section) => {
      if (section.startsWith('m=audio')) {
        for (const pt of payloadTypes(section, /^opus$/i)) {
          section = addFmtp(section, pt, `maxaveragebitrate=${q.audioKbps * 1000};stereo=0;useinbandfec=1;usedtx=0`)
        }
        return section
      }
      if (section.startsWith('m=video')) {
        section = setBandwidth(section, q.videoMaxKbps)
        for (const pt of payloadTypes(section, /^(H264|VP8|VP9|AV1)$/i)) {
          section = addFmtp(
            section,
            pt,
            `x-google-start-bitrate=${q.videoStartKbps};x-google-max-bitrate=${q.videoMaxKbps};x-google-min-bitrate=${q.videoMinKbps}`,
          )
        }
        return section
      }
      return section
    })
    .join('\r\n')
}
