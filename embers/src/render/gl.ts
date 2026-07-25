// WebGL2 renderer: cell texture → palette/emissive scene (HDR) → bloom pyramid → composite with
// heat-haze refraction (driven by the actual air-field temperature), emissive light spill, and
// liquid sheen. Render-only code — Math.sin and friends are fine here; nothing feeds the sim.

import { CATEGORY, CAT_GAS, CAT_LIQUID, ELEM_COUNT, PALETTE } from '../sim/elements.js'
import { BAND_ROWS, FIELD_H, FIELD_W, PART_CAP, SIM_H, SIM_W } from '../sim/shared.js'
import type { FieldCols, ParticleCols } from '../sim/particles.js'

const VS = `#version 300 es
layout(location=0) in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`

const FS_SCENE = `#version 300 es
precision highp float;
uniform highp usampler2D uCells;
uniform vec4 uPal[${ELEM_COUNT}];
uniform float uEmit[${ELEM_COUNT}];
uniform uint uCat[${ELEM_COUNT}];
uniform float uTime;
in vec2 vUv;
out vec4 outColor;

void main() {
  ivec2 cell = ivec2(vUv * vec2(${SIM_W}.0, ${SIM_H}.0));
  cell.y = ${SIM_H} - 1 - cell.y; // staging row 0 is the sim's TOP row
  uvec4 d = texelFetch(uCells, cell, 0);
  uint elem = d.r;
  if (elem == 0u) { outColor = vec4(0.02, 0.015, 0.02, 1.0); return; }
  float vary = float(d.g) / 255.0;
  float temp = float(d.b) / 255.0;
  uint flags = d.a;
  vec4 pal = uPal[elem];
  vec3 col = pal.rgb * (1.0 - pal.a * (vary - 0.5));
  float emit = uEmit[elem];
  if (emit > 0.0) {
    float flick = 0.78 + 0.22 * sin(uTime * 11.0 + vary * 43.0);
    // Hotter reads whiter: push emissive pixels toward yellow-white by encoded temp.
    col = mix(col, vec3(1.0, 0.93, 0.62), temp * 0.45);
    col *= 1.0 + emit * flick;
  } else if (temp > 0.4) {
    // Non-emissive but hot (sand near lava, smoldering wood): dull red heat glow.
    col += vec3(1.0, 0.32, 0.06) * (temp - 0.4) * 1.6;
  }
  if (flags == 1u) {
    // Lit fuse / smoldering wood: crawling orange sparks.
    float spark = 0.55 + 0.45 * sin(uTime * 23.0 + vary * 91.0);
    col += vec3(1.0, 0.45, 0.1) * spark;
  }
  // Liquid sheen: a liquid cell with empty/gas above catches a specular streak.
  if (uCat[elem] == 3u) {
    uvec4 up = texelFetch(uCells, cell + ivec2(0, -1), 0);
    if (up.r == 0u || uCat[up.r] == 4u) {
      float streak = 0.5 + 0.5 * sin(vUv.x * 210.0 + uTime * 1.7);
      col += vec3(0.35, 0.45, 0.55) * (0.25 + 0.4 * streak);
    }
    col *= 0.92 + 0.16 * sin(vUv.x * 55.0 + uTime * 0.9 + vary * 6.0);
  }
  outColor = vec4(col, 1.0);
}`

const FS_BRIGHT = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
in vec2 vUv;
out vec4 outColor;
void main() {
  vec3 c = texture(uSrc, vUv).rgb;
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  float k = max(l - 0.85, 0.0);
  outColor = vec4(c * (k / max(l, 1e-4)), 1.0);
}`

const FS_BLUR = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uTexel;
in vec2 vUv;
out vec4 outColor;
void main() {
  vec3 a = texture(uSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
  vec3 b = texture(uSrc, vUv + uTexel * vec2(1.0, -1.0)).rgb;
  vec3 c = texture(uSrc, vUv + uTexel * vec2(-1.0, 1.0)).rgb;
  vec3 d = texture(uSrc, vUv + uTexel * vec2(1.0, 1.0)).rgb;
  vec3 e = texture(uSrc, vUv).rgb;
  outColor = vec4((a + b + c + d) * 0.1875 + e * 0.25, 1.0);
}`

const FS_COMPOSITE = `#version 300 es
precision highp float;
uniform sampler2D uScene;
uniform sampler2D uBloom0;
uniform sampler2D uBloom2;
uniform sampler2D uField;
uniform float uTime;
in vec2 vUv;
out vec4 outColor;

// Field staging row 0 is the sim's TOP row — flip V here.
float fieldT(vec2 uv) { return texture(uField, vec2(uv.x, 1.0 - uv.y)).r; }

void main() {
  vec2 uv = vUv;
  // Heat haze: refract by the temperature gradient of the air field, with a slow upward ripple.
  vec2 ft = vec2(1.0 / ${FIELD_W}.0, 1.0 / ${FIELD_H}.0);
  float t0 = fieldT(uv);
  float gx = fieldT(uv + vec2(ft.x, 0.0)) - fieldT(uv - vec2(ft.x, 0.0));
  float gy = fieldT(uv + vec2(0.0, ft.y)) - fieldT(uv - vec2(0.0, ft.y));
  float heat = clamp(t0 * 2.2, 0.0, 1.0);
  float ripple = sin(uv.y * 140.0 - uTime * 7.0 + sin(uv.x * 90.0) * 2.0);
  vec2 offset = vec2(gx, gy) * 0.012 + vec2(ripple, 0.0) * 0.0022 * heat;
  vec2 suv = clamp(uv + offset * heat, vec2(0.0), vec2(1.0));

  vec3 base = texture(uScene, suv).rgb;
  vec3 bloom = texture(uBloom0, suv).rgb;
  vec3 light = texture(uBloom2, uv).rgb;

  // Emissive light spill: the widest blur level doubles as a cheap radiance map.
  vec3 lit = base * (0.88 + light * 0.9) + light * 0.05;
  vec3 c = lit + bloom * 0.85;

  // Pressure shock shimmer.
  float p = texture(uField, vec2(uv.x, 1.0 - uv.y)).g - 0.5;
  c += vec3(0.6, 0.7, 0.9) * clamp(abs(p) * 1.4 - 0.08, 0.0, 0.35);

  // Vignette + tonemap + dither.
  vec2 v = uv - 0.5;
  c *= 1.0 - dot(v, v) * 0.55;
  c = c * 1.25 / (1.0 + c);
  float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  c += (n - 0.5) / 255.0;
  outColor = vec4(c, 1.0);
}`

interface Pass {
  prog: WebGLProgram
  uni: Record<string, WebGLUniformLocation | null>
}

export interface Renderer {
  render(time: number): void
  updateCells(cols: ParticleCols): void
  updateField(f: FieldCols): void
  resize(): void
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!
  gl.shaderSource(sh, src)
  gl.compileShader(sh)
  if (gl.getShaderParameter(sh, gl.COMPILE_STATUS) !== true) {
    throw new Error(`shader: ${gl.getShaderInfoLog(sh) ?? '?'}`)
  }
  return sh
}

function makePass(gl: WebGL2RenderingContext, fs: string, uniforms: string[]): Pass {
  const prog = gl.createProgram()!
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS))
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, fs))
  gl.linkProgram(prog)
  if (gl.getProgramParameter(prog, gl.LINK_STATUS) !== true) {
    throw new Error(`link: ${gl.getProgramInfoLog(prog) ?? '?'}`)
  }
  const uni: Record<string, WebGLUniformLocation | null> = {}
  for (const u of uniforms) uni[u] = gl.getUniformLocation(prog, u)
  return { prog, uni }
}

export function createRenderer(canvas: HTMLCanvasElement): Renderer {
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false })
  if (gl === null) throw new Error('WebGL2 unavailable')
  const hdrOk = gl.getExtension('EXT_color_buffer_float') !== null

  gl.bindVertexArray(gl.createVertexArray())
  const vbo = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
  gl.enableVertexAttribArray(0)
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)

  const scene = makePass(gl, FS_SCENE, ['uCells', 'uPal', 'uEmit', 'uCat', 'uTime'])
  const bright = makePass(gl, FS_BRIGHT, ['uSrc'])
  const blur = makePass(gl, FS_BLUR, ['uSrc', 'uTexel'])
  const composite = makePass(gl, FS_COMPOSITE, ['uScene', 'uBloom0', 'uBloom2', 'uField', 'uTime'])

  const texCells = gl.createTexture()!
  gl.bindTexture(gl.TEXTURE_2D, texCells)
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8UI, SIM_W, SIM_H)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)

  const texField = gl.createTexture()!
  gl.bindTexture(gl.TEXTURE_2D, texField)
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, FIELD_W, FIELD_H)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

  const fmt = hdrOk ? gl.RGBA16F : gl.RGBA8
  const makeTarget = (w: number, h: number): { tex: WebGLTexture; fbo: WebGLFramebuffer } => {
    const tex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texStorage2D(gl.TEXTURE_2D, 1, fmt, w, h)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    const fbo = gl.createFramebuffer()!
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
    return { tex, fbo }
  }

  const sceneT = makeTarget(SIM_W, SIM_H)
  const bloomSizes: [number, number][] = [
    [SIM_W >> 1, SIM_H >> 1],
    [SIM_W >> 2, SIM_H >> 2],
    [SIM_W >> 3, SIM_H >> 3],
  ]
  const bloom = bloomSizes.map(([w, h]) => makeTarget(w, h))
  const bloomB = bloomSizes.map(([w, h]) => makeTarget(w, h))

  const pal = new Float32Array(ELEM_COUNT * 4)
  const emit = new Float32Array(ELEM_COUNT)
  const cats = new Uint32Array(ELEM_COUNT)
  for (let e = 0; e < ELEM_COUNT; e++) {
    pal[e * 4] = PALETTE[e]!.rgb[0] / 255
    pal[e * 4 + 1] = PALETTE[e]!.rgb[1] / 255
    pal[e * 4 + 2] = PALETTE[e]!.rgb[2] / 255
    pal[e * 4 + 3] = PALETTE[e]!.vary
    emit[e] = PALETTE[e]!.emit
    cats[e] = CATEGORY[e] === CAT_LIQUID ? 3 : CATEGORY[e] === CAT_GAS ? 4 : CATEGORY[e]!
  }

  const cellStage = new Uint8Array(SIM_W * SIM_H * 4)
  const fieldStage = new Uint8Array(FIELD_W * FIELD_H * 4)

  const draw = (pass: Pass, fbo: WebGLFramebuffer | null, w: number, h: number): void => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.viewport(0, 0, w, h)
    gl.useProgram(pass.prog)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  const bind = (unit: number, tex: WebGLTexture): void => {
    gl.activeTexture(gl.TEXTURE0 + unit)
    gl.bindTexture(gl.TEXTURE_2D, tex)
  }

  return {
    updateCells(cols: ParticleCols): void {
      cellStage.fill(0)
      const elems = cols.elem
      for (let row = 0; row < PART_CAP; row++) {
        const e = elems[row]!
        if (e === 0) continue
        const at = (cols.py[row]! * SIM_W + cols.px[row]!) * 4
        cellStage[at] = e
        cellStage[at + 1] = (Math.imul(row, 2654435761) >>> 24) & 0xff
        const t = cols.temp[row]!
        cellStage[at + 2] = t <= -50 ? 0 : t >= 1900 ? 255 : ((t + 50) * 0.1307) | 0
        cellStage[at + 3] = cols.meta[row]! === 1 && (e === 15 || e === 17) ? 1 : 0
      }
      gl.bindTexture(gl.TEXTURE_2D, texCells)
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, SIM_W, SIM_H, gl.RGBA_INTEGER, gl.UNSIGNED_BYTE, cellStage)
    },
    updateField(f: FieldCols): void {
      for (let fy = 0; fy < FIELD_H; fy++) {
        const b = (fy / BAND_ROWS) | 0
        const local = (fy - b * BAND_ROWS) * FIELD_W
        const tArr = f.t[b]!
        const pArr = f.p[b]!
        for (let fx = 0; fx < FIELD_W; fx++) {
          const at = (fy * FIELD_W + fx) * 4
          const t = tArr[local + fx]!
          const p = pArr[local + fx]!
          fieldStage[at] = t <= 22 ? 0 : t >= 1522 ? 255 : ((t - 22) * 0.17) | 0
          fieldStage[at + 1] = Math.max(0, Math.min(255, 128 + p * 0.5)) | 0
        }
      }
      gl.bindTexture(gl.TEXTURE_2D, texField)
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, FIELD_W, FIELD_H, gl.RGBA, gl.UNSIGNED_BYTE, fieldStage)
    },
    render(time: number): void {
      gl.useProgram(scene.prog)
      bind(0, texCells)
      gl.uniform1i(scene.uni['uCells']!, 0)
      gl.uniform4fv(scene.uni['uPal']!, pal)
      gl.uniform1fv(scene.uni['uEmit']!, emit)
      gl.uniform1uiv(scene.uni['uCat']!, cats)
      gl.uniform1f(scene.uni['uTime']!, time)
      draw(scene, sceneT.fbo, SIM_W, SIM_H)

      gl.useProgram(bright.prog)
      bind(0, sceneT.tex)
      gl.uniform1i(bright.uni['uSrc']!, 0)
      draw(bright, bloom[0]!.fbo, bloomSizes[0]![0], bloomSizes[0]![1])

      gl.useProgram(blur.prog)
      gl.uniform1i(blur.uni['uSrc']!, 0)
      for (let i = 1; i < 3; i++) {
        bind(0, bloom[i - 1]!.tex)
        gl.uniform2f(blur.uni['uTexel']!, 1 / bloomSizes[i - 1]![0], 1 / bloomSizes[i - 1]![1])
        draw(blur, bloom[i]!.fbo, bloomSizes[i]![0], bloomSizes[i]![1])
      }
      for (let i = 2; i >= 0; i--) {
        bind(0, bloom[i]!.tex)
        gl.uniform2f(blur.uni['uTexel']!, 1.5 / bloomSizes[i]![0], 1.5 / bloomSizes[i]![1])
        draw(blur, bloomB[i]!.fbo, bloomSizes[i]![0], bloomSizes[i]![1])
      }

      gl.useProgram(composite.prog)
      bind(0, sceneT.tex)
      bind(1, bloomB[0]!.tex)
      bind(2, bloomB[2]!.tex)
      bind(3, texField)
      gl.uniform1i(composite.uni['uScene']!, 0)
      gl.uniform1i(composite.uni['uBloom0']!, 1)
      gl.uniform1i(composite.uni['uBloom2']!, 2)
      gl.uniform1i(composite.uni['uField']!, 3)
      gl.uniform1f(composite.uni['uTime']!, time)
      draw(composite, null, gl.drawingBufferWidth, gl.drawingBufferHeight)
    },
    resize(): void {
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const w = Math.round(canvas.clientWidth * dpr)
      const h = Math.round(canvas.clientHeight * dpr)
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
      }
    },
  }
}
