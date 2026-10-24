// src/workers/chromaKey.ts
// Green / blue screen removal on the built-in graphics chip (WebGL2).
// One tiny shader per frame, so it costs almost nothing on the CPU, and it
// keeps full-resolution edges (no AI mask involved).

type Source = VideoFrame | ImageBitmap

const VERT = `#version 300 es
in vec2 p;
out vec2 uv;
void main() {
  uv = vec2((p.x + 1.0) * 0.5, 1.0 - (p.y + 1.0) * 0.5);
  gl_Position = vec4(p, 0.0, 1.0);
}`

// "How much greener (or bluer) than red/blue is this pixel" is a simple, sturdy
// key that copes with real-world cloths (never pure green) and keeps skin.
const FRAG = `#version 300 es
precision mediump float;
uniform sampler2D tex;
uniform int blueKey;
in vec2 uv;
out vec4 outColor;
void main() {
  vec3 c = texture(tex, uv).rgb;
  float k = blueKey == 1 ? c.b - max(c.r, c.g) : c.g - max(c.r, c.b);
  float a = 1.0 - smoothstep(0.06, 0.16, k);
  // Spill: remove the green / blue glow the screen throws on hair and edges.
  if (k > 0.0) {
    if (blueKey == 1) c.b = max(c.r, c.g); else c.g = max(c.r, c.b);
  }
  outColor = vec4(c * a, a);
}`

export class ChromaKeyer {
  readonly canvas: OffscreenCanvas
  private readonly gl: WebGL2RenderingContext
  private readonly blueLoc: WebGLUniformLocation | null

  private constructor(canvas: OffscreenCanvas, gl: WebGL2RenderingContext) {
    this.canvas = canvas
    this.gl = gl
    const prog = gl.createProgram()!
    for (const [type, src] of [
      [gl.VERTEX_SHADER, VERT],
      [gl.FRAGMENT_SHADER, FRAG],
    ] as const) {
      const sh = gl.createShader(type)!
      gl.shaderSource(sh, src)
      gl.compileShader(sh)
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) || 'shader')
      gl.attachShader(prog, sh)
    }
    gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'link')
    gl.useProgram(prog)

    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
    const loc = gl.getAttribLocation(prog, 'p')
    gl.enableVertexAttribArray(loc)
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)

    const tex = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    this.blueLoc = gl.getUniformLocation(prog, 'blueKey')
  }

  /** null when WebGL2 isn't available. */
  static create(): ChromaKeyer | null {
    try {
      const canvas = new OffscreenCanvas(2, 2)
      const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, preserveDrawingBuffer: true, antialias: false })
      if (!gl) return null
      return new ChromaKeyer(canvas, gl)
    } catch {
      return null
    }
  }

  /** Returns the keyed picture (same size as the frame, transparent where the screen was). */
  process(frame: Source, width: number, height: number, key: 'green' | 'blue'): OffscreenCanvas {
    const gl = this.gl
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width
      this.canvas.height = height
    }
    gl.viewport(0, 0, width, height)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame)
    gl.uniform1i(this.blueLoc, key === 'blue' ? 1 : 0)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    return this.canvas
  }
}
