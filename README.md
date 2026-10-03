# PIXEL

Browser-only pixel art tool. Vintage film looks and authentic pixel art for your photos — previewed live on your own image, rendered on your GPU. No upload, no account, no watermark.

Live at **[pixel.amoghbajpai.com](https://pixel.amoghbajpai.com)**.

## How it works

Pick a look → adjust one slider → **Save**.

- **Three tabs**: FILM (81 looks), PIXEL (size, colours, pattern), MORE (texture, sound).
- Every option is a live thumbnail of *your* photo; hover on desktop previews it full-size.
- **Hold the photo** (or `\`) to see the original. **⚄ Surprise** (Space) rolls a new look.
- Undo / redo, and the session survives a reload (IndexedDB + localStorage).
- The URL is the recipe (`#r=1~px:8~pal:pico8~film:portra400.s7`): copy it to share a look, never the photo.
- Saved PNGs carry the recipe in a `tEXt` chunk — drop one back in and the look comes with it.
- Save options: native ×1–8, or padded frames for IG 4:5 / 3:4, Story 9:16, square.
- Keyboard (optional): `← →` next look, `1 2 3` tabs, `F` favourite, `⌘S` save, `⌘K` search everything, `?` all keys.

## Features

- **Block-average pixelation** with adjustable size (1–48 px)
- **9 palette presets**: Game Boy, GB Pocket, CGA, PICO-8, Sweetie 16, C64, Endesga 32, Mono, Original
- **Dithering**: none, Floyd-Steinberg, Bayer 4×4, Bayer 8×8
- **Film**: 81 film, camera, and print-process looks in six groups —
  colour negative (Portra, Gold, Superia, Wolfen NC500…), slide & cinema
  (Kodachrome, Velvia, Vision3→2383 print, CineStill 800T halation,
  Technicolor 2-strip), lab & decay (cross-process, redscale, LomoChrome
  Purple, Aerochrome, expired-roll lottery, faded '70s print), cameras
  (SX-70, Instax, Holga, disposable flash with LED date stamp, Super 8 gate),
  antique (tintype, daguerreotype, autochrome, cyanotype, platinum,
  hand-tinted), earth & auteur grades, and AFTERDARK — the IG-goth /
  underground-rap edits: NightShot IR camcorder, trail cam, thermal, VHS
  found footage, witch house, xerox zine, halftone, riso misprint, grunge
  angel dithers with misregistered plates and torn photocopy frames,
  cutout and gig-poster posterize, 1-bit, soft grunge '14, deep fried and
  CCD digicam (with burned-in REC / PLAY / trail-cam HUDs and real JPEG
  crunch). One parametric model on the GPU
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

## Credits

Sample photo: *Chuck Norris, The Delta Force (1986)* by Yoni S. Hamenahem, [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/), via [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Chuck_Norris,_The_Delta_Force_1986.jpg). Resized.
