// src/shared/types.ts
// Types shared by the app and the compositor worker.

export type LayoutMode = 'camera' | 'bubble' | 'split'
export type BubbleSize = 'small' | 'medium' | 'large'
export type Corner = 'bl' | 'br' | 'tl' | 'tr'
export type Fit = 'contain' | 'cover'
export type Rotation = 0 | 90 | 180 | 270
export type SourceKey = 'screen' | 'camera'
export type AudioCodecUsed = 'aac' | 'opus' | null
export type VideoCodecUsed = 'avc' | 'vp9'

// ---------- camera background ----------
export type BgMode = 'none' | 'blur' | 'image' | 'color'
export type BgBlur = 'light' | 'strong'
/** How you're separated from the background: AI, or a real green / blue screen. */
export type BgKeyer = 'ai' | 'green' | 'blue'

export interface Background {
  mode: BgMode
  blur: BgBlur
  /** A preset id from shared/backgrounds.ts, or 'custom' for an uploaded picture */
  image: string
  /** CSS hex colour, e.g. '#18181b' */
  color: string
  keyer: BgKeyer
  /** Screen + bubble only: drop the circle and the background, so you appear over the screen */
  cutout: boolean
}

/** Progress of the background AI, shown under the background picker. */
export interface BgStatus {
  type: 'bg-status'
  /** 'ai' = the segmenter, 'keyer' = the green screen shader */
  source: 'ai' | 'keyer'
  state: 'loading' | 'ready' | 'error'
  /** Where the AI runs: the graphics chip or the CPU */
  delegate?: 'GPU' | 'CPU'
  /** Average time per mask, in ms */
  ms?: number
  message?: string
}

// compositor <-> segmenter (over a MessagePort)
export interface SegRequest {
  type: 'frame'
  bitmap: ImageBitmap
}
export type SegReply =
  | { type: 'mask'; data: Uint8ClampedArray<ArrayBuffer>; width: number; height: number; ms: number }
  | { type: 'skip' }

// main thread -> segmenter worker
export interface SegInit {
  type: 'init'
  wasmBase: string
  modelUrl: string
  port: MessagePort
}

export interface Layout {
  mode: LayoutMode
  bubbleSize: BubbleSize
  bubbleCorner: Corner
  mirror: boolean
  splitFit: Fit
  hasCamera: boolean
  /** Extra clockwise turn applied to the camera picture */
  cameraRotation: Rotation
}

export type SaveTarget =
  | { kind: 'handle'; handle: FileSystemFileHandle; name: string }
  | { kind: 'opfs'; name: string }

export interface TargetInfo {
  kind: SaveTarget['kind']
  name: string
}

// ---------- app -> worker ----------
export type ToWorker =
  | { type: 'init'; canvas: OffscreenCanvas }
  | { type: 'source'; key: SourceKey; readable: ReadableStream<VideoFrame> | null }
  | { type: 'layout'; layout: Partial<Layout> }
  | { type: 'fps'; fps: number }
  /** Fallback for browsers without MediaStreamTrackProcessor (Firefox): the page sends frames when asked */
  | { type: 'pull-mode'; on: boolean }
  | { type: 'frames'; frames: Partial<Record<SourceKey, ImageBitmap>> }
  | { type: 'background'; background: Background }
  /** The uploaded background picture (null = none) */
  | { type: 'bg-image'; image: ImageBitmap | null }
  /** Line to the segmenter worker, sent the first time the background AI is needed */
  | { type: 'segmenter'; port: MessagePort }
  | {
      type: 'start'
      target: SaveTarget
      videoBitrate: number
      audioReadable: ReadableStream<AudioData> | null
      /** Fallback audio path: planar Float32 chunks from an AudioWorklet */
      audioPort: MessagePort | null
      audioChannels: number
    }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'stop' }
  | { type: 'discard' }

// ---------- worker -> app ----------
export interface StopResult {
  duration: number
  bytes: number
  framesAdded: number
  framesDropped: number
  audioCodec: AudioCodecUsed
  videoCodec: VideoCodecUsed
  target: TargetInfo
}

export type FromWorker =
  | { type: 'started'; audioCodec: AudioCodecUsed; videoCodec: VideoCodecUsed; hardwareEncoder: boolean }
  | { type: 'need-frames' }
  | { type: 'stats'; time: number; bytes: number; paused: boolean; dropped: number }
  | { type: 'paused' }
  | { type: 'resumed' }
  | ({ type: 'stopped' } & StopResult)
  | { type: 'discarded'; target: TargetInfo }
  | { type: 'error'; message: string; target?: TargetInfo }
  | BgStatus

export type StudioEvent = FromWorker | { type: 'screen-ended' }

/** Message an AudioWorklet posts on the fallback audio port. */
export interface PcmChunk {
  data: Float32Array<ArrayBuffer>
  frames: number
  channels: number
  sampleRate: number
}
