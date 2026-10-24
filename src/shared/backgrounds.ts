// src/shared/backgrounds.ts
// Built-in background pictures. They're drawn in code (no image files to
// download), once, at 1920x1080. `css` is a close match used for the
// thumbnails in the picker.

import type { Background } from './types'

export const DEFAULT_BACKGROUND: Background = {
  mode: 'none',
  blur: 'light',
  image: 'studio',
  color: '#18181b',
  keyer: 'ai',
  cutout: false,
}

export const BG_COLORS = ['#ffffff', '#e4e4e7', '#18181b', '#0f172a', '#1e3a8a', '#14532d', '#7c2d12', '#be123c']

type Ctx = OffscreenCanvasRenderingContext2D

function linear(c: Ctx, w: number, h: number, angleDeg: number, stops: [number, string][]) {
  const a = (angleDeg * Math.PI) / 180
  const dx = Math.sin(a)
  const dy = -Math.cos(a)
  const len = Math.abs(w * dx) + Math.abs(h * dy)
  const g = c.createLinearGradient(w / 2 - (dx * len) / 2, h / 2 - (dy * len) / 2, w / 2 + (dx * len) / 2, h / 2 + (dy * len) / 2)
  for (const [at, col] of stops) g.addColorStop(at, col)
  c.fillStyle = g
  c.fillRect(0, 0, w, h)
}

function glow(c: Ctx, x: number, y: number, r: number, color: string) {
  const g = c.createRadialGradient(x, y, 0, x, y, r)
  g.addColorStop(0, color)
  g.addColorStop(1, 'rgba(0,0,0,0)')
  c.fillStyle = g
  c.fillRect(x - r, y - r, r * 2, r * 2)
}

/** Small fixed pseudo-random sequence, so the bokeh looks the same every time. */
function seeded(seed: number) {
  let s = seed
  return () => {
    s = (s * 16807) % 2147483647
    return (s - 1) / 2147483646
  }
}

export interface BgPreset {
  id: string
  name: string
  css: string
  draw: (c: Ctx, w: number, h: number) => void
}

export const BG_PRESETS: BgPreset[] = [
  {
    id: 'studio',
    name: 'Studio',
    css: 'radial-gradient(ellipse at 50% 40%, #a1a1aa 0%, #52525b 45%, #27272a 100%)',
    draw(c, w, h) {
      c.fillStyle = '#27272a'
      c.fillRect(0, 0, w, h)
      const g = c.createRadialGradient(w * 0.5, h * 0.4, 0, w * 0.5, h * 0.4, w * 0.62)
      g.addColorStop(0, '#a1a1aa')
      g.addColorStop(0.45, '#52525b')
      g.addColorStop(1, '#27272a')
      c.fillStyle = g
      c.fillRect(0, 0, w, h)
    },
  },
  {
    id: 'bokeh',
    name: 'Café',
    css:
      'radial-gradient(circle at 20% 30%, rgba(251,191,36,.55) 0 8%, transparent 9%), radial-gradient(circle at 75% 25%, rgba(254,243,199,.45) 0 6%, transparent 7%), radial-gradient(circle at 60% 70%, rgba(251,146,60,.4) 0 10%, transparent 11%), linear-gradient(160deg, #44403c, #1c1917)',
    draw(c, w, h) {
      linear(c, w, h, 160, [
        [0, '#44403c'],
        [1, '#1c1917'],
      ])
      const rnd = seeded(7)
      const colors = ['rgba(251,191,36,', 'rgba(254,243,199,', 'rgba(251,146,60,', 'rgba(253,224,71,']
      for (let i = 0; i < 38; i++) {
        const r = 40 + rnd() * 120
        const alpha = 0.18 + rnd() * 0.35
        const col = colors[Math.floor(rnd() * colors.length)]
        const x = rnd() * w
        const y = rnd() * h * 0.85
        const g = c.createRadialGradient(x, y, r * 0.55, x, y, r)
        g.addColorStop(0, `${col}${alpha})`)
        g.addColorStop(1, `${col}0)`)
        c.fillStyle = g
        c.beginPath()
        c.arc(x, y, r, 0, Math.PI * 2)
        c.fill()
      }
    },
  },
  {
    id: 'midnight',
    name: 'Midnight',
    css: 'linear-gradient(135deg, #0f172a 0%, #312e81 55%, #581c87 100%)',
    draw(c, w, h) {
      linear(c, w, h, 135, [
        [0, '#0f172a'],
        [0.55, '#312e81'],
        [1, '#581c87'],
      ])
      glow(c, w * 0.78, h * 0.25, h * 0.6, 'rgba(167,139,250,0.25)')
    },
  },
  {
    id: 'sunset',
    name: 'Sunset',
    css: 'linear-gradient(160deg, #fdba74 0%, #fb7185 50%, #7c3aed 100%)',
    draw(c, w, h) {
      linear(c, w, h, 160, [
        [0, '#fdba74'],
        [0.5, '#fb7185'],
        [1, '#7c3aed'],
      ])
    },
  },
  {
    id: 'ocean',
    name: 'Ocean',
    css: 'linear-gradient(160deg, #67e8f9 0%, #0ea5e9 45%, #1e3a8a 100%)',
    draw(c, w, h) {
      linear(c, w, h, 160, [
        [0, '#67e8f9'],
        [0.45, '#0ea5e9'],
        [1, '#1e3a8a'],
      ])
    },
  },
  {
    id: 'forest',
    name: 'Forest',
    css: 'radial-gradient(ellipse at 30% 30%, #4d7c0f 0%, transparent 55%), linear-gradient(160deg, #166534 0%, #14532d 50%, #052e16 100%)',
    draw(c, w, h) {
      linear(c, w, h, 160, [
        [0, '#166534'],
        [0.5, '#14532d'],
        [1, '#052e16'],
      ])
      glow(c, w * 0.3, h * 0.3, h * 0.7, 'rgba(132,204,22,0.35)')
    },
  },
]
