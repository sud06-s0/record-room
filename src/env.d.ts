// src/env.d.ts
/// <reference types="vite/client" />

// Newer browser APIs that TypeScript's built-in types don't include yet.

interface MediaStreamTrackProcessorInit {
  track: MediaStreamTrack
  maxBufferSize?: number
}
declare class MediaStreamTrackProcessor<T extends VideoFrame | AudioData = VideoFrame> {
  constructor(init: MediaStreamTrackProcessorInit)
  readonly readable: ReadableStream<T>
}

type CaptureFocusBehavior = 'focus-capturing-application' | 'focus-captured-surface' | 'no-focus-change'
declare class CaptureController extends EventTarget {
  constructor()
  setFocusBehavior(behavior: CaptureFocusBehavior): void
}

interface DisplayMediaStreamOptions {
  controller?: CaptureController
  systemAudio?: 'include' | 'exclude'
  selfBrowserSurface?: 'include' | 'exclude'
  surfaceSwitching?: 'include' | 'exclude'
  monitorTypeSurfaces?: 'include' | 'exclude'
  preferCurrentTab?: boolean
}

interface DocumentPictureInPictureOptions {
  width?: number
  height?: number
  disallowReturnToOpener?: boolean
  preferInitialWindowPlacement?: boolean
}
interface DocumentPictureInPicture extends EventTarget {
  requestWindow(options?: DocumentPictureInPictureOptions): Promise<Window>
  readonly window: Window | null
}
interface Window {
  documentPictureInPicture?: DocumentPictureInPicture
}

interface FileSystemFileHandle {
  /** Chrome 110+ */
  move?(destination: FileSystemDirectoryHandle, newName: string): Promise<void>
}

interface MediaTrackConstraintSet {
  /** Chrome: keep playing tab audio locally while it's captured */
  suppressLocalAudioPlayback?: ConstrainBoolean
}
