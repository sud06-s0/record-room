// src/components/ui.tsx
import type { ReactNode } from 'react'

export function Section({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="border-b border-white/5 px-5 py-4 last:border-b-0">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">{title}</h3>
        {right}
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  )
}

export interface Option<T extends string> {
  value: T
  label: string
  title?: string
}

export function Select<T extends string>({
  value,
  onChange,
  options,
  disabled,
}: {
  value: T
  onChange: (value: T) => void
  options: Option<T>[]
  disabled?: boolean
}) {
  return (
    <div className="relative">
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as T)}
        className="w-full appearance-none truncate rounded-lg border border-white/10 bg-zinc-900 py-2 pl-3 pr-8 text-sm text-zinc-100 outline-none transition focus:border-rose-500/60 disabled:opacity-50"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <svg
        className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500"
        viewBox="0 0 20 20"
      >
        <path d="M5.5 7.5 10 12l4.5-4.5" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" />
      </svg>
    </div>
  )
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  disabled,
}: {
  value: T
  onChange: (value: T) => void
  options: Option<T>[]
  disabled?: boolean
}) {
  return (
    <div className="flex rounded-lg border border-white/10 bg-zinc-900 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          disabled={disabled}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={`flex-1 rounded-md px-2 py-1.5 text-xs font-medium transition disabled:opacity-50 ${
            value === o.value ? 'bg-zinc-700 text-white shadow' : 'text-zinc-400 hover:text-zinc-200'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  hint?: string
  disabled?: boolean
}) {
  return (
    <label className={`flex cursor-pointer items-start gap-3 ${disabled ? 'opacity-50' : ''}`}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition ${checked ? 'bg-rose-500' : 'bg-zinc-700'}`}
      >
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${checked ? 'left-[18px]' : 'left-0.5'}`}
        />
      </button>
      <span className="text-sm leading-tight text-zinc-200">
        {label}
        {hint && <span className="mt-0.5 block text-xs text-zinc-500">{hint}</span>}
      </span>
    </label>
  )
}

export function Slider({
  value,
  onChange,
  min = 0,
  max = 1,
  step = 0.01,
  disabled,
}: {
  value: number
  onChange: (value: number) => void
  min?: number
  max?: number
  step?: number
  disabled?: boolean
}) {
  return (
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(Number(e.target.value))}
      className="w-full accent-rose-500"
    />
  )
}

export function Label({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-1.5 flex items-center justify-between text-xs text-zinc-400">
      <span>{children}</span>
      {right}
    </div>
  )
}
