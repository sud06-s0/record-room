// vite.config.ts
import { createReadStream, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * Serves MediaPipe's WASM runtime (used by the camera background AI) from our
 * own site at /mediapipe/, straight out of node_modules, so it's always the
 * same version as the package and needs no CDN. Dev: served by a middleware.
 * Build: copied into dist/mediapipe/.
 */
function mediapipeWasm(): Plugin {
  const dir = fileURLToPath(new URL('./node_modules/@mediapipe/tasks-vision/wasm/', import.meta.url))
  const files = ['vision_wasm_module_internal.js', 'vision_wasm_module_internal.wasm']
  const type = (f: string) => (f.endsWith('.wasm') ? 'application/wasm' : 'text/javascript')
  return {
    name: 'mediapipe-wasm',
    configureServer(server) {
      server.middlewares.use('/mediapipe', (req, res, next) => {
        const name = (req.url || '').split('?')[0].replace(/^\//, '')
        if (!files.includes(name)) return next()
        res.setHeader('Content-Type', type(name))
        res.setHeader('Cache-Control', 'no-cache')
        createReadStream(dir + name).pipe(res)
      })
    },
    generateBundle() {
      for (const name of files) {
        this.emitFile({ type: 'asset', fileName: `mediapipe/${name}`, source: readFileSync(dir + name) })
      }
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), mediapipeWasm()],
  worker: { format: 'es' },
  build: { target: 'es2022' },
})
