export type GamutCMYK = { c: number; m: number; y: number; k: number };
type ShapePoint = { a: number; b: number; rgb: [number, number, number] };

const vertexSource = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_lab;
layout(location = 1) in vec3 a_color;
uniform vec4 u_bounds;
uniform vec2 u_plot_scale;
uniform float u_point_size;
out vec3 v_color;
void main() {
  float x = ((a_lab.x - u_bounds.x) / max(u_bounds.y - u_bounds.x, 1.0)) * 2.0 - 1.0;
  float y = ((a_lab.y - u_bounds.z) / max(u_bounds.w - u_bounds.z, 1.0)) * 2.0 - 1.0;
  gl_Position = vec4(x * u_plot_scale.x, y * u_plot_scale.y, 0.0, 1.0);
  gl_PointSize = u_point_size;
  v_color = a_color;
}`;

const fragmentSource = `#version 300 es
precision highp float;
in vec3 v_color;
uniform int u_mode;
out vec4 out_color;
void main() {
  if (u_mode == 2) {
    vec2 point = gl_PointCoord * 2.0 - 1.0;
    float radius = length(point);
    bool ring = abs(radius - 0.62) < 0.08;
    bool cross = (abs(point.x) < 0.045 && abs(point.y) < 0.92) || (abs(point.y) < 0.045 && abs(point.x) < 0.92);
    if (!ring && !cross) discard;
    out_color = vec4(0.094, 0.094, 0.086, 1.0);
    return;
  }
  if (u_mode == 1) {
    out_color = vec4(0.094, 0.094, 0.086, 0.24);
    return;
  }
  out_color = vec4(v_color, 1.0);
}`;

type Renderer = {
  gl: WebGL2RenderingContext;
  program: WebGLProgram;
  buffer: WebGLBuffer;
  vertexArray: WebGLVertexArrayObject;
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
  const gl = canvas.getContext("webgl2", { alpha: true, antialias: true, powerPreference: "high-performance", preserveDrawingBuffer: true });
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
  const vertexArray = gl.createVertexArray()!;
  const buffer = gl.createBuffer()!;
  gl.useProgram(program);
  gl.bindVertexArray(vertexArray);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 20, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 20, 8);
  gl.disable(gl.BLEND);
  return {
    gl,
    program,
    buffer,
    vertexArray,
    uniforms: Object.fromEntries(["bounds", "plot_scale", "point_size", "mode"].map((name) => [name, gl.getUniformLocation(program, `u_${name}`)])),
  };
}

function rgbFor({ c, m, y, k }: GamutCMYK): [number, number, number] {
  return [
    Math.round(255 * (1 - c / 100) * (1 - k / 100)),
    Math.round(255 * (1 - m / 100) * (1 - k / 100)),
    Math.round(255 * (1 - y / 100) * (1 - k / 100)),
  ];
}

function labFor(rgb: [number, number, number]) {
  const linear = rgb.map((value) => {
    const channel = value / 255;
    return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
  });
  const x = (linear[0] * .4124 + linear[1] * .3576 + linear[2] * .1805) / .95047;
  const y = linear[0] * .2126 + linear[1] * .7152 + linear[2] * .0722;
  const z = (linear[0] * .0193 + linear[1] * .1192 + linear[2] * .9505) / 1.08883;
  const pivot = (value: number) => value > .008856 ? Math.cbrt(value) : 7.787 * value + 16 / 116;
  return { a: 500 * (pivot(x) - pivot(y)), b: 200 * (pivot(y) - pivot(z)) };
}

function cross(origin: ShapePoint, left: ShapePoint, right: ShapePoint) {
  return (left.a - origin.a) * (right.b - origin.b) - (left.b - origin.b) * (right.a - origin.a);
}

function convexHull(points: ShapePoint[]) {
  if (points.length <= 2) return points;
  const sorted = [...points].sort((left, right) => left.a - right.a || left.b - right.b);
  const lower: ShapePoint[] = [];
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) lower.pop();
    lower.push(point);
  }
  const upper: ShapePoint[] = [];
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const point = sorted[index];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) upper.pop();
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function shapeFor(base: GamutCMYK, tolerance: number) {
  const offsets = tolerance === 0 ? [0] : [-tolerance, -Math.ceil(tolerance / 2), 0, Math.floor(tolerance / 2), tolerance];
  const unique = new Map<string, ShapePoint>();
  const clamp = (value: number) => Math.max(0, Math.min(100, Math.round(value)));
  for (const dc of offsets) for (const dm of offsets) for (const dy of offsets) for (const dk of offsets) {
    const rgb = rgbFor({ c: clamp(base.c + dc), m: clamp(base.m + dm), y: clamp(base.y + dy), k: clamp(base.k + dk) });
    const lab = labFor(rgb);
    unique.set(`${lab.a.toFixed(4)}:${lab.b.toFixed(4)}`, { a: lab.a, b: lab.b, rgb: rgb.map((value) => value / 255) as [number, number, number] });
  }
  const hull = convexHull([...unique.values()]);
  const baseRgb = rgbFor(base);
  const baseLab = labFor(baseRgb);
  const center: ShapePoint = { a: baseLab.a, b: baseLab.b, rgb: baseRgb.map((value) => value / 255) as [number, number, number] };
  const bounds = hull.reduce((result, point) => [
    Math.min(result[0], point.a), Math.max(result[1], point.a),
    Math.min(result[2], point.b), Math.max(result[3], point.b),
  ], [center.a, center.a, center.b, center.b]);
  return { hull, center, bounds };
}

export function drawShaderGamut(canvas: HTMLCanvasElement, base: GamutCMYK, tolerance: number) {
  if (!renderers.has(canvas)) renderers.set(canvas, createRenderer(canvas));
  const renderer = renderers.get(canvas);
  if (!renderer) return false;
  const { gl, program, buffer, vertexArray, uniforms } = renderer;
  const rect = canvas.getBoundingClientRect();
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.round(rect.width * ratio), height = Math.round(rect.height * ratio);
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  const { hull, center, bounds } = shapeFor(base, tolerance);
  const loop = hull.length ? [...hull, hull[0]] : [center];
  const vertices = [center, ...loop];
  const data = new Float32Array(vertices.flatMap((point) => [point.a, point.b, ...point.rgb]));
  const padding = 32 * ratio;
  gl.viewport(0, 0, width, height);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.useProgram(program);
  gl.bindVertexArray(vertexArray);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
  gl.uniform4f(uniforms.bounds, bounds[0], bounds[1], bounds[2], bounds[3]);
  gl.uniform2f(uniforms.plot_scale, (width - padding * 2) / width, (height - padding * 2) / height);
  gl.uniform1f(uniforms.point_size, 22 * ratio);
  if (hull.length >= 3) {
    gl.uniform1i(uniforms.mode, 0);
    gl.drawArrays(gl.TRIANGLE_FAN, 0, vertices.length);
    gl.uniform1i(uniforms.mode, 1);
    gl.lineWidth(Math.min(1.25 * ratio, 2));
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.LINE_LOOP, 1, hull.length);
    gl.disable(gl.BLEND);
  }
  gl.uniform1i(uniforms.mode, 2);
  gl.drawArrays(gl.POINTS, 0, 1);
  return true;
}
