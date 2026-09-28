// src/components/PhonePanel.tsx
// PC side: QR code + live status for using a phone as camera and mic.
import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import type { LinkState, LinkStats } from '../lib/phoneLink'

export function phoneUrl(room: string): string {
  const url = new URL(location.origin + location.pathname)
  url.searchParams.set('phone', room)
  // keep the local test signalling flag, if used
  if (new URLSearchParams(location.search).get('signal') === 'local') url.searchParams.set('signal', 'local')
  return url.toString()
}

const STATE_TEXT: Record<LinkState, string> = {
  idle: 'Not started',
  waiting: 'Waiting for your phone…',
  connecting: 'Connecting over WiFi…',
  connected: 'Connected',
  failed: 'Connection failed',
}

interface Props {
  room: string
  state: LinkState
  stats: LinkStats | null
  onClose: () => void
  onDisconnect: () => void
  onNewLink: () => void
}

export default function PhonePanel({ room, state, stats, onClose, onDisconnect, onNewLink }: Props) {
  const url = phoneUrl(room)
  const [qr, setQr] = useState('')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    QRCode.toDataURL(url, { width: 520, margin: 1, errorCorrectionLevel: 'M' }).then(setQr, () => setQr(''))
  }, [url])

  const connected = state === 'connected'

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/70 p-6 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-full max-w-3xl overflow-hidden rounded-2xl border border-white/10 bg-zinc-950 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-white/5 px-6 py-4">
          <h2 className="font-semibold">Use your phone as camera &amp; mic</h2>
          <button onClick={onClose} className="rounded-md px-2 py-1 text-zinc-400 hover:bg-white/10 hover:text-white">
            ✕
          </button>
        </div>

        <div className="grid grid-cols-[260px_1fr] gap-8 p-6">
          <div>
            <div className="rounded-xl bg-white p-3">
              {qr ? <img src={qr} alt="Scan with your phone" className="block w-full" /> : <div className="aspect-square" />}
            </div>
            <button
              onClick={() => {
                void navigator.clipboard.writeText(url).then(() => {
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1500)
                })
              }}
              className="mt-2 w-full truncate rounded-lg bg-zinc-900 px-3 py-2 text-xs text-zinc-400 hover:text-zinc-200"
              title={url}
            >
              {copied ? 'Link copied ✓' : 'Copy link instead'}
            </button>
          </div>

          <div className="flex flex-col">
            <ol className="space-y-2.5 text-sm text-zinc-300">
              <li><b className="text-white">1.</b> Put your phone on the <b className="text-white">same WiFi</b> as this PC.</li>
              <li><b className="text-white">2.</b> Scan the code with the phone camera and open the link.</li>
              <li><b className="text-white">3.</b> Tap <b className="text-white">Start camera</b> and allow camera + mic.</li>
              <li><b className="text-white">4.</b> Turn the phone <b className="text-white">sideways</b> for a full 16:9 picture. Keep it plugged in for long recordings.</li>
            </ol>

            <div
              className={`mt-6 rounded-xl border px-4 py-3 ${
                connected
                  ? 'border-emerald-500/30 bg-emerald-500/10'
                  : state === 'failed'
                    ? 'border-rose-500/30 bg-rose-500/10'
                    : 'border-white/10 bg-zinc-900'
              }`}
            >
              <div className="flex items-center gap-2 text-sm font-medium">
                <span
                  className={`h-2 w-2 rounded-full ${
                    connected ? 'bg-emerald-400' : state === 'failed' ? 'bg-rose-400' : 'animate-pulse bg-amber-400'
                  }`}
                />
                {STATE_TEXT[state]}
              </div>
              {connected && stats && (
                <div className="mt-1.5 grid grid-cols-4 gap-2 text-xs text-zinc-400">
                  <Stat label="Resolution" value={stats.width ? `${stats.width}×${stats.height}` : '—'} />
                  <Stat label="Frame rate" value={stats.fps ? `${Math.round(stats.fps)} fps` : '—'} />
                  <Stat label="Bitrate" value={`${stats.mbps.toFixed(1)} Mbps`} />
                  <Stat label="Codec" value={stats.codec ?? '—'} />
                </div>
              )}
              {state === 'failed' && (
                <p className="mt-1.5 text-xs text-rose-200/80">
                  The devices couldn't reach each other. Check both are on the same WiFi (not guest WiFi, no VPN), then
                  reload the page on the phone.
                </p>
              )}
            </div>

            <div className="mt-auto flex gap-2 pt-6">
              {connected ? (
                <button onClick={onClose} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold hover:bg-emerald-500">
                  Done
                </button>
              ) : null}
              <button onClick={onDisconnect} className="rounded-lg bg-zinc-800 px-4 py-2 text-sm hover:bg-zinc-700">
                {connected ? 'Disconnect phone' : 'Cancel'}
              </button>
              <button
                onClick={onNewLink}
                className="ml-auto rounded-lg px-3 py-2 text-xs text-zinc-500 hover:bg-white/5 hover:text-zinc-300"
                title="Makes the old QR code / link stop working"
              >
                New link
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</div>
      <div className="text-zinc-200">{value}</div>
    </div>
  )
}
