import type { Metadata } from "next";
import { JetBrains_Mono, VT323 } from "next/font/google";
import "./globals.css";

const mono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  variable: "--font-mono",
  display: "swap",
});

const display = VT323({
  subsets: ["latin"],
  weight: "400",
  variable: "--font-display",
  display: "swap",
});

export const metadata: Metadata = {
  title: "LORES // PIXEL ART OPERATOR",
  description:
    "Browser-only pixel art tool. Drop an image, get authentic 8-bit output. Palettes, dithering, no upload.",
  metadataBase: new URL("https://pixel.amoghbajpai.com"),
  openGraph: {
    title: "Lores — Pixel Art Operator",
    description: "Drop an image, get authentic pixel art. Runs in your browser.",
    url: "https://pixel.amoghbajpai.com",
    siteName: "Lores",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Lores — Pixel Art Operator",
    description: "Drop an image, get authentic pixel art. Runs in your browser.",
  },
  icons: { icon: "/favicon.svg" },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${mono.variable} ${display.variable}`}>
      <body className="bg-ink-100 text-ink-900 font-mono antialiased">
        {children}
      </body>
    </html>
  );
}
