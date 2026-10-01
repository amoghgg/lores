# Lores

Browser-only pixel art tool. Drop an image, get authentic 8-bit output — or shoot it on 60 vintage film stocks. Palettes, dithering, film, no upload.

Live at **[pixel.amoghbajpai.com](https://pixel.amoghbajpai.com)**.

## Features

- **Block-average pixelation** with adjustable size (1–48 px)
- **9 palette presets**: Game Boy, GB Pocket, CGA, PICO-8, Sweetie 16, C64, Endesga 32, Mono, Original
- **Dithering**: none, Floyd-Steinberg, Bayer 4×4, Bayer 8×8
- **Film**: 60 vintage film, camera, and print-process looks in six groups —
  colour negative (Portra, Gold, Superia, Wolfen NC500…), slide & cinema
  (Kodachrome, Velvia, Vision3→2383 print, CineStill 800T halation,
  Technicolor 2-strip), lab & decay (cross-process, redscale, LomoChrome
  Purple, Aerochrome, expired-roll lottery, faded '70s print), cameras
  (SX-70, Instax, Holga, disposable flash with LED date stamp, Super 8 gate),
  antique (tintype, daguerreotype, autochrome, cyanotype, platinum,
  hand-tinted), and earth & auteur grades. One parametric model on the GPU
  with a CPU port: channel mixer, 12-band hue control, gray-ramp curves,
  split tone, halation, grain, vignette, leaks, dust, and print borders.
  PHOTO MODE bypasses the pixel stages for a straight film look.
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
