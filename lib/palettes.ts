export type RGB = [number, number, number];

export type Palette = {
  id: string;
  name: string;
  description: string;
  colors: RGB[];
};

const hex = (s: string): RGB => {
  const n = parseInt(s.replace("#", ""), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
};

const rgb = (...hexes: string[]): RGB[] => hexes.map(hex);

export const PALETTES: Palette[] = [
  {
    id: "none",
    name: "ORIGINAL",
    description: "no quantization",
    colors: [],
  },
  {
    id: "mono",
    name: "MONO",
    description: "1-bit · black + white",
    colors: rgb("#0a0a0a", "#e8e8e8"),
  },
  {
    id: "gb",
    name: "GAME BOY",
    description: "4 shades · DMG",
    colors: rgb("#0f380f", "#306230", "#8bac0f", "#9bbc0f"),
  },
  {
    id: "gb-pocket",
    name: "GB POCKET",
    description: "4 shades · grayscale",
    colors: rgb("#2c2c2c", "#6b6b6b", "#ababab", "#e5e5e5"),
  },
  {
    id: "cga",
    name: "CGA",
    description: "4 colors · mode 4 high",
    colors: rgb("#000000", "#55ffff", "#ff55ff", "#ffffff"),
  },
  {
    id: "pico8",
    name: "PICO-8",
    description: "16 colors · fantasy console",
    colors: rgb(
      "#000000",
      "#1d2b53",
      "#7e2553",
      "#008751",
      "#ab5236",
      "#5f574f",
      "#c2c3c7",
      "#fff1e8",
      "#ff004d",
      "#ffa300",
      "#ffec27",
      "#00e436",
      "#29adff",
      "#83769c",
      "#ff77a8",
      "#ffccaa"
    ),
  },
  {
    id: "sweetie16",
    name: "SWEETIE 16",
    description: "16 colors · GrafxKid",
    colors: rgb(
      "#1a1c2c",
      "#5d275d",
      "#b13e53",
      "#ef7d57",
      "#ffcd75",
      "#a7f070",
      "#38b764",
      "#257179",
      "#29366f",
      "#3b5dc9",
      "#41a6f6",
      "#73eff7",
      "#f4f4f4",
      "#94b0c2",
      "#566c86",
      "#333c57"
    ),
  },
  {
    id: "c64",
    name: "C64",
    description: "16 colors · Commodore",
    colors: rgb(
      "#000000",
      "#ffffff",
      "#880000",
      "#aaffee",
      "#cc44cc",
      "#00cc55",
      "#0000aa",
      "#eeee77",
      "#dd8855",
      "#664400",
      "#ff7777",
      "#333333",
      "#777777",
      "#aaff66",
      "#0088ff",
      "#bbbbbb"
    ),
  },
  {
    id: "endesga32",
    name: "ENDESGA 32",
    description: "32 colors · indie classic",
    colors: rgb(
      "#be4a2f",
      "#d77643",
      "#ead4aa",
      "#e4a672",
      "#b86f50",
      "#733e39",
      "#3e2731",
      "#a22633",
      "#e43b44",
      "#f77622",
      "#feae34",
      "#fee761",
      "#63c74d",
      "#3e8948",
      "#265c42",
      "#193c3e",
      "#124e89",
      "#0099db",
      "#2ce8f5",
      "#ffffff",
      "#c0cbdc",
      "#8b9bb4",
      "#5a6988",
      "#3a4466",
      "#262b44",
      "#181425",
      "#ff0044",
      "#68386c",
      "#b55088",
      "#f6757a",
      "#e8b796",
      "#c28569"
    ),
  },
];

export const getPalette = (id: string): Palette =>
  PALETTES.find((p) => p.id === id) ?? PALETTES[0];
