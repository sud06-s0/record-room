// src/lib/bgImage.ts
// Your uploaded background picture. It's shrunk to 1920x1080 at most and kept
// in this browser (localStorage) so it's still there next time.

const KEY = 'framecast:bgImage:v1'
const MAX_W = 1920
const MAX_H = 1080

/** Shrinks the picture, saves it, and returns it ready for the compositor plus a thumbnail URL. */
export async function saveBackgroundImage(file: Blob): Promise<{ bitmap: ImageBitmap; dataUrl: string }> {
  const original = await createImageBitmap(file)
  const scale = Math.min(1, MAX_W / original.width, MAX_H / original.height)
  const w = Math.max(1, Math.round(original.width * scale))
  const h = Math.max(1, Math.round(original.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const c = canvas.getContext('2d')!
  c.imageSmoothingQuality = 'high'
  c.drawImage(original, 0, 0, w, h)
  original.close()
  const dataUrl = canvas.toDataURL('image/jpeg', 0.86)
  try {
    localStorage.setItem(KEY, dataUrl)
  } catch {
    // Storage full or blocked: the picture still works until the page is reloaded.
  }
  return { bitmap: await createImageBitmap(canvas), dataUrl }
}

/** The saved picture, or null. */
export async function loadBackgroundImage(): Promise<{ bitmap: ImageBitmap; dataUrl: string } | null> {
  let dataUrl: string | null = null
  try {
    dataUrl = localStorage.getItem(KEY)
  } catch {}
  if (!dataUrl) return null
  try {
    const blob = await (await fetch(dataUrl)).blob()
    return { bitmap: await createImageBitmap(blob), dataUrl }
  } catch {
    return null
  }
}
