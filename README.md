# Lores

Browser-only pixel art tool. Drop an image, get authentic 8-bit output. Palettes, dithering, no upload.

Live at **[pixel.amoghbajpai.com](https://pixel.amoghbajpai.com)**.

## Features

- **Block-average pixelation** with adjustable size (1–48 px)
- **9 palette presets**: Game Boy, GB Pocket, CGA, PICO-8, Sweetie 16, C64, Endesga 32, Mono, Original
- **Dithering**: none, Floyd-Steinberg, Bayer 4×4, Bayer 8×8
- **Export**: PNG at 1×, 2×, 4×, or 8× nearest-neighbor upscale
- **Privacy by default**: every step runs in your browser. No upload, no tracking.

## Stack

- Next.js 15 (App Router, static export)
- TypeScript strict
- Tailwind CSS
- Pure Canvas 2D — no image processing libraries

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Build

```bash
npm run build
```

Outputs a static site to `out/` ready to drop on any static host.

## License

MIT — see [LICENSE](./LICENSE).

## Contributing

Palette PRs welcome. Add an entry to `lib/palettes.ts` with a clear name, source attribution in the description, and accurate hex values.
