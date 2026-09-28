// src/App.tsx
import { useEffect, useState } from 'react'
import Recorder from './components/Recorder'
import Library from './components/Library'
import { browserSupport } from './lib/studio'
import { loadSavedFolder, pickFolder, reconnectFolder, errorMessage, errorName, type FolderState } from './lib/folder'

export default function App() {
  const [tab, setTab] = useState<'record' | 'library'>('record')
  const [folder, setFolder] = useState<FolderState>({ handle: null, permission: 'none' })
  const [libraryKey, setLibraryKey] = useState(0)
  const missing = browserSupport()

  useEffect(() => {
    loadSavedFolder().then(setFolder)
  }, [])

  async function choose() {
    try {
      const handle = await pickFolder()
      setFolder({ handle, permission: 'granted' })
    } catch (e) {
      if (errorName(e) !== 'AbortError') alert(errorMessage(e))
    }
  }
  async function reconnect() {
    if (!folder.handle) return choose()
    const permission = await reconnectFolder(folder.handle)
    setFolder((f) => ({ ...f, permission }))
  }

  if (missing.length) {
    return (
      <div className="grid h-screen place-items-center p-8 text-center">
        <div className="max-w-md">
          <h1 className="text-xl font-semibold">Please open this in Chrome or Edge on a desktop</h1>
          <p className="mt-2 text-sm text-zinc-400">
            This browser is missing: {missing.join(', ')}. FrameCast needs the latest Google Chrome or Microsoft Edge.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-screen min-w-[1100px] flex-col">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-white/5 px-6">
        <div className="flex items-center gap-2.5">
          <div className="grid h-7 w-7 place-items-center rounded-lg bg-rose-600">
            <div className="h-2.5 w-2.5 rounded-full bg-white" />
          </div>
          <span className="font-semibold tracking-tight">FrameCast</span>
        </div>
        <nav className="flex gap-1 rounded-lg bg-zinc-900 p-1">
          {(
            [
              ['record', 'Record'],
              ['library', 'Recordings'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`rounded-md px-4 py-1.5 text-sm font-medium transition ${
                tab === id ? 'bg-zinc-700 text-white' : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="w-44 text-right text-xs text-zinc-600">Saved on this PC only</div>
      </header>

      {/* Recorder stays mounted so camera / screen keep running while you browse recordings */}
      <div className={tab === 'record' ? 'flex min-h-0 flex-1' : 'hidden'}>
        <Recorder
          folder={folder}
          onPickFolder={choose}
          onReconnectFolder={reconnect}
          onRecordingSaved={() => setLibraryKey((k) => k + 1)}
        />
      </div>
      {tab === 'library' && (
        <Library folder={folder} onPickFolder={choose} onReconnectFolder={reconnect} refreshKey={libraryKey} />
      )}
    </div>
  )
}
