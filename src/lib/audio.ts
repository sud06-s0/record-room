// src/lib/audio.ts
// Audio graph: mic -> high-pass -> AI noise removal (only on the mic) -> gentle
// compressor -> mix. PC/tab audio is mixed in untouched, after noise removal.

import {
  RnnoiseWorkletNode,
  loadRnnoise,
  GtcrnWorkletNode,
  loadGtcrn,
} from '@sapphi-red/web-noise-suppressor'
import rnnoiseWorkletPath from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url'
import rnnoiseWasmPath from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url'
import rnnoiseSimdPath from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url'
import gtcrnWorkletPath from '@sapphi-red/web-noise-suppressor/gtcrnWorklet.js?url'
import gtcrnWasmPath from '@sapphi-red/web-noise-suppressor/gtcrn.wasm?url'

export type NcMode = 'off' | 'standard' | 'strong'

export const NC_MODES: { id: NcMode; label: string; hint: string }[] = [
  { id: 'off', label: 'Off', hint: 'Browser default processing' },
  { id: 'standard', label: 'Standard', hint: 'RNNoise — light, very low CPU' },
  { id: 'strong', label: 'Strong AI', hint: 'GTCRN neural model — best cleanup' },
]

type AiMode = Exclude<NcMode, 'off'>
const isAi = (m: NcMode): m is AiMode => m === 'standard' || m === 'strong'

export class AudioMixer {
  readonly ctx: AudioContext
  private readonly dest: MediaStreamAudioDestinationNode
  private readonly micGain: GainNode
  private readonly sysGain: GainNode
  private readonly analyser: AnalyserNode
  private readonly monitorGain: GainNode
  private micNodes: AudioNode[] = []
  private sysSource: MediaStreamAudioSourceNode | null = null
  private readonly loaded: Partial<Record<AiMode, ArrayBuffer>> = {}
  private readonly levelBuf: Float32Array<ArrayBuffer>

  constructor() {
    this.ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' })
    this.dest = this.ctx.createMediaStreamDestination()
    this.dest.channelCount = 2

    this.micGain = this.ctx.createGain()
    this.sysGain = this.ctx.createGain()
    this.micGain.connect(this.dest)
    this.sysGain.connect(this.dest)

    this.analyser = this.ctx.createAnalyser()
    this.analyser.fftSize = 1024
    this.micGain.connect(this.analyser)
    this.levelBuf = new Float32Array(this.analyser.fftSize)

    this.monitorGain = this.ctx.createGain()
    this.monitorGain.gain.value = 0
    this.micGain.connect(this.monitorGain)
    this.monitorGain.connect(this.ctx.destination)
  }

  async resume() {
    if (this.ctx.state !== 'running') await this.ctx.resume()
  }

  private async loadModel(mode: AiMode): Promise<ArrayBuffer> {
    const cached = this.loaded[mode]
    if (cached) return cached
    let wasm: ArrayBuffer
    if (mode === 'standard') {
      wasm = await loadRnnoise({ url: rnnoiseWasmPath, simdUrl: rnnoiseSimdPath })
      await this.ctx.audioWorklet.addModule(rnnoiseWorkletPath)
    } else {
      wasm = await loadGtcrn({ url: gtcrnWasmPath })
      await this.ctx.audioWorklet.addModule(gtcrnWorkletPath)
    }
    this.loaded[mode] = wasm
    return wasm
  }

  private clearMic() {
    for (const n of this.micNodes) {
      try { n.disconnect() } catch {}
      if (n instanceof RnnoiseWorkletNode || n instanceof GtcrnWorkletNode) {
        try { n.destroy() } catch {}
      }
    }
    this.micNodes = []
  }

  /** Connect a mic MediaStream through the processing chain. */
  async setMic(stream: MediaStream | null, ncMode: NcMode = 'strong') {
    this.clearMic()
    if (!stream || !stream.getAudioTracks().length) return
    const src = this.ctx.createMediaStreamSource(stream)

    const hp = this.ctx.createBiquadFilter()
    hp.type = 'highpass'
    hp.frequency.value = 80
    hp.Q.value = 0.7

    const nodes: AudioNode[] = [src, hp]
    if (isAi(ncMode)) {
      const wasmBinary = await this.loadModel(ncMode)
      nodes.push(
        ncMode === 'standard'
          ? new RnnoiseWorkletNode(this.ctx, { maxChannels: 1, wasmBinary })
          : new GtcrnWorkletNode(this.ctx, { maxChannels: 1, wasmBinary }),
      )
    }

    const comp = this.ctx.createDynamicsCompressor()
    comp.threshold.value = -24
    comp.knee.value = 12
    comp.ratio.value = 3
    comp.attack.value = 0.005
    comp.release.value = 0.2
    nodes.push(comp)

    // Mono mic -> both stereo channels
    const up = this.ctx.createGain()
    up.channelCount = 1
    up.channelCountMode = 'explicit'
    up.channelInterpretation = 'speakers'
    nodes.push(up)

    for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1])
    up.connect(this.micGain)
    this.micNodes = nodes
  }

  /** Connect PC / tab audio (from the screen share) — no processing. */
  setSystem(stream: MediaStream | null) {
    if (this.sysSource) {
      try { this.sysSource.disconnect() } catch {}
      this.sysSource = null
    }
    if (!stream || !stream.getAudioTracks().length) return
    this.sysSource = this.ctx.createMediaStreamSource(stream)
    this.sysSource.connect(this.sysGain)
  }

  setMicVolume(v: number) {
    this.micGain.gain.value = v
  }
  setSystemVolume(v: number) {
    this.sysGain.gain.value = v
  }
  /** Hear your processed mic through headphones (for testing). */
  setMonitor(on: boolean) {
    this.monitorGain.gain.value = on ? 1 : 0
  }

  /** 0..1 mic level for a meter */
  level(): number {
    this.analyser.getFloatTimeDomainData(this.levelBuf)
    let peak = 0
    for (const v of this.levelBuf) peak = Math.max(peak, Math.abs(v))
    const db = 20 * Math.log10(peak || 1e-6)
    return Math.max(0, Math.min(1, (db + 60) / 60))
  }

  get track(): MediaStreamTrack {
    return this.dest.stream.getAudioTracks()[0]
  }
}
