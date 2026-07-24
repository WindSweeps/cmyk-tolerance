# CMYK Tolerance

一个用于观察 CMYK 印刷色容差的交互式网页。

输入一组 CMYK 基准值并设置每通道 `±0–10` 的容差，页面会：

- 计算所有整数步进下的通道组合（`±10` 时共 194,481 种）
- 在 CIELAB `a* / b*` 平面上绘制完整色彩分布
- 显示近似最大 ΔE 与最大偏离样本
- 展示由各通道下限、基准、上限组成的代表性色样谱

> 屏幕结果采用通用 CMYK → sRGB 与 CIELAB 近似换算，仅用于预判，不替代 ICC 色彩管理与实体打样。

## 本地运行

```bash
pnpm install
pnpm dev
```

## GitHub Pages

推送到 `main` 后，GitHub Actions 会构建静态版本并自动发布到 GitHub Pages。
