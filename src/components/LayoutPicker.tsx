// src/components/LayoutPicker.tsx
import type { LayoutMode } from '../shared/types'

const MODES: { id: LayoutMode; name: string; desc: string }[] = [
  { id: 'camera', name: 'Camera only', desc: 'Full-frame webcam' },
  { id: 'bubble', name: 'Screen + bubble', desc: 'Round camera in the corner' },
  { id: 'split', name: '50 / 50', desc: 'Camera left, screen right' },
]

function Icon({ id, active }: { id: LayoutMode; active: boolean }) {
  const screen = active ? '#3f3f46' : '#27272a'
  const cam = active ? '#fb7185' : '#71717a'
  return (
    <svg viewBox="0 0 64 36" className="h-12 w-full">
      <rect x="0.5" y="0.5" width="63" height="35" rx="4" fill="#18181b" stroke={active ? '#fb7185' : '#3f3f46'} />
      {id === 'camera' && (
        <>
          <circle cx="32" cy="15" r="6" fill={cam} />
          <path d="M20 33c1.5-7 6.5-10 12-10s10.5 3 12 10" fill={cam} />
        </>
      )}
      {id === 'bubble' && (
        <>
          <rect x="4" y="4" width="56" height="28" rx="2" fill={screen} />
          <rect x="9" y="8" width="24" height="3" rx="1.5" fill="#52525b" />
          <rect x="9" y="14" width="40" height="2" rx="1" fill="#52525b" />
          <rect x="9" y="19" width="34" height="2" rx="1" fill="#52525b" />
          <circle cx="12" cy="27" r="6.5" fill={cam} stroke="#fff" strokeWidth="1.2" />
        </>
      )}
      {id === 'split' && (
        <>
          <rect x="1" y="1" width="31" height="34" rx="3" fill="#1f1f23" />
          <circle cx="16.5" cy="14" r="5" fill={cam} />
          <path d="M7 34c1-6 5-9 9.5-9s8.5 3 9.5 9" fill={cam} />
          <rect x="33" y="1" width="30" height="34" rx="3" fill={screen} />
          <rect x="37" y="9" width="18" height="2.5" rx="1.2" fill="#52525b" />
          <rect x="37" y="15" width="22" height="2" rx="1" fill="#52525b" />
          <rect x="37" y="20" width="16" height="2" rx="1" fill="#52525b" />
        </>
      )}
    </svg>
  )
}

export default function LayoutPicker({ value, onChange }: { value: LayoutMode; onChange: (mode: LayoutMode) => void }) {
  return (
    <div className="grid grid-cols-3 gap-3">
      {MODES.map((m) => {
        const active = value === m.id
        return (
          <button
            key={m.id}
            type="button"
            onClick={() => onChange(m.id)}
            className={`group rounded-xl border p-3 text-left transition ${
              active
                ? 'border-rose-500/70 bg-rose-500/[0.07] ring-1 ring-rose-500/30'
                : 'border-white/10 bg-zinc-900/60 hover:border-white/20'
            }`}
          >
            <Icon id={m.id} active={active} />
            <div className="mt-2 text-sm font-medium text-zinc-100">{m.name}</div>
            <div className="text-xs text-zinc-500">{m.desc}</div>
          </button>
        )
      })}
    </div>
  )
}
