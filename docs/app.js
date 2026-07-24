const channelDefs = [
  { key: "c", label: "C", name: "青", color: "#00a7c8" },
  { key: "m", label: "M", name: "品红", color: "#d72573" },
  { key: "y", label: "Y", name: "黄", color: "#e4b800" },
  { key: "k", label: "K", name: "黑", color: "#20201e" },
];

const presets = [
  { name: "海报蓝", value: { c: 82, m: 44, y: 0, k: 3 } },
  { name: "珊瑚红", value: { c: 0, m: 72, y: 58, k: 2 } },
  { name: "植物绿", value: { c: 71, m: 12, y: 72, k: 6 } },
  { name: "暖灰", value: { c: 18, m: 15, y: 17, k: 24 } },
];

const state = {
  cmyk: { c: 80, m: 80, y: 60, k: 5 },
  tolerance: 10,
  sort: "distance",
  points: [],
  baseLab: null,
  renderFrame: 0,
  exactTimer: 0,
  worker: null,
  workerRequest: 0,
  gamutRenderer: undefined,
  gamutMode: "points",
};

const clamp = (value) => Math.max(0, Math.min(100, Math.round(value)));
const SAMPLE_LIMIT = window.matchMedia("(pointer: coarse)").matches ? 5000 : 8000;

function cmykToRgb({ c, m, y, k }) {
  return [
    Math.round(255 * (1 - c / 100) * (1 - k / 100)),
    Math.round(255 * (1 - m / 100) * (1 - k / 100)),
    Math.round(255 * (1 - y / 100) * (1 - k / 100)),
  ];
}

function rgbToHex(rgb) {
  return `#${rgb.map((value) => value.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

function rgbToLab([r, g, b]) {
  const linear = [r, g, b].map((value) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  const x = (linear[0] * 0.4124 + linear[1] * 0.3576 + linear[2] * 0.1805) / 0.95047;
  const y = linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  const z = (linear[0] * 0.0193 + linear[1] * 0.1192 + linear[2] * 0.9505) / 1.08883;
  const pivot = (value) => value > 0.008856 ? Math.cbrt(value) : 7.787 * value + 16 / 116;
  return { l: 116 * pivot(y) - 16, a: 500 * (pivot(x) - pivot(y)), b: 200 * (pivot(y) - pivot(z)) };
}

function makePoint(value, baseLab) {
  const rgb = cmykToRgb(value);
  const lab = rgbToLab(rgb);
  return {
    ...value,
    rgb,
    hex: rgbToHex(rgb),
    a: lab.a,
    b: lab.b,
    distance: Math.sqrt((lab.l - baseLab.l) ** 2 + (lab.a - baseLab.a) ** 2 + (lab.b - baseLab.b) ** 2),
  };
}

function buildPreviewPoints() {
  const result = [];
  const { cmyk, tolerance, baseLab } = state;
  const side = tolerance * 2 + 1;
  const total = side ** 4;
  const sampleCount = Math.min(total, SAMPLE_LIMIT);

  for (let sample = 0; sample < sampleCount; sample += 1) {
    const index = sampleCount === 1 ? 0 : Math.round(sample * (total - 1) / (sampleCount - 1));
    let remainder = index;
    const dk = remainder % side - tolerance;
    remainder = Math.floor(remainder / side);
    const dy = remainder % side - tolerance;
    remainder = Math.floor(remainder / side);
    const dm = remainder % side - tolerance;
    const dc = Math.floor(remainder / side) - tolerance;
    result.push(makePoint({
      c: clamp(cmyk.c + dc),
      m: clamp(cmyk.m + dm),
      y: clamp(cmyk.y + dy),
      k: clamp(cmyk.k + dk),
    }, baseLab));
  }
  state.points = result;
}

function requestExactResult() {
  window.clearTimeout(state.exactTimer);
  if (state.worker) {
    state.worker.terminate();
    state.worker = null;
  }
  const request = ++state.workerRequest;
  state.exactTimer = window.setTimeout(() => {
    state.worker = new Worker("./color-worker.js?v=1");
    state.worker.addEventListener("message", (event) => {
      if (event.data.request !== request) return;
      const farthest = event.data.farthest;
      document.querySelector("#max-distance-heading").textContent = farthest.distance.toFixed(1);
      document.querySelector("#farthest-hex").textContent = farthest.hex;
      state.worker.terminate();
      state.worker = null;
    });
    state.worker.postMessage({ request, cmyk: { ...state.cmyk }, tolerance: state.tolerance });
  }, 180);
}

function scheduleRender({ exact = true } = {}) {
  if (!state.renderFrame) {
    state.renderFrame = requestAnimationFrame(() => {
      state.renderFrame = 0;
      renderResults();
    });
  }
  if (exact) requestExactResult();
}

const GAMUT_VERTEX_SHADER = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_lab;
layout(location = 1) in vec3 a_color;
uniform vec4 u_bounds;
uniform vec2 u_plot_scale;
uniform float u_point_size;
uniform int u_mode;
out vec3 v_color;

void main() {
  float x = ((a_lab.x - u_bounds.x) / max(u_bounds.y - u_bounds.x, 1.0)) * 2.0 - 1.0;
  float y = ((a_lab.y - u_bounds.z) / max(u_bounds.w - u_bounds.z, 1.0)) * 2.0 - 1.0;
  gl_Position = vec4(x * u_plot_scale.x, y * u_plot_scale.y, 0.0, 1.0);
  gl_PointSize = u_point_size;
  v_color = a_color;
}`;

const GAMUT_FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec3 v_color;
uniform int u_mode;
out vec4 out_color;

void main() {
  if (u_mode == 2) {
    vec2 point = gl_PointCoord * 2.0 - 1.0;
    float radius = length(point);
    bool ring = abs(radius - 0.62) < 0.08;
    bool cross = (abs(point.x) < 0.045 && abs(point.y) < 0.92)
      || (abs(point.y) < 0.045 && abs(point.x) < 0.92);
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

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(message || "Shader compilation failed");
  }
  return shader;
}

function createGamutRenderer(canvas) {
  const gl = canvas.getContext("webgl2", {
    alpha: true,
    antialias: true,
    powerPreference: "high-performance",
    preserveDrawingBuffer: true,
  });
  if (!gl) return null;
  const program = gl.createProgram();
  const vertex = compileShader(gl, gl.VERTEX_SHADER, GAMUT_VERTEX_SHADER);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, GAMUT_FRAGMENT_SHADER);
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) || "Shader link failed");
  }
  gl.useProgram(program);
  const vertexArray = gl.createVertexArray();
  const buffer = gl.createBuffer();
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
    uniforms: {
      bounds: gl.getUniformLocation(program, "u_bounds"),
      plotScale: gl.getUniformLocation(program, "u_plot_scale"),
      pointSize: gl.getUniformLocation(program, "u_point_size"),
      mode: gl.getUniformLocation(program, "u_mode"),
    },
  };
}

function crossProduct(origin, left, right) {
  return (left.a - origin.a) * (right.b - origin.b) - (left.b - origin.b) * (right.a - origin.a);
}

function convexHull(points) {
  if (points.length <= 2) return points;
  const sorted = [...points].sort((left, right) => left.a - right.a || left.b - right.b);
  const lower = [];
  for (const point of sorted) {
    while (lower.length >= 2 && crossProduct(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) lower.pop();
    lower.push(point);
  }
  const upper = [];
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const point = sorted[index];
    while (upper.length >= 2 && crossProduct(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) upper.pop();
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function getGamutShape() {
  const tolerance = state.tolerance;
  const offsets = tolerance === 0
    ? [0]
    : [-tolerance, -Math.ceil(tolerance / 2), 0, Math.floor(tolerance / 2), tolerance];
  const unique = new Map();
  for (const dc of offsets) for (const dm of offsets) for (const dy of offsets) for (const dk of offsets) {
    const rgb = cmykToRgb({
      c: clamp(state.cmyk.c + dc),
      m: clamp(state.cmyk.m + dm),
      y: clamp(state.cmyk.y + dy),
      k: clamp(state.cmyk.k + dk),
    });
    const lab = rgbToLab(rgb);
    const key = `${lab.a.toFixed(4)}:${lab.b.toFixed(4)}`;
    unique.set(key, { a: lab.a, b: lab.b, rgb: rgb.map((value) => value / 255) });
  }
  const hull = convexHull([...unique.values()]);
  const baseRgb = cmykToRgb(state.cmyk);
  const center = { a: state.baseLab.a, b: state.baseLab.b, rgb: baseRgb.map((value) => value / 255) };
  const bounds = hull.reduce((result, point) => [
    Math.min(result[0], point.a),
    Math.max(result[1], point.a),
    Math.min(result[2], point.b),
    Math.max(result[3], point.b),
  ], [center.a, center.a, center.b, center.b]);
  return { hull, center, bounds };
}

function drawGamutWebGL(renderer, width, height, ratio) {
  const { gl, program, uniforms, buffer, vertexArray } = renderer;
  const { hull, center, bounds } = getGamutShape();
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
  gl.uniform2f(uniforms.plotScale, (width - padding * 2) / width, (height - padding * 2) / height);
  gl.uniform1f(uniforms.pointSize, 22 * ratio);
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
}

function drawGamutFallback(canvas, rect, ratio) {
  if (!state.points.length) buildPreviewPoints();
  const context = canvas.getContext("2d");
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, rect.width, rect.height);
  const padding = 32;
  let minA = Infinity;
  let maxA = -Infinity;
  let minB = Infinity;
  let maxB = -Infinity;
  for (const point of state.points) {
    minA = Math.min(minA, point.a);
    maxA = Math.max(maxA, point.a);
    minB = Math.min(minB, point.b);
    maxB = Math.max(maxB, point.b);
  }
  const spanA = Math.max(maxA - minA, 1);
  const spanB = Math.max(maxB - minB, 1);
  const xFor = (a) => padding + ((a - minA) / spanA) * (rect.width - padding * 2);
  const yFor = (b) => rect.height - padding - ((b - minB) / spanB) * (rect.height - padding * 2);
  context.globalAlpha = 1;
  for (const point of state.points) {
    context.fillStyle = point.hex;
    context.beginPath();
    context.arc(xFor(point.a), yFor(point.b), state.points.length > 5000 ? 2.1 : 2.5, 0, Math.PI * 2);
    context.fill();
  }
  context.globalAlpha = 1;
  const x = xFor(state.baseLab.a);
  const y = yFor(state.baseLab.b);
  context.strokeStyle = "#181816";
  context.lineWidth = 1.5;
  context.beginPath();
  context.arc(x, y, 7, 0, Math.PI * 2);
  context.moveTo(x - 11, y);
  context.lineTo(x + 11, y);
  context.moveTo(x, y - 11);
  context.lineTo(x, y + 11);
  context.stroke();
}

function drawGamut() {
  const pointsCanvas = document.querySelector("#gamut-points");
  const continuousCanvas = document.querySelector("#gamut-continuous");
  const useContinuous = state.gamutMode === "continuous";
  pointsCanvas.hidden = useContinuous;
  continuousCanvas.hidden = !useContinuous;
  const canvas = useContinuous ? continuousCanvas : pointsCanvas;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.round(rect.width * ratio);
  const height = Math.round(rect.height * ratio);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  if (useContinuous) {
    if (state.gamutRenderer === undefined) {
      state.gamutRenderer = createGamutRenderer(canvas);
    }
    if (state.gamutRenderer) {
      drawGamutWebGL(state.gamutRenderer, width, height, ratio);
    }
  } else {
    drawGamutFallback(canvas, rect, ratio);
  }
}

function renderChannels() {
  const container = document.querySelector("#channels");
  container.innerHTML = channelDefs.map((channel) => `
    <div class="channel channel-${channel.key}">
      <div class="channel-title">
        <span class="channel-letter" style="color:${channel.color}">${channel.label}</span>
        <span>${channel.name}</span>
        <label for="${channel.key}-number">百分比</label>
      </div>
      <div class="channel-value">
        <input id="${channel.key}-number" data-channel="${channel.key}" data-kind="number" type="number" min="0" max="100" inputmode="numeric" value="${state.cmyk[channel.key]}">
        <span>%</span>
      </div>
      <input class="channel-range" data-channel="${channel.key}" data-kind="range" aria-label="${channel.name}通道 ${state.cmyk[channel.key]}%" type="range" min="0" max="100" value="${state.cmyk[channel.key]}" style="--channel:${channel.color};--position:${state.cmyk[channel.key]}%">
    </div>
  `).join("");

  container.querySelectorAll("input").forEach((input) => {
    input.addEventListener("input", (event) => {
      const key = event.target.dataset.channel;
      state.cmyk[key] = clamp(Number(event.target.value) || 0);
      const siblingSelector = `[data-channel="${key}"][data-kind="${event.target.dataset.kind === "range" ? "number" : "range"}"]`;
      const sibling = container.querySelector(siblingSelector);
      sibling.value = state.cmyk[key];
      if (sibling.type === "range") sibling.style.setProperty("--position", `${state.cmyk[key]}%`);
      if (event.target.type === "range") event.target.style.setProperty("--position", `${state.cmyk[key]}%`);
      scheduleRender();
    });
  });
}

function buildSwatches() {
  const offsets = state.tolerance === 0 ? [0] : [-state.tolerance, 0, state.tolerance];
  const result = [];
  for (const dc of offsets) for (const dm of offsets) for (const dy of offsets) for (const dk of offsets) {
    result.push(makePoint({
      c: clamp(state.cmyk.c + dc),
      m: clamp(state.cmyk.m + dm),
      y: clamp(state.cmyk.y + dy),
      k: clamp(state.cmyk.k + dk),
    }, state.baseLab));
  }
  return result.sort((left, right) => {
    if (state.sort === "distance") return left.distance - right.distance;
    if (state.sort === "light") return (right.rgb[0] + right.rgb[1] + right.rgb[2]) - (left.rgb[0] + left.rgb[1] + left.rgb[2]);
    return left.c - right.c || left.m - right.m || left.y - right.y || left.k - right.k;
  });
}

const EXPORT_SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans CJK SC", "Microsoft YaHei", "PingFang SC", Arial, sans-serif';
const EXPORT_SERIF = '"Songti SC", STSong, SimSun, "Noto Serif CJK SC", "Noto Serif SC", serif';
const EXPORT_MONO = 'ui-monospace, "SFMono-Regular", "Cascadia Mono", Consolas, "Liberation Mono", monospace';

function makeExportCanvas(width, height, gridSize = 48) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  context.fillStyle = "#f3f0e8";
  context.fillRect(0, 0, width, height);
  context.strokeStyle = "rgba(24, 24, 22, .055)";
  context.lineWidth = 1;
  for (let x = 0; x <= width; x += gridSize) {
    context.beginPath();
    context.moveTo(x + .5, 0);
    context.lineTo(x + .5, height);
    context.stroke();
  }
  for (let y = 0; y <= height; y += gridSize) {
    context.beginPath();
    context.moveTo(0, y + .5);
    context.lineTo(width, y + .5);
    context.stroke();
  }
  return { canvas, context };
}

function exportTextColor(rgb) {
  return rgb[0] * .299 + rgb[1] * .587 + rgb[2] * .114 > 155 ? "#181816" : "#fbfaf6";
}

function downloadCanvas(canvas, filename) {
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, "image/png");
}

function exportSwatchSheet() {
  const swatches = buildSwatches();
  const width = 1800;
  const margin = 72;
  const headerHeight = 292;
  const columns = 9;
  const cell = (width - margin * 2) / columns;
  const height = Math.round(headerHeight + cell * Math.ceil(swatches.length / columns) + 92);
  const { canvas, context } = makeExportCanvas(width, height);
  const cmykLabel = `C${state.cmyk.c}  M${state.cmyk.m}  Y${state.cmyk.y}  K${state.cmyk.k}`;

  context.fillStyle = "#ff4f2e";
  context.font = `600 18px ${EXPORT_MONO}`;
  context.letterSpacing = "3px";
  context.fillText("PROOF SHEET / 代表性色样谱", margin, 70);
  context.letterSpacing = "0px";
  context.fillStyle = "#181816";
  context.font = `600 74px ${EXPORT_SERIF}`;
  context.fillText("CMYK 容差色样谱", margin, 160);
  context.font = `500 22px ${EXPORT_MONO}`;
  context.fillText(`${cmykLabel}   ·   各通道 ±${state.tolerance}   ·   ${swatches.length} 个代表样本`, margin, 214);
  context.fillStyle = "#6f6c65";
  context.font = `400 18px ${EXPORT_SANS}`;
  context.fillText("每个通道取下限、基准与上限，按当前页面排列方式生成。", margin, 253);

  swatches.forEach((swatch, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = margin + column * cell;
    const y = headerHeight + row * cell;
    context.fillStyle = swatch.hex;
    context.fillRect(x, y, cell - 2, cell - 2);
    context.fillStyle = exportTextColor(swatch.rgb);
    context.font = `700 17px ${EXPORT_MONO}`;
    context.fillText(swatch.hex, x + 15, y + 30);
    context.font = `500 13px ${EXPORT_MONO}`;
    context.fillText(`C${swatch.c} M${swatch.m}`, x + 15, y + cell - 42);
    context.fillText(`Y${swatch.y} K${swatch.k}`, x + 15, y + cell - 21);
  });

  context.fillStyle = "#6f6c65";
  context.font = `400 14px ${EXPORT_MONO}`;
  context.fillText("SCREEN SIMULATION · CIE76 · COLOR TOLERANCE STUDY", margin, height - 38);
  downloadCanvas(canvas, `CMYK-${state.cmyk.c}-${state.cmyk.m}-${state.cmyk.y}-${state.cmyk.k}-色样谱.png`);
}

function exportDeltaPanel() {
  const width = 2000;
  const height = 1220;
  const leftWidth = 690;
  const baseHeight = 410;
  const padding = 58;
  const { canvas, context } = makeExportCanvas(width, height);
  const sourceCanvas = document.querySelector(state.gamutMode === "continuous" ? "#gamut-continuous" : "#gamut-points");
  const baseRgb = cmykToRgb(state.cmyk);
  const baseHex = rgbToHex(baseRgb);
  const delta = document.querySelector("#max-distance-heading").textContent;
  const farthestHex = document.querySelector("#farthest-hex").textContent;

  context.fillStyle = baseHex;
  context.fillRect(0, 0, leftWidth, baseHeight);
  context.fillStyle = exportTextColor(baseRgb);
  context.font = `600 17px ${EXPORT_MONO}`;
  context.fillText("BASE", padding, 62);
  context.font = `700 30px ${EXPORT_MONO}`;
  context.fillText(baseHex, padding, baseHeight - 48);

  context.fillStyle = "#fbfaf6";
  context.fillRect(0, baseHeight, leftWidth, height - baseHeight);
  context.fillStyle = "#ff4f2e";
  context.font = `600 15px ${EXPORT_MONO}`;
  context.fillText("OUTPUT / 最大近似色差", padding, baseHeight + 72);
  context.font = `600 32px ${EXPORT_MONO}`;
  context.fillText("ΔE", padding, baseHeight + 144);
  context.fillStyle = "#181816";
  context.font = `600 92px ${EXPORT_SERIF}`;
  context.fillText(delta, padding + 78, baseHeight + 148);
  context.fillStyle = "#181816";
  context.fillRect(padding, baseHeight + 190, 3, 69);
  context.font = `500 18px ${EXPORT_MONO}`;
  context.fillText("ΔE*ab = √[(ΔL*)² + (Δa*)² + (Δb*)²]", padding + 18, baseHeight + 218);
  context.fillStyle = "#6f6c65";
  context.font = `400 18px ${EXPORT_SANS}`;
  context.fillText("采用 CIE76 欧氏距离估算容差范围内的最大偏离。", padding, baseHeight + 305);

  const rows = [
    ["RGB 模拟", baseRgb.join(" · ")],
    ["CMYK 基准", `C${state.cmyk.c} · M${state.cmyk.m} · Y${state.cmyk.y} · K${state.cmyk.k}`],
    ["通道容差", `C / M / Y / K 各 ±${state.tolerance}`],
    ["最大偏离样本", farthestHex],
  ];
  context.strokeStyle = "#d1ccc0";
  context.lineWidth = 1;
  rows.forEach(([label, value], index) => {
    const y = baseHeight + 382 + index * 72;
    context.beginPath();
    context.moveTo(padding, y);
    context.lineTo(leftWidth - padding, y);
    context.stroke();
    context.fillStyle = "#969187";
    context.font = `400 15px ${EXPORT_SANS}`;
    context.fillText(label, padding, y + 43);
    context.fillStyle = "#181816";
    context.font = `500 16px ${EXPORT_MONO}`;
    context.textAlign = "right";
    context.fillText(value, leftWidth - padding, y + 43);
    context.textAlign = "left";
  });

  context.fillStyle = "#dedbd3";
  context.fillRect(leftWidth, 0, width - leftWidth, height);
  context.fillStyle = "#181816";
  context.font = `600 25px ${EXPORT_SERIF}`;
  context.fillText("色彩分布图", leftWidth + padding, 70);
  context.fillStyle = "#969187";
  context.font = `500 14px ${EXPORT_MONO}`;
  context.fillText("CIELAB a* / b* 平面", leftWidth + padding, 100);
  context.textAlign = "right";
  context.fillText("−a 绿     ─────     +a 红", width - padding, 74);
  context.textAlign = "left";

  const plotX = leftWidth + padding;
  const plotY = 132;
  const plotWidth = width - leftWidth - padding * 2;
  const plotHeight = height - 224;
  context.strokeStyle = "rgba(24, 24, 22, .09)";
  context.beginPath();
  context.moveTo(plotX + plotWidth / 2, plotY);
  context.lineTo(plotX + plotWidth / 2, plotY + plotHeight);
  context.moveTo(plotX, plotY + plotHeight / 2);
  context.lineTo(plotX + plotWidth, plotY + plotHeight / 2);
  context.stroke();
  context.drawImage(sourceCanvas, plotX, plotY, plotWidth, plotHeight);
  context.fillStyle = "#969187";
  context.font = `500 14px ${EXPORT_MONO}`;
  context.fillText("−b 蓝", plotX, height - 42);
  context.textAlign = "right";
  context.fillText("+b 黄", plotX + plotWidth, height - 42);
  context.textAlign = "left";

  downloadCanvas(canvas, `CMYK-${state.cmyk.c}-${state.cmyk.m}-${state.cmyk.y}-${state.cmyk.k}-DeltaE.png`);
}

function renderResults() {
  const baseRgb = cmykToRgb(state.cmyk);
  const baseHex = rgbToHex(baseRgb);
  state.baseLab = rgbToLab(baseRgb);
  state.points = [];
  const swatches = buildSwatches();
  const farthest = swatches.reduce((current, point) => point.distance > current.distance ? point : current, swatches[0]);

  document.querySelector("#base-swatch").style.background = baseHex;
  document.querySelector("#base-hex").textContent = baseHex;
  document.querySelector("#base-rgb").textContent = baseRgb.join(" · ");
  document.querySelector("#max-distance-heading").textContent = farthest.distance.toFixed(1);
  document.querySelector("#summary-tolerance").textContent = `C / M / Y / K 各 ±${state.tolerance}`;
  document.querySelector("#farthest-hex").textContent = farthest.hex;
  document.querySelector("#swatch-count").textContent = swatches.length;
  document.querySelector("#swatches").innerHTML = swatches.map((swatch) => `
    <button class="swatch" type="button" style="background:${swatch.hex}" aria-label="C ${swatch.c}, M ${swatch.m}, Y ${swatch.y}, K ${swatch.k}, ${swatch.hex}, 色差 ${swatch.distance.toFixed(1)}">
      <span>${swatch.hex}</span>
      <small>C${swatch.c} M${swatch.m} Y${swatch.y} K${swatch.k}</small>
    </button>
  `).join("");
  drawGamut();
}

function initialize() {
  document.querySelector("#presets").innerHTML = presets.map((preset, index) => `
    <button type="button" data-preset="${index}">
      <span style="background:${rgbToHex(cmykToRgb(preset.value))}"></span>${preset.name}
    </button>
  `).join("");
  document.querySelectorAll("[data-preset]").forEach((button) => {
    button.addEventListener("click", () => {
      state.cmyk = { ...presets[Number(button.dataset.preset)].value };
      renderChannels();
      scheduleRender();
    });
  });

  const tolerance = document.querySelector("#tolerance");
  tolerance.addEventListener("input", () => {
    state.tolerance = Number(tolerance.value);
    tolerance.style.setProperty("--position", `${state.tolerance * 10}%`);
    document.querySelector("#tolerance-output").textContent = `±${state.tolerance}`;
    document.querySelector("#top-tolerance").textContent = `Δ ±${state.tolerance}`;
    scheduleRender();
  });

  document.querySelector("#sort").addEventListener("change", (event) => {
    state.sort = event.target.value;
    renderResults();
  });
  document.querySelector("#export-swatches").addEventListener("click", exportSwatchSheet);
  document.querySelector("#export-delta").addEventListener("click", exportDeltaPanel);
  document.querySelectorAll("[data-gamut-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      state.gamutMode = button.dataset.gamutMode;
      document.querySelectorAll("[data-gamut-mode]").forEach((item) => {
        const active = item.dataset.gamutMode === state.gamutMode;
        item.classList.toggle("is-active", active);
        item.setAttribute("aria-pressed", String(active));
      });
      drawGamut();
    });
  });

  renderChannels();
  renderResults();
  requestExactResult();
  new ResizeObserver(drawGamut).observe(document.querySelector(".gamut-canvas-wrap"));
}

initialize();
