// src/workers/compositor.worker.ts
// Runs in a dedicated worker so recording keeps going at full frame rate even
// when this tab is in the background (you'll be on the tab you're recording).
// It composites screen + camera onto a 1920x1080 OffscreenCanvas, encodes
// H.264 + AAC with WebCodecs, and streams the MP4 straight to disk.

import {
  Output,
  Mp4OutputFormat,
  StreamTarget,
  EncodedVideoPacketSource,
  EncodedPacket,
  AudioSampleSource,
  AudioSample,
  canEncodeAudio,
  type StreamTargetChunk,
} from 'mediabunny'
import type {
  AudioCodecUsed,
  Background,
  SegReply,
  Fit,
  FromWorker,
  Rotation,
  Layout,
  PcmChunk,
  SaveTarget,
  SourceKey,
  StopResult,
  TargetInfo,
  ToWorker,
  VideoCodecUsed,
} from '../shared/types'
import { BG_PRESETS, DEFAULT_BACKGROUND } from '../shared/backgrounds'
import { ChromaKeyer } from './chromaKey'

declare const self: DedicatedWorkerGlobalScope

const W = 1920
const H = 1080

let canvas: OffscreenCanvas | null = null
let ctx: OffscreenCanvasRenderingContext2D | null = null

type Frame = VideoFrame | ImageBitmap
/** Anything drawFit can place: a camera / screen frame or one of our own canvases. */
type Drawable = Frame | OffscreenCanvas

// Latest decoded frames from each source.
const latest: Record<SourceKey, Frame | null> = { screen: null, camera: null }
const readers: Record<SourceKey, ReadableStreamDefaultReader<VideoFrame> | null> = {
  screen: null,
  camera: null,
}

let layout: Layout = {
  mode: 'bubble',
  bubbleSize: 'medium',
  bubbleCorner: 'bl',
  mirror: true,
  splitFit: 'contain',
  hasCamera: true,
  cameraRotation: 0,
}

let fps = 30
// Fallback (Firefox): no MediaStreamTrackProcessor, so ask the page for frames each tick.
let pullMode = false
let pullPending = false
let tickTimer: ReturnType<typeof setTimeout> | null = null
let nextTickAt = 0

// ---------- recording state ----------
interface Recording {
  output: Output
  video: VideoPipe
  audioSource: AudioSampleSource | null
  audioCodec: AudioCodecUsed
  videoCodec: VideoCodecUsed
  audioPort: MessagePort | null
  startAt: number
  pausedTotal: number
  pausedAt: number
  lastVideoTs: number
  lastKeyTs: number
  framesAdded: number
  framesDropped: number
  audioReader: ReadableStreamDefaultReader<AudioData> | null
  audioPending: Promise<void> | null
  audioSamplesWritten: number
  audioOffset: number
  audioResync: boolean
  lastAudioEnd: number
  bytes: { value: number }
  stopping: boolean
  target: TargetInfo
}
let rec: Recording | null = null

const post = (msg: FromWorker) => self.postMessage(msg)
const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e))

// ---------- frame pumps ----------
async function setSource(key: SourceKey, readable: ReadableStream<VideoFrame> | null) {
  const old = readers[key]
  if (old) {
    readers[key] = null
    try { await old.cancel() } catch {}
  }
  latest[key]?.close()
  latest[key] = null
  if (!readable) return

  const reader = readable.getReader()
  readers[key] = reader
  ;(async () => {
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        if (readers[key] !== reader) {
          value.close()
          break
        }
        latest[key]?.close()
        latest[key] = value
      }
    } catch {
      /* source ended */
    }
  })()
}

// ---------- drawing ----------
function frameSize(f: Drawable) {
  if (f instanceof ImageBitmap || f instanceof OffscreenCanvas) return { w: f.width, h: f.height }
  return { w: f.displayWidth || f.codedWidth, h: f.displayHeight || f.codedHeight }
}

function setFrames(frames: Partial<Record<SourceKey, ImageBitmap>>) {
  for (const key of ['screen', 'camera'] as const) {
    const bmp = frames[key]
    if (!bmp) continue
    latest[key]?.close()
    latest[key] = bmp
  }
}

/** Draws a frame into (x, y, w, h) like CSS object-fit, optionally turned and mirrored. */
function drawFit(
  c: OffscreenCanvasRenderingContext2D,
  frame: Drawable,
  x: number,
  y: number,
  w: number,
  h: number,
  fit: Fit,
  mirror = false,
  rotation: Rotation = 0,
) {
  const { w: fw, h: fh } = frameSize(frame)
  if (!fw || !fh) return
  // A quarter turn swaps the picture's width and height.
  const sideways = rotation === 90 || rotation === 270
  const sw = sideways ? fh : fw
  const sh = sideways ? fw : fh
  const scale = fit === 'cover' ? Math.max(w / sw, h / sh) : Math.min(w / sw, h / sh)
  const dw = fw * scale
  const dh = fh * scale
  c.save()
  c.beginPath()
  c.rect(x, y, w, h)
  c.clip()
  c.translate(x + w / 2, y + h / 2)
  if (mirror) c.scale(-1, 1)
  if (rotation) c.rotate((rotation * Math.PI) / 180)
  c.drawImage(frame, -dw / 2, -dh / 2, dw, dh)
  c.restore()
}

function placeholder(c: OffscreenCanvasRenderingContext2D, x: number, y: number, w: number, h: number, text: string) {
  c.save()
  c.fillStyle = '#16161d'
  c.fillRect(x, y, w, h)
  c.fillStyle = '#6b6b7b'
  c.font = '500 34px system-ui, sans-serif'
  c.textAlign = 'center'
  c.textBaseline = 'middle'
  c.fillText(text, x + w / 2, y + h / 2)
  c.restore()
}

const BUBBLE_SIZES: Record<Layout['bubbleSize'], number> = { small: 0.24, medium: 0.32, large: 0.42 }

function drawBubble(c: OffscreenCanvasRenderingContext2D) {
  const d = Math.round(H * (BUBBLE_SIZES[layout.bubbleSize] ?? 0.32))
  const margin = 44
  const corner = layout.bubbleCorner
  const x = corner.endsWith('l') ? margin : W - margin - d
  const y = corner.startsWith('t') ? margin : H - margin - d
  const cx = x + d / 2
  const cy = y + d / 2
  const r = d / 2

  // Soft edge without shadowBlur (blur is one of the most expensive canvas
  // operations): two faint rings stacked around the bubble.
  c.save()
  c.fillStyle = 'rgba(0,0,0,0.18)'
  c.beginPath()
  c.arc(cx, cy + 4, r + 10, 0, Math.PI * 2)
  c.fill()
  c.fillStyle = 'rgba(0,0,0,0.22)'
  c.beginPath()
  c.arc(cx, cy + 2, r + 4, 0, Math.PI * 2)
  c.fill()
  c.restore()

  c.save()
  c.beginPath()
  c.arc(cx, cy, r, 0, Math.PI * 2)
  c.clip()
  if (latest.camera) drawCamera(c, x, y, d, d)
  else placeholder(c, x, y, d, d, 'Camera')
  c.restore()

  // ring
  c.save()
  c.beginPath()
  c.arc(cx, cy, r - 3, 0, Math.PI * 2)
  c.lineWidth = 6
  c.strokeStyle = 'rgba(255,255,255,0.92)'
  c.stroke()
  c.restore()
}

/**
 * "Cutout" bubble: no circle and no background, just you standing over the
 * screen. Sits on the bottom edge (or near the top for the top corners).
 * Returns false while there's no cutout yet, so the round bubble is drawn instead.
 */
function drawCutout(c: OffscreenCanvasRenderingContext2D): boolean {
  if (!latest.camera) return false
  const d = Math.round(H * (BUBBLE_SIZES[layout.bubbleSize] ?? 0.32) * 1.3)
  const margin = 32
  const corner = layout.bubbleCorner
  const x = corner.endsWith('l') ? margin : W - margin - d
  const y = corner.startsWith('t') ? margin : H - d
  return drawPerson(c, latest.camera, x, y, d, d)
}

function draw() {
  const c = ctx
  if (!c) return
  c.fillStyle = '#0b0b10'
  c.fillRect(0, 0, W, H)
  switch (layout.mode) {
    case 'camera':
      if (latest.camera) drawCamera(c, 0, 0, W, H)
      else placeholder(c, 0, 0, W, H, 'No camera selected')
      break
    case 'bubble':
      if (latest.screen) drawFit(c, latest.screen, 0, 0, W, H, 'contain')
      else placeholder(c, 0, 0, W, H, 'Choose a screen, window or tab to share')
      if (layout.hasCamera && !(bg.cutout && drawCutout(c))) drawBubble(c)
      break
    case 'split': {
      const half = W / 2
      if (latest.camera) drawCamera(c, 0, 0, half, H)
      else placeholder(c, 0, 0, half, H, 'Camera')
      if (latest.screen) drawFit(c, latest.screen, half, 0, half, H, layout.splitFit)
      else placeholder(c, half, 0, half, H, 'Screen')
      break
    }
  }
}

// ---------- camera background ----------
// Order per camera draw: background (blur / picture / colour), then just you on
// top. "Just you" comes from either the AI mask (segmenter worker) or the green
// screen shader. Until either is ready, the plain camera is drawn.

let bg: Background = { ...DEFAULT_BACKGROUND }
let bgCustom: ImageBitmap | null = null
const presetCache = new Map<string, OffscreenCanvas>()

// AI mask
let segPort: MessagePort | null = null
let segBusy = false
let segSentAt = 0
/** Masks per second. Drops automatically if the PC is slow. */
let segHz = 15
let segIn: OffscreenCanvas | null = null
let segInCtx: OffscreenCanvasRenderingContext2D | null = null
let mask: OffscreenCanvas | null = null
let maskCtx: OffscreenCanvasRenderingContext2D | null = null
let maskValid = false

// Green screen
let keyer: ChromaKeyer | null | undefined // undefined = not tried yet
let keyerFailed = false

// Scratch canvases
let person: OffscreenCanvas | null = null
let personCtx: OffscreenCanvasRenderingContext2D | null = null
const blurA = new OffscreenCanvas(2, 2)
const blurACtx = blurA.getContext('2d')!
const blurB = new OffscreenCanvas(2, 2)
const blurBCtx = blurB.getContext('2d')!
// Better downscaling (fewer shimmering pixels in the blur).
blurACtx.imageSmoothingQuality = 'medium'
blurBCtx.imageSmoothingQuality = 'medium'

/** Is the camera on screen with an effect that needs "just you"? */
function cameraEffectOn(): boolean {
  const camVisible = layout.mode === 'camera' || layout.hasCamera
  return camVisible && (bg.mode !== 'none' || (layout.mode === 'bubble' && bg.cutout))
}

/** Green / blue screen is used for picture, colour and cutout. Blur always uses AI. */
function useKeyer(): boolean {
  return bg.keyer !== 'ai' && (bg.mode !== 'blur' || (layout.mode === 'bubble' && bg.cutout))
}

function onSegReply(msg: SegReply) {
  segBusy = false
  if (msg.type !== 'mask') return
  if (!mask || mask.width !== msg.width || mask.height !== msg.height) {
    mask = new OffscreenCanvas(msg.width, msg.height)
    maskCtx = mask.getContext('2d')
  }
  maskCtx?.putImageData(new ImageData(msg.data, msg.width, msg.height), 0, 0)
  maskValid = true
  // Keep the AI under ~45% of each frame's time budget on slow PCs.
  if (msg.ms > 45) segHz = 6
  else if (msg.ms > 25) segHz = 10
  else segHz = 15
}

/** Send a small copy of the camera frame to the segmenter (if it's time). */
function requestMask() {
  const f = latest.camera
  if (!segPort || !f) return
  const now = performance.now()
  if (segBusy && now - segSentAt < 3000) return
  if (now - segSentAt < 1000 / segHz) return
  const { w: fw, h: fh } = frameSize(f)
  if (!fw || !fh) return
  const mw = fw >= fh ? 256 : Math.round((256 * fw) / fh)
  const mh = fw >= fh ? Math.round((256 * fh) / fw) : 256
  if (!segIn || segIn.width !== mw || segIn.height !== mh) {
    segIn = new OffscreenCanvas(mw, mh)
    segInCtx = segIn.getContext('2d')
    if (segInCtx) segInCtx.imageSmoothingQuality = 'medium'
  }
  segInCtx!.drawImage(f, 0, 0, mw, mh)
  const bitmap = segIn.transferToImageBitmap()
  segBusy = true
  segSentAt = now
  segPort.postMessage({ type: 'frame', bitmap }, [bitmap])
}

/** The mask only fits frames with the same shape (e.g. after switching cameras). */
function maskFits(f: Frame): boolean {
  if (!mask || !maskValid) return false
  const { w, h } = frameSize(f)
  return Math.abs(w / h - mask.width / mask.height) < 0.03
}

/** Draws only you (no background) into the rect. false = not available yet. */
function drawPerson(c: OffscreenCanvasRenderingContext2D, f: Frame, x: number, y: number, w: number, h: number): boolean {
  if (useKeyer()) {
    if (keyer === undefined) {
      keyer = ChromaKeyer.create()
      if (!keyer && !keyerFailed) {
        keyerFailed = true
        post({ type: 'bg-status', source: 'keyer', state: 'error', message: 'Green screen needs WebGL2, which this browser or graphics driver has turned off.' })
      }
    }
    if (!keyer) return false
    const { w: fw, h: fh } = frameSize(f)
    if (!fw || !fh) return false
    const keyed = keyer.process(f, fw, fh, bg.keyer === 'blue' ? 'blue' : 'green')
    drawFit(c, keyed, x, y, w, h, 'cover', layout.mirror, layout.cameraRotation)
    return true
  }

  if (!maskFits(f)) return false
  if (!person || person.width !== w || person.height !== h) {
    person = new OffscreenCanvas(w, h)
    personCtx = person.getContext('2d')
    if (personCtx) personCtx.imageSmoothingQuality = 'medium'
  }
  const p = personCtx!
  p.globalCompositeOperation = 'source-over'
  p.clearRect(0, 0, w, h)
  // The small mask, stretched to size (smoothing gives soft edges for free)...
  drawFit(p, mask!, 0, 0, w, h, 'cover', layout.mirror, layout.cameraRotation)
  // ...then the camera, kept only where the mask says "you".
  p.globalCompositeOperation = 'source-in'
  drawFit(p, f, 0, 0, w, h, 'cover', layout.mirror, layout.cameraRotation)
  p.globalCompositeOperation = 'source-over'
  c.drawImage(person, x, y)
  return true
}

function presetCanvas(id: string): OffscreenCanvas {
  let cv = presetCache.get(id)
  if (!cv) {
    const preset = BG_PRESETS.find((p) => p.id === id) ?? BG_PRESETS[0]
    cv = new OffscreenCanvas(W, H)
    preset.draw(cv.getContext('2d')!, W, H)
    presetCache.set(id, cv)
  }
  return cv
}

/**
 * Cheap blur: shrink the camera picture a lot, then stretch it back up in two
 * steps. Looks like a soft lens blur and costs a fraction of a real blur filter.
 */
function drawBlur(c: OffscreenCanvasRenderingContext2D, f: Frame, x: number, y: number, w: number, h: number) {
  const [s1, s2] = bg.blur === 'strong' ? [1 / 10, 1 / 36] : [1 / 6, 1 / 18]
  const aw = Math.max(2, Math.round(w * s1))
  const ah = Math.max(2, Math.round(h * s1))
  const bw = Math.max(2, Math.round(w * s2))
  const bh = Math.max(2, Math.round(h * s2))
  if (blurA.width !== aw || blurA.height !== ah) {
    blurA.width = aw
    blurA.height = ah
  }
  if (blurB.width !== bw || blurB.height !== bh) {
    blurB.width = bw
    blurB.height = bh
  }
  drawFit(blurACtx, f, 0, 0, aw, ah, 'cover', layout.mirror, layout.cameraRotation)
  blurBCtx.drawImage(blurA, 0, 0, bw, bh)
  blurACtx.drawImage(blurB, 0, 0, aw, ah)
  c.save()
  c.imageSmoothingQuality = 'high'
  c.drawImage(blurA, x, y, w, h)
  c.restore()
}

function drawBackground(c: OffscreenCanvasRenderingContext2D, f: Frame, x: number, y: number, w: number, h: number) {
  switch (bg.mode) {
    case 'blur':
      drawBlur(c, f, x, y, w, h)
      break
    case 'color':
      c.fillStyle = bg.color
      c.fillRect(x, y, w, h)
      break
    case 'image':
      drawFit(c, bg.image === 'custom' && bgCustom ? bgCustom : presetCanvas(bg.image === 'custom' ? 'studio' : bg.image), x, y, w, h, 'cover')
      break
  }
}

/** The camera in a rect, with the chosen background effect. */
function drawCamera(c: OffscreenCanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  const f = latest.camera
  if (!f) return
  if (bg.mode !== 'none') {
    c.save()
    c.beginPath()
    c.rect(x, y, w, h)
    c.clip()
    drawBackground(c, f, x, y, w, h)
    const ok = drawPerson(c, f, x, y, w, h)
    c.restore()
    if (ok) return
  }
  drawFit(c, f, x, y, w, h, 'cover', layout.mirror, layout.cameraRotation)
}

// ---------- timing ----------
function recTime(): number {
  if (!rec) return 0
  const now = performance.now()
  const pausedNow = rec.pausedAt ? now - rec.pausedAt : 0
  return (now - rec.startAt - rec.pausedTotal - pausedNow) / 1000
}

function tick() {
  if (pullMode && !pullPending) {
    pullPending = true
    post({ type: 'need-frames' })
  }
  if (cameraEffectOn() && !useKeyer()) requestMask()
  draw()
  const r = rec
  if (r && !r.pausedAt && !r.stopping) {
    encodeFrame(r)
  }
  scheduleTick()
}

function scheduleTick() {
  const interval = 1000 / fps
  const now = performance.now()
  nextTickAt = Math.max(nextTickAt + interval, now + 1)
  if (nextTickAt - now > interval * 3) nextTickAt = now + interval
  tickTimer = setTimeout(tick, nextTickAt - now)
}

function startLoop() {
  if (tickTimer) clearTimeout(tickTimer)
  nextTickAt = performance.now()
  scheduleTick()
}

// ---------- audio ----------
// Timestamps come from counting samples, re-anchored to the video clock at the
// start and after every resume, so audio and video stay in sync.
async function writeAudio(r: Recording, buf: Float32Array<ArrayBuffer>, ch: number, frames: number, sr: number) {
  if (!r.audioSource) return
  if (r.audioResync) {
    r.audioOffset = recTime() - r.audioSamplesWritten / sr
    r.audioResync = false
  }
  let ts = Math.max(0, r.lastAudioEnd, r.audioOffset + r.audioSamplesWritten / sr)
  // Guard against a drifting audio clock: never let audio run more than 0.25 s
  // ahead of or behind the video clock.
  const now = recTime()
  if (ts > now + 0.25) return
  if (ts < now - 0.25) {
    r.audioOffset += now - ts
    ts = now
  }
  const sample = new AudioSample({ data: buf, format: 'f32-planar', numberOfChannels: ch, sampleRate: sr, timestamp: ts })
  r.audioSamplesWritten += frames
  r.lastAudioEnd = ts + frames / sr
  try {
    await r.audioSource.add(sample)
  } finally {
    sample.close()
  }
}

/** Chrome / Edge: AudioData from MediaStreamTrackProcessor. */
async function pumpAudio(reader: ReadableStreamDefaultReader<AudioData>) {
  try {
    while (true) {
      const { value: data, done } = await reader.read()
      if (done) break
      const r = rec
      if (!r || r.audioReader !== reader || r.pausedAt || r.stopping || !r.audioSource) {
        data.close()
        if (!r || r.audioReader !== reader) break
        continue
      }
      const ch = data.numberOfChannels
      const frames = data.numberOfFrames
      const sr = data.sampleRate
      const buf = new Float32Array(ch * frames)
      for (let c = 0; c < ch; c++) {
        data.copyTo(buf.subarray(c * frames, (c + 1) * frames), { planeIndex: c, format: 'f32-planar' })
      }
      data.close()
      r.audioPending = writeAudio(r, buf, ch, frames, sr)
      await r.audioPending
    }
  } catch (e) {
    if (rec && rec.audioReader === reader && !rec.stopping) fail(e)
  }
}

/** Fallback (Firefox): planar PCM chunks posted by an AudioWorklet. */
function listenAudioPort(r: Recording, port: MessagePort) {
  port.onmessage = (e: MessageEvent<PcmChunk>) => {
    if (rec !== r || r.pausedAt || r.stopping || !r.audioSource) return
    const { data, channels, frames, sampleRate } = e.data
    r.audioPending = (r.audioPending ?? Promise.resolve())
      .then(() => writeAudio(r, data, channels, frames, sampleRate))
      .catch((err) => {
        if (rec === r && !r.stopping) fail(err)
      })
  }
}

// ---------- video encoding ----------
// We drive WebCodecs' VideoEncoder ourselves: prefer the GPU encoder, keep a few
// frames queued, and only skip a frame when that queue is truly full. Encoded
// packets are handed to the MP4 muxer in order, without blocking new frames.

interface PickedEncoder {
  codec: VideoCodecUsed
  config: VideoEncoderConfig
  hardware: boolean
}

interface VideoPipe {
  encoder: VideoEncoder
  muxChain: Promise<void>
  /** packets waiting to be written to the file */
  pendingMux: number
}

/** Frames allowed to wait in the encoder before we start skipping. */
const MAX_ENCODE_QUEUE = 8
/** Packets allowed to wait for the disk before we start skipping. */
const MAX_PENDING_MUX = 120
const KEYFRAME_EVERY_S = 2

async function pickVideoEncoder(bitrate: number): Promise<PickedEncoder | null> {
  // Level 4.0 covers 1080p30, 4.2 covers 1080p60.
  const level = fps > 30 ? '2a' : '28'
  const candidates: { codec: VideoCodecUsed; strings: string[] }[] = [
    { codec: 'avc', strings: [`avc1.6400${level}`, `avc1.4d00${level}`, `avc1.42e0${level}`] },
    { codec: 'vp9', strings: ['vp09.00.40.08', 'vp09.00.41.08'] },
  ]
  for (const { codec, strings } of candidates) {
    // Graphics card first; the CPU encoder only if there's no hardware one.
    for (const hardwareAcceleration of ['prefer-hardware', 'no-preference'] as const) {
      for (const codecString of strings) {
        const config: VideoEncoderConfig = {
          codec: codecString,
          width: W,
          height: H,
          bitrate,
          framerate: fps,
          bitrateMode: 'variable',
          latencyMode: 'realtime',
          hardwareAcceleration,
          ...(codec === 'avc' ? { avc: { format: 'avc' } } : {}),
        }
        try {
          const support = await VideoEncoder.isConfigSupported(config)
          if (support.supported) {
            return { codec, config: support.config ?? config, hardware: hardwareAcceleration === 'prefer-hardware' }
          }
        } catch {}
      }
    }
  }
  return null
}

function createVideoPipe(picked: PickedEncoder, source: EncodedVideoPacketSource): VideoPipe {
  const pipe: VideoPipe = {
    encoder: null as unknown as VideoEncoder,
    muxChain: Promise.resolve(),
    pendingMux: 0,
  }
  pipe.encoder = new VideoEncoder({
    output: (chunk, meta) => {
      const packet = EncodedPacket.fromEncodedChunk(chunk)
      pipe.pendingMux++
      pipe.muxChain = pipe.muxChain
        .then(() => source.add(packet, meta))
        .then(() => {
          pipe.pendingMux--
        })
        .catch((e) => {
          if (rec && !rec.stopping) fail(e)
        })
    },
    error: (e) => {
      if (rec && !rec.stopping) fail(e)
    },
  })
  pipe.encoder.configure(picked.config)
  return pipe
}

function encodeFrame(r: Recording) {
  const c = canvas
  const enc = r.video.encoder
  if (!c || enc.state !== 'configured') return
  const t = recTime()
  if (t <= r.lastVideoTs) return
  if (enc.encodeQueueSize >= MAX_ENCODE_QUEUE || r.video.pendingMux >= MAX_PENDING_MUX) {
    r.framesDropped++
    return
  }
  r.lastVideoTs = t
  const frame = new VideoFrame(c, { timestamp: Math.round(t * 1e6), duration: Math.round(1e6 / fps) })
  const keyFrame = t - r.lastKeyTs >= KEYFRAME_EVERY_S
  if (keyFrame) r.lastKeyTs = t
  try {
    enc.encode(frame, { keyFrame })
    r.framesAdded++
  } finally {
    frame.close()
  }
}

async function finishVideo(pipe: VideoPipe) {
  if (pipe.encoder.state === 'configured') await pipe.encoder.flush()
  await pipe.muxChain
  closeVideo(pipe)
}

function closeVideo(pipe: VideoPipe) {
  if (pipe.encoder.state !== 'closed') {
    try { pipe.encoder.close() } catch {}
  }
}

// ---------- start / stop ----------
async function openWritable(target: SaveTarget): Promise<FileSystemWritableFileStream> {
  if (target.kind === 'handle') return await target.handle.createWritable()
  const root = await navigator.storage.getDirectory()
  const fh = await root.getFileHandle(target.name, { create: true })
  return await fh.createWritable()
}

async function start(msg: Extract<ToWorker, { type: 'start' }>) {
  if (rec) throw new Error('Already recording')
  if (!canvas) throw new Error('Preview is not ready yet')
  const { target, videoBitrate, audioReadable, audioPort, audioChannels } = msg

  const picked = await pickVideoEncoder(videoBitrate)
  if (!picked) throw new Error('This browser cannot encode 1080p video. Use the latest Chrome or Edge.')
  const videoCodec = picked.codec

  const fileWritable = await openWritable(target)
  const bytes = { value: 0 }
  const writable = new WritableStream<StreamTargetChunk>({
    write(chunk) {
      bytes.value = Math.max(bytes.value, chunk.position + chunk.data.byteLength)
      return fileWritable.write({ type: 'write', position: chunk.position, data: chunk.data })
    },
    close() {
      return fileWritable.close()
    },
    abort(reason) {
      return fileWritable.abort(reason)
    },
  })

  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: false }),
    target: new StreamTarget(writable, { chunked: true, chunkSize: 8 * 1024 * 1024 }),
  })

  const videoSource = new EncodedVideoPacketSource(videoCodec)
  output.addVideoTrack(videoSource, { frameRate: fps })
  const video = createVideoPipe(picked, videoSource)

  let audioSource: AudioSampleSource | null = null
  let audioCodec: AudioCodecUsed = null
  if (audioReadable || audioPort) {
    const numberOfChannels = audioChannels || 2
    if (await canEncodeAudio('aac', { numberOfChannels, sampleRate: 48000, bitrate: 192000 })) {
      audioCodec = 'aac'
    } else if (await canEncodeAudio('opus', { numberOfChannels, sampleRate: 48000, bitrate: 160000 })) {
      audioCodec = 'opus'
    }
    if (audioCodec) {
      audioSource = new AudioSampleSource({ codec: audioCodec, bitrate: audioCodec === 'aac' ? 192000 : 160000 })
      output.addAudioTrack(audioSource)
    }
  }

  await output.start()

  const r: Recording = {
    output,
    video,
    audioSource,
    audioCodec,
    videoCodec,
    audioPort,
    startAt: performance.now(),
    pausedTotal: 0,
    pausedAt: 0,
    lastVideoTs: -1,
    lastKeyTs: -Infinity,
    framesAdded: 0,
    framesDropped: 0,
    audioReader: null,
    audioPending: null,
    audioSamplesWritten: 0,
    audioOffset: 0,
    audioResync: true,
    lastAudioEnd: 0,
    bytes,
    stopping: false,
    target: { kind: target.kind, name: target.name },
  }
  rec = r

  if (audioReadable) {
    const reader = audioReadable.getReader()
    r.audioReader = reader
    if (audioSource) void pumpAudio(reader)
    else reader.cancel().catch(() => {})
  }
  if (audioPort) {
    if (audioSource) listenAudioPort(r, audioPort)
    else audioPort.close()
  }

  post({ type: 'started', audioCodec, videoCodec, hardwareEncoder: picked.hardware })
}

async function stopAudio(r: Recording) {
  if (r.audioPort) {
    r.audioPort.onmessage = null
    r.audioPort.close()
  }
  if (r.audioReader) {
    try { await r.audioReader.cancel() } catch {}
  }
  if (r.audioPending) await r.audioPending.catch(() => {})
}

async function stop() {
  const r = rec
  if (!r) return
  r.stopping = true
  const duration = recTime()
  await finishVideo(r.video)
  await stopAudio(r)
  await r.output.finalize()
  const result: StopResult = {
    duration,
    bytes: r.bytes.value,
    framesAdded: r.framesAdded,
    framesDropped: r.framesDropped,
    audioCodec: r.audioCodec,
    videoCodec: r.videoCodec,
    target: r.target,
  }
  rec = null
  post({ type: 'stopped', ...result })
}

async function discard() {
  const r = rec
  if (!r) return
  r.stopping = true
  closeVideo(r.video)
  await stopAudio(r)
  try { await r.output.cancel() } catch {}
  rec = null
  post({ type: 'discarded', target: r.target })
}

function fail(err: unknown) {
  const r = rec
  rec = null
  if (r) {
    r.audioReader?.cancel().catch(() => {})
    r.audioPort?.close()
    closeVideo(r.video)
    r.output.cancel().catch(() => {})
  }
  post({ type: 'error', message: errorMessage(err), target: r?.target })
}

// ---------- stats ----------
setInterval(() => {
  if (rec && !rec.stopping) {
    post({ type: 'stats', time: recTime(), bytes: rec.bytes.value, paused: !!rec.pausedAt, dropped: rec.framesDropped })
  }
}, 250)

// ---------- messages ----------
self.onmessage = async (e: MessageEvent<ToWorker>) => {
  const msg = e.data
  try {
    switch (msg.type) {
      case 'init': {
        canvas = msg.canvas
        canvas.width = W
        canvas.height = H
        ctx = canvas.getContext('2d', { alpha: false, desynchronized: true })
        if (ctx) ctx.imageSmoothingQuality = 'high'
        startLoop()
        break
      }
      case 'source':
        await setSource(msg.key, msg.readable)
        break
      case 'pull-mode':
        pullMode = msg.on
        pullPending = false
        break
      case 'frames':
        pullPending = false
        setFrames(msg.frames)
        break
      case 'layout':
        layout = { ...layout, ...msg.layout }
        break
      case 'background':
        bg = { ...msg.background }
        break
      case 'bg-image':
        bgCustom?.close()
        bgCustom = msg.image
        break
      case 'segmenter':
        segPort = msg.port
        segPort.onmessage = (ev: MessageEvent<SegReply>) => onSegReply(ev.data)
        break
      case 'fps':
        if (!rec) {
          fps = msg.fps
          startLoop()
        }
        break
      case 'start':
        await start(msg)
        break
      case 'pause':
        if (rec && !rec.pausedAt) {
          rec.pausedAt = performance.now()
          post({ type: 'paused' })
        }
        break
      case 'resume':
        if (rec && rec.pausedAt) {
          rec.pausedTotal += performance.now() - rec.pausedAt
          rec.pausedAt = 0
          rec.audioResync = true
          post({ type: 'resumed' })
        }
        break
      case 'stop':
        await stop()
        break
      case 'discard':
        await discard()
        break
    }
  } catch (err) {
    if (msg.type === 'start' || msg.type === 'stop') fail(err)
    else post({ type: 'error', message: errorMessage(err) })
  }
}
