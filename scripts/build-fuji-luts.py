"""Build the FUJIFILM looks' colour tables (public/luts/fuji/*.png).

Source: github.com/abpy/FujifilmCameraProfiles (CC BY-NC-SA 4.0) — 32³ .cube
LUTs matched to Fujifilm's film simulations via Adobe's camera-matching
profiles. Those expect a flat, linear-contrast render; a phone photo is
already a finished, roughly PROVIA/STANDARD-like render. So each look here is
the *difference* PROVIA → simulation: X(PROVIA⁻¹(c)). PROVIA is inverted
numerically (damped Newton per grid point); colours more saturated than
PROVIA can produce land on the nearest reachable one.

    git clone --depth 1 https://github.com/abpy/FujifilmCameraProfiles /tmp/fuji
    python3 scripts/build-fuji-luts.py "/tmp/fuji/cube lut"

Output layout: an N²×N RGB PNG; pixel (b·N + r, g) holds LUT[r, g, b].
"""

import os
import sys

import numpy as np
from PIL import Image

SIMS = {
    "velvia": "velvia",
    "astia": "astia",
    "classicchrome": "classic chrome",
    "proneghi": "pro neg hi",
    "pronegstd": "pro neg std",
    "classicneg": "classic neg",
    "nostalgicneg": "nostalgic neg",
    "eterna": "eterna",
    "bleachbypass": "bleach bypass",
    "realaace": "reala ace",
}


def load(path):
    rows = [l.split() for l in open(path) if l.strip() and (l[0].isdigit() or l[0] in "-.")]
    a = np.array(rows, np.float64)
    n = round(len(a) ** (1 / 3))
    return a.reshape(n, n, n, 3)  # .cube order: red fastest → index [b][g][r]


def apply(L, x):
    """Trilinear lookup; x is (..., 3) RGB in 0..1."""
    n = L.shape[0]
    p = np.clip(x, 0, 1) * (n - 1)
    i = np.minimum(np.floor(p).astype(int), n - 2)
    f = p - i
    r, g, b = i[..., 0], i[..., 1], i[..., 2]
    fr, fg, fb = f[..., 0:1], f[..., 1:2], f[..., 2:3]
    c = lambda db, dg, dr: L[b + db, g + dg, r + dr]
    c00 = c(0, 0, 0) * (1 - fr) + c(0, 0, 1) * fr
    c01 = c(0, 1, 0) * (1 - fr) + c(0, 1, 1) * fr
    c10 = c(1, 0, 0) * (1 - fr) + c(1, 0, 1) * fr
    c11 = c(1, 1, 0) * (1 - fr) + c(1, 1, 1) * fr
    return (c00 * (1 - fg) + c01 * fg) * (1 - fb) + (c10 * (1 - fg) + c11 * fg) * fb


def invert(P):
    n = P.shape[0]
    g = np.linspace(0, 1, n)
    B, G, R = np.meshgrid(g, g, g, indexing="ij")
    Y = np.stack([R, G, B], -1)
    X = Y.copy()
    h = 1e-3
    for _ in range(60):
        F = apply(P, X) - Y
        J = np.stack(
            [(apply(P, np.clip(X + h * e, 0, 1)) - apply(P, np.clip(X - h * e, 0, 1))) / (2 * h) for e in np.eye(3)],
            -1,
        )
        J += np.eye(3) * 1e-4
        d = np.linalg.solve(J, -F[..., None])[..., 0]
        m = np.abs(d).max(-1, keepdims=True)
        X = np.clip(X + d * np.minimum(1, 0.15 / np.maximum(m, 1e-9)), 0, 1)
    err = np.abs(apply(P, X) - Y).max(-1)
    chroma = Y.max(-1) - Y.min(-1)
    print(f"PROVIA inverse: mean error {err[chroma < 0.6].mean():.4f} on everyday colours")
    return X


def main():
    src = sys.argv[1]
    out = os.path.join(os.path.dirname(__file__), "..", "public", "luts", "fuji")
    os.makedirs(out, exist_ok=True)
    inv = invert(load(os.path.join(src, "provia_sRGB.cube")))
    n = inv.shape[0]
    for key, name in SIMS.items():
        rel = apply(load(os.path.join(src, f"{name}_sRGB.cube")), inv)  # [b][g][r] → rgb
        img = np.transpose(rel, (1, 0, 2, 3)).reshape(n, n * n, 3)  # row g, column b·n + r
        Image.fromarray((np.clip(img, 0, 1) * 255 + 0.5).astype(np.uint8)).save(
            os.path.join(out, f"{key}.png"), optimize=True
        )
        print(key, "ok")


if __name__ == "__main__":
    main()
