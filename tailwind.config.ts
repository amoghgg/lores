import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          0: "#000000",
          50: "#070707",
          100: "#0a0a0a",
          200: "#0f0f0f",
          300: "#141414",
          400: "#1a1a1a",
          500: "#262626",
          600: "#3d3d3d",
          700: "#5c5c5c",
          800: "#a3a3a3",
          900: "#e8e8e8",
          950: "#fafafa",
        },
        lime: {
          DEFAULT: "#a3e635",
          dim: "#5c8120",
          glow: "#bef264",
        },
        warn: "#fbbf24",
        err: "#ef4444",
      },
      fontFamily: {
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
        display: ["var(--font-display)", "monospace"],
      },
      letterSpacing: {
        wide: "0.04em",
        wider: "0.08em",
        widest: "0.16em",
      },
      transitionTimingFunction: {
        chunky: "steps(6, end)",
      },
      animation: {
        "fade-up": "fadeUp 0.6s steps(8, end) both",
        "blink": "blink 1.2s steps(2, end) infinite",
        "scan": "scan 8s linear infinite",
        "loading-stripe": "loadingStripe 1s linear infinite",
      },
      keyframes: {
        fadeUp: {
          "0%": { opacity: "0", transform: "translateY(8px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        blink: {
          "0%, 49%": { opacity: "1" },
          "50%, 100%": { opacity: "0" },
        },
        scan: {
          "0%": { transform: "translateY(-100%)" },
          "100%": { transform: "translateY(100%)" },
        },
        loadingStripe: {
          "0%": { transform: "translateX(-100%)" },
          "100%": { transform: "translateX(400%)" },
        },
      },
    },
  },
  plugins: [],
};

export default config;
