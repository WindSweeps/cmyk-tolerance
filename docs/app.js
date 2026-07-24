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

function getPreviewFarthest() {
  let farthest = state.points[0];
  for (let index = 1; index < state.points.length; index += 1) {
    if (state.points[index].distance > farthest.distance) farthest = state.points[index];
  }
  return farthest;
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

function drawGamut() {
  const canvas = document.querySelector("#gamut");
  const context = canvas.getContext("2d");
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height || !state.points.length) return;
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.round(rect.width * ratio);
  const height = Math.round(rect.height * ratio);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
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

  context.globalAlpha = state.points.length > 5000 ? 0.34 : 0.55;
  for (const point of state.points) {
    context.fillStyle = point.hex;
    const size = state.points.length > 5000 ? 1.35 : 1.8;
    context.fillRect(xFor(point.a), yFor(point.b), size, size);
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

function renderResults() {
  const baseRgb = cmykToRgb(state.cmyk);
  const baseHex = rgbToHex(baseRgb);
  state.baseLab = rgbToLab(baseRgb);
  buildPreviewPoints();
  const farthest = getPreviewFarthest();

  document.querySelector("#base-swatch").style.background = baseHex;
  document.querySelector("#base-hex").textContent = baseHex;
  document.querySelector("#base-rgb").textContent = baseRgb.join(" · ");
  document.querySelector("#max-distance-heading").textContent = farthest.distance.toFixed(1);
  document.querySelector("#summary-tolerance").textContent = `C / M / Y / K 各 ±${state.tolerance}`;
  document.querySelector("#farthest-hex").textContent = farthest.hex;
  document.querySelector("#gamut").setAttribute("aria-label", "指定 CMYK 容差内可能颜色的抽样分布图");

  const swatches = buildSwatches();
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

  renderChannels();
  renderResults();
  requestExactResult();
  new ResizeObserver(drawGamut).observe(document.querySelector("#gamut"));
}

initialize();
