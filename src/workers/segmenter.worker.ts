// src/workers/segmenter.worker.ts
// Finds you in the camera picture so the background can be blurred or replaced.
//
// Kept light for PCs without a graphics card:
// - MediaPipe's smallest selfie model (~250 KB, 256x144 input).
// - Runs on the built-in graphics chip (WebGL) when it can, otherwise on the
//   CPU (WASM + SIMD).
// - Its own worker, so a slow mask never holds up recording. The compositor
//   asks for a mask about 15 times a second and reuses the last one between.

import { FilesetResolver, ImageSegmenter, type ImageSegmenterResult } from '@mediapipe/tasks-vision'
import type { BgStatus, SegInit, SegReply, SegRequest } from '../shared/types'

declare const self: DedicatedWorkerGlobalScope

type Delegate = 'GPU' | 'CPU'

let segmenter: ImageSegmenter | null = null
let delegate: Delegate = 'GPU'
let port: MessagePort | null = null
let lastTs = 0
let avgMs = 0
let lastReport = 0
/** Last mask (0..1), blended with the new one to stop edges flickering. */
let prev: Float32Array | null = null

/** Masks made since the current delegate started (to judge its speed). */
let framesOnDelegate = 0

let fileset: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>> | null = null
let model: Uint8Array | null = null

const status = (s: Omit<BgStatus, 'type' | 'source'>) =>
  self.postMessage({ type: 'bg-status', source: 'ai', ...s } satisfies BgStatus)

async function create(d: Delegate): Promise<ImageSegmenter> {
  return ImageSegmenter.createFromOptions(fileset!, {
    baseOptions: { modelAssetBuffer: model!.slice(), delegate: d },
    runningMode: 'VIDEO',
    outputConfidenceMasks: true,
    outputCategoryMask: false,
    ...(d === 'GPU' ? { canvas: new OffscreenCanvas(1, 1) } : {}),
  })
}

/**
 * Is there a real graphics chip? With the GPU blocklisted, Chrome emulates
 * WebGL on the CPU (SwiftShader), which is far slower than the CPU path.
 */
function hasRealGpu(): boolean {
  try {
    const gl = new OffscreenCanvas(1, 1).getContext('webgl2')
    if (!gl) return false
    const info = gl.getExtension('WEBGL_debug_renderer_info')
    const renderer = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER))
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return !/swiftshader|llvmpipe|softpipe|software|basic render/i.test(renderer)
  } catch {
    return false
  }
}

async function init(msg: SegInit) {
  port = msg.port
  port.onmessage = (e: MessageEvent<SegRequest>) => onFrame(e.data)
  status({ state: 'loading' })
  try {
    const res = await fetch(msg.modelUrl)
    if (!res.ok) throw new Error(`Could not download the background model (${res.status})`)
    model = new Uint8Array(await res.arrayBuffer())
    fileset = await FilesetResolver.forVisionTasks(msg.wasmBase, true)
    try {
      if (!hasRealGpu()) throw new Error('no graphics chip')
      segmenter = await create('GPU')
      delegate = 'GPU'
    } catch {
      segmenter = await create('CPU')
      delegate = 'CPU'
    }
    framesOnDelegate = 0
    status({ state: 'ready', delegate })
  } catch (e) {
    status({ state: 'error', message: e instanceof Error ? e.message : String(e) })
  }
}

/** Graphics chip failed on a real frame: switch to the CPU for good. */
async function fallBackToCpu() {
  try { segmenter?.close() } catch {}
  segmenter = null
  try {
    segmenter = await create('CPU')
    delegate = 'CPU'
    prev = null
    avgMs = 0
    framesOnDelegate = 0
    status({ state: 'ready', delegate })
  } catch (e) {
    status({ state: 'error', message: e instanceof Error ? e.message : String(e) })
  }
}

function reply(msg: SegReply, transfer: Transferable[] = []) {
  port?.postMessage(msg, transfer)
}

function onFrame(req: SegRequest) {
  const bitmap = req.bitmap
  const seg = segmenter
  if (!seg) {
    bitmap.close()
    reply({ type: 'skip' })
    return
  }
  const t0 = performance.now()
  lastTs = Math.max(lastTs + 1, t0)
  let out: SegReply | null = null
  try {
    seg.segmentForVideo(bitmap, lastTs, (result: ImageSegmenterResult) => {
      const mask = result.confidenceMasks?.[0]
      if (!mask) return
      out = toAlpha(mask.getAsFloat32Array(), mask.width, mask.height, t0)
    })
  } catch (e) {
    bitmap.close()
    reply({ type: 'skip' })
    if (delegate === 'GPU') void fallBackToCpu()
    else status({ state: 'error', message: e instanceof Error ? e.message : String(e) })
    return
  }
  bitmap.close()
  if (!out) {
    reply({ type: 'skip' })
    return
  }
  const m = out as Extract<SegReply, { type: 'mask' }>
  reply(m, [m.data.buffer])

  avgMs = avgMs ? avgMs * 0.9 + m.ms * 0.1 : m.ms
  framesOnDelegate++
  // Graphics chip turned out slow (old driver, emulation): the CPU will do better.
  if (delegate === 'GPU' && framesOnDelegate >= 10 && avgMs > 35) {
    void fallBackToCpu()
    return
  }
  if (t0 - lastReport > 2000) {
    lastReport = t0
    status({ state: 'ready', delegate, ms: Math.round(avgMs * 10) / 10 })
  }
}

/** Confidence (0..1) -> RGBA picture whose alpha is "this pixel is you". */
function toAlpha(conf: Float32Array, width: number, height: number, t0: number): SegReply {
  const n = width * height
  if (!prev || prev.length !== n) prev = new Float32Array(conf)
  const data = new Uint8ClampedArray(n * 4)
  for (let i = 0; i < n; i++) {
    // A little of the last mask keeps edges steady; most of the new one keeps them on time.
    const c = prev[i] * 0.3 + conf[i] * 0.7
    prev[i] = c
    // Tighten the soft edge: below 0.3 is background, above 0.7 is you.
    let a = (c - 0.3) * 2.5
    a = a < 0 ? 0 : a > 1 ? 1 : a
    data[i * 4 + 3] = a * 255
  }
  return { type: 'mask', data, width, height, ms: performance.now() - t0 }
}

self.onmessage = (e: MessageEvent<SegInit>) => {
  if (e.data.type === 'init') void init(e.data)
}
