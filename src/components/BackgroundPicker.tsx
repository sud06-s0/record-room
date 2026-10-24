// src/components/BackgroundPicker.tsx
import { useRef } from 'react'
import type { Background, BgStatus, LayoutMode } from '../shared/types'
import { BG_COLORS, BG_PRESETS } from '../shared/backgrounds'
import { Label, Segmented, Toggle } from './ui'

interface Props {
  value: Background
  onChange: (patch: Partial<Background>) => void
  layoutMode: LayoutMode
  /** Background AI progress */
  aiStatus: BgStatus | null
  /** Set when the green screen can't run */
  keyerError: string | null
  /** Thumbnail of the uploaded picture */
  customThumb: string | null
  onUpload: (file: File) => void
}

function Tile({
  active,
  title,
  onClick,
  style,
  children,
}: {
  active: boolean
  title: string
  onClick: () => void
  style?: React.CSSProperties
  children?: React.ReactNode
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      style={style}
      className={`relative aspect-video overflow-hidden rounded-md bg-zinc-800 bg-cover bg-center text-[10px] text-zinc-300 transition ${
        active ? 'ring-2 ring-rose-500 ring-offset-1 ring-offset-zinc-950' : 'ring-1 ring-white/10 hover:ring-white/30'
      }`}
    >
      {children}
    </button>
  )
}

export default function BackgroundPicker({ value: bg, onChange, layoutMode, aiStatus: status, keyerError, customThumb, onUpload }: Props) {
  const fileRef = useRef<HTMLInputElement>(null)
  const cutoutOn = layoutMode === 'bubble' && bg.cutout
  // Blur needs the AI; picture / colour / cutout can also use a real green or blue screen.
  const showKeyer = bg.mode === 'image' || bg.mode === 'color' || cutoutOn
  const usesAi = bg.mode === 'blur' || ((bg.mode !== 'none' || cutoutOn) && bg.keyer === 'ai')

  return (
    <>
      <Segmented
        value={bg.mode}
        onChange={(mode) => onChange({ mode })}
        options={[
          { value: 'none', label: 'None' },
          { value: 'blur', label: 'Blur' },
          { value: 'image', label: 'Picture' },
          { value: 'color', label: 'Colour' },
        ]}
      />

      {bg.mode === 'blur' && (
        <div>
          <Label>Blur amount</Label>
          <Segmented
            value={bg.blur}
            onChange={(blur) => onChange({ blur })}
            options={[
              { value: 'light', label: 'Light' },
              { value: 'strong', label: 'Strong' },
            ]}
          />
        </div>
      )}

      {bg.mode === 'image' && (
        <div className="grid grid-cols-4 gap-2">
          {BG_PRESETS.map((p) => (
            <Tile
              key={p.id}
              title={p.name}
              active={bg.image === p.id}
              onClick={() => onChange({ image: p.id })}
              style={{ backgroundImage: p.css }}
            />
          ))}
          {customThumb && (
            <Tile
              title="Your picture"
              active={bg.image === 'custom'}
              onClick={() => onChange({ image: 'custom' })}
              style={{ backgroundImage: `url(${customThumb})` }}
            />
          )}
          <Tile title="Upload a picture" active={false} onClick={() => fileRef.current?.click()}>
            <span className="flex h-full flex-col items-center justify-center gap-0.5">
              <span className="text-base leading-none">＋</span>
              Upload
            </span>
          </Tile>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) onUpload(file)
              e.target.value = ''
            }}
          />
        </div>
      )}

      {bg.mode === 'color' && (
        <div className="flex flex-wrap items-center gap-2">
          {BG_COLORS.map((col) => (
            <button
              key={col}
              type="button"
              title={col}
              onClick={() => onChange({ color: col })}
              style={{ background: col }}
              className={`h-7 w-7 rounded-full ${
                bg.color.toLowerCase() === col ? 'ring-2 ring-rose-500 ring-offset-2 ring-offset-zinc-950' : 'ring-1 ring-white/15'
              }`}
            />
          ))}
          <label
            title="Pick any colour"
            className="relative flex h-7 w-7 cursor-pointer items-center justify-center overflow-hidden rounded-full text-xs ring-1 ring-white/15"
            style={{ background: 'conic-gradient(#f43f5e, #f59e0b, #22c55e, #06b6d4, #6366f1, #f43f5e)' }}
          >
            <input
              type="color"
              value={bg.color}
              onChange={(e) => onChange({ color: e.target.value })}
              className="absolute inset-0 cursor-pointer opacity-0"
            />
          </label>
        </div>
      )}

      {layoutMode === 'bubble' && (
        <Toggle
          checked={bg.cutout}
          onChange={(cutout) => onChange({ cutout })}
          label="Cutout bubble"
          hint="No circle and no background — just you, standing over your screen."
        />
      )}

      {showKeyer && (
        <div>
          <Label>Separate me using</Label>
          <Segmented
            value={bg.keyer}
            onChange={(keyer) => onChange({ keyer })}
            options={[
              { value: 'ai', label: 'AI', title: 'Works anywhere, no green screen needed' },
              { value: 'green', label: 'Green screen', title: 'Sharpest edges, almost no CPU — needs a green cloth behind you' },
              { value: 'blue', label: 'Blue screen', title: 'Same as green screen, for a blue cloth' },
            ]}
          />
        </div>
      )}

      {(bg.mode !== 'none' || cutoutOn) && (
        <p className="text-xs text-zinc-500">
          {usesAi ? (
            status?.state === 'error' ? (
              <span className="text-rose-400">Background AI: {status.message}</span>
            ) : status?.state === 'ready' ? (
              <>
                AI running on {status.delegate === 'GPU' ? 'the graphics chip' : 'the CPU'}
                {status.ms ? ` · ${status.ms} ms per update` : ''}.
              </>
            ) : (
              'Loading the background AI… (first time only, about 14 MB)'
            )
          ) : keyerError ? (
            <span className="text-rose-400">{keyerError}</span>
          ) : (
            'Green screen runs on the graphics chip. Light it evenly for clean edges.'
          )}{' '}
          Records at 30 fps while a background effect is on. The floating controls show your plain camera.
        </p>
      )}
    </>
  )
}
