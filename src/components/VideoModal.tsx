// src/components/VideoModal.tsx
import { useEffect } from 'react'

export default function VideoModal({ url, name, onClose }: { url: string; name: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/80 p-8 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-6xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <div className="truncate text-sm text-zinc-300">{name}</div>
          <button onClick={onClose} className="rounded-lg px-3 py-1 text-sm text-zinc-400 hover:bg-white/10 hover:text-white">
            Close ✕
          </button>
        </div>
        <video src={url} controls autoPlay className="aspect-video w-full rounded-xl bg-black" />
      </div>
    </div>
  )
}
