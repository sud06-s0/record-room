// src/components/Library.tsx
// Lists the recordings in your chosen folder — all local, no database.
import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import {
  listRecordings,
  deleteRecording,
  renameRecording,
  formatBytes,
  errorMessage,
  canPickFolder,
  type FolderState,
  type RecordingItem,
} from '../lib/folder'
import VideoModal from './VideoModal'

interface Props {
  folder: FolderState
  onPickFolder: () => void
  onReconnectFolder: () => void
  refreshKey: number
}

export default function Library({ folder, onPickFolder, onReconnectFolder, refreshKey }: Props) {
  const [items, setItems] = useState<RecordingItem[]>([])
  const [loading, setLoading] = useState(false)
  const [playing, setPlaying] = useState<{ name: string; url: string } | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const ok = folder.handle && folder.permission === 'granted'

  const load = useCallback(async () => {
    if (!ok || !folder.handle) return
    setLoading(true)
    try {
      setItems(await listRecordings(folder.handle))
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setLoading(false)
    }
  }, [ok, folder.handle])

  useEffect(() => {
    load()
  }, [load, refreshKey])

  async function play(item: RecordingItem) {
    const file = await item.handle.getFile()
    setPlaying({ name: item.name, url: URL.createObjectURL(file) })
  }

  async function remove(item: RecordingItem) {
    if (!folder.handle) return
    if (!confirm(`Delete “${item.name}” from your PC? This can't be undone.`)) return
    try {
      await deleteRecording(folder.handle, item.name)
      load()
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  async function saveRename(item: RecordingItem, value: string) {
    setRenaming(null)
    if (!folder.handle) return
    let name = value.trim().replace(/[\\/:*?"<>|]+/g, '')
    if (!name || name === item.name) return
    if (!/\.(mp4|webm|mov)$/i.test(name)) name += '.mp4'
    try {
      const done = await renameRecording(folder.handle, item.handle, name)
      if (!done) setError('Renaming is not supported in this browser version — rename it in File Explorer.')
      load()
    } catch (e) {
      setError(`Rename failed: ${errorMessage(e)}`)
    }
  }

  if (!folder.handle && !canPickFolder()) {
    return (
      <Empty
        title="Recordings go to your Downloads folder"
        text="This browser can't open a folder on your PC, so each recording downloads when you stop. Use Chrome or Edge to save to a chosen folder and browse recordings here."
      >
        {null}
      </Empty>
    )
  }
  if (!folder.handle) {
    return (
      <Empty title="No folder chosen yet" text="Pick the folder where recordings are saved and they'll show up here.">
        <button onClick={onPickFolder} className="rounded-xl bg-rose-600 px-5 py-2.5 font-semibold hover:bg-rose-500">
          Choose folder…
        </button>
      </Empty>
    )
  }
  if (!ok || !folder.handle) {
    return (
      <Empty title={`Allow access to “${folder.handle.name}”`} text="Your browser asks again after a restart. One click and you're back.">
        <button onClick={onReconnectFolder} className="rounded-xl bg-rose-600 px-5 py-2.5 font-semibold hover:bg-rose-500">
          Allow access
        </button>
      </Empty>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto p-8">
      <div className="mx-auto max-w-5xl">
        <div className="mb-6 flex items-end justify-between">
          <div>
            <h1 className="text-xl font-semibold">Recordings</h1>
            <p className="text-sm text-zinc-500">
              📁 {folder.handle.name} · {items.length} file{items.length === 1 ? '' : 's'}
            </p>
          </div>
          <div className="flex gap-2">
            <button onClick={load} className="rounded-lg bg-zinc-800 px-3 py-1.5 text-sm hover:bg-zinc-700">
              Refresh
            </button>
            <button onClick={onPickFolder} className="rounded-lg px-3 py-1.5 text-sm text-zinc-400 hover:bg-white/5">
              Change folder
            </button>
          </div>
        </div>
        {error && (
          <div className="mb-4 flex justify-between rounded-lg bg-rose-500/10 px-4 py-2 text-sm text-rose-200">
            {error}
            <button onClick={() => setError(null)}>✕</button>
          </div>
        )}
        {loading && !items.length ? (
          <p className="text-sm text-zinc-500">Loading…</p>
        ) : !items.length ? (
          <p className="rounded-xl border border-dashed border-white/10 p-10 text-center text-sm text-zinc-500">
            No recordings in this folder yet.
          </p>
        ) : (
          <div className="divide-y divide-white/5 overflow-hidden rounded-xl border border-white/10 bg-zinc-900/40">
            {items.map((item) => (
              <div key={item.name} className="flex items-center gap-4 px-4 py-3 hover:bg-white/[0.02]">
                <button
                  onClick={() => play(item)}
                  className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-rose-600/15 text-rose-400 hover:bg-rose-600/25"
                  title="Play"
                >
                  ▶
                </button>
                <div className="min-w-0 flex-1">
                  {renaming === item.name ? (
                    <input
                      autoFocus
                      defaultValue={item.name}
                      onBlur={(e) => saveRename(item, e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') e.currentTarget.blur()
                        if (e.key === 'Escape') setRenaming(null)
                      }}
                      className="w-full rounded-md border border-rose-500/50 bg-zinc-950 px-2 py-1 text-sm outline-none"
                    />
                  ) : (
                    <div className="truncate text-sm font-medium text-zinc-100">{item.name}</div>
                  )}
                  <div className="text-xs text-zinc-500">
                    {new Date(item.modified).toLocaleString()} · {formatBytes(item.size)}
                  </div>
                </div>
                <button onClick={() => setRenaming(item.name)} className="rounded-md px-2.5 py-1 text-xs text-zinc-400 hover:bg-white/5 hover:text-zinc-200">
                  Rename
                </button>
                <button onClick={() => remove(item)} className="rounded-md px-2.5 py-1 text-xs text-zinc-400 hover:bg-rose-500/10 hover:text-rose-300">
                  Delete
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      {playing && (
        <VideoModal
          {...playing}
          onClose={() => {
            URL.revokeObjectURL(playing.url)
            setPlaying(null)
          }}
        />
      )}
    </div>
  )
}

function Empty({ title, text, children }: { title: string; text: string; children: ReactNode }) {
  return (
    <div className="grid flex-1 place-items-center p-8">
      <div className="max-w-sm text-center">
        <div className="mb-4 text-4xl">📁</div>
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="mb-6 mt-1 text-sm text-zinc-500">{text}</p>
        {children}
      </div>
    </div>
  )
}
