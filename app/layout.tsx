import type { Metadata } from "next";
import { Inter, VT323 } from "next/font/google";
import "./globals.css";

const sans = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const display = VT323({
  subsets: ["latin"],
  weight: "400",
  variable: "--font-display",
  display: "swap",
});

export const metadata: Metadata = {
  title: "LORES — film, screen & pixel looks for your photos",
  description:
    "100+ looks for your photos — film stocks, CRTs, receipts, depth maps, datamosh and real pixel art — previewed on your own image, rendered on your device. No upload, no account, no watermark.",
  metadataBase: new URL("https://lores.amoghbajpai.com"),
  openGraph: {
    title: "LORES — film, screen & pixel looks",
    description: "Film, screen, glitch and pixel looks for your photos. Runs on your device.",
    url: "https://lores.amoghbajpai.com",
    siteName: "LORES",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "LORES — film, screen & pixel looks",
    description: "Film, screen, glitch and pixel looks for your photos. Runs on your device.",
  },
  icons: { icon: "/favicon.svg" },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${sans.variable} ${display.variable}`} suppressHydrationWarning>
      <head>
        {/* Set the theme before first paint: saved choice, else the OS setting. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=JSON.parse(localStorage.getItem("pixel:theme")||"null");if(!t)t=matchMedia("(prefers-color-scheme: light)").matches?"light":"dark";document.documentElement.dataset.theme=t}catch(e){}`,
          }}
        />
      </head>
      <body className="bg-ink-100 text-ink-900 font-sans antialiased">
        {children}
      </body>
    </html>
  );
}
