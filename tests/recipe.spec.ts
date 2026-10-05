// The recipe model: codes, the film stack and its engine ordering. Pure
// logic, no browser.
import { test, expect } from "@playwright/test";
import {
  DEFAULT_RECIPE,
  MAX_FILMS,
  decodeRecipe,
  describeRecipe,
  encodeRecipe,
  filmLayers,
  patchLayer,
  removeLayer,
  stageOf,
  toFilms,
} from "../lib/recipe";
import { FILM_CATEGORIES, FILM_STOCKS, HERO_LOOKS, chipFor, getStock } from "../lib/filmStocks";

const ids = (code: string) => filmLayers(decodeRecipe(code)!).map((l) => l.film);

test("legacy single-look codes still decode", () => {
  const r = decodeRecipe("1~px:8~pal:pico8~dt:bayer4~film:portra400.s7")!;
  expect(r.block).toBe(8);
  expect(r.palette).toBe("pico8");
  expect(filmLayers(r).map((l) => l.film)).toEqual(["portra400"]);
  expect(encodeRecipe(r)).toBe("1~px:8~pal:pico8~dt:bayer4~film:portra400.s7");
});

test("a stack round-trips through its code", () => {
  let r = patchLayer(DEFAULT_RECIPE, 1, { film: "kodachrome64" });
  r = patchLayer(r, 2, { film: "cinestill800t", grain: 1.5 });
  r = patchLayer(r, 1, { filmAmt: 0.5 });
  const code = encodeRecipe(r);
  expect(encodeRecipe(decodeRecipe(code)!)).toBe(code);
  expect(toFilms(decodeRecipe(code)!)).toHaveLength(3);
  expect(describeRecipe(r)).toBe("PORTRA 400 · KODACHROME 64 · CINESTILL 800T");
});

test("the stack keeps engine order: restyle → grade → screen", () => {
  expect(stageOf("ps2red")).toBe(0);
  expect(stageOf("portra400")).toBe(1);
  expect(stageOf("crt")).toBe(2);
  // Added CRT first, then a grade, then a restyle — runs restyle, grade, CRT.
  let r = patchLayer({ ...DEFAULT_RECIPE, film: "none" }, 0, { film: "crt" });
  r = patchLayer(r, 1, { film: "portra400" });
  r = patchLayer(r, 2, { film: "datamosh" });
  expect(filmLayers(r).map((l) => l.film)).toEqual(["datamosh", "portra400", "crt"]);
  // Within a stage, insertion order holds.
  r = patchLayer(r, 3, { film: "trix" });
  expect(filmLayers(r).map((l) => l.film)).toEqual(["datamosh", "portra400", "trix", "crt"]);
  // Old codes in any order are normalised.
  expect(ids("1~film:crt.s1~film:portra400.s2")).toEqual(["portra400", "crt"]);
});

test("removing layers and the stack limit", () => {
  let r = DEFAULT_RECIPE;
  for (let i = 0; i < MAX_FILMS + 3; i++) r = patchLayer(r, 99, { film: "trix" });
  expect(filmLayers(r)).toHaveLength(MAX_FILMS);
  r = removeLayer(decodeRecipe("1~film:portra400.s7~film:trix.s9")!, 0);
  expect(filmLayers(r).map((l) => l.film)).toEqual(["trix"]);
  expect(filmLayers(removeLayer(r, 0))).toHaveLength(0);
});

test("the text switch covers every layer and round-trips", () => {
  const r = decodeRecipe("1~film:nightshot.s7~film:nightshot.s9~notext")!;
  expect(r.text).toBe(false);
  for (const f of toFilms(r)) {
    expect(f.recipe.hud).toBe("none");
    expect(f.recipe.dateStamp).toBe(false);
    expect(f.recipe.fxLabels).toBe(false);
  }
  expect(encodeRecipe(r)).toContain("~notext");
  // Legacy per-layer flag.
  expect(decodeRecipe("1~film:nightshot.t0.s7")!.text).toBe(false);
});

test("catalogue integrity", () => {
  const seen = new Set<string>();
  const cats = new Set(FILM_CATEGORIES.map((c) => c.id));
  for (const s of FILM_STOCKS) {
    expect(seen.has(s.id), `duplicate id ${s.id}`).toBe(false);
    seen.add(s.id);
    expect(cats.has(s.category), `${s.id} has unknown category ${s.category}`).toBe(true);
    expect(s.name && s.hint && s.note && s.meta, `${s.id} is missing copy`).toBeTruthy();
    expect(s.id).toMatch(/^[a-z0-9]+$/); // safe inside recipe codes
  }
  for (const c of FILM_CATEGORIES) expect(FILM_STOCKS.some((s) => s.category === c.id), `${c.id} is empty`).toBe(true);
  expect(HERO_LOOKS.length).toBeGreaterThanOrEqual(16);
  expect(HERO_LOOKS.length).toBeLessThanOrEqual(30);
  for (const id of HERO_LOOKS) {
    expect(getStock(id), `hero ${id} doesn't exist`).not.toBeNull();
    expect(chipFor(id)).toBe("best");
  }
  // Every family is represented among the heroes.
  for (const c of FILM_CATEGORIES)
    expect(HERO_LOOKS.some((id) => getStock(id)!.category === c.id), `no hero from ${c.id}`).toBe(true);
});
