// src/components/FloatingControls.tsx
// Always-on-top mini window (Document Picture-in-Picture) with camera preview,
// timer and Pause / Stop — stays visible while you work in other tabs/apps.
import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { formatTime } from '../lib/folder'

export const pipSupported = () => !!window.documentPictureInPicture

/** Must be called from a click. Returns the PiP window or null. */
export async function openPipWindow(): Promise<Window | null> {
  const pip = window.documentPictureInPicture
  if (!pip) return null
  const win = await pip.requestWindow({ width: 300, height: 340 })
  // Copy the app's styles into the new window.
  for (const sheet of document.styleSheets) {
    try {
      const css = [...sheet.cssRules].map((r) => r.cssText).join('\n')
      const style = win.document.createElement('style')
      style.textContent = css
      win.document.head.appendChild(style)
    } catch {
      if (sheet.href) {
        const link = win.document.createElement('link')
        link.rel = 'stylesheet'
        link.href = sheet.href
        win.document.head.appendChild(link)
      }
    }
  }
  win.document.title = 'FrameCast'
  win.document.body.className = 'bg-zinc-950 text-zinc-100 m-0'
  return win
}

function CameraBubble({ stream, mirror, rotation }: { stream: MediaStream | null; mirror: boolean; rotation: number }) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream || null
  }, [stream])
  if (!stream) {
    return <div className="grid h-36 w-36 place-items-center rounded-full bg-zinc-800 text-xs text-zinc-500">No camera</div>
  }
  return (
    <video
      ref={ref}
      autoPlay
      muted
      playsInline
      className="h-36 w-36 rounded-full object-cover ring-4 ring-white/90"
      style={{ transform: `${mirror ? 'scaleX(-1) ' : ''}rotate(${rotation}deg)` }}
    />
  )
}

export type RecStatus = 'idle' | 'countdown' | 'starting' | 'recording' | 'paused' | 'stopping'

interface Props {
  win: Window | null
  status: RecStatus
  countdown: number
  time: number
  cameraStream: MediaStream | null
  mirror: boolean
  rotation: number
  onPause: () => void
  onResume: () => void
  onStop: () => void
  onCancel: () => void
}

export default function FloatingControls({ win, status, countdown, time, cameraStream, mirror, rotation, onPause, onResume, onStop, onCancel }: Props) {
  if (!win) return null
  const paused = status === 'paused'
  return createPortal(
    <div className="flex h-screen flex-col items-center justify-center gap-4 p-4 select-none">
      <div className="relative">
        <CameraBubble stream={cameraStream} mirror={mirror} rotation={rotation} />
        {status === 'countdown' && (
          <div className="absolute inset-0 grid place-items-center rounded-full bg-black/60 text-6xl font-bold text-white">
            {countdown}
          </div>
        )}
      </div>

      {status === 'countdown' ? (
        <div className="text-center">
          <div className="text-sm text-zinc-300">Switch to what you're sharing now</div>
          <button onClick={onCancel} className="mt-3 rounded-lg bg-zinc-800 px-4 py-1.5 text-sm hover:bg-zinc-700">
            Cancel
          </button>
        </div>
      ) : status === 'stopping' ? (
        <div className="text-sm text-zinc-300">Saving…</div>
      ) : (
        <>
          <div className="flex items-center gap-2 font-mono text-2xl tabular-nums">
            <span className={`h-2.5 w-2.5 rounded-full ${paused ? 'bg-amber-400' : 'animate-pulse bg-rose-500'}`} />
            {formatTime(time)}
          </div>
          <div className="flex gap-2">
            <button
              onClick={paused ? onResume : onPause}
              className="rounded-xl bg-zinc-800 px-4 py-2 text-sm font-medium hover:bg-zinc-700"
            >
              {paused ? 'Resume' : 'Pause'}
            </button>
            <button onClick={onStop} className="rounded-xl bg-rose-600 px-4 py-2 text-sm font-semibold hover:bg-rose-500">
              Stop & save
            </button>
          </div>
        </>
      )}
    </div>,
    win.document.body,
  )
}
