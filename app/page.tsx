"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type CMYK = { c: number; m: number; y: number; k: number };
type ColorPoint = CMYK & {
  hex: string;
  rgb: [number, number, number];
  a: number;
  b: number;
  distance: number;
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

export default function Home() {
  const [cmyk, setCmyk] = useState<CMYK>({ c: 82, m: 44, y: 0, k: 3 });
  const [tolerance, setTolerance] = useState(5);
  const [sort, setSort] = useState<"distance" | "light" | "channel">("distance");
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const baseRgb = useMemo(() => cmykToRgb(cmyk), [cmyk]);
  const baseHex = useMemo(() => rgbToHex(baseRgb), [baseRgb]);
  const baseLab = useMemo(() => rgbToLab(baseRgb), [baseRgb]);

  const points = useMemo(() => {
    const result: ColorPoint[] = [];
    for (let dc = -tolerance; dc <= tolerance; dc += 1) {
      for (let dm = -tolerance; dm <= tolerance; dm += 1) {
        for (let dy = -tolerance; dy <= tolerance; dy += 1) {
          for (let dk = -tolerance; dk <= tolerance; dk += 1) {
            result.push(makePoint({
              c: clamp(cmyk.c + dc),
              m: clamp(cmyk.m + dm),
              y: clamp(cmyk.y + dy),
              k: clamp(cmyk.k + dk),
            }, baseLab));
          }
        }
      }
    }
    return result;
  }, [cmyk, tolerance, baseLab]);

  const farthest = useMemo(
    () => points.reduce((current, point) => point.distance > current.distance ? point : current, points[0]),
    [points],
  );

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

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    const draw = () => {
      const rect = canvas.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(rect.width * ratio);
      canvas.height = Math.round(rect.height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, rect.width, rect.height);

      const padding = 32;
      const aValues = points.map((point) => point.a);
      const bValues = points.map((point) => point.b);
      const minA = Math.min(...aValues);
      const maxA = Math.max(...aValues);
      const minB = Math.min(...bValues);
      const maxB = Math.max(...bValues);
      const spanA = Math.max(maxA - minA, 1);
      const spanB = Math.max(maxB - minB, 1);
      const xFor = (a: number) => padding + ((a - minA) / spanA) * (rect.width - padding * 2);
      const yFor = (b: number) => rect.height - padding - ((b - minB) / spanB) * (rect.height - padding * 2);

      context.globalAlpha = points.length > 5000 ? 0.34 : 0.55;
      for (const point of points) {
        context.fillStyle = point.hex;
        context.beginPath();
        context.arc(xFor(point.a), yFor(point.b), points.length > 5000 ? 1.35 : 1.8, 0, Math.PI * 2);
        context.fill();
      }
      context.globalAlpha = 1;
      const x = xFor(baseLab.a);
      const y = yFor(baseLab.b);
      context.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue("--ink");
      context.lineWidth = 1.5;
      context.beginPath();
      context.arc(x, y, 7, 0, Math.PI * 2);
      context.moveTo(x - 11, y);
      context.lineTo(x + 11, y);
      context.moveTo(x, y - 11);
      context.lineTo(x, y + 11);
      context.stroke();
    };

    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [points, baseLab]);

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
          <h1>看见颜色<br /><em>允许的偏差</em></h1>
        </div>
        <div className="hero-note">
          <span className="note-index">A—01</span>
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
              max="5"
              value={tolerance}
              onChange={(event) => setTolerance(Number(event.target.value))}
              style={{ "--position": `${tolerance * 20}%` } as React.CSSProperties}
            />
            <span>±5</span>
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
            <div className="axis-key" aria-hidden="true"><span>−a 绿</span><i /><span>+a 红</span></div>
          </div>
          <canvas ref={canvasRef} aria-label={`${points.length} 种可能颜色的色彩分布图`} />
          <div className="gamut-axis" aria-hidden="true"><span>−b 蓝</span><span>+b 黄</span></div>
        </div>
      </section>

      <section className="swatch-section" aria-labelledby="swatch-title">
        <div className="swatch-heading">
          <div>
            <p className="section-label">PROOF SHEET / 边界色样</p>
            <h2 id="swatch-title">代表性色样谱</h2>
          </div>
          <div className="sort-control">
            <label htmlFor="sort">排列</label>
            <select id="sort" value={sort} onChange={(event) => setSort(event.target.value as typeof sort)}>
              <option value="distance">由接近到偏离</option>
              <option value="light">由明到暗</option>
              <option value="channel">按 CMYK 数值</option>
            </select>
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
