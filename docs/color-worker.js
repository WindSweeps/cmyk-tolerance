const clamp = (value) => Math.max(0, Math.min(100, Math.round(value)));

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

self.addEventListener("message", (event) => {
  const { request, cmyk, tolerance } = event.data;
  const baseLab = rgbToLab(cmykToRgb(cmyk));
  const side = tolerance * 2 + 1;
  const count = side ** 4;
  const positions = new Float32Array(count * 2);
  const colors = new Uint8ClampedArray(count * 3);
  const bounds = [Infinity, -Infinity, Infinity, -Infinity];
  let farthest = null;
  let index = 0;

  for (let dc = -tolerance; dc <= tolerance; dc += 1) {
    for (let dm = -tolerance; dm <= tolerance; dm += 1) {
      for (let dy = -tolerance; dy <= tolerance; dy += 1) {
        for (let dk = -tolerance; dk <= tolerance; dk += 1) {
          const value = {
            c: clamp(cmyk.c + dc),
            m: clamp(cmyk.m + dm),
            y: clamp(cmyk.y + dy),
            k: clamp(cmyk.k + dk),
          };
          const rgb = cmykToRgb(value);
          const lab = rgbToLab(rgb);
          positions[index * 2] = lab.a;
          positions[index * 2 + 1] = lab.b;
          colors[index * 3] = rgb[0];
          colors[index * 3 + 1] = rgb[1];
          colors[index * 3 + 2] = rgb[2];
          bounds[0] = Math.min(bounds[0], lab.a);
          bounds[1] = Math.max(bounds[1], lab.a);
          bounds[2] = Math.min(bounds[2], lab.b);
          bounds[3] = Math.max(bounds[3], lab.b);
          index += 1;
          const distance = Math.sqrt(
            (lab.l - baseLab.l) ** 2
            + (lab.a - baseLab.a) ** 2
            + (lab.b - baseLab.b) ** 2,
          );
          if (!farthest || distance > farthest.distance) {
            farthest = { ...value, hex: rgbToHex(rgb), distance };
          }
        }
      }
    }
  }

  self.postMessage(
    { request, farthest, cloud: { positions, colors, bounds, count } },
    [positions.buffer, colors.buffer],
  );
});
