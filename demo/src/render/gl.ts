// The retro CRT renderer: WebGL2, instanced sprite quads over a procedurally drawn pixel atlas,
// composited at a fixed 480×270 internal resolution, then a CRT post pass (barrel, scanlines,
// phosphor triad mask, vignette, bloom-from-mip, flicker) upscales to the canvas. Zero assets,
// zero dependencies — every sprite is fillRect pixels drawn at boot, tinted per instance.
//
// Render-only module: it reads sim state, never writes it. Nothing here may feed back into the
// simulation (determinism), which is also why particles live out here.

import { ARENA_H, ARENA_W } from '../sim/shared.js'

export const SPR_PLAYER = 0
export const SPR_SWARM = 1
export const SPR_MOTH = 2
export const SPR_BRUTE = 3
export const SPR_BULLET = 4
export const SPR_GEM = 5
export const SPR_BOSS = 6
export const SPR_DOT = 7
export const SPR_GLOW = 8
export const SPR_MOTH2 = 9
export const SPR_FLAME = 10
export const SPR_RING = 11

const ATLAS = 128
const CELL = 16 // atlas grid cell (pixels); sprite quads sample one cell
const MAX_INSTANCES = 80000
const FLOATS = 8 // x, y, size, sprite, r, g, b, a

function drawAtlas(): HTMLCanvasElement {
  const cv = document.createElement('canvas')
  cv.width = ATLAS
  cv.height = ATLAS
  const g = cv.getContext('2d')!
  g.clearRect(0, 0, ATLAS, ATLAS)
  const px = (cell: number, x: number, y: number, v: number, size = 1): void => {
    const cx = (cell % 8) * CELL
    const cy = Math.floor(cell / 8) * CELL
    g.fillStyle = `rgba(255,255,255,${v})`
    g.fillRect(cx + x, cy + y, size, size)
  }
  // Sprites draw around cell center (8,8) in grayscale VALUE layers (instances tint them):
  // 'X' = 1.0 bright body, 'o' = 0.6 mid, '.' = 0.28 dark shade, ' ' = empty.
  const art = (cell: number, rows: string[], ox: number, oy: number): void => {
    rows.forEach((row, y) =>
      row.split('').forEach((c, x) => {
        if (c === 'X') px(cell, x + ox, y + oy, 1)
        else if (c === 'o') px(cell, x + ox, y + oy, 0.6)
        else if (c === '.') px(cell, x + ox, y + oy, 0.28)
      }),
    )
  }
  // 0: player ship — a finned interceptor with a bright cockpit.
  art(SPR_PLAYER, [
    '   oXo   ',
    '   XXX   ',
    '  .XXX.  ',
    '  oXXXo  ',
    ' oXXXXXo ',
    'oXX.XXXo ',
    'XXo XXXoX',
    'X. oXo .X',
    '    o    ',
  ], 3, 3)
  // 1: swarm — a spiky mite: bright core, dark spikes.
  art(SPR_SWARM, [
    '.  X  .',
    ' .oXo. ',
    'XoXXXoX',
    ' .oXo. ',
    '.  X  .',
  ], 4, 5)
  // 2/9: moth — two wing frames (spread / folded) for the flap cycle.
  art(SPR_MOTH, [
    'X.   .X',
    'XXo oXX',
    '.XXoXX.',
    ' oXXXo ',
    '.XXoXX.',
    'XXo oXX',
    'X.   .X',
  ], 4, 4)
  art(SPR_MOTH2, [
    '       ',
    'X.   .X',
    'XXX.XXX',
    ' oXXXo ',
    'XXX.XXX',
    'X.   .X',
    '       ',
  ], 4, 4)
  // 3: brute — armored slab, glowing eyes, dark plating seams.
  art(SPR_BRUTE, [
    ' .XXXXXXX. ',
    '.XXXXXXXXX.',
    'XX.XXXXX.XX',
    'XXoXXXXXoXX',
    'XX.XXXXX.XX',
    'XXXXXXXXXXX',
    '.XX.XXX.XX.',
    '.XXXXXXXXX.',
    ' .X.X.X.X. ',
  ], 2, 3)
  // 4: bullet — a bright bolt with a hot head and fading tail.
  art(SPR_BULLET, ['oXo', 'XXX', 'oXo', '.o.'], 6, 5)
  // 5: gem — faceted diamond with a specular corner.
  art(SPR_GEM, [
    ' oXo ',
    'oXXXo',
    'XXoXX',
    'oXXXo',
    ' .o. ',
  ], 5, 5)
  px(SPR_GEM, 6, 6, 1)
  // 6: boss — a horned reaper skull.
  art(SPR_BOSS, [
    'X.          .X',
    'XX. .XXXX. .XX',
    'XXXXXXXXXXXXXX',
    '.XXXXXXXXXXXX.',
    'XXXXXXXXXXXXXX',
    'XX..XXXXXX..XX',
    'XX..XXXXXX..XX',
    'XXXXXX..XXXXXX',
    'XXXXXXXXXXXXXX',
    '.XXXXXXXXXXXX.',
    '.XX.XX.XX.XX. ',
    ' oX.XX.XX.Xo  ',
    '  o .o .o o   ',
  ], 1, 1)
  // 7: dot particle.
  px(SPR_DOT, 7, 7, 1)
  px(SPR_DOT, 8, 7, 1)
  px(SPR_DOT, 7, 8, 1)
  px(SPR_DOT, 8, 8, 1)
  // 8: radial glow (for additive pass).
  for (let y = 0; y < CELL; y++)
    for (let x = 0; x < CELL; x++) {
      const dx = x - 7.5
      const dy = y - 7.5
      const d = Math.sqrt(dx * dx + dy * dy) / 8
      const v = Math.max(0, 1 - d)
      if (v > 0.02) px(SPR_GLOW, x, y, v * v)
    }
  // 10: thruster flame — a small teardrop, drawn additive behind ships.
  art(SPR_FLAME, ['oXo', 'XXX', 'oXo', '.X.', ' o '], 6, 5)
  // 11: a crisp circle outline — the live player's anchor ring in the melee.
  for (let y = 0; y < CELL; y++)
    for (let x = 0; x < CELL; x++) {
      const d = Math.sqrt((x - 7.5) * (x - 7.5) + (y - 7.5) * (y - 7.5))
      if (d >= 6.1 && d <= 7.2) px(SPR_RING, x, y, d <= 6.7 ? 1 : 0.45)
    }
  return cv
}

/** Procedural arena backdrop: soft radial haze, a fine grid, drifting dust, and bounds. */
function drawBackground(w: number, h: number): HTMLCanvasElement {
  const cv = document.createElement('canvas')
  cv.width = w
  cv.height = h
  const g = cv.getContext('2d')!
  const grad = g.createRadialGradient(w / 2, h / 2, 20, w / 2, h / 2, w * 0.62)
  grad.addColorStop(0, '#0a1018')
  grad.addColorStop(0.55, '#060a10')
  grad.addColorStop(1, '#03050a')
  g.fillStyle = grad
  g.fillRect(0, 0, w, h)
  // Fine grid with brighter majors — the CRT tabletop.
  for (let x = 0; x <= w; x += 24) {
    g.fillStyle = x % 96 === 0 ? 'rgba(110,200,255,0.055)' : 'rgba(110,200,255,0.028)'
    g.fillRect(x, 0, 1, h)
  }
  for (let y = 0; y <= h; y += 24) {
    g.fillStyle = y % 96 === 0 ? 'rgba(110,200,255,0.055)' : 'rgba(110,200,255,0.028)'
    g.fillRect(0, y, w, 1)
  }
  // Dust motes (render-only randomness — never touches the sim).
  for (let i = 0; i < 110; i++) {
    const a = 0.04 + Math.random() * 0.1
    g.fillStyle = `rgba(${150 + Math.random() * 60}, ${200 + Math.random() * 40}, 255, ${a})`
    g.fillRect(Math.floor(Math.random() * w), Math.floor(Math.random() * h), 1, 1)
  }
  // Arena bounds — a phosphor edge so the walls read.
  g.strokeStyle = 'rgba(120,255,190,0.22)'
  g.lineWidth = 1
  g.strokeRect(1.5, 1.5, w - 3, h - 3)
  g.strokeStyle = 'rgba(120,255,190,0.07)'
  g.strokeRect(3.5, 3.5, w - 7, h - 7)
  return cv
}

const SCENE_VS = `#version 300 es
layout(location=0) in vec2 corner;      // unit quad -0.5..0.5
layout(location=1) in vec4 inst0;       // x, y, size, sprite
layout(location=2) in vec4 tint;
uniform vec2 viewport;                  // internal resolution
uniform vec2 shake;
out vec2 uv;
out vec4 vtint;
void main() {
  float size = inst0.z;
  vec2 center = floor(inst0.xy + shake) + 0.5;      // pixel snap — the retro crunch
  vec2 pos = center + corner * size * ${CELL}.0;
  vec2 clip = (pos / viewport) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  float s = inst0.w;
  // Sample a size-scaled window centered in the sprite's atlas cell, so a quad smaller than the
  // cell (tight quads keep overdraw sane at horde scale) still lands on the centered art.
  vec2 cellUv = vec2(mod(s, 8.0), floor(s / 8.0)) * ${CELL}.0;
  uv = (cellUv + ${CELL}.0 * 0.5 + corner * size * ${CELL}.0) / ${ATLAS}.0;
  vtint = tint;
}`

const SCENE_FS = `#version 300 es
precision mediump float;
in vec2 uv;
in vec4 vtint;
uniform sampler2D atlas;
out vec4 color;
void main() {
  vec4 t = texture(atlas, uv);
  if (t.a < 0.01) discard;
  color = vec4(t.rgb * vtint.rgb, t.a * vtint.a);
}`

const POST_VS = `#version 300 es
layout(location=0) in vec2 p;
out vec2 uv;
void main() { uv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }`

const BG_FS = `#version 300 es
precision mediump float;
in vec2 uv;
uniform sampler2D bg;
out vec4 color;
void main() { color = texture(bg, vec2(uv.x, 1.0 - uv.y)); }`

const POST_FS = `#version 300 es
precision highp float;
in vec2 uv;
uniform sampler2D scene;
uniform float time;
uniform vec2 outSize;
out vec4 color;

vec2 barrel(vec2 v) {
  vec2 c = v - 0.5;
  float r2 = dot(c, c);
  return 0.5 + c * (1.0 + 0.11 * r2 + 0.09 * r2 * r2);
}

void main() {
  vec2 buv = barrel(uv);
  if (buv.x < 0.0 || buv.x > 1.0 || buv.y < 0.0 || buv.y > 1.0) {
    color = vec4(0.01, 0.012, 0.01, 1.0);
    return;
  }
  // Chromatic fringe.
  float ca = 0.0016 * (0.4 + dot(buv - 0.5, buv - 0.5) * 4.0);
  float r = texture(scene, buv + vec2(ca, 0.0)).r;
  float g = texture(scene, buv).g;
  float b = texture(scene, buv - vec2(ca, 0.0)).b;
  vec3 col = vec3(r, g, b);
  // Thresholded bloom from the mip chain: only genuinely bright pixels halo, so the backdrop
  // stays inky while ships, bolts, and novas burn. Soft-clipped so stacked kills glow, not nuke.
  vec3 blur = textureLod(scene, buv, 2.5).rgb;
  vec3 wide = textureLod(scene, buv, 4.0).rgb;
  vec3 bloom = max(blur - 0.26, 0.0) * 0.75 + max(wide - 0.3, 0.0) * 0.35;
  col += bloom / (1.0 + bloom);
  // Scanlines at internal-res lines.
  float line = sin(buv.y * ${ARENA_H}.0 * 3.14159265 * 2.0);
  col *= 0.82 + 0.18 * line * line;
  // Phosphor triad mask on OUTPUT pixels.
  float m = mod(gl_FragCoord.x, 3.0);
  vec3 mask = m < 1.0 ? vec3(1.05, 0.9, 0.9) : m < 2.0 ? vec3(0.9, 1.05, 0.9) : vec3(0.9, 0.9, 1.05);
  col *= mask;
  // Vignette + flicker + a faint moving raster wave.
  vec2 c = buv - 0.5;
  col *= 1.0 - dot(c, c) * 0.55;
  col *= 0.985 + 0.015 * sin(time * 73.0);
  col += 0.006 * sin(buv.y * 700.0 + time * 8.0);
  color = vec4(col, 1.0);
}`

function compile(gl: WebGL2RenderingContext, vsSrc: string, fsSrc: string): WebGLProgram {
  const mk = (kind: number, src: string): WebGLShader => {
    const sh = gl.createShader(kind)!
    gl.shaderSource(sh, src)
    gl.compileShader(sh)
    if (gl.getShaderParameter(sh, gl.COMPILE_STATUS) !== true) {
      throw new Error(`shader: ${gl.getShaderInfoLog(sh) ?? 'compile failed'}`)
    }
    return sh
  }
  const prog = gl.createProgram()!
  gl.attachShader(prog, mk(gl.VERTEX_SHADER, vsSrc))
  gl.attachShader(prog, mk(gl.FRAGMENT_SHADER, fsSrc))
  gl.linkProgram(prog)
  if (gl.getProgramParameter(prog, gl.LINK_STATUS) !== true) {
    throw new Error(`program: ${gl.getProgramInfoLog(prog) ?? 'link failed'}`)
  }
  return prog
}

export class Renderer {
  readonly #gl: WebGL2RenderingContext
  readonly #scene: WebGLProgram
  readonly #post: WebGLProgram
  readonly #vao: WebGLVertexArrayObject
  readonly #postVao: WebGLVertexArrayObject
  readonly #instBuf: WebGLBuffer
  readonly #data = new Float32Array(MAX_INSTANCES * FLOATS)
  readonly #fbo: WebGLFramebuffer
  readonly #fboTex: WebGLTexture
  readonly #atlasTex: WebGLTexture
  readonly #bgTex: WebGLTexture
  readonly #bgProg: WebGLProgram
  #count = 0
  #glowStart = -1
  #uViewport: WebGLUniformLocation
  #uShake: WebGLUniformLocation
  #uTime: WebGLUniformLocation
  #uOutSize: WebGLUniformLocation

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false })
    if (gl === null) throw new Error('WebGL2 unavailable')
    this.#gl = gl

    this.#scene = compile(gl, SCENE_VS, SCENE_FS)
    this.#post = compile(gl, POST_VS, POST_FS)
    this.#bgProg = compile(gl, POST_VS, BG_FS)
    this.#uViewport = gl.getUniformLocation(this.#scene, 'viewport')!
    this.#uShake = gl.getUniformLocation(this.#scene, 'shake')!
    this.#uTime = gl.getUniformLocation(this.#post, 'time')!
    this.#uOutSize = gl.getUniformLocation(this.#post, 'outSize')!

    // Atlas texture.
    const atlasTex = gl.createTexture()!
    this.#atlasTex = atlasTex
    gl.bindTexture(gl.TEXTURE_2D, atlasTex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, drawAtlas())
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

    // Arena backdrop texture (drawn once, blitted under the instances every frame).
    this.#bgTex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, this.#bgTex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, drawBackground(ARENA_W, ARENA_H))
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

    // Scene VAO: unit quad + instance buffer.
    this.#vao = gl.createVertexArray()!
    gl.bindVertexArray(this.#vao)
    const quad = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, quad)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5]), gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    this.#instBuf = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#instBuf)
    gl.bufferData(gl.ARRAY_BUFFER, this.#data.byteLength, gl.DYNAMIC_DRAW)
    gl.enableVertexAttribArray(1)
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, FLOATS * 4, 0)
    gl.vertexAttribDivisor(1, 1)
    gl.enableVertexAttribArray(2)
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, FLOATS * 4, 16)
    gl.vertexAttribDivisor(2, 1)
    gl.bindVertexArray(null)

    // Post VAO: fullscreen triangle-strip quad.
    this.#postVao = gl.createVertexArray()!
    gl.bindVertexArray(this.#postVao)
    const pquad = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, pquad)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    gl.bindVertexArray(null)

    // Internal-resolution scene target (mipmapped so the post pass can cheaply bloom).
    this.#fboTex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, this.#fboTex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, ARENA_W, ARENA_H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    this.#fbo = gl.createFramebuffer()!
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.#fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.#fboTex, 0)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)

    gl.disable(gl.DEPTH_TEST)
    gl.enable(gl.BLEND)
  }

  begin(): void {
    this.#count = 0
    this.#glowStart = -1
  }

  sprite(x: number, y: number, sprite: number, size: number, r: number, g: number, b: number, a: number): void {
    if (this.#count >= MAX_INSTANCES || this.#glowStart >= 0) return
    const at = this.#count++ * FLOATS
    const d = this.#data
    d[at] = x
    d[at + 1] = y
    d[at + 2] = size
    d[at + 3] = sprite
    d[at + 4] = r
    d[at + 5] = g
    d[at + 6] = b
    d[at + 7] = a
  }

  /** Additive glow instances — call only AFTER all sprite() calls for the frame. */
  glow(x: number, y: number, size: number, r: number, g: number, b: number, a: number): void {
    if (this.#count >= MAX_INSTANCES) return
    if (this.#glowStart < 0) this.#glowStart = this.#count
    const at = this.#count++ * FLOATS
    const d = this.#data
    d[at] = x
    d[at + 1] = y
    d[at + 2] = size
    d[at + 3] = SPR_GLOW
    d[at + 4] = r
    d[at + 5] = g
    d[at + 6] = b
    d[at + 7] = a
  }

  flush(timeSeconds: number, shakeX: number, shakeY: number): void {
    const gl = this.#gl
    const canvas = gl.canvas as HTMLCanvasElement

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.#fbo)
    gl.viewport(0, 0, ARENA_W, ARENA_H)
    gl.clearColor(0.012, 0.016, 0.028, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)

    // Backdrop first — grid, dust, and bounds under everything.
    gl.useProgram(this.#bgProg)
    gl.bindTexture(gl.TEXTURE_2D, this.#bgTex)
    gl.blendFunc(gl.ONE, gl.ZERO)
    gl.bindVertexArray(this.#postVao)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    gl.bindVertexArray(null)

    gl.useProgram(this.#scene)
    gl.uniform2f(this.#uViewport, ARENA_W, ARENA_H)
    gl.uniform2f(this.#uShake, shakeX, shakeY)
    // Re-bind the atlas EVERY frame: after the post pass, unit 0 holds the FBO texture — sampling
    // it while rendering into it is a feedback loop (undefined behavior, real context losses).
    gl.bindTexture(gl.TEXTURE_2D, this.#atlasTex)
    gl.bindVertexArray(this.#vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#instBuf)
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.#data.subarray(0, this.#count * FLOATS))

    const solid = this.#glowStart < 0 ? this.#count : this.#glowStart
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    if (solid > 0) gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, solid)
    if (this.#glowStart >= 0) {
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE)
      // Instance attributes advance from #glowStart: rebind pointers at a byte offset.
      gl.vertexAttribPointer(1, 4, gl.FLOAT, false, FLOATS * 4, this.#glowStart * FLOATS * 4)
      gl.vertexAttribPointer(2, 4, gl.FLOAT, false, FLOATS * 4, this.#glowStart * FLOATS * 4 + 16)
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.#count - this.#glowStart)
      gl.vertexAttribPointer(1, 4, gl.FLOAT, false, FLOATS * 4, 0)
      gl.vertexAttribPointer(2, 4, gl.FLOAT, false, FLOATS * 4, 16)
    }
    gl.bindVertexArray(null)

    // Unbind the FBO BEFORE generating mips — generating for a texture still attached to the bound
    // framebuffer is a driver-hazard (SwiftShader in particular).
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.bindTexture(gl.TEXTURE_2D, this.#fboTex)
    gl.generateMipmap(gl.TEXTURE_2D)
    gl.viewport(0, 0, canvas.width, canvas.height)
    gl.useProgram(this.#post)
    gl.uniform1f(this.#uTime, timeSeconds)
    gl.uniform2f(this.#uOutSize, canvas.width, canvas.height)
    gl.blendFunc(gl.ONE, gl.ZERO)
    gl.bindVertexArray(this.#postVao)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    gl.bindVertexArray(null)
  }
}
