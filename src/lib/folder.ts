// src/lib/folder.ts
// Saves recordings to a folder on your PC (File System Access API).
// The chosen folder is remembered in IndexedDB so you only pick it once.

const DB = 'framecast'
const STORE = 'handles'
const KEY = 'saveFolder'

export type FolderPermission = PermissionState | 'none'
export interface FolderState {
  handle: FileSystemDirectoryHandle | null
  permission: FolderPermission
}

export interface RecordingItem {
  name: string
  handle: FileSystemFileHandle
  size: number
  modified: number
}

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await idb()
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key)
    req.onsuccess = () => resolve(req.result as T | undefined)
    req.onerror = () => reject(req.error)
  })
}

async function idbSet(key: string, value: unknown): Promise<void> {
  const db = await idb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(value, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export const canPickFolder = () => typeof window.showDirectoryPicker === 'function'

export async function loadSavedFolder(): Promise<FolderState> {
  try {
    const handle = await idbGet<FileSystemDirectoryHandle>(KEY)
    if (!handle) return { handle: null, permission: 'none' }
    const permission = await handle.queryPermission({ mode: 'readwrite' })
    return { handle, permission }
  } catch {
    return { handle: null, permission: 'none' }
  }
}

/** Must be called from a click. */
export async function pickFolder(): Promise<FileSystemDirectoryHandle> {
  const handle = await window.showDirectoryPicker({ id: 'framecast-recordings', mode: 'readwrite', startIn: 'videos' })
  await idbSet(KEY, handle)
  return handle
}

/** Must be called from a click. */
export async function reconnectFolder(handle: FileSystemDirectoryHandle): Promise<PermissionState> {
  return await handle.requestPermission({ mode: 'readwrite' })
}

export function makeFileName(title: string): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
  const clean = title.replace(/[\\/:*?"<>|]+/g, '').trim().slice(0, 80)
  return clean ? `${clean} (${stamp}).mp4` : `Recording ${stamp}.mp4`
}

export async function createFile(dir: FileSystemDirectoryHandle, name: string): Promise<FileSystemFileHandle> {
  return await dir.getFileHandle(name, { create: true })
}

export async function listRecordings(dir: FileSystemDirectoryHandle): Promise<RecordingItem[]> {
  const items: RecordingItem[] = []
  for await (const [name, entry] of dir.entries()) {
    if (entry.kind !== 'file' || !/\.(mp4|webm|mov)$/i.test(name)) continue
    try {
      const file = await entry.getFile()
      items.push({ name, handle: entry, size: file.size, modified: file.lastModified })
    } catch {}
  }
  return items.sort((a, b) => b.modified - a.modified)
}

export async function deleteRecording(dir: FileSystemDirectoryHandle, name: string): Promise<void> {
  await dir.removeEntry(name)
}

/** Returns false when this browser can't rename files in place. */
export async function renameRecording(
  dir: FileSystemDirectoryHandle,
  file: FileSystemFileHandle,
  newName: string,
): Promise<boolean> {
  if (typeof file.move !== 'function') return false
  await file.move(dir, newName)
  return true
}

// ---- Fallback: record into the browser's private storage, then download ----
export async function downloadFromOpfs(name: string): Promise<void> {
  const root = await navigator.storage.getDirectory()
  const fh = await root.getFileHandle(name)
  const file = await fh.getFile()
  const url = URL.createObjectURL(file)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Give the download time to start before cleaning up.
  setTimeout(async () => {
    URL.revokeObjectURL(url)
    try { await root.removeEntry(name) } catch {}
  }, 60_000)
}

export async function removeFromOpfs(name: string): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory()
    await root.removeEntry(name)
  } catch {}
}

export function formatBytes(n: number): string {
  if (!n) return '0 MB'
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

export function formatTime(sec: number): string {
  const total = Math.max(0, Math.floor(sec))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e))
export const errorName = (e: unknown) => (e instanceof DOMException || e instanceof Error ? e.name : '')
