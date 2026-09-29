// src/lib/phoneLink.ts
// Phone → PC camera & mic over your WiFi (WebRTC, direct device to device).
// PhoneSender runs on the phone, PhoneReceiver runs on the PC.

import { openSignal, type Signal, type SignalMessage } from './signaling'
import { boostSdp, HIGH_QUALITY, stripRotationExtension } from './sdp'

export type LinkState = 'idle' | 'waiting' | 'connecting' | 'connected' | 'failed'
export type Facing = 'user' | 'environment'

export interface LinkStats {
  width?: number
  height?: number
  fps?: number
  mbps: number
  codec?: string
  /** phone side: why the encoder lowered quality ('none' is best) */
  limitation?: string
}

const RTC_CONFIG: RTCConfiguration = {
  // Devices on the same WiFi connect directly; STUN only helps them discover
  // their addresses. No video ever goes through a server.
  iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }],
  bundlePolicy: 'max-bundle',
}

const VIDEO_MAX_BPS = HIGH_QUALITY.videoMaxKbps * 1000
const AUDIO_BPS = HIGH_QUALITY.audioKbps * 1000

/** Shared bits: ICE queueing and stats polling. */
abstract class LinkBase {
  protected signal: Signal | null = null
  protected pc: RTCPeerConnection | null = null
  private pendingIce: RTCIceCandidateInit[] = []
  private statsTimer: ReturnType<typeof setInterval> | null = null
  private lastBytes = 0
  private lastTime = 0

  constructor(
    protected readonly room: string,
    protected readonly onState: (s: LinkState) => void,
    protected readonly onStats: (s: LinkStats | null) => void,
  ) {}

  protected abstract readonly role: 'pc' | 'phone'
  protected abstract handle(msg: SignalMessage): void

  protected async openSignal() {
    this.signal = await openSignal(this.room, (msg) => this.handle(msg))
  }

  protected newPeer(): RTCPeerConnection {
    this.closePeer()
    const pc = new RTCPeerConnection(RTC_CONFIG)
    this.pc = pc
    this.pendingIce = []
    pc.onicecandidate = (e) => {
      if (e.candidate) this.signal?.send({ kind: 'ice', from: this.role, candidate: e.candidate.toJSON() })
    }
    pc.onconnectionstatechange = () => {
      if (this.pc !== pc) return
      const s = pc.connectionState
      if (s === 'connected') {
        this.onState('connected')
        this.startStats()
      } else if (s === 'failed') {
        this.onState('failed')
      } else if (s === 'disconnected' || s === 'closed') {
        this.onState('waiting')
      } else if (s === 'connecting') {
        this.onState('connecting')
      }
    }
    return pc
  }

  protected async addIce(candidate: RTCIceCandidateInit) {
    const pc = this.pc
    if (!pc) return
    if (!pc.remoteDescription) {
      this.pendingIce.push(candidate)
      return
    }
    try { await pc.addIceCandidate(candidate) } catch {}
  }

  protected async flushIce() {
    const pc = this.pc
    if (!pc) return
    for (const c of this.pendingIce.splice(0)) {
      try { await pc.addIceCandidate(c) } catch {}
    }
  }

  private startStats() {
    this.stopStats()
    this.lastBytes = 0
    this.lastTime = 0
    this.statsTimer = setInterval(() => void this.pollStats(), 1000)
  }

  private stopStats() {
    if (this.statsTimer) clearInterval(this.statsTimer)
    this.statsTimer = null
  }

  private async pollStats() {
    const pc = this.pc
    if (!pc) return
    const report = await pc.getStats()
    const want = this.role === 'pc' ? 'inbound-rtp' : 'outbound-rtp'
    let stats: LinkStats | null = null
    report.forEach((r) => {
      if (r.type !== want || r.kind !== 'video') return
      const bytes: number = this.role === 'pc' ? r.bytesReceived : r.bytesSent
      const now: number = r.timestamp
      const mbps = this.lastTime ? ((bytes - this.lastBytes) * 8) / ((now - this.lastTime) / 1000) / 1e6 : 0
      this.lastBytes = bytes
      this.lastTime = now
      const codec = r.codecId ? report.get(r.codecId)?.mimeType?.replace('video/', '') : undefined
      stats = {
        width: r.frameWidth,
        height: r.frameHeight,
        fps: r.framesPerSecond,
        mbps: Math.max(0, mbps),
        codec,
        limitation: r.qualityLimitationReason,
      }
    })
    this.onStats(stats)
  }

  protected closePeer() {
    this.stopStats()
    this.onStats(null)
    if (this.pc) {
      this.pc.onconnectionstatechange = null
      this.pc.onicecandidate = null
      this.pc.close()
    }
    this.pc = null
  }

  close() {
    this.signal?.send({ kind: 'bye', from: this.role })
    this.closePeer()
    this.signal?.close()
    this.signal = null
    this.onState('idle')
  }
}

// ============================ PC side ============================

export interface PhoneStatus {
  facing: Facing
  micMuted: boolean
}

export class PhoneReceiver extends LinkBase {
  protected readonly role = 'pc' as const
  private audioSink: HTMLAudioElement | null = null
  private stream: MediaStream | null = null

  constructor(
    room: string,
    onState: (s: LinkState) => void,
    onStats: (s: LinkStats | null) => void,
    private readonly onStream: (stream: MediaStream | null) => void,
    private readonly onStatus: (status: PhoneStatus) => void,
  ) {
    super(room, onState, onStats)
  }

  async start() {
    this.onState('waiting')
    await this.openSignal()
    // In case the phone is already open and waiting.
    this.signal?.send({ kind: 'hello', from: 'pc' })
  }

  protected handle(msg: SignalMessage) {
    switch (msg.kind) {
      case 'hello':
        if (msg.from === 'phone') this.signal?.send({ kind: 'hello', from: 'pc' })
        break
      case 'offer':
        void this.answer(msg.sdp)
        break
      case 'ice':
        if (msg.from === 'phone') void this.addIce(msg.candidate)
        break
      case 'phone-status':
        this.onStatus({ facing: msg.facing, micMuted: msg.micMuted })
        break
      case 'bye':
        if (msg.from === 'phone') this.dropStream()
        break
    }
  }

  private async answer(sdp: string) {
    this.dropStream()
    const pc = this.newPeer()
    this.onState('connecting')
    const stream = new MediaStream()
    pc.ontrack = (e) => {
      stream.addTrack(e.track)
      // Keep a small jitter buffer: smooth playback without adding lag.
      try { (e.receiver as RTCRtpReceiver & { jitterBufferTarget?: number }).jitterBufferTarget = 80 } catch {}
      if (e.track.kind === 'audio') this.attachAudioSink(stream)
      this.stream = stream
      this.onStream(stream)
    }
    // Without the rotation extension on both sides, the phone sends upright pixels.
    await pc.setRemoteDescription({ type: 'offer', sdp: stripRotationExtension(sdp) })
    await this.flushIce()
    const answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
    // The phone reads these hints and sends at high bitrate.
    this.signal?.send({ kind: 'answer', sdp: boostSdp(answer.sdp ?? '') })
  }

  /** Chrome only feeds remote WebRTC audio into Web Audio while it's attached to a media element. */
  private attachAudioSink(stream: MediaStream) {
    if (!this.audioSink) {
      this.audioSink = document.createElement('audio')
      this.audioSink.muted = true
      this.audioSink.autoplay = true
    }
    this.audioSink.srcObject = stream
    void this.audioSink.play().catch(() => {})
  }

  private dropStream() {
    if (this.stream) {
      this.stream = null
      this.onStream(null)
    }
    if (this.audioSink) this.audioSink.srcObject = null
    this.closePeer()
    this.onState('waiting')
  }

  close() {
    this.dropStream()
    super.close()
  }
}

// ============================ phone side ============================

function sortCodecs(codecs: RTCRtpCodec[]): RTCRtpCodec[] {
  // Hardware H.264 first: light on the phone and on the PC.
  const rank = (c: RTCRtpCodec) => {
    const mime = c.mimeType.toLowerCase()
    if (mime === 'video/h264') return c.sdpFmtpLine?.includes('packetization-mode=1') ? 0 : 1
    if (mime === 'video/vp8') return 2
    if (mime === 'video/vp9') return 3
    if (mime === 'video/av1') return 4
    return 9 // rtx / red / fec
  }
  return [...codecs].sort((a, b) => rank(a) - rank(b))
}

export class PhoneSender extends LinkBase {
  protected readonly role = 'phone' as const
  private local: MediaStream | null = null
  private videoSender: RTCRtpSender | null = null
  private audioSender: RTCRtpSender | null = null
  facing: Facing = 'user'
  micMuted = false

  constructor(
    room: string,
    onState: (s: LinkState) => void,
    onStats: (s: LinkStats | null) => void,
    private readonly onPreview: (stream: MediaStream | null) => void,
  ) {
    super(room, onState, onStats)
  }

  private videoConstraints(facing: Facing): MediaTrackConstraints {
    return {
      facingMode: { ideal: facing },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 30, max: 30 },
    }
  }

  async start(facing: Facing = 'user') {
    this.facing = facing
    this.local = await navigator.mediaDevices.getUserMedia({
      video: this.videoConstraints(facing),
      audio: {
        channelCount: 1,
        sampleRate: 48000,
        echoCancellation: true,
        // The PC runs AI noise removal, so send the natural voice.
        noiseSuppression: false,
        autoGainControl: true,
      },
    })
    const vt = this.local.getVideoTracks()[0]
    if (vt) vt.contentHint = 'motion'
    this.onPreview(this.local)
    this.onState('waiting')
    await this.openSignal()
    this.signal?.send({ kind: 'hello', from: 'phone' })
  }

  protected handle(msg: SignalMessage) {
    switch (msg.kind) {
      case 'hello':
        if (msg.from === 'pc') void this.offer()
        break
      case 'answer':
        void this.acceptAnswer(msg.sdp)
        break
      case 'ice':
        if (msg.from === 'pc') void this.addIce(msg.candidate)
        break
      case 'bye':
        if (msg.from === 'pc') {
          this.closePeer()
          this.onState('waiting')
        }
        break
    }
  }

  private async offer() {
    const local = this.local
    if (!local) return
    const pc = this.newPeer()
    this.onState('connecting')

    const video = local.getVideoTracks()[0]
    const audio = local.getAudioTracks()[0]
    if (video) {
      const t = pc.addTransceiver(video, {
        direction: 'sendonly',
        streams: [local],
        sendEncodings: [{ maxBitrate: VIDEO_MAX_BPS, maxFramerate: 30, priority: 'high', networkPriority: 'high' }],
      })
      this.videoSender = t.sender
      const caps = RTCRtpSender.getCapabilities?.('video')
      if (caps && typeof t.setCodecPreferences === 'function') {
        try { t.setCodecPreferences(sortCodecs(caps.codecs)) } catch {}
      }
    }
    if (audio) {
      const t = pc.addTransceiver(audio, {
        direction: 'sendonly',
        streams: [local],
        sendEncodings: [{ maxBitrate: AUDIO_BPS, priority: 'high', networkPriority: 'high' }],
      })
      this.audioSender = t.sender
      audio.enabled = !this.micMuted
    }

    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    this.signal?.send({ kind: 'offer', sdp: offer.sdp ?? '' })
  }

  private async acceptAnswer(sdp: string) {
    const pc = this.pc
    if (!pc || pc.signalingState !== 'have-local-offer') return
    await pc.setRemoteDescription({ type: 'answer', sdp })
    await this.flushIce()
    await this.tuneSender()
    this.sendStatus()
  }

  /** Keep full 1080p even when the network hiccups; lower frame rate briefly instead of blurring. */
  private async tuneSender() {
    const a = this.audioSender
    if (a) {
      try {
        const p = a.getParameters()
        p.encodings.forEach((e) => (e.maxBitrate = AUDIO_BPS))
        await a.setParameters(p)
      } catch {}
    }
    const s = this.videoSender
    if (!s) return
    try {
      const p = s.getParameters() as RTCRtpSendParameters & { degradationPreference?: string }
      p.degradationPreference = 'maintain-resolution'
      p.encodings.forEach((e) => {
        e.maxBitrate = VIDEO_MAX_BPS
        e.maxFramerate = 30
      })
      await s.setParameters(p)
    } catch {}
  }

  async switchCamera() {
    const local = this.local
    if (!local) return
    const next: Facing = this.facing === 'user' ? 'environment' : 'user'
    // Many phones can't open two cameras at once: release the current one first.
    local.getVideoTracks().forEach((t) => {
      t.stop()
      local.removeTrack(t)
    })
    const fresh = await navigator.mediaDevices.getUserMedia({ video: this.videoConstraints(next) })
    const track = fresh.getVideoTracks()[0]
    track.contentHint = 'motion'
    local.addTrack(track)
    await this.videoSender?.replaceTrack(track)
    this.facing = next
    this.onPreview(new MediaStream(local.getTracks()))
    this.sendStatus()
  }

  setMicMuted(muted: boolean) {
    this.micMuted = muted
    this.local?.getAudioTracks().forEach((t) => (t.enabled = !muted))
    this.sendStatus()
  }

  private sendStatus() {
    this.signal?.send({ kind: 'phone-status', facing: this.facing, micMuted: this.micMuted })
  }


  close() {
    super.close()
    this.local?.getTracks().forEach((t) => t.stop())
    this.local = null
    this.onPreview(null)
  }
}
