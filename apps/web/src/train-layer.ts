import maplibregl, { type CustomLayerInterface, type CustomRenderMethodInput, type Map as MapLibreMap } from "maplibre-gl";
import type { TrainPart } from "./drive.js";

/**
 * The Drive view's train as a WebGL custom layer. A GeoJSON fill-extrusion
 * is updated through a web worker, so it lags the camera by a frame or more
 * and the train shakes on screen; a custom layer draws the footprints given
 * in the same frame as the camera move.
 *
 * Vertices are kept relative to an origin near the train (in float64 on the
 * CPU, folded into the matrix), because float32 Mercator coordinates only
 * resolve about 2 m, which is half the width of the train. MapLibre's
 * modelViewProjectionMatrix takes x and y in world pixels and z in metres.
 */

const VERTEX = `
attribute vec3 a_pos;
attribute vec3 a_color;
uniform mat4 u_matrix;
varying vec3 v_color;
void main() {
  v_color = a_color;
  gl_Position = u_matrix * vec4(a_pos, 1.0);
}`;

const FRAGMENT = `
precision mediump float;
varying vec3 v_color;
void main() {
  gl_FragColor = vec4(v_color, 1.0);
}`;

/** light from the north-west and above, like the map's fill-extrusions */
const LIGHT = normalize([-0.5, 0.6, 0.62]);

function normalize(v: number[]): [number, number, number] {
  const l = Math.hypot(v[0]!, v[1]!, v[2]!) || 1;
  return [v[0]! / l, v[1]! / l, v[2]! / l];
}

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export class TrainLayer implements CustomLayerInterface {
  readonly id: string;
  readonly type = "custom" as const;
  readonly renderingMode = "3d" as const;
  private map: MapLibreMap | undefined;
  private program: WebGLProgram | undefined;
  private buffer: WebGLBuffer | null = null;
  private count = 0;
  private dirty = false;
  private data = new Float32Array(0);
  private origin: [number, number] = [0, 0];
  private readonly matrix = new Float64Array(16);
  visible = true;

  constructor(id: string) {
    this.id = id;
  }

  onAdd(map: MapLibreMap, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    this.map = map;
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, compile(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(p);
    this.program = p;
    this.buffer = gl.createBuffer();
  }

  onRemove(_map: MapLibreMap, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    if (this.buffer) gl.deleteBuffer(this.buffer);
    if (this.program) gl.deleteProgram(this.program);
  }

  /** Replace the train. Call before moving the camera in the same frame. */
  setParts(parts: TrainPart[]): void {
    const first = parts[0]?.ring[0];
    if (!first) {
      this.count = 0;
      this.map?.triggerRepaint();
      return;
    }
    const o = maplibregl.MercatorCoordinate.fromLngLat(first, 0);
    this.origin = [o.x, o.y];
    const out: number[] = [];
    for (const part of parts) {
      const pts = part.ring.slice(0, -1).map((c) => {
        const m = maplibregl.MercatorCoordinate.fromLngLat(c, 0);
        return [m.x - o.x, m.y - o.y] as const;
      });
      const zb = part.base, zt = part.height;
      const base = rgb(part.color);
      const push = (p: readonly [number, number], z: number, c: readonly number[]) => out.push(p[0], p[1], z, c[0]!, c[1]!, c[2]!);
      const shade = (nx: number, ny: number, nz: number) => {
        const k = 0.55 + 0.45 * Math.max(0, nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]);
        return base.map((v) => v * k);
      };
      // sides: one quad per ring edge, shaded by its outward normal (mercator y points south)
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i]!, b = pts[(i + 1) % pts.length]!;
        const dx = b[0] - a[0], dy = -(b[1] - a[1]);
        const len = Math.hypot(dx, dy) || 1;
        // the ring runs clockwise seen from above, so the outward normal is (−dy, dx)
        const c = shade(-dy / len, dx / len, 0);
        push(a, zb, c); push(b, zb, c); push(b, zt, c);
        push(a, zb, c); push(b, zt, c); push(a, zt, c);
      }
      // top: the ring is a strip of left points, then the right points backwards
      const top = base;
      const n = pts.length;
      for (let i = 0; i < n / 2 - 1; i++) {
        const l0 = pts[i]!, l1 = pts[i + 1]!, r0 = pts[n - 1 - i]!, r1 = pts[n - 2 - i]!;
        push(l0, zt, top); push(l1, zt, top); push(r1, zt, top);
        push(l0, zt, top); push(r1, zt, top); push(r0, zt, top);
      }
    }
    this.data = new Float32Array(out);
    this.count = out.length / 6;
    this.dirty = true;
    this.map?.triggerRepaint();
  }

  render(gl: WebGLRenderingContext | WebGL2RenderingContext, options: CustomRenderMethodInput): void {
    if (!this.visible || this.count === 0 || !this.program) return;
    gl.useProgram(this.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    if (this.dirty) {
      gl.bufferData(gl.ARRAY_BUFFER, this.data, gl.DYNAMIC_DRAW);
      this.dirty = false;
    }
    // matrix · translate(origin · worldSize) · scale(worldSize, worldSize, 1), in float64
    const m = options.modelViewProjectionMatrix as unknown as ArrayLike<number>;
    const ws = 512 * 2 ** this.map!.getZoom();
    const [ox, oy] = this.origin;
    for (let r = 0; r < 4; r++) {
      this.matrix[r] = m[r]! * ws;
      this.matrix[4 + r] = m[4 + r]! * ws;
      this.matrix[8 + r] = m[8 + r]!;
      this.matrix[12 + r] = m[r]! * ws * ox + m[4 + r]! * ws * oy + m[12 + r]!;
    }
    gl.uniformMatrix4fv(gl.getUniformLocation(this.program, "u_matrix"), false, new Float32Array(this.matrix));
    const pos = gl.getAttribLocation(this.program, "a_pos");
    const col = gl.getAttribLocation(this.program, "a_color");
    gl.enableVertexAttribArray(pos);
    gl.enableVertexAttribArray(col);
    gl.vertexAttribPointer(pos, 3, gl.FLOAT, false, 24, 0);
    gl.vertexAttribPointer(col, 3, gl.FLOAT, false, 24, 12);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    gl.drawArrays(gl.TRIANGLES, 0, this.count);
    gl.disableVertexAttribArray(pos);
    gl.disableVertexAttribArray(col);
  }
}
