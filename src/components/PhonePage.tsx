// src/components/PhonePage.tsx
// The phone side: opened from the QR code. Mobile-friendly, streams the phone's
// camera and mic to the PC over the same WiFi.
import { useEffect, useRef, useState } from 'react'
import { PhoneSender, type LinkState, type LinkStats } from '../lib/phoneLink'
import { signalingConfigured } from '../lib/signaling'
import { errorMessage, errorName } from '../lib/folder'

const STATUS: Record<LinkState, { text: string; dot: string }> = {
  idle: { text: 'Not started', dot: 'bg-zinc-500' },
  waiting: { text: 'Waiting for the PC…', dot: 'animate-pulse bg-amber-400' },
  connecting: { text: 'Connecting over WiFi…', dot: 'animate-pulse bg-amber-400' },
  connected: { text: 'Live on PC', dot: 'bg-emerald-400' },
  failed: { text: 'Connection failed', dot: 'bg-rose-500' },
}

type WakeLockSentinelLike = { release: () => Promise<void> }

export default function PhonePage({ room }: { room: string }) {
  const senderRef = useRef<PhoneSender | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const wakeRef = useRef<WakeLockSentinelLike | null>(null)
  const [started, setStarted] = useState(false)
  const [state, setState] = useState<LinkState>('idle')
  const [stats, setStats] = useState<LinkStats | null>(null)
  const [preview, setPreview] = useState<MediaStream | null>(null)
  const [facing, setFacing] = useState<'user' | 'environment'>('user')
  const [muted, setMuted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [portrait, setPortrait] = useState(() => window.matchMedia('(orientation: portrait)').matches)

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = preview
  }, [preview])

  useEffect(() => {
    const mq = window.matchMedia('(orientation: portrait)')
    const onChange = () => setPortrait(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  // Keep the screen on while streaming (the camera stops if the phone locks).
  useEffect(() => {
    if (!started) return
    const lock = async () => {
      try {
        const nav = navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<WakeLockSentinelLike> } }
        wakeRef.current = (await nav.wakeLock?.request('screen')) ?? null
      } catch {}
    }
    void lock()
    const onVisible = () => document.visibilityState === 'visible' && void lock()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      void wakeRef.current?.release()
    }
  }, [started])

  useEffect(() => () => senderRef.current?.close(), [])

  async function start() {
    setError(null)
    setBusy(true)
    const sender = new PhoneSender(room, setState, setStats, setPreview)
    senderRef.current = sender
    try {
      await sender.start('user')
      setStarted(true)
    } catch (e) {
      sender.close()
      senderRef.current = null
      setError(
        errorName(e) === 'NotAllowedError'
          ? 'Camera / microphone access was blocked. Allow it in your browser settings for this site, then try again.'
          : errorMessage(e),
      )
    } finally {
      setBusy(false)
    }
  }

  async function flip() {
    const sender = senderRef.current
    if (!sender || busy) return
    setBusy(true)
    try {
      await sender.switchCamera()
      setFacing(sender.facing)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  function toggleMute() {
    const sender = senderRef.current
    if (!sender) return
    sender.setMicMuted(!muted)
    setMuted(!muted)
  }

  function stop() {
    senderRef.current?.close()
    senderRef.current = null
    setStarted(false)
    setStats(null)
  }

  // ---------- start screen ----------
  if (!started) {
    return (
      <div className="flex min-h-[100dvh] flex-col bg-zinc-950 px-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-[max(2rem,env(safe-area-inset-top))] text-zinc-100">
        <div className="flex items-center gap-2.5">
          <div className="grid h-8 w-8 place-items-center rounded-lg bg-rose-600">
            <div className="h-3 w-3 rounded-full bg-white" />
          </div>
          <span className="text-lg font-semibold tracking-tight">FrameCast</span>
        </div>

        <div className="mt-10 flex-1">
          <h1 className="text-2xl font-semibold leading-tight">Use this phone as your camera &amp; mic</h1>
          <ul className="mt-5 space-y-3 text-[15px] text-zinc-300">
            <li className="flex gap-3"><span>📶</span>Same WiFi as your PC</li>
            <li className="flex gap-3"><span>↔️</span>Hold the phone sideways for a full-width picture</li>
            <li className="flex gap-3"><span>🔌</span>Plug in the charger for long recordings</li>
            <li className="flex gap-3"><span>🔒</span>Video goes straight to your PC — never to the internet</li>
          </ul>
          {!signalingConfigured() && (
            <p className="mt-6 rounded-xl bg-amber-500/15 p-4 text-sm text-amber-200">
              Pairing isn't set up on this site yet (Supabase keys missing).
            </p>
          )}
          {error && <p className="mt-6 rounded-xl bg-rose-500/15 p-4 text-sm text-rose-200">{error}</p>}
        </div>

        <button
          onClick={() => void start()}
          disabled={busy || !signalingConfigured()}
          className="w-full rounded-2xl bg-rose-600 py-4 text-lg font-semibold active:bg-rose-500 disabled:opacity-50"
        >
          {busy ? 'Starting…' : 'Start camera'}
        </button>
      </div>
    )
  }

  // ---------- live screen ----------
  const st = STATUS[state]
  return (
    <div className="relative h-[100dvh] w-full overflow-hidden bg-black text-white">
      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        className="absolute inset-0 h-full w-full object-contain"
        style={{ transform: facing === 'user' ? 'scaleX(-1)' : undefined }}
      />

      {/* top bar */}
      <div className="absolute inset-x-0 top-0 flex flex-wrap items-center gap-2 bg-gradient-to-b from-black/70 to-transparent px-4 pb-8 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <span className="flex items-center gap-2 rounded-full bg-black/60 px-3 py-1.5 text-sm backdrop-blur">
          <span className={`h-2 w-2 rounded-full ${st.dot}`} />
          {st.text}
        </span>
        {state === 'connected' && stats && (
          <span className="rounded-full bg-black/60 px-3 py-1.5 text-xs text-zinc-300 backdrop-blur">
            {stats.width && stats.height ? `${Math.min(stats.width, stats.height)}p · ` : ''}
            {stats.mbps.toFixed(1)} Mbps{stats.codec ? ` · ${stats.codec}` : ''}
          </span>
        )}
        {muted && <span className="rounded-full bg-rose-600 px-3 py-1.5 text-xs font-medium">Mic muted</span>}
      </div>

      {portrait && (
        <div className="absolute inset-x-4 top-1/2 -translate-y-1/2 text-center">
          <span className="inline-block rounded-xl bg-black/60 px-4 py-2 text-sm text-zinc-200 backdrop-blur">
            ↔️ Turn sideways for a full 16:9 picture
          </span>
        </div>
      )}

      {state === 'failed' && (
        <div className="absolute inset-x-4 top-20 rounded-xl bg-rose-600/90 p-3 text-sm">
          Couldn't reach the PC. Make sure both are on the same WiFi (not guest WiFi, no VPN) and reload this page.
        </div>
      )}
      {error && <div className="absolute inset-x-4 top-20 rounded-xl bg-rose-600/90 p-3 text-sm">{error}</div>}

      {/* bottom controls */}
      <div className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-5 bg-gradient-to-t from-black/70 to-transparent px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-10">
        <RoundButton label="Flip" onClick={() => void flip()} disabled={busy}>
          <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 7h4l2-3h6l2 3h4v12H3z" />
            <path d="M9 13a3 3 0 0 1 5.2-2" />
            <path d="M15 13a3 3 0 0 1-5.2 2" />
          </svg>
        </RoundButton>
        <RoundButton label={muted ? 'Unmute' : 'Mute'} onClick={toggleMute} active={muted}>
          <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <rect x="9" y="3" width="6" height="11" rx="3" />
            <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
            {muted && <path d="M4 4l16 16" />}
          </svg>
        </RoundButton>
        <RoundButton label="Stop" onClick={stop} danger>
          <span className="h-5 w-5 rounded-[4px] bg-white" />
        </RoundButton>
      </div>
    </div>
  )
}

function RoundButton({
  label,
  onClick,
  children,
  disabled,
  active,
  danger,
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
  disabled?: boolean
  active?: boolean
  danger?: boolean
}) {
  return (
    <button onClick={onClick} disabled={disabled} className="flex flex-col items-center gap-1.5 disabled:opacity-50">
      <span
        className={`grid h-14 w-14 place-items-center rounded-full backdrop-blur transition active:scale-95 ${
          danger ? 'bg-rose-600' : active ? 'bg-white text-black' : 'bg-white/15'
        }`}
      >
        {children}
      </span>
      <span className="text-xs text-zinc-300">{label}</span>
    </button>
  )
}
