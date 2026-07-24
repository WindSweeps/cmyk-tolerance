"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { drawShaderGamut } from "./gamutWebGL";

type CMYK = { c: number; m: number; y: number; k: number };
type ColorPoint = CMYK & {
  hex: string;
  rgb: [number, number, number];
  a: number;
  b: number;
  distance: number;
};
type PointCloud = {
  positions: Float32Array;
  colors: Uint8ClampedArray;
  bounds: [number, number, number, number];
  count: number;
};

const channels = [
  { key: "c", label: "C", name: "青", color: "#00a7c8" },
  { key: "m", label: "M", name: "品红", color: "#d72573" },
  { key: "y", label: "Y", name: "黄", color: "#e4b800" },
  { key: "k", label: "K", name: "黑", color: "#20201e" },
] as const;

const presets: Array<{ name: string; value: CMYK }> = [
  { name: "海报蓝", value: { c: 82, m: 44, y: 0, k: 3 } },
  { name: "珊瑚红", value: { c: 0, m: 72, y: 58, k: 2 } },
  { name: "植物绿", value: { c: 71, m: 12, y: 72, k: 6 } },
  { name: "暖灰", value: { c: 18, m: 15, y: 17, k: 24 } },
];

const clamp = (value: number) => Math.max(0, Math.min(100, Math.round(value)));

function cmykToRgb({ c, m, y, k }: CMYK): [number, number, number] {
  return [
    Math.round(255 * (1 - c / 100) * (1 - k / 100)),
    Math.round(255 * (1 - m / 100) * (1 - k / 100)),
    Math.round(255 * (1 - y / 100) * (1 - k / 100)),
  ];
}

function rgbToHex([r, g, b]: [number, number, number]) {
  return `#${[r, g, b].map((value) => value.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

function rgbToLab([r, g, b]: [number, number, number]) {
  const linear = [r, g, b].map((value) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  const x = (linear[0] * 0.4124 + linear[1] * 0.3576 + linear[2] * 0.1805) / 0.95047;
  const yy = linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  const z = (linear[0] * 0.0193 + linear[1] * 0.1192 + linear[2] * 0.9505) / 1.08883;
  const pivot = (value: number) => value > 0.008856 ? Math.cbrt(value) : 7.787 * value + 16 / 116;
  return { l: 116 * pivot(yy) - 16, a: 500 * (pivot(x) - pivot(yy)), b: 200 * (pivot(yy) - pivot(z)) };
}

function makePoint(value: CMYK, baseLab: ReturnType<typeof rgbToLab>): ColorPoint {
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

function buildPreviewPoints(cmyk: CMYK, tolerance: number, baseLab: ReturnType<typeof rgbToLab>, limit = 3000) {
  const result: ColorPoint[] = [];
  const side = tolerance * 2 + 1;
  const total = side ** 4;
  const sampleCount = Math.min(total, limit);
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
  return result;
}

function drawFullPointGamut(
  canvas: HTMLCanvasElement,
  cloud: PointCloud,
  baseLab: ReturnType<typeof rgbToLab>,
) {
  canvas.dataset.renderQuality = "full";
  canvas.dataset.pointCount = String(cloud.count);
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.round(rect.width * ratio);
  const height = Math.round(rect.height * ratio);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const context = canvas.getContext("2d");
  if (!context) return;
  const startedAt = performance.now();
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, rect.width, rect.height);
  context.imageSmoothingEnabled = true;
  const padding = 32;
  const [minA, maxA, minB, maxB] = cloud.bounds;
  const spanA = Math.max(maxA - minA, 1);
  const spanB = Math.max(maxB - minB, 1);
  const plotWidth = rect.width - padding * 2;
  const plotHeight = rect.height - padding * 2;
  for (let point = 0; point < cloud.count; point += 1) {
    const x = padding + ((cloud.positions[point * 2] - minA) / spanA) * plotWidth;
    const y = rect.height - padding - ((cloud.positions[point * 2 + 1] - minB) / spanB) * plotHeight;
    const colorIndex = point * 3;
    context.fillStyle = `rgb(${cloud.colors[colorIndex]} ${cloud.colors[colorIndex + 1]} ${cloud.colors[colorIndex + 2]})`;
    context.beginPath();
    context.arc(x, y, 2.1, 0, Math.PI * 2);
    context.fill();
  }
  const x = 32 + ((baseLab.a - minA) / spanA) * (rect.width - 64);
  const y = rect.height - 32 - ((baseLab.b - minB) / spanB) * (rect.height - 64);
  context.strokeStyle = "#181816";
  context.lineWidth = 1.5;
  context.beginPath();
  context.arc(x, y, 7, 0, Math.PI * 2);
  context.moveTo(x - 11, y);
  context.lineTo(x + 11, y);
  context.moveTo(x, y - 11);
  context.lineTo(x, y + 11);
  context.stroke();
  canvas.dataset.renderMs = String(Math.round(performance.now() - startedAt));
}

function drawPointGamut(canvas: HTMLCanvasElement, points: ColorPoint[], baseLab: ReturnType<typeof rgbToLab>) {
  canvas.dataset.renderQuality = "preview";
  canvas.dataset.pointCount = String(points.length);
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height || !points.length) return;
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.round(rect.width * ratio);
  const height = Math.round(rect.height * ratio);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const context = canvas.getContext("2d");
  if (!context) return;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, rect.width, rect.height);
  const padding = 32;
  const minA = Math.min(...points.map((point) => point.a));
  const maxA = Math.max(...points.map((point) => point.a));
  const minB = Math.min(...points.map((point) => point.b));
  const maxB = Math.max(...points.map((point) => point.b));
  const spanA = Math.max(maxA - minA, 1);
  const spanB = Math.max(maxB - minB, 1);
  const xFor = (a: number) => padding + ((a - minA) / spanA) * (rect.width - padding * 2);
  const yFor = (b: number) => rect.height - padding - ((b - minB) / spanB) * (rect.height - padding * 2);
  for (const point of points) {
    context.fillStyle = point.hex;
    context.beginPath();
    context.arc(xFor(point.a), yFor(point.b), points.length > 5000 ? 2.1 : 2.5, 0, Math.PI * 2);
    context.fill();
  }
  const x = xFor(baseLab.a);
  const y = yFor(baseLab.b);
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

const EXPORT_SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans CJK SC", "Microsoft YaHei", "PingFang SC", Arial, sans-serif';
const EXPORT_SERIF = '"Songti SC", STSong, SimSun, "Noto Serif CJK SC", "Noto Serif SC", serif';
const EXPORT_MONO = 'ui-monospace, "SFMono-Regular", "Cascadia Mono", Consolas, "Liberation Mono", monospace';

function makeExportCanvas(width: number, height: number, gridSize = 48) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d")!;
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

function exportTextColor(rgb: [number, number, number]) {
  return rgb[0] * .299 + rgb[1] * .587 + rgb[2] * .114 > 155 ? "#181816" : "#fbfaf6";
}

function downloadCanvas(canvas: HTMLCanvasElement, filename: string) {
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

function exportSwatchImage(swatches: ColorPoint[], cmyk: CMYK, tolerance: number) {
  const width = 1800;
  const margin = 72;
  const headerHeight = 292;
  const columns = 9;
  const cell = (width - margin * 2) / columns;
  const height = Math.round(headerHeight + cell * Math.ceil(swatches.length / columns) + 92);
  const { canvas, context } = makeExportCanvas(width, height);

  context.fillStyle = "#ff4f2e";
  context.font = `600 18px ${EXPORT_MONO}`;
  context.fillText("PROOF SHEET / 代表性色样谱", margin, 70);
  context.fillStyle = "#181816";
  context.font = `600 74px ${EXPORT_SERIF}`;
  context.fillText("CMYK 容差色样谱", margin, 160);
  context.font = `500 22px ${EXPORT_MONO}`;
  context.fillText(`C${cmyk.c}  M${cmyk.m}  Y${cmyk.y}  K${cmyk.k}   ·   各通道 ±${tolerance}   ·   ${swatches.length} 个代表样本`, margin, 214);
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
  downloadCanvas(canvas, `CMYK-${cmyk.c}-${cmyk.m}-${cmyk.y}-${cmyk.k}-色样谱.png`);
}

function exportDeltaImage(
  cmyk: CMYK,
  tolerance: number,
  baseRgb: [number, number, number],
  baseHex: string,
  farthest: ColorPoint,
  sourceCanvas: HTMLCanvasElement | null,
) {
  if (!sourceCanvas) return;
  const width = 2000;
  const height = 1220;
  const leftWidth = 690;
  const baseHeight = 410;
  const padding = 58;
  const { canvas, context } = makeExportCanvas(width, height);

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
  context.fillText(farthest.distance.toFixed(1), padding + 78, baseHeight + 148);
  context.fillRect(padding, baseHeight + 190, 3, 69);
  context.font = `500 18px ${EXPORT_MONO}`;
  context.fillText("ΔE*ab = √[(ΔL*)² + (Δa*)² + (Δb*)²]", padding + 18, baseHeight + 218);
  context.fillStyle = "#6f6c65";
  context.font = `400 18px ${EXPORT_SANS}`;
  context.fillText("采用 CIE76 欧氏距离估算容差范围内的最大偏离。", padding, baseHeight + 305);

  const rows = [
    ["RGB 模拟", baseRgb.join(" · ")],
    ["CMYK 基准", `C${cmyk.c} · M${cmyk.m} · Y${cmyk.y} · K${cmyk.k}`],
    ["通道容差", `C / M / Y / K 各 ±${tolerance}`],
    ["最大偏离样本", farthest.hex],
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

  downloadCanvas(canvas, `CMYK-${cmyk.c}-${cmyk.m}-${cmyk.y}-${cmyk.k}-DeltaE.png`);
}

export default function Home() {
  const [cmyk, setCmyk] = useState<CMYK>({ c: 80, m: 80, y: 60, k: 5 });
  const [tolerance, setTolerance] = useState(10);
  const [sort, setSort] = useState<"distance" | "light" | "channel">("distance");
  const [gamutMode, setGamutMode] = useState<"points" | "continuous">("points");
  const [exactFarthest, setExactFarthest] = useState<ColorPoint | null>(null);
  const [fullCloud, setFullCloud] = useState<PointCloud | null>(null);
  const pointsCanvasRef = useRef<HTMLCanvasElement>(null);
  const continuousCanvasRef = useRef<HTMLCanvasElement>(null);

  const baseRgb = useMemo(() => cmykToRgb(cmyk), [cmyk]);
  const baseHex = useMemo(() => rgbToHex(baseRgb), [baseRgb]);
  const baseLab = useMemo(() => rgbToLab(baseRgb), [baseRgb]);
  const previewPoints = useMemo(
    () => buildPreviewPoints(cmyk, tolerance, baseLab),
    [cmyk, tolerance, baseLab],
  );

  useEffect(() => {
    setExactFarthest(null);
    setFullCloud(null);
    let worker: Worker | null = null;
    const timer = window.setTimeout(() => {
      worker = new Worker("./color-worker.js");
      worker.addEventListener("message", (event: MessageEvent<{ farthest: ColorPoint; cloud: PointCloud }>) => {
        setExactFarthest(event.data.farthest);
        setFullCloud(event.data.cloud);
        worker?.terminate();
        worker = null;
      });
      worker.postMessage({ request: 1, cmyk, tolerance });
    }, 180);
    return () => {
      window.clearTimeout(timer);
      worker?.terminate();
    };
  }, [cmyk, tolerance]);

  const swatches = useMemo(() => {
    const offsets = tolerance === 0 ? [0] : [-tolerance, 0, tolerance];
    const result: ColorPoint[] = [];
    for (const dc of offsets) for (const dm of offsets) for (const dy of offsets) for (const dk of offsets) {
      result.push(makePoint({
        c: clamp(cmyk.c + dc),
        m: clamp(cmyk.m + dm),
        y: clamp(cmyk.y + dy),
        k: clamp(cmyk.k + dk),
      }, baseLab));
    }
    return result.sort((left, right) => {
      if (sort === "distance") return left.distance - right.distance;
      if (sort === "light") return (right.rgb[0] + right.rgb[1] + right.rgb[2]) - (left.rgb[0] + left.rgb[1] + left.rgb[2]);
      return left.c - right.c || left.m - right.m || left.y - right.y || left.k - right.k;
    });
  }, [cmyk, tolerance, baseLab, sort]);
  const previewFarthest = useMemo(
    () => swatches.reduce((current, point) => point.distance > current.distance ? point : current, swatches[0]),
    [swatches],
  );
  const farthest = exactFarthest ?? previewFarthest;

  useEffect(() => {
    const canvas = gamutMode === "continuous" ? continuousCanvasRef.current : pointsCanvasRef.current;
    if (!canvas) return;
    const draw = () => {
      if (gamutMode === "continuous") drawShaderGamut(canvas, cmyk, tolerance);
      else if (fullCloud) drawFullPointGamut(canvas, fullCloud, baseLab);
      else drawPointGamut(canvas, previewPoints, baseLab);
    };

    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [cmyk, tolerance, gamutMode, previewPoints, fullCloud, baseLab]);

  const updateChannel = (key: keyof CMYK, value: number) => {
    setCmyk((current) => ({ ...current, [key]: clamp(Number.isFinite(value) ? value : 0) }));
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="色差实验室首页">
          <span className="brand-mark" aria-hidden="true">
            <i /><i /><i /><i />
          </span>
          <span>色差实验室</span>
          <small>CMYK / TOLERANCE MAP</small>
        </a>
        <div className="top-meta">
          <span>屏幕模拟</span>
          <span>整数步进</span>
          <strong>Δ ±{tolerance}</strong>
        </div>
      </header>

      <section className="hero" id="top">
        <div className="hero-copy">
          <p className="eyebrow">PRINT COLOR EXPLORER · 01</p>
          <h1>色差实验室<br /><em>CMYK印刷容差可视化</em></h1>
        </div>
        <div className="hero-note">
          <p className="hero-context">实际印刷中，套印、供墨与承印材料差异都可能使 CMYK 产生轻微偏移。</p>
          <p>输入一组 CMYK 值，观察四个通道在指定容差内波动时，所有可能出现的屏幕模拟色。</p>
        </div>
      </section>

      <section className="control-deck" aria-labelledby="input-title">
        <div className="control-heading">
          <div>
            <p className="section-label">INPUT / 基准值</p>
            <h2 id="input-title">设置油墨比例</h2>
          </div>
          <div className="preset-row" aria-label="颜色预设">
            {presets.map((preset) => (
              <button key={preset.name} type="button" onClick={() => setCmyk(preset.value)}>
                <span style={{ background: rgbToHex(cmykToRgb(preset.value)) }} />
                {preset.name}
              </button>
            ))}
          </div>
        </div>

        <div className="channel-grid">
          {channels.map((channel) => (
            <div className={`channel channel-${channel.key}`} key={channel.key}>
              <div className="channel-title">
                <span className="channel-letter" style={{ color: channel.color }}>{channel.label}</span>
                <span>{channel.name}</span>
                <label htmlFor={`${channel.key}-number`}>百分比</label>
              </div>
              <div className="channel-value">
                <input
                  id={`${channel.key}-number`}
                  type="number"
                  min="0"
                  max="100"
                  inputMode="numeric"
                  value={cmyk[channel.key]}
                  onChange={(event) => updateChannel(channel.key, Number(event.target.value))}
                />
                <span>%</span>
              </div>
              <input
                className="channel-range"
                aria-label={`${channel.name}通道 ${cmyk[channel.key]}%`}
                type="range"
                min="0"
                max="100"
                value={cmyk[channel.key]}
                onChange={(event) => updateChannel(channel.key, Number(event.target.value))}
                style={{ "--channel": channel.color, "--position": `${cmyk[channel.key]}%` } as React.CSSProperties}
              />
            </div>
          ))}
        </div>

        <div className="tolerance-row">
          <div>
            <label htmlFor="tolerance">通道容差</label>
            <p>每个通道独立在基准值上下浮动</p>
          </div>
          <div className="tolerance-control">
            <span>±0</span>
            <input
              id="tolerance"
              type="range"
              min="0"
              max="10"
              value={tolerance}
              onChange={(event) => setTolerance(Number(event.target.value))}
              style={{ "--position": `${tolerance * 10}%` } as React.CSSProperties}
            />
            <span>±10</span>
            <output>±{tolerance}</output>
          </div>
        </div>
      </section>

      <section className="results">
        <div className="result-summary">
          <div className="base-swatch" style={{ background: baseHex }}>
            <span>BASE</span>
            <strong>{baseHex}</strong>
          </div>
          <div className="summary-copy">
            <p className="section-label">OUTPUT / 最大近似色差</p>
            <h2 className="delta-heading"><small>ΔE</small>{farthest.distance.toFixed(1)}</h2>
            <p className="delta-formula">ΔE*ab = √[(ΔL*)² + (Δa*)² + (Δb*)²]</p>
            <p>采用 CIE76 欧氏距离估算当前容差范围内，偏离基准色最远的屏幕模拟色。</p>
            <dl>
              <div><dt>RGB 模拟</dt><dd>{baseRgb.join(" · ")}</dd></div>
              <div><dt>通道容差</dt><dd>C / M / Y / K 各 ±{tolerance}</dd></div>
              <div><dt>最大偏离样本</dt><dd>{farthest.hex}</dd></div>
            </dl>
          </div>
        </div>

        <div className="gamut-panel">
          <div className="panel-heading">
            <div>
              <span>色彩分布图</span>
              <small>CIELAB a* / b* 平面</small>
            </div>
            <div className="panel-actions">
              <div className="mode-switch" role="group" aria-label="色彩分布显示模式">
                <button
                  className={gamutMode === "points" ? "is-active" : ""}
                  type="button"
                  aria-pressed={gamutMode === "points"}
                  onClick={() => setGamutMode("points")}
                >
                  浮点模式
                </button>
                <button
                  className={gamutMode === "continuous" ? "is-active" : ""}
                  type="button"
                  aria-pressed={gamutMode === "continuous"}
                  onClick={() => setGamutMode("continuous")}
                >
                  连续模式
                </button>
              </div>
              <div className="axis-key" aria-hidden="true"><span>−a 绿</span><i /><span>+a 红</span></div>
              <button
                className="export-button"
                type="button"
                onClick={() => exportDeltaImage(
                  cmyk,
                  tolerance,
                  baseRgb,
                  baseHex,
                  farthest,
                  gamutMode === "continuous" ? continuousCanvasRef.current : pointsCanvasRef.current,
                )}
              >
                导出完整图 <span>PNG ↓</span>
              </button>
            </div>
          </div>
          <div className="gamut-canvas-wrap">
            <canvas ref={pointsCanvasRef} aria-label="指定 CMYK 容差内可能颜色的浮点分布图" hidden={gamutMode !== "points"} />
            <canvas ref={continuousCanvasRef} aria-label="指定 CMYK 容差内可能颜色的连续分布图" hidden={gamutMode !== "continuous"} />
          </div>
          <div className="gamut-axis" aria-hidden="true"><span>−b 蓝</span><span>+b 黄</span></div>
        </div>
      </section>

      <section className="swatch-section" aria-labelledby="swatch-title">
        <div className="swatch-heading">
          <div>
            <p className="section-label">PROOF SHEET / 边界色样</p>
            <h2 id="swatch-title">代表性色样谱</h2>
          </div>
          <div className="swatch-actions">
            <div className="sort-control">
              <label htmlFor="sort">排列</label>
              <select id="sort" value={sort} onChange={(event) => setSort(event.target.value as typeof sort)}>
                <option value="distance">由接近到偏离</option>
                <option value="light">由明到暗</option>
                <option value="channel">按 CMYK 数值</option>
              </select>
            </div>
            <button
              className="export-button export-button-dark"
              type="button"
              onClick={() => exportSwatchImage(swatches, cmyk, tolerance)}
            >
              导出色样谱 <span>PNG ↓</span>
            </button>
          </div>
        </div>
        <p className="swatch-intro">
          从每个通道的下限、基准、上限组合中抽取 {swatches.length} 个代表样本。悬停或聚焦可查看精确配方。
        </p>
        <div className="swatch-grid">
          {swatches.map((swatch, index) => (
            <button
              className="swatch"
              key={`${swatch.c}-${swatch.m}-${swatch.y}-${swatch.k}-${index}`}
              type="button"
              style={{ background: swatch.hex }}
              aria-label={`C ${swatch.c}, M ${swatch.m}, Y ${swatch.y}, K ${swatch.k}, ${swatch.hex}, 色差 ${swatch.distance.toFixed(1)}`}
            >
              <span>{swatch.hex}</span>
              <small>C{swatch.c} M{swatch.m} Y{swatch.y} K{swatch.k}</small>
            </button>
          ))}
        </div>
      </section>

      <footer>
        <p>注：结果采用通用 CMYK → sRGB 与 CIELAB 近似换算，仅用于屏幕预判。正式印刷请结合纸张、油墨、设备及 ICC 色彩配置。</p>
        <span>COLOR TOLERANCE STUDY · 2026</span>
      </footer>
    </main>
  );
}
