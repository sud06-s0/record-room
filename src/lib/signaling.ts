// src/lib/signaling.ts
// One-time handshake between the PC and the phone. Only a few small messages
// (SDP offer/answer + network candidates) pass through here — never video.
// Uses Supabase Realtime "broadcast": no tables, nothing stored.

import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js'

export type Role = 'pc' | 'phone'

export type SignalMessage =
  | { kind: 'hello'; from: Role }
  | { kind: 'offer'; sdp: string }
  | { kind: 'answer'; sdp: string }
  | { kind: 'ice'; from: Role; candidate: RTCIceCandidateInit }
  | { kind: 'phone-status'; facing: 'user' | 'environment'; micMuted: boolean }
  | { kind: 'bye'; from: Role }

export interface Signal {
  send(msg: SignalMessage): void
  close(): void
}

const URL_ = import.meta.env.VITE_SUPABASE_URL as string | undefined
const KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

/** `?signal=local` uses BroadcastChannel (two tabs of one browser) — for testing only. */
const useLocal = () => new URLSearchParams(location.search).get('signal') === 'local'

export const signalingConfigured = () => useLocal() || (!!URL_ && !!KEY)

let client: SupabaseClient | null = null

export async function openSignal(room: string, onMessage: (msg: SignalMessage) => void): Promise<Signal> {
  if (useLocal()) {
    const bc = new BroadcastChannel(`framecast-${room}`)
    bc.onmessage = (e: MessageEvent<SignalMessage>) => onMessage(e.data)
    return { send: (msg) => bc.postMessage(msg), close: () => bc.close() }
  }
  if (!URL_ || !KEY) throw new Error('Phone pairing is not set up: add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in Vercel.')

  client ??= createClient(URL_, KEY, { auth: { persistSession: false } })
  const channel: RealtimeChannel = client.channel(`framecast-${room}`, {
    config: { broadcast: { self: false, ack: false } },
  })
  channel.on('broadcast', { event: 'sig' }, ({ payload }) => onMessage(payload as SignalMessage))

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Could not reach the pairing server (Supabase Realtime).')), 12_000)
    channel.subscribe((status, err) => {
      if (status === 'SUBSCRIBED') {
        clearTimeout(timer)
        resolve()
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        clearTimeout(timer)
        reject(err ?? new Error(`Pairing channel ${status.toLowerCase()}`))
      }
    })
  })

  return {
    send: (msg) => {
      void channel.send({ type: 'broadcast', event: 'sig', payload: msg })
    },
    close: () => {
      void client?.removeChannel(channel)
    },
  }
}

/** Random, unguessable room id — the pairing link works like a password. */
export function newRoomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  return Array.from(bytes, (b) => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('')
}
