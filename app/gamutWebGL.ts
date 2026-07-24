export type GamutCMYK = { c: number; m: number; y: number; k: number };

const vertexSource = `#version 300 es
precision highp float;
uniform vec4 u_base;
uniform int u_side;
uniform int u_total;
uniform int u_draw_count;
uniform float u_tolerance;
uniform vec4 u_bounds;
uniform vec2 u_plot_scale;
uniform float u_point_size;
uniform int u_marker;
out vec3 v_color;
flat out int v_marker;
float pivot(float value) { return value > 0.008856 ? pow(value, 1.0 / 3.0) : 7.787 * value + 16.0 / 116.0; }
vec3 rgbToLab(vec3 rgb) {
  vec3 linear = mix(rgb / 12.92, pow((rgb + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), rgb));
  float x = dot(linear, vec3(0.4124, 0.3576, 0.1805)) / 0.95047;
  float y = dot(linear, vec3(0.2126, 0.7152, 0.0722));
  float z = dot(linear, vec3(0.0193, 0.1192, 0.9505)) / 1.08883;
  float fx = pivot(x), fy = pivot(y), fz = pivot(z);
  return vec3(116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz));
}
vec3 cmykToRgb(vec4 cmyk) {
  vec3 rgb = (1.0 - cmyk.xyz / 100.0) * (1.0 - cmyk.w / 100.0);
  return floor(rgb * 255.0 + 0.5) / 255.0;
}
void main() {
  vec4 cmyk = u_base;
  if (u_marker == 0) {
    int index = gl_VertexID;
    if (u_draw_count < u_total) index = (gl_VertexID * 8191) % u_total;
    float dk = float(index % u_side) - u_tolerance; index /= u_side;
    float dy = float(index % u_side) - u_tolerance; index /= u_side;
    float dm = float(index % u_side) - u_tolerance; index /= u_side;
    float dc = float(index % u_side) - u_tolerance;
    cmyk = clamp(u_base + vec4(dc, dm, dy, dk), 0.0, 100.0);
  }
  vec3 rgb = cmykToRgb(cmyk);
  vec3 lab = rgbToLab(rgb);
  float x = ((lab.y - u_bounds.x) / max(u_bounds.y - u_bounds.x, 1.0)) * 2.0 - 1.0;
  float y = ((lab.z - u_bounds.z) / max(u_bounds.w - u_bounds.z, 1.0)) * 2.0 - 1.0;
  gl_Position = vec4(x * u_plot_scale.x, y * u_plot_scale.y, 0.0, 1.0);
  gl_PointSize = u_marker == 1 ? u_point_size * 7.0 : u_point_size;
  v_color = rgb;
  v_marker = u_marker;
}`;

const fragmentSource = `#version 300 es
precision highp float;
in vec3 v_color;
flat in int v_marker;
uniform float u_alpha;
out vec4 out_color;
void main() {
  vec2 point = gl_PointCoord * 2.0 - 1.0;
  if (v_marker == 1) {
    float radius = length(point);
    bool ring = abs(radius - 0.62) < 0.08;
    bool cross = (abs(point.x) < 0.045 && abs(point.y) < 0.92) || (abs(point.y) < 0.045 && abs(point.x) < 0.92);
    if (!ring && !cross) discard;
    out_color = vec4(0.094, 0.094, 0.086, 1.0);
    return;
  }
  if (dot(point, point) > 1.0) discard;
  out_color = vec4(v_color, u_alpha);
}`;

type Renderer = {
  gl: WebGL2RenderingContext;
  program: WebGLProgram;
  uniforms: Record<string, WebGLUniformLocation | null>;
};

const renderers = new WeakMap<HTMLCanvasElement, Renderer | null>();

function compile(gl: WebGL2RenderingContext, type: number, source: string) {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || "Shader compilation failed");
  return shader;
}

function createRenderer(canvas: HTMLCanvasElement): Renderer | null {
  const gl = canvas.getContext("webgl2", { alpha: true, antialias: false, powerPreference: "high-performance", preserveDrawingBuffer: true });
  if (!gl) return null;
  const program = gl.createProgram()!;
  const vertex = compile(gl, gl.VERTEX_SHADER, vertexSource);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, fragmentSource);
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || "Shader link failed");
  gl.useProgram(program);
  gl.bindVertexArray(gl.createVertexArray());
  gl.disable(gl.BLEND);
  return {
    gl,
    program,
    uniforms: Object.fromEntries(["base", "side", "total", "draw_count", "tolerance", "bounds", "plot_scale", "point_size", "marker", "alpha"].map((name) => [name, gl.getUniformLocation(program, `u_${name}`)])),
  };
}

function rgbToLab(rgb: [number, number, number]) {
  const linear = rgb.map((value) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  const x = (linear[0] * .4124 + linear[1] * .3576 + linear[2] * .1805) / .95047;
  const y = linear[0] * .2126 + linear[1] * .7152 + linear[2] * .0722;
  const z = (linear[0] * .0193 + linear[1] * .1192 + linear[2] * .9505) / 1.08883;
  const pivot = (value: number) => value > .008856 ? Math.cbrt(value) : 7.787 * value + 16 / 116;
  return { a: 500 * (pivot(x) - pivot(y)), b: 200 * (pivot(y) - pivot(z)) };
}

function boundsFor(base: GamutCMYK, tolerance: number) {
  const offsets = tolerance === 0 ? [0] : [-tolerance, -Math.ceil(tolerance / 2), 0, Math.floor(tolerance / 2), tolerance];
  const bounds = [Infinity, -Infinity, Infinity, -Infinity];
  const clamp = (value: number) => Math.max(0, Math.min(100, Math.round(value)));
  for (const dc of offsets) for (const dm of offsets) for (const dy of offsets) for (const dk of offsets) {
    const c = clamp(base.c + dc), m = clamp(base.m + dm), y = clamp(base.y + dy), k = clamp(base.k + dk);
    const rgb: [number, number, number] = [
      Math.round(255 * (1 - c / 100) * (1 - k / 100)),
      Math.round(255 * (1 - m / 100) * (1 - k / 100)),
      Math.round(255 * (1 - y / 100) * (1 - k / 100)),
    ];
    const lab = rgbToLab(rgb);
    bounds[0] = Math.min(bounds[0], lab.a); bounds[1] = Math.max(bounds[1], lab.a);
    bounds[2] = Math.min(bounds[2], lab.b); bounds[3] = Math.max(bounds[3], lab.b);
  }
  return bounds;
}

export function drawShaderGamut(canvas: HTMLCanvasElement, base: GamutCMYK, tolerance: number) {
  if (!renderers.has(canvas)) renderers.set(canvas, createRenderer(canvas));
  const renderer = renderers.get(canvas);
  if (!renderer) return false;
  const { gl, program, uniforms } = renderer;
  const rect = canvas.getBoundingClientRect();
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.round(rect.width * ratio), height = Math.round(rect.height * ratio);
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  const side = tolerance * 2 + 1, total = side ** 4, bounds = boundsFor(base, tolerance), padding = 32 * ratio;
  const drawLimit = window.matchMedia("(pointer: coarse)").matches ? 24000 : 36000;
  const drawCount = Math.min(total, drawLimit);
  gl.viewport(0, 0, width, height);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.useProgram(program);
  gl.uniform4f(uniforms.base, base.c, base.m, base.y, base.k);
  gl.uniform1i(uniforms.side, side);
  gl.uniform1i(uniforms.total, total);
  gl.uniform1i(uniforms.draw_count, drawCount);
  gl.uniform1f(uniforms.tolerance, tolerance);
  gl.uniform4f(uniforms.bounds, bounds[0], bounds[1], bounds[2], bounds[3]);
  gl.uniform2f(uniforms.plot_scale, (width - padding * 2) / width, (height - padding * 2) / height);
  gl.uniform1f(uniforms.point_size, 4.2 * ratio);
  gl.uniform1f(uniforms.alpha, 1);
  gl.uniform1i(uniforms.marker, 0);
  gl.drawArrays(gl.POINTS, 0, drawCount);
  gl.uniform1i(uniforms.marker, 1);
  gl.drawArrays(gl.POINTS, 0, 1);
  return true;
}
