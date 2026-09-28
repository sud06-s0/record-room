// src/lib/studio.ts
// Main-thread controller: grabs camera / mic / screen, wires them into the
// compositor worker and the audio mixer, and drives recording.

import { AudioMixer, type NcMode } from './audio'
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

export function browserSupport(): string[] {
  const missing: string[] = []
  if (!('VideoEncoder' in window)) missing.push('WebCodecs (VideoEncoder)')
  if (!('MediaStreamTrackProcessor' in window)) missing.push('MediaStreamTrackProcessor')
  if (!('OffscreenCanvas' in window)) missing.push('OffscreenCanvas')
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
  private screenStream: MediaStream | null = null
  private fps = 30

  constructor(
    canvasEl: HTMLCanvasElement,
    private readonly onEvent: (ev: StudioEvent) => void,
  ) {
    this.worker = new Worker(new URL('../workers/compositor.worker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => this.onEvent(e.data)
    this.worker.onerror = (e) => this.onEvent({ type: 'error', message: e.message || 'Worker error' })
    const off = canvasEl.transferControlToOffscreen()
    this.send({ type: 'init', canvas: off }, [off])
  }

  private send(msg: ToWorker, transfer: Transferable[] = []) {
    this.worker.postMessage(msg, transfer)
  }

  private sendTrack(key: SourceKey, track: MediaStreamTrack | null) {
    if (!track) {
      this.send({ type: 'source', key, readable: null })
      return
    }
    const { readable } = new MediaStreamTrackProcessor<VideoFrame>({ track })
    this.send({ type: 'source', key, readable }, [readable])
  }

  // ---------- camera ----------
  /** deviceId: specific camera, undefined = default, 'none' = no camera */
  async setCamera(deviceId?: string): Promise<MediaTrackSettings | null> {
    stopStream(this.cameraStream)
    this.cameraStream = null
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
    const track = stream.getVideoTracks()[0]
    track.contentHint = 'motion'
    this.sendTrack('camera', track.clone())
    return track.getSettings()
  }

  /** A separate stream for on-screen previews (floating controls). */
  cameraPreview(): MediaStream | null {
    return this.cameraStream ? new MediaStream(this.cameraStream.getVideoTracks().map((t) => t.clone())) : null
  }

  // ---------- microphone ----------
  async setMic(deviceId: string | undefined, ncMode: NcMode) {
    stopStream(this.micStream)
    this.micStream = null
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
      audio: audio
        ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: false }
        : false,
      systemAudio: audio ? 'include' : 'exclude',
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
      monitorTypeSurfaces: 'include',
      preferCurrentTab: false,
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
  start({ target, bitrate, withAudio }: { target: SaveTarget; bitrate: number; withAudio: boolean }) {
    let audioReadable: ReadableStream<AudioData> | null = null
    const transfer: Transferable[] = []
    if (withAudio) {
      audioReadable = new MediaStreamTrackProcessor<AudioData>({ track: this.mixer.track.clone() }).readable
      transfer.push(audioReadable)
    }
    this.send({ type: 'start', target, videoBitrate: bitrate, audioReadable, audioChannels: 2 }, transfer)
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
    stopStream(this.cameraStream)
    stopStream(this.micStream)
    stopStream(this.screenStream)
    this.worker.terminate()
    void this.mixer.ctx.close()
  }
}
