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
  title: "PIXEL — film & pixel looks for your photos",
  description:
    "63 vintage film looks and authentic pixel art for your photos — previewed on your own image, rendered on your GPU. No upload, no account, no watermark.",
  metadataBase: new URL("https://pixel.amoghbajpai.com"),
  openGraph: {
    title: "PIXEL — film & pixel looks",
    description: "Vintage film looks and pixel art for your photos. Runs in your browser.",
    url: "https://pixel.amoghbajpai.com",
    siteName: "PIXEL",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "PIXEL — film & pixel looks",
    description: "Vintage film looks and pixel art for your photos. Runs in your browser.",
  },
  icons: { icon: "/favicon.svg" },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${mono.variable} ${display.variable}`} suppressHydrationWarning>
      <head>
        {/* Set the theme before first paint: saved choice, else the OS setting. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=JSON.parse(localStorage.getItem("pixel:theme")||"null");if(!t)t=matchMedia("(prefers-color-scheme: light)").matches?"light":"dark";document.documentElement.dataset.theme=t}catch(e){}`,
          }}
        />
      </head>
      <body className="bg-ink-100 text-ink-900 font-mono antialiased">
        {children}
      </body>
    </html>
  );
}
