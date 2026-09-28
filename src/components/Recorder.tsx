// src/components/Recorder.tsx
import { useCallback, useEffect, useRef, useState } from 'react'
import { Studio, QUALITY, CAPS, type QualityKey, type ScreenInfo, type Surface } from '../lib/studio'
import { useSettings } from '../lib/settings'
import { NC_MODES } from '../lib/audio'
import {
  createFile,
  makeFileName,
  downloadFromOpfs,
  removeFromOpfs,
  formatBytes,
  formatTime,
  canPickFolder,
  errorMessage,
  errorName,
  type FolderState,
} from '../lib/folder'
import LayoutPicker from './LayoutPicker'
import FloatingControls, { openPipWindow, pipSupported, type RecStatus } from './FloatingControls'
import { Section, Select, Segmented, Toggle, Slider, Label } from './ui'
import VideoModal from './VideoModal'
import type { SaveTarget, StopResult, StudioEvent } from '../shared/types'

const SURFACE_LABEL: Record<string, string> = { browser: 'Browser tab', window: 'Window', monitor: 'Entire screen' }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface SavedInfo extends StopResult {
  name: string
  handle?: FileSystemFileHandle
}

interface Props {
  folder: FolderState
  onPickFolder: () => void
  onReconnectFolder: () => void
  onRecordingSaved?: () => void
}

export default function Recorder({ folder, onPickFolder, onReconnectFolder, onRecordingSaved }: Props) {
  const [s, set] = useSettings()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const studioRef = useRef<Studio | null>(null)
  const [ready, setReady] = useState(false)
  const [devices, setDevices] = useState<{ cams: MediaDeviceInfo[]; mics: MediaDeviceInfo[] }>({ cams: [], mics: [] })
  const [screenInfo, setScreenInfo] = useState<ScreenInfo | null>(null)
  const [status, setStatus] = useState<RecStatus>('idle')
  const [stats, setStats] = useState({ time: 0, bytes: 0, dropped: 0 })
  const [countdownN, setCountdownN] = useState(3)
  const [pipWin, setPipWin] = useState<Window | null>(null)
  const [camPreview, setCamPreview] = useState<MediaStream | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [limitedDismissed, setLimitedDismissed] = useState(false)
  const [saved, setSaved] = useState<SavedInfo | null>(null)
  const [playing, setPlaying] = useState<{ name: string; url: string } | null>(null)
  const [monitor, setMonitor] = useState(false)
  const [level, setLevel] = useState(0)
  const [title, setTitle] = useState('')
  const [camBusy, setCamBusy] = useState(false)
  const targetRef = useRef<SaveTarget | null>(null)
  const cancelCountdown = useRef(false)
  const statusRef = useRef(status)
  statusRef.current = status

  const busy = status !== 'idle'
  const needsScreen = s.mode !== 'camera'
  const quality = QUALITY[s.quality] ?? QUALITY['1080p30']

  // ---------- helpers ----------
  const closePip = useCallback(() => {
    setPipWin((w) => {
      try { w?.close() } catch {}
      return null
    })
    setCamPreview((p) => {
      p?.getTracks().forEach((t) => t.stop())
      return null
    })
  }, [])

  const removeTarget = useCallback(
    async (target: SaveTarget | null) => {
      if (!target) return
      if (target.kind === 'opfs') await removeFromOpfs(target.name)
      else if (folder.handle) {
        try { await folder.handle.removeEntry(target.name) } catch {}
      }
    },
    [folder.handle],
  )

  // ---------- worker events ----------
  const handleEvent = useRef<(ev: StudioEvent) => void>(() => {})
  handleEvent.current = (ev: StudioEvent) => {
    switch (ev.type) {
      case 'started':
        setStatus('recording')
        {
          const notes: string[] = []
          if (ev.videoCodec === 'vp9') notes.push('No H.264 encoder in this browser — video saved as VP9 inside the MP4.')
          if (ev.audioCodec === 'opus') notes.push('No AAC encoder in this browser — audio saved as Opus inside the MP4.')
          if (notes.length) setNotice(notes.join(' '))
        }
        break
      case 'stats':
        setStats({ time: ev.time, bytes: ev.bytes, dropped: ev.dropped })
        break
      case 'paused':
        setStatus('paused')
        break
      case 'resumed':
        setStatus('recording')
        break
      case 'stopped': {
        const target = targetRef.current
        setStatus('idle')
        closePip()
        setSaved({ ...ev, name: ev.target.name, handle: target?.kind === 'handle' ? target.handle : undefined })
        if (ev.target.kind === 'opfs') void downloadFromOpfs(ev.target.name)
        targetRef.current = null
        onRecordingSaved?.()
        break
      }
      case 'discarded':
        setStatus('idle')
        closePip()
        removeTarget(targetRef.current)
        targetRef.current = null
        break
      case 'screen-ended':
        setScreenInfo(null)
        if (statusRef.current === 'recording' || statusRef.current === 'paused') {
          setStatus('stopping')
          studioRef.current?.stop()
        }
        break
      case 'error':
        setError(ev.message)
        if (statusRef.current !== 'idle') {
          setStatus('idle')
          closePip()
          removeTarget(targetRef.current)
          targetRef.current = null
        }
        break
    }
  }

  // ---------- init ----------
  const refreshDevices = useCallback(async () => {
    const list = await navigator.mediaDevices.enumerateDevices()
    setDevices({
      cams: list.filter((d) => d.kind === 'videoinput'),
      mics: list.filter((d) => d.kind === 'audioinput'),
    })
  }, [])

  useEffect(() => {
    if (studioRef.current) return
    if (!canvasRef.current) return
    const studio = new Studio(canvasRef.current, (ev) => handleEvent.current(ev))
    studioRef.current = studio
    studio.setFps(quality.fps)
    ;(async () => {
      try {
        const tmp = await navigator.mediaDevices.getUserMedia({ video: true, audio: true })
        tmp.getTracks().forEach((t) => t.stop())
      } catch {
        setError('Camera / microphone permission was blocked. Allow it in the address bar, then reload.')
      }
      await refreshDevices()
      setReady(true)
    })()
    navigator.mediaDevices.addEventListener('devicechange', refreshDevices)
    return () => navigator.mediaDevices.removeEventListener('devicechange', refreshDevices)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Layout -> worker
  useEffect(() => {
    studioRef.current?.setLayout({
      mode: s.mode,
      bubbleSize: s.bubbleSize,
      bubbleCorner: s.bubbleCorner,
      mirror: s.mirror,
      splitFit: s.splitFit,
      hasCamera: s.cameraId !== 'none',
    })
  }, [s.mode, s.bubbleSize, s.bubbleCorner, s.mirror, s.splitFit, s.cameraId])

  // Camera
  useEffect(() => {
    if (!ready) return
    let cancelled = false
    setCamBusy(true)
    studioRef.current!
      .setCamera(s.cameraId || undefined)
      .catch((e: unknown) => {
        if (cancelled) return
        if (s.cameraId && s.cameraId !== 'none') {
          set({ cameraId: '' }) // device gone — fall back to default
        } else setError(`Camera: ${errorMessage(e)}`)
      })
      .finally(() => !cancelled && setCamBusy(false))
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, s.cameraId])

  // Mic + noise cancellation
  useEffect(() => {
    if (!ready) return
    studioRef.current!.setMic(s.micId || undefined, s.ncMode).catch((e: unknown) => {
      if (s.micId && s.micId !== 'none') set({ micId: '' })
      else setError(`Microphone: ${errorMessage(e)}`)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, s.micId, s.ncMode])

  useEffect(() => {
    studioRef.current?.mixer.setMicVolume(s.micVolume)
  }, [s.micVolume])
  useEffect(() => {
    studioRef.current?.mixer.setSystemVolume(s.systemVolume)
  }, [s.systemVolume])
  useEffect(() => {
    studioRef.current?.mixer.setMonitor(monitor)
  }, [monitor])
  useEffect(() => {
    if (status === 'idle') studioRef.current?.setFps(quality.fps)
  }, [quality.fps, status])

  // Mic meter
  useEffect(() => {
    let raf = 0
    const loop = () => {
      if (studioRef.current) setLevel(studioRef.current.mixer.level())
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])

  // Warn before closing the tab mid-recording
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (statusRef.current !== 'idle') {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])

  // ---------- actions ----------
  async function chooseScreen() {
    setError(null)
    try {
      const info = await studioRef.current!.chooseScreen({
        surface: CAPS.tabCapture ? s.surface : 'monitor',
        audio: CAPS.displayAudio && s.shareAudio,
      })
      setScreenInfo(info)
    } catch (e) {
      const name = errorName(e)
      if (name !== 'NotAllowedError' && name !== 'AbortError') setError(`Screen share: ${errorMessage(e)}`)
    }
  }

  function stopSharing() {
    studioRef.current?.stopScreen()
    setScreenInfo(null)
  }

  async function startRecording() {
    setError(null)
    setNotice(null)
    setSaved(null)
    if (needsScreen && !screenInfo) {
      setError('Choose a tab, window or screen to share first.')
      return
    }
    if (s.mode === 'camera' && s.cameraId === 'none') {
      setError('Camera-only mode needs a camera.')
      return
    }

    // Open the floating controls first — it needs the click that started this.
    let win = null
    if (s.floatingControls && pipSupported()) {
      try {
        win = await openPipWindow()
      } catch {}
    }

    const name = makeFileName(title)
    let target: SaveTarget
    try {
      if (folder.handle && folder.permission === 'granted') {
        const handle = await createFile(folder.handle, name)
        target = { kind: 'handle', handle, name }
      } else {
        target = { kind: 'opfs', name }
      }
    } catch (e) {
      try { win?.close() } catch {}
      setError(`Could not create the file in your folder: ${errorMessage(e)}`)
      return
    }
    targetRef.current = target

    if (win) {
      setPipWin(win)
      setCamPreview(studioRef.current?.cameraPreview() ?? null)
      win.addEventListener('pagehide', () => {
        setPipWin(null)
        setCamPreview((p) => {
          p?.getTracks().forEach((t) => t.stop())
          return null
        })
      })
    }

    setStats({ time: 0, bytes: 0, dropped: 0 })
    cancelCountdown.current = false
    if (s.countdown) {
      setStatus('countdown')
      for (let n = 3; n >= 1; n--) {
        setCountdownN(n)
        await sleep(1000)
        if (cancelCountdown.current) {
          setStatus('idle')
          closePip()
          await removeTarget(target)
          targetRef.current = null
          return
        }
      }
    }
    setStatus('starting')
    const hasAudio = s.micId !== 'none' || !!screenInfo?.hasAudio
    void studioRef.current?.start({ target, bitrate: quality.bitrate, withAudio: hasAudio })
  }

  const pause = () => studioRef.current?.pause()
  const resume = () => studioRef.current?.resume()
  const stop = () => {
    setStatus('stopping')
    studioRef.current?.stop()
  }
  const discard = () => {
    if (!confirm('Discard this recording? It will be deleted.')) return
    setStatus('stopping')
    studioRef.current?.discard()
  }

  async function playSaved() {
    if (!saved?.handle) return
    const file = await saved.handle.getFile()
    setPlaying({ name: saved.name, url: URL.createObjectURL(file) })
  }

  // ---------- render ----------
  const camOptions: { value: string; label: string }[] = [
    ...devices.cams.map((d, i) => ({ value: d.deviceId, label: d.label || `Camera ${i + 1}` })),
    { value: 'none', label: 'No camera' },
  ]
  const micOptions = [
    ...devices.mics
      .filter((d) => d.deviceId !== 'communications')
      .map((d, i) => ({ value: d.deviceId, label: d.label || `Microphone ${i + 1}` })),
    { value: 'none', label: 'No microphone' },
  ]
  const recording = status === 'recording' || status === 'paused'
  const nc = NC_MODES.find((m) => m.id === s.ncMode)

  return (
    <div className="flex min-h-0 flex-1">
      {/* ---------- main column ---------- */}
      <div className="flex min-w-0 flex-1 flex-col gap-5 overflow-y-auto p-6">
        {error && (
          <div className="flex items-start justify-between gap-4 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
            <span>{error}</span>
            <button onClick={() => setError(null)} className="text-rose-300 hover:text-white">✕</button>
          </div>
        )}
        {!CAPS.full && !limitedDismissed && (
          <div className="flex items-start justify-between gap-4 rounded-xl border border-sky-500/30 bg-sky-500/10 px-4 py-3 text-sm text-sky-200">
            <span>
              <b className="font-semibold">Limited mode in this browser.</b> You can record a window or your entire screen
              with your mic (noise cancellation works). Tab recording, PC sound, saving to a folder and floating controls
              need Chrome or Edge. Keep this tab visible if recording stutters.
            </span>
            <button onClick={() => setLimitedDismissed(true)}>✕</button>
          </div>
        )}
        {notice && (
          <div className="flex items-start justify-between gap-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
            <span>{notice}</span>
            <button onClick={() => setNotice(null)}>✕</button>
          </div>
        )}
        {saved && (
          <div className="flex items-center justify-between gap-4 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3">
            <div className="min-w-0 text-sm">
              <div className="truncate font-medium text-emerald-200">Saved · {saved.name}</div>
              <div className="text-emerald-300/70">
                {formatTime(saved.duration)} · {formatBytes(saved.bytes)} ·{' '}
                {saved.target.kind === 'opfs' ? 'downloading to your Downloads folder' : `in “${folder.handle?.name}”`}
              </div>
            </div>
            <div className="flex shrink-0 gap-2">
              {saved.target.kind === 'handle' && (
                <button onClick={playSaved} className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium hover:bg-emerald-500">
                  Play
                </button>
              )}
              <button onClick={() => setSaved(null)} className="rounded-lg bg-white/10 px-3 py-1.5 text-sm hover:bg-white/15">
                Dismiss
              </button>
            </div>
          </div>
        )}

        {/* Preview */}
        <div className="relative mx-auto w-full max-w-[1280px]">
          <div className="overflow-hidden rounded-2xl bg-black shadow-2xl shadow-black/50 ring-1 ring-white/10">
            <canvas ref={canvasRef} className="block aspect-video w-full" />
          </div>
          <div className="pointer-events-none absolute left-4 top-4 flex gap-2">
            {recording && (
              <span className="flex items-center gap-2 rounded-full bg-black/70 px-3 py-1 font-mono text-sm tabular-nums text-white backdrop-blur">
                <span className={`h-2 w-2 rounded-full ${status === 'paused' ? 'bg-amber-400' : 'animate-pulse bg-rose-500'}`} />
                {status === 'paused' ? 'PAUSED' : 'REC'} {formatTime(stats.time)}
              </span>
            )}
            {!recording && (
              <span className="rounded-full bg-black/60 px-3 py-1 text-xs text-zinc-300 backdrop-blur">
                Live preview · exactly what gets recorded
              </span>
            )}
          </div>
          {status === 'countdown' && (
            <div className="absolute inset-0 grid place-items-center rounded-2xl bg-black/60">
              <div className="text-center">
                <div className="text-8xl font-bold text-white">{countdownN}</div>
                <div className="mt-2 text-zinc-300">Switch to what you're sharing now</div>
                <button
                  onClick={() => (cancelCountdown.current = true)}
                  className="mt-4 rounded-lg bg-white/10 px-4 py-1.5 text-sm hover:bg-white/20"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Record bar */}
        <div className="mx-auto flex w-full max-w-[1280px] items-center gap-4">
          {!recording && status !== 'stopping' && status !== 'starting' ? (
            <>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Title (optional) — used as the file name"
                disabled={busy}
                className="min-w-0 flex-1 rounded-xl border border-white/10 bg-zinc-900 px-4 py-3 text-sm outline-none placeholder:text-zinc-600 focus:border-rose-500/60"
              />
              <button
                onClick={startRecording}
                disabled={busy || !ready}
                className="flex items-center gap-2.5 rounded-xl bg-rose-600 px-6 py-3 font-semibold text-white shadow-lg shadow-rose-900/40 transition hover:bg-rose-500 disabled:opacity-50"
              >
                <span className="h-3 w-3 rounded-full bg-white" />
                Start recording
              </button>
            </>
          ) : (
            <>
              <div className="flex flex-1 items-center gap-6 text-sm text-zinc-400">
                <span className="font-mono text-2xl tabular-nums text-white">{formatTime(stats.time)}</span>
                <span>{formatBytes(stats.bytes)} written</span>
                {stats.dropped > 30 && <span className="text-amber-400">PC is struggling — {stats.dropped} frames skipped</span>}
              </div>
              {status === 'stopping' || status === 'starting' ? (
                <span className="text-sm text-zinc-400">{status === 'starting' ? 'Starting…' : 'Saving…'}</span>
              ) : (
                <>
                  <button onClick={discard} className="rounded-xl px-4 py-3 text-sm text-zinc-400 hover:bg-white/5 hover:text-zinc-200">
                    Discard
                  </button>
                  <button
                    onClick={status === 'paused' ? resume : pause}
                    className="rounded-xl bg-zinc-800 px-5 py-3 text-sm font-medium hover:bg-zinc-700"
                  >
                    {status === 'paused' ? 'Resume' : 'Pause'}
                  </button>
                  <button onClick={stop} className="rounded-xl bg-rose-600 px-6 py-3 font-semibold hover:bg-rose-500">
                    Stop & save
                  </button>
                </>
              )}
            </>
          )}
        </div>

        <div className="mx-auto w-full max-w-[1280px]">
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="text-sm font-semibold text-zinc-200">Layout</h2>
            <span className="text-xs text-zinc-500">You can switch layouts even while recording</span>
          </div>
          <LayoutPicker value={s.mode} onChange={(mode) => set({ mode })} />
        </div>
      </div>

      {/* ---------- settings sidebar ---------- */}
      <aside className="w-[360px] shrink-0 overflow-y-auto border-l border-white/5 bg-zinc-950/60">
        {needsScreen && (
          <Section title="Screen">
            {CAPS.tabCapture && (
              <div>
                <Label>What to share</Label>
                <Segmented
                  value={s.surface}
                  onChange={(surface) => set({ surface: surface as Surface })}
                  options={[
                    { value: 'browser', label: 'Tab' },
                    { value: 'window', label: 'Window' },
                    { value: 'monitor', label: 'Entire screen' },
                  ]}
                />
              </div>
            )}
            {screenInfo ? (
              <div className="rounded-lg border border-white/10 bg-zinc-900 p-3">
                <div className="text-xs text-zinc-500">{SURFACE_LABEL[screenInfo.surface] || 'Sharing'}</div>
                <div className="truncate text-sm text-zinc-100" title={screenInfo.label}>
                  {screenInfo.label || 'Shared screen'}
                </div>
                <div className="mt-0.5 text-xs text-zinc-500">
                  {screenInfo.width}×{screenInfo.height} · {screenInfo.hasAudio ? 'with sound' : 'no sound'}
                </div>
                <div className="mt-2.5 flex gap-2">
                  <button onClick={chooseScreen} className="rounded-md bg-zinc-800 px-3 py-1.5 text-xs font-medium hover:bg-zinc-700">
                    Change
                  </button>
                  {!recording && (
                    <button onClick={stopSharing} className="rounded-md px-3 py-1.5 text-xs text-zinc-400 hover:bg-white/5">
                      Stop sharing
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <button
                onClick={chooseScreen}
                className="w-full rounded-lg border border-dashed border-white/15 bg-zinc-900/60 py-3 text-sm font-medium text-zinc-200 hover:border-rose-500/50 hover:text-white"
              >
                {CAPS.tabCapture ? `Choose ${SURFACE_LABEL[s.surface].toLowerCase()} to share…` : 'Choose a window or screen to share…'}
              </button>
            )}
            {CAPS.displayAudio && (
              <Toggle
                checked={s.shareAudio}
                onChange={(shareAudio) => set({ shareAudio })}
                label="Include PC / tab sound"
                hint="Tab sound works for tabs. Full PC sound needs “Entire screen” on Windows. Applies next time you choose."
              />
            )}
          </Section>
        )}

        <Section title="Camera">
          <Select
            value={s.cameraId || devices.cams[0]?.deviceId || ''}
            onChange={(cameraId) => set({ cameraId })}
            options={camOptions.length > 1 ? camOptions : [{ value: '', label: 'No camera found' }, ...camOptions]}
            disabled={camBusy}
          />
          <Toggle checked={s.mirror} onChange={(mirror) => set({ mirror })} label="Mirror camera" />
          {s.mode === 'bubble' && (
            <>
              <div>
                <Label>Bubble size</Label>
                <Segmented
                  value={s.bubbleSize}
                  onChange={(bubbleSize) => set({ bubbleSize })}
                  options={[
                    { value: 'small', label: 'Small' },
                    { value: 'medium', label: 'Medium' },
                    { value: 'large', label: 'Large' },
                  ]}
                />
              </div>
              <div>
                <Label>Bubble position</Label>
                <Segmented
                  value={s.bubbleCorner}
                  onChange={(bubbleCorner) => set({ bubbleCorner })}
                  options={[
                    { value: 'bl', label: '↙', title: 'Bottom left' },
                    { value: 'br', label: '↘', title: 'Bottom right' },
                    { value: 'tl', label: '↖', title: 'Top left' },
                    { value: 'tr', label: '↗', title: 'Top right' },
                  ]}
                />
              </div>
            </>
          )}
          {s.mode === 'split' && (
            <div>
              <Label>Screen in right half</Label>
              <Segmented
                value={s.splitFit}
                onChange={(splitFit) => set({ splitFit })}
                options={[
                  { value: 'contain', label: 'Fit (show all)' },
                  { value: 'cover', label: 'Fill (crop edges)' },
                ]}
              />
            </div>
          )}
        </Section>

        <Section title="Microphone">
          <Select
            value={s.micId || micOptions[0]?.value || ''}
            onChange={(micId) => set({ micId })}
            options={micOptions}
          />
          <div className="h-1.5 overflow-hidden rounded-full bg-zinc-800">
            <div
              className={`h-full rounded-full transition-[width] duration-75 ${level > 0.9 ? 'bg-rose-500' : 'bg-emerald-500'}`}
              style={{ width: `${Math.round(level * 100)}%` }}
            />
          </div>
          <div>
            <Label>Noise cancellation</Label>
            <Segmented
              value={s.ncMode}
              onChange={(ncMode) => set({ ncMode })}
              options={NC_MODES.map((m) => ({ value: m.id, label: m.label, title: m.hint }))}
            />
            <p className="mt-1.5 text-xs text-zinc-500">
              {nc?.hint}. Only your mic is cleaned — PC sound is never touched.
            </p>
          </div>
          <Toggle
            checked={monitor}
            onChange={setMonitor}
            label="Listen to my mic"
            hint="Wear headphones — hear exactly how your voice will sound."
          />
          <div>
            <Label right={<span>{Math.round(s.micVolume * 100)}%</span>}>Mic volume</Label>
            <Slider value={s.micVolume} max={2} onChange={(micVolume) => set({ micVolume })} />
          </div>
          {needsScreen && CAPS.displayAudio && (
            <div>
              <Label right={<span>{Math.round(s.systemVolume * 100)}%</span>}>PC / tab sound volume</Label>
              <Slider value={s.systemVolume} max={1.5} onChange={(systemVolume) => set({ systemVolume })} />
            </div>
          )}
        </Section>

        <Section title="Output">
          <div>
            <Label right={<span>≈ {quality.mbPerMin} MB / min</span>}>Quality · MP4 (H.264 + AAC)</Label>
            <Segmented
              value={s.quality}
              disabled={busy}
              onChange={(q) => set({ quality: q as QualityKey })}
              options={Object.entries(QUALITY).map(([k, v]) => ({ value: k, label: v.label }))}
            />
          </div>
          <div>
            <Label>Save to</Label>
            {folder.handle && folder.permission === 'granted' ? (
              <div className="flex items-center justify-between gap-2 rounded-lg border border-white/10 bg-zinc-900 px-3 py-2">
                <span className="truncate text-sm">📁 {folder.handle.name}</span>
                <button onClick={onPickFolder} disabled={busy} className="shrink-0 text-xs text-rose-400 hover:text-rose-300">
                  Change
                </button>
              </div>
            ) : folder.handle ? (
              <button
                onClick={onReconnectFolder}
                className="w-full rounded-lg bg-amber-500/15 px-3 py-2 text-left text-sm text-amber-200 hover:bg-amber-500/25"
              >
                Allow access to “{folder.handle.name}” again
              </button>
            ) : canPickFolder() ? (
              <button onClick={onPickFolder} className="w-full rounded-lg bg-zinc-800 px-3 py-2 text-sm hover:bg-zinc-700">
                Choose a folder on this PC…
              </button>
            ) : null}
            {!(folder.handle && folder.permission === 'granted') && (
              <p className="mt-1.5 text-xs text-zinc-500">
                {canPickFolder()
                  ? 'Until you pick one, recordings download to your Downloads folder.'
                  : 'Recordings download to your Downloads folder when you stop.'}
              </p>
            )}
          </div>
          <Toggle checked={s.countdown} onChange={(countdown) => set({ countdown })} label="3-second countdown" />
          {pipSupported() && (
            <Toggle
              checked={s.floatingControls}
              onChange={(floatingControls) => set({ floatingControls })}
              label="Floating controls"
              hint="Small always-on-top window with your camera, timer, pause and stop."
            />
          )}
        </Section>
      </aside>

      <FloatingControls
        win={pipWin}
        status={status}
        countdown={countdownN}
        time={stats.time}
        cameraStream={camPreview}
        mirror={s.mirror}
        onPause={pause}
        onResume={resume}
        onStop={stop}
        onCancel={() => (cancelCountdown.current = true)}
      />
      {playing && (
        <VideoModal
          {...playing}
          onClose={() => {
            URL.revokeObjectURL(playing.url)
            setPlaying(null)
          }}
        />
      )}
    </div>
  )
}
