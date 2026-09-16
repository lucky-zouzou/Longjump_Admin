import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

const title = "LOONG JUMP · 品牌出海供应链控制塔";
const description = "销售、库存、备货、生产与跨境运输的一体化协同系统";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host");
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host?.startsWith("localhost") || host?.startsWith("127.0.0.1") ? "http" : "https");
  const socialImage = host ? `${protocol}://${host}/og.png` : undefined;
  return {
    title,
    description,
    icons: { icon: "/favicon.png", shortcut: "/favicon.png", apple:"/favicon.png" },
    openGraph: {
      title,
      description,
      type: "website",
      locale: "zh_CN",
      images: socialImage ? [{ url:socialImage, width:1200, height:630, alt:title }] : undefined,
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: socialImage ? [socialImage] : undefined,
    },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
