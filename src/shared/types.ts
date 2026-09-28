// src/shared/types.ts
// Types shared by the app and the compositor worker.

export type LayoutMode = 'camera' | 'bubble' | 'split'
export type BubbleSize = 'small' | 'medium' | 'large'
export type Corner = 'bl' | 'br' | 'tl' | 'tr'
export type Fit = 'contain' | 'cover'
export type SourceKey = 'screen' | 'camera'
export type AudioCodecUsed = 'aac' | 'opus' | null

export interface Layout {
  mode: LayoutMode
  bubbleSize: BubbleSize
  bubbleCorner: Corner
  mirror: boolean
  splitFit: Fit
  hasCamera: boolean
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
  | {
      type: 'start'
      target: SaveTarget
      videoBitrate: number
      audioReadable: ReadableStream<AudioData> | null
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
  target: TargetInfo
}

export type FromWorker =
  | { type: 'started'; audioCodec: AudioCodecUsed }
  | { type: 'stats'; time: number; bytes: number; paused: boolean; dropped: number }
  | { type: 'paused' }
  | { type: 'resumed' }
  | ({ type: 'stopped' } & StopResult)
  | { type: 'discarded'; target: TargetInfo }
  | { type: 'error'; message: string; target?: TargetInfo }

export type StudioEvent = FromWorker | { type: 'screen-ended' }
