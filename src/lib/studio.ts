// src/lib/studio.ts
// Main-thread controller: grabs camera / mic / screen, wires them into the
// compositor worker and the audio mixer, and drives recording.

import { AudioMixer, type NcMode, type PcmTap } from './audio'
import type { FromWorker, Layout, SaveTarget, SourceKey, StudioEvent, ToWorker } from '../shared/types'

export type QualityKey = '1080p30' | '1080p60'
export const QUALITY: Record<QualityKey, { fps: number; bitrate: number; label: string; mbPerMin: number }> = {
  '1080p30': { fps: 30, bitrate: 10_000_000, label: '1080p · 30 fps', mbPerMin: 76 },
  '1080p60': { fps: 60, bitrate: 16_000_000, label: '1080p · 60 fps', mbPerMin: 122 },
}

export type Surface = 'browser' | 'window' | 'monitor'

export interface ScreenInfo {
  surface: string
  label: string
  width?: number
  height?: number
  hasAudio: boolean
}

const isFirefox = /firefox/i.test(navigator.userAgent)
const hasTrackProcessor = 'MediaStreamTrackProcessor' in window

/** What this browser can do. Chrome / Edge: everything. Firefox: a reduced set. */
export const CAPS = {
  /** Full-speed capture in the worker. Without it frames are pulled from hidden <video>s. */
  trackProcessor: hasTrackProcessor,
  /** Record a single browser tab */
  tabCapture: !isFirefox,
  /** PC / tab sound from screen sharing */
  displayAudio: !isFirefox,
  /** Full feature set available */
  full: hasTrackProcessor && !isFirefox,
}

export function browserSupport(): string[] {
  const missing: string[] = []
  if (!('VideoEncoder' in window)) missing.push('WebCodecs (VideoEncoder)')
  if (!('AudioEncoder' in window)) missing.push('WebCodecs (AudioEncoder)')
  if (!('transferControlToOffscreen' in HTMLCanvasElement.prototype)) missing.push('OffscreenCanvas')
  if (!navigator.mediaDevices?.getDisplayMedia) missing.push('Screen capture')
  if (!('AudioWorkletNode' in window)) missing.push('AudioWorklet')
  return missing
}

function stopStream(s: MediaStream | null) {
  s?.getTracks().forEach((t) => t.stop())
}

export class Studio {
  readonly mixer = new AudioMixer()
  private readonly worker: Worker
  private cameraStream: MediaStream | null = null
  private micStream: MediaStream | null = null
  /** false when the stream comes from the phone link (not ours to stop) */
  private cameraOwned = true
  private micOwned = true
  private screenStream: MediaStream | null = null
  private fps = 30
  /** Tracks currently feeding the worker, so they can be stopped when replaced. */
  private readonly sentTracks: Partial<Record<SourceKey, MediaStreamTrack>> = {}
  /** Fallback (Firefox): hidden <video> elements frames are grabbed from. */
  private readonly pullVideos: Partial<Record<SourceKey, HTMLVideoElement>> = {}
  private grabbing = false
  private tap: PcmTap | null = null

  constructor(
    canvasEl: HTMLCanvasElement,
    private readonly onEvent: (ev: StudioEvent) => void,
  ) {
    this.worker = new Worker(new URL('../workers/compositor.worker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => this.handleWorker(e.data)
    this.worker.onerror = (e) => this.onEvent({ type: 'error', message: e.message || 'Worker error' })
    const off = canvasEl.transferControlToOffscreen()
    this.send({ type: 'init', canvas: off }, [off])
    if (!CAPS.trackProcessor) this.send({ type: 'pull-mode', on: true })
  }

  private handleWorker(msg: FromWorker) {
    if (msg.type === 'need-frames') {
      void this.grabFrames()
      return
    }
    if (msg.type === 'stopped' || msg.type === 'discarded' || msg.type === 'error') {
      this.tap?.stop()
      this.tap = null
    }
    this.onEvent(msg)
  }

  /** Fallback: snapshot the hidden videos and hand the images to the worker. */
  private async grabFrames() {
    if (this.grabbing) return
    this.grabbing = true
    const frames: Partial<Record<SourceKey, ImageBitmap>> = {}
    const transfer: Transferable[] = []
    try {
      for (const key of ['screen', 'camera'] as const) {
        const v = this.pullVideos[key]
        if (!v || v.readyState < 2 || !v.videoWidth) continue
        try {
          const bmp = await createImageBitmap(v)
          frames[key] = bmp
          transfer.push(bmp)
        } catch {}
      }
    } finally {
      this.grabbing = false
      this.send({ type: 'frames', frames }, transfer)
    }
  }

  private send(msg: ToWorker, transfer: Transferable[] = []) {
    this.worker.postMessage(msg, transfer)
  }

  private sendTrack(key: SourceKey, track: MediaStreamTrack | null) {
    this.sentTracks[key]?.stop()
    this.sentTracks[key] = track ?? undefined
    const oldVideo = this.pullVideos[key]
    if (oldVideo) {
      oldVideo.srcObject = null
      oldVideo.remove()
      delete this.pullVideos[key]
    }

    if (!track) {
      this.send({ type: 'source', key, readable: null })
      return
    }
    if (CAPS.trackProcessor) {
      const { readable } = new MediaStreamTrackProcessor<VideoFrame>({ track })
      this.send({ type: 'source', key, readable }, [readable])
      return
    }
    // Fallback: play the track in an invisible (but rendered) <video>.
    this.send({ type: 'source', key, readable: null })
    const v = document.createElement('video')
    v.muted = true
    v.playsInline = true
    v.autoplay = true
    v.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:-1'
    v.srcObject = new MediaStream([track])
    document.body.appendChild(v)
    void v.play().catch(() => {})
    this.pullVideos[key] = v
  }

  // ---------- camera ----------
  /** deviceId: specific camera, undefined = default, 'none' = no camera */
  async setCamera(deviceId?: string): Promise<MediaTrackSettings | null> {
    this.releaseCamera()
    if (deviceId === 'none') {
      this.sendTrack('camera', null)
      return null
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: this.fps },
      },
      audio: false,
    })
    this.cameraStream = stream
    this.cameraOwned = true
    const track = stream.getVideoTracks()[0]
    track.contentHint = 'motion'
    this.sendTrack('camera', track.clone())
    return track.getSettings()
  }

  private releaseCamera() {
    if (this.cameraOwned) stopStream(this.cameraStream)
    this.cameraStream = null
    this.cameraOwned = true
  }

  private releaseMic() {
    if (this.micOwned) stopStream(this.micStream)
    this.micStream = null
    this.micOwned = true
  }

  /** Use a camera that lives elsewhere (the phone link). null = no camera. */
  setCameraStream(stream: MediaStream | null) {
    this.releaseCamera()
    const track = stream?.getVideoTracks()[0]
    if (!stream || !track) {
      this.sendTrack('camera', null)
      return
    }
    this.cameraStream = stream
    this.cameraOwned = false
    this.sendTrack('camera', track.clone())
  }

  /** Use a mic that lives elsewhere (the phone link), with the same noise removal. */
  async setMicStream(stream: MediaStream | null, ncMode: NcMode) {
    this.releaseMic()
    const tracks = stream?.getAudioTracks() ?? []
    if (!tracks.length) {
      await this.mixer.setMic(null)
      return
    }
    this.micStream = new MediaStream(tracks)
    this.micOwned = false
    await this.mixer.resume()
    await this.mixer.setMic(this.micStream, ncMode)
  }

  /** A separate stream for on-screen previews (floating controls). */
  cameraPreview(): MediaStream | null {
    return this.cameraStream ? new MediaStream(this.cameraStream.getVideoTracks().map((t) => t.clone())) : null
  }

  // ---------- microphone ----------
  async setMic(deviceId: string | undefined, ncMode: NcMode) {
    this.releaseMic()
    if (deviceId === 'none') {
      await this.mixer.setMic(null)
      return
    }
    const ai = ncMode !== 'off'
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        channelCount: 1,
        sampleRate: 48000,
        echoCancellation: true,
        // When AI noise removal is on, turn off the browser's own suppressor so
        // the two don't fight and make your voice sound robotic.
        noiseSuppression: !ai,
        autoGainControl: true,
      },
      video: false,
    })
    this.micStream = stream
    this.micOwned = true
    await this.mixer.resume()
    await this.mixer.setMic(stream, ncMode)
  }

  // ---------- screen ----------
  /** Must be called from a click. */
  async chooseScreen({ surface = 'browser', audio = true }: { surface?: Surface; audio?: boolean } = {}): Promise<ScreenInfo> {
    const options: DisplayMediaStreamOptions = {
      video: {
        displaySurface: surface,
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: this.fps, max: this.fps },
      },
      audio: audio && CAPS.displayAudio
        ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: false }
        : false,
    }
    if (!isFirefox) {
      Object.assign(options, {
        systemAudio: audio ? 'include' : 'exclude',
        selfBrowserSurface: 'exclude',
        surfaceSwitching: 'include',
        monitorTypeSurfaces: 'include',
        preferCurrentTab: false,
      } satisfies DisplayMediaStreamOptions)
    }
    // Stay on this page after picking, so you can check the preview first.
    if ('CaptureController' in window) {
      const controller = new CaptureController()
      try {
        controller.setFocusBehavior('no-focus-change')
      } catch {}
      options.controller = controller
    }
    const stream = await navigator.mediaDevices.getDisplayMedia(options)

    stopStream(this.screenStream)
    this.screenStream = stream
    const track = stream.getVideoTracks()[0]
    track.contentHint = 'detail'
    track.addEventListener('ended', () => {
      if (this.screenStream === stream) {
        this.screenStream = null
        this.sendTrack('screen', null)
        this.mixer.setSystem(null)
        this.onEvent({ type: 'screen-ended' })
      }
    })
    this.sendTrack('screen', track.clone())
    const hasAudio = stream.getAudioTracks().length > 0
    this.mixer.setSystem(hasAudio ? stream : null)

    const s = track.getSettings()
    return { surface: s.displaySurface || surface, label: track.label, width: s.width, height: s.height, hasAudio }
  }

  stopScreen() {
    stopStream(this.screenStream)
    this.screenStream = null
    this.sendTrack('screen', null)
    this.mixer.setSystem(null)
  }

  // ---------- settings ----------
  setLayout(layout: Partial<Layout>) {
    this.send({ type: 'layout', layout })
  }
  setFps(fps: number) {
    this.fps = fps
    this.send({ type: 'fps', fps })
  }

  // ---------- recording ----------
  async start({ target, bitrate, withAudio }: { target: SaveTarget; bitrate: number; withAudio: boolean }) {
    let audioReadable: ReadableStream<AudioData> | null = null
    let audioPort: MessagePort | null = null
    const transfer: Transferable[] = []
    try {
      if (withAudio && CAPS.trackProcessor) {
        audioReadable = new MediaStreamTrackProcessor<AudioData>({ track: this.mixer.track.clone() }).readable
        transfer.push(audioReadable)
      } else if (withAudio) {
        this.tap = await this.mixer.createPcmTap()
        audioPort = this.tap.port
        transfer.push(audioPort)
      }
    } catch (e) {
      this.onEvent({ type: 'error', message: `Audio: ${e instanceof Error ? e.message : String(e)}` })
      return
    }
    this.send({ type: 'start', target, videoBitrate: bitrate, audioReadable, audioPort, audioChannels: 2 }, transfer)
  }
  pause() {
    this.send({ type: 'pause' })
  }
  resume() {
    this.send({ type: 'resume' })
  }
  stop() {
    this.send({ type: 'stop' })
  }
  discard() {
    this.send({ type: 'discard' })
  }

  destroy() {
    this.sendTrack('screen', null)
    this.sendTrack('camera', null)
    this.tap?.stop()
    this.releaseCamera()
    this.releaseMic()
    stopStream(this.screenStream)
    this.worker.terminate()
    void this.mixer.ctx.close()
  }
}
