import type { Metadata } from "next";
import "./globals.css";

const assetRoot = process.env.GITHUB_ACTIONS === "true" ? "/cmyk-tolerance" : "";

export const metadata: Metadata = {
  title: "色差实验室｜CMYK 容差可视化",
  description: "输入 CMYK 值，可视化四个通道在正负 5 以内的所有可能颜色。",
  icons: {
    icon: `${assetRoot}/favicon.svg`,
    shortcut: `${assetRoot}/favicon.svg`,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
