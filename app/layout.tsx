import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import "react-pdf/dist/Page/TextLayer.css";
import "katex/dist/katex.min.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://mathmargin.bl786.chatgpt.site"),
  title: { default: "MathMargin", template: "%s · MathMargin" },
  description: "A private workspace for reading and annotating mathematical textbooks with LaTeX notes.",
  openGraph: {
    title: "MathMargin",
    description: "Read closely. Think in the margins.",
    type: "website",
    images: [{ url: "https://mathmargin.bl786.chatgpt.site/og.png", width: 1728, height: 910, alt: "MathMargin — Read closely. Think in the margins." }],
  },
  twitter: {
    card: "summary_large_image",
    title: "MathMargin",
    description: "Read closely. Think in the margins.",
    images: ["https://mathmargin.bl786.chatgpt.site/og.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
