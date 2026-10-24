// src/lib/settings.ts
import { useEffect, useState } from 'react'
import type { Background, BubbleSize, Corner, Fit, LayoutMode, Rotation } from '../shared/types'
import { DEFAULT_BACKGROUND } from '../shared/backgrounds'
import type { NcMode } from './audio'
import type { QualityKey, Surface } from './studio'

const KEY = 'framecast:settings:v1'

export interface Settings {
  mode: LayoutMode
  bubbleSize: BubbleSize
  bubbleCorner: Corner
  mirror: boolean
  cameraRotation: Rotation
  splitFit: Fit
  /** '' = system default, 'none' = off */
  cameraId: string
  micId: string
  ncMode: NcMode
  surface: Surface
  shareAudio: boolean
  micVolume: number
  systemVolume: number
  quality: QualityKey
  countdown: boolean
  floatingControls: boolean
  /** Camera background: blur, picture, colour, cutout */
  background: Background
}

export const DEFAULTS: Settings = {
  mode: 'bubble',
  bubbleSize: 'medium',
  bubbleCorner: 'bl',
  mirror: true,
  cameraRotation: 0,
  splitFit: 'contain',
  cameraId: '',
  micId: '',
  ncMode: 'strong',
  surface: 'browser',
  shareAudio: true,
  micVolume: 1,
  systemVolume: 0.8,
  quality: '1080p30',
  countdown: true,
  floatingControls: true,
  background: DEFAULT_BACKGROUND,
}

function load(): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || '{}') as Partial<Settings>
    return { ...DEFAULTS, ...saved, background: { ...DEFAULT_BACKGROUND, ...saved.background } }
  } catch {
    return { ...DEFAULTS }
  }
}

export function useSettings(): [Settings, (patch: Partial<Settings>) => void] {
  const [settings, setSettings] = useState<Settings>(load)
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(settings))
    } catch {}
  }, [settings])
  const update = (patch: Partial<Settings>) => setSettings((s) => ({ ...s, ...patch }))
  return [settings, update]
}
