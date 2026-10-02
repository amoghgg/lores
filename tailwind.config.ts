import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Theme-aware: values live in CSS variables (app/globals.css),
        // swapped by [data-theme="light"].
        ink: Object.fromEntries(
          ["0", "50", "100", "200", "300", "400", "500", "600", "700", "800", "900", "950"].map((k) => [
            k,
            `rgb(var(--ink-${k}) / <alpha-value>)`,
          ])
        ),
        lime: {
          DEFAULT: "rgb(var(--lime) / <alpha-value>)",
          dim: "rgb(var(--lime-dim) / <alpha-value>)",
          glow: "rgb(var(--lime-glow) / <alpha-value>)",
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
