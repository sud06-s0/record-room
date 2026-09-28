// src/lib/settings.ts
import { useEffect, useState } from 'react'
import type { BubbleSize, Corner, Fit, LayoutMode } from '../shared/types'
import type { NcMode } from './audio'
import type { QualityKey, Surface } from './studio'

const KEY = 'framecast:settings:v1'

export interface Settings {
  mode: LayoutMode
  bubbleSize: BubbleSize
  bubbleCorner: Corner
  mirror: boolean
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
}

export const DEFAULTS: Settings = {
  mode: 'bubble',
  bubbleSize: 'medium',
  bubbleCorner: 'bl',
  mirror: true,
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
}

function load(): Settings {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) || '{}') as Partial<Settings>) }
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
