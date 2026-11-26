#!/usr/bin/env node
// Build SQL UPDATE statements to fix each games.input_fields to match UniPlay's
// actual form schema (scraped from uniplay.id/game/<slug>).
import fs from "node:fs";

const scrape = JSON.parse(fs.readFileSync("C:/Users/HERAAY~1/AppData/Local/Temp/claude/aa6caf5de252baf4/37123b16-67dc-4afb-86dc-3f721c781fbe/scratchpad/uniplay-forms.json", "utf8")).results;

// Map UniPlay URL slug → our DB slug (prefix `mobile-` + game name slugified).
// Our DB slug is set by src/sync.js `${category}-${slugify(item.name)}`.
// We know the names roughly. Hardcode mapping for high-signal cases.
const MAP = {
  "ace-razer": "mobile-ace-racer",
  "afk-journey": "mobile-afk-journey",
  "age-of-magic": "mobile-age-of-magic",
  "arena-of-valor": "mobile-arena-of-valor-all-bind",
  "astral-guardians-cyber-fantasy": "mobile-astral-guardians-cyber-fantasy",
  "au2-mobile": "mobile-au2-mobile",
  "be-the-king": "mobile-be-the-king",
  "bleach-mobile-3d": "mobile-bleach-mobile-3d",
  "blood-strike": "mobile-blood-strike",
  "call-of-duty-id": "mobile-call-of-duty-mobile-id",
  "city-of-crime-gang-wars": "mobile-city-of-crime-gang-wars",
  "crystal-of-atlan": "mobile-crystal-of-atlan",
  "crystalfall": "mobile-crystalfall",
  "culinary-tour": "mobile-culinary-tour",
  "dc-dark-legion": "mobile-dc-dark-legion",
  "delta-force-mobile": "mobile-delta-force-mobile",
  "destiny-rising": "mobile-destiny-rising",
  "dragon-raja-sea": "mobile-dragon-raja-sea",
  "dragonheir-silent-gods": "mobile-dragonheir-silent-gods",
  "dynasty-warriors-overlords": "mobile-dynasty-warriors-overlords",
  "echocalypse": "mobile-echocalypse",
  "eggy-party": "mobile-eggy-party",
  "ensemble-stars-music": "mobile-ensemble-stars-music",
  "era-of-celestials": "mobile-era-of-celestials",
  "fable-town": "mobile-fable-town",
  "farlight-84": "mobile-farlight-84",
  "football-master-2": "mobile-football-master-2",
  "free-fire": "mobile-free-fire",
  "free-fire-global": "mobile-free-fire-global",
  "free-fire-max": "mobile-free-fire-max",
  "ghost-pinball-tuyul-adventure": "mobile-ghost-pinball-tuyul-adventure",
  "ghost-story-love-destiny": "mobile-ghost-story-love-destiny",
  "guns-of-glory": "mobile-guns-of-glory",
  "haikyu-fly-high": "mobile-haikyu-fly-high",
  "heaven-domain-rebirth": "mobile-heaven-domain-rebirth",
  "heroes-evolved": "mobile-heroes-evolved",
  "honkai-impact-3": "mobile-honkai-impact-3",
  "honor-of-kings": "mobile-honor-of-kings",
  "identity-v": "mobile-identity-v",
  "journey-renewed-fate-fantasy": "mobile-journey-renewed-fate-fantasy",
  "king-of-avalon": "mobile-king-of-avalon",
  "kings-choice": "mobile-kings-choice",
  "league-of-legends-wild-rift": "mobile-league-of-legends-wild-rift",
  "legacy-fate-sacred-and-fearless": "mobile-legacy-fate-sacred-and-fearless",
  "legend-of-mushroom-rush": "mobile-legend-of-mushroom-rush",
  "life-makeover": "mobile-life-makeover",
  "light-of-thel-new-era": "mobile-light-of-thel-new-era",
  "lineage2m": "mobile-lineage2m",
  "lita": "mobile-lita",
  "lokapala": "mobile-lokapala",
  "love-and-deepspace": "mobile-love-and-deepspace",
  "machina-waking": "mobile-machina-waking",
  "magic-chess-go-go": "mobile-magic-chess-go-go",
  "mangatoon": "mobile-mangatoon",
  "marvel-duel": "mobile-marvel-duel",
  "marvel-rivals": "mobile-marvel-rivals",
  "melojam": "mobile-melojam",
  "misty-continent": "mobile-misty-continent",
  "mobile-legends": "mobile-mobile-legends-bang-bang-id",
  "mobile-legends-global": "mobile-mobile-legends-global-exc-id-my-ph-ru-sg-tr",
  "mobile-legends-my": "mobile-mobile-legends-bang-bang-my",
  "mobile-legends-ph": "mobile-mobile-legends-bang-bang-ph",
  "mobile-legends-russia": "mobile-mobile-legends-bang-bang-russia",
  "mobile-legends-th": "mobile-mobile-legends-bang-bang-thailand",
  "mobile-legends-turkey": "mobile-mobile-legends-bang-bang-turkey",
  "mobile-royale": "mobile-mobile-royale",
  "moonlight-blade-m": "mobile-moonlight-blade-m",
  "mu-origin-2": "mobile-mu-origin-2",
  "mythic-dawn-13-megami": "mobile-mythic-dawn-13-megami",
  "nba-infinite": "mobile-nba-infinite",
  "one-punch-man-the-strongest": "mobile-one-punch-man-the-strongest",
  "onmyoji-arena": "mobile-onmyoji-arena",
  "path-to-nowhere": "mobile-path-to-nowhere",
  "perfect-world": "mobile-perfect-world",
  "point-blank": "mobile-point-blank",
  "pokemon-unite": "mobile-pok-mon-unite",
  "pubg-mobile": "mobile-pubg-mobile",
  "pubg-mobile-global": "mobile-pubg-mobile-global",
  "pubg-mobile-lite": "mobile-pubg-mobile-lite",
  "punishing-gray-raven": "mobile-punishing-gray-raven",
  "pure-sniper-gun-shooter-games": "mobile-pure-sniper-gun-shooter-games",
  "ragnarok-crush": "mobile-ragnarok-crush",
  "ragnarok-idle-adventure-plus": "mobile-ragnarok-idle-adventure-plus",
  "ragnarok-x": "mobile-ragnarok-x-next-generation",
  "rememento-white-shadow": "mobile-rememento-white-shadow",
  "saint-seiya-awakening": "mobile-saint-seiya-awakening",
  "silver-and-blood": "mobile-silver-and-blood",
  "snowbreak-containment-zone": "mobile-snowbreak-containment-zone",
  "stormshot": "mobile-stormshot",
  "super-sus": "mobile-super-sus",
  "sword-of-justice": "mobile-sword-of-justice",
  "the-ants": "mobile-the-ants-underground-kingdom",
  "undawn-non-bind-garena": "mobile-undawn-non-bind-garena",
  "valorant": "mobile-valorant",
  "where-winds-meet": "mobile-where-winds-meet",
  "wuthering-waves": "mobile-wuthering-waves",
  "ys-6-mobile": "mobile-ys-6-mobile",
};

// Build per-game fields array from UniPlay scrape
const rows = [];
for (const [uplSlug, ourSlug] of Object.entries(MAP)) {
  const page = scrape[uplSlug];
  if (!page) { console.error(`MISSING scrape for ${uplSlug}`); continue; }
  const uidInput = page.inputs.find(i => i.name === "user_id");
  const sidInput = page.inputs.find(i => i.name === "server_id");
  if (!uidInput) { console.error(`NO user_id for ${uplSlug} — skip`); continue; }
  const fields = [
    { key: "user_id", type: "text", label: uidInput.placeholder || "User ID", required: true, placeholder: `Masukkan ${uidInput.placeholder || "User ID"}` },
  ];
  if (sidInput) {
    fields.push({ key: "server_id", type: "text", label: sidInput.placeholder || "Server ID", required: true, placeholder: `Masukkan ${sidInput.placeholder || "Server ID"}` });
  }
  rows.push({ our: ourSlug, upl: uplSlug, fields });
}

// Output SQL
console.log("-- Batch update games.input_fields to match UniPlay actual form schema");
console.log("-- Generated from scrape of uniplay.id/game/<slug>");
console.log();
for (const r of rows) {
  const jsonStr = JSON.stringify(r.fields).replace(/'/g, "''"); // escape single quotes for PG
  console.log(`UPDATE games SET input_fields = '${jsonStr}'::jsonb WHERE slug = '${r.our}';`);
}
console.error(`\nGenerated ${rows.length} UPDATE statements.`);
