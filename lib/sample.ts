// The bundled sample photo, its required credit, and the lore that comes with it.

export const SAMPLE = {
  url: "/chuck-norris.jpg",
  filename: "chuck-norris.jpg",
  // CC BY-SA 3.0 — attribution required wherever the image is shown.
  credit: "Chuck Norris, The Delta Force (1986) · photo Yoni S. Hamenahem · CC BY-SA 3.0",
  source: "https://commons.wikimedia.org/wiki/File:Chuck_Norris,_The_Delta_Force_1986.jpg",
};

/** Photography facts, Chuck Norris edition. Shown while the sample is loaded. */
export const FACTS = [
  "CHUCK NORRIS DOESN'T NEED A FILTER. FILTERS NEED CHUCK NORRIS.",
  "CHUCK NORRIS SHOOTS KODACHROME. IT WAS DISCONTINUED. HE DIDN'T NOTICE.",
  "HALATION IS JUST LIGHT TRYING TO GET AWAY FROM CHUCK NORRIS.",
  "THERE IS NO UNDO FOR CHUCK NORRIS. ONLY REDO.",
  "CHUCK NORRIS'S LIGHT LEAKS ARE ON PURPOSE.",
  "GRAIN DOESN'T APPEAR ON CHUCK NORRIS. IT ASKS PERMISSION.",
  "CHUCK NORRIS DOESN'T EXPIRE. FILM EXPIRES OUT OF RESPECT.",
  "CHUCK NORRIS HOLDS THE PHOTO TO COMPARE. THE PHOTO CANNOT HOLD CHUCK NORRIS.",
  "CHUCK NORRIS DID ALL 63 LOOKS AT ONCE. THAT'S WHY THERE ARE 63.",
  "A TINTYPE CAN'T SEE RED. IT STILL SEES CHUCK NORRIS.",
  "CHUCK NORRIS'S POLAROIDS DEVELOP INSTANTLY. OUT OF FEAR.",
  "PIXELS DON'T GET BIGGER ON CHUCK NORRIS. THEY BACK AWAY.",
];

export function randomFact(): string {
  return FACTS[Math.floor(Math.random() * FACTS.length)];
}
