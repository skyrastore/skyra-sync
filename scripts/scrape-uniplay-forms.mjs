#!/usr/bin/env node
// Batch-scrape UniPlay game pages → extract input form schema.
// Output: JSON mapping { uniplay_slug: { game_name, inputs: [{name, placeholder, type}] } }

import fs from "node:fs/promises";

const SLUGS = ["ace-razer","afk-journey","age-of-magic","arena-of-valor","astral-guardians-cyber-fantasy","au2-mobile","be-the-king","bleach-mobile-3d","blood-strike","call-of-duty-id","city-of-crime-gang-wars","crystal-of-atlan","crystalfall","culinary-tour","dc-dark-legion","delta-force-mobile","destiny-rising","dragon-raja-sea","dragonheir-silent-gods","dynasty-warriors-overlords","echocalypse","eggy-party","ensemble-stars-music","era-of-celestials","fable-town","farlight-84","football-master-2","free-fire","free-fire-global","free-fire-max","ghost-pinball-tuyul-adventure","ghost-story-love-destiny","guns-of-glory","haikyu-fly-high","heaven-domain-rebirth","heroes-evolved","honkai-impact-3","honor-of-kings","identity-v","journey-renewed-fate-fantasy","king-of-avalon","kings-choice","league-of-legends-wild-rift","legacy-fate-sacred-and-fearless","legend-of-mushroom-rush","life-makeover","light-of-thel-new-era","lineage2m","lita","lokapala","love-and-deepspace","machina-waking","magic-chess-go-go","mangatoon","marvel-duel","marvel-rivals","melojam","misty-continent","mobile-legends","mobile-legends-global","mobile-legends-my","mobile-legends-ph","mobile-legends-russia","mobile-legends-th","mobile-legends-turkey","mobile-royale","moonlight-blade-m","mu-origin-2","mythic-dawn-13-megami","nba-infinite","one-punch-man-the-strongest","onmyoji-arena","path-to-nowhere","perfect-world","point-blank","pokemon-unite","pubg-mobile","pubg-mobile-global","pubg-mobile-lite","punishing-gray-raven","pure-sniper-gun-shooter-games","ragnarok-crush","ragnarok-idle-adventure-plus","ragnarok-x","rememento-white-shadow","saint-seiya-awakening","silver-and-blood","snowbreak-containment-zone","stormshot","super-sus","sword-of-justice","the-ants","undawn-non-bind-garena","valorant","where-winds-meet","wuthering-waves","ys-6-mobile"];

// Robust parser: extract all <input type="text" name="X" placeholder="Y" ...> with user_id/server_id/custom_*
// Also extract <select name="X">...options...</select> if present.
// Also page title + <h4> "MASUKKAN ..."
function extract(html) {
  const inputRe = /<input\b([^>]*?)\/?>/gi;
  const inputs = [];
  let m;
  while ((m = inputRe.exec(html))) {
    const attrs = m[1];
    const name = (attrs.match(/\bname=["']([^"']+)["']/) || [])[1];
    const placeholder = (attrs.match(/\bplaceholder=["']([^"']+)["']/) || [])[1];
    const type = (attrs.match(/\btype=["']([^"']+)["']/) || [])[1] || "text";
    if (!name) continue;
    if (/^(user_id|server_id|custom_|zone_|email|roblox_)/i.test(name)) {
      inputs.push({ name, placeholder: placeholder || null, type });
    }
  }
  // selects
  const selectRe = /<select\b([^>]*)>([\s\S]*?)<\/select>/gi;
  const selects = [];
  while ((m = selectRe.exec(html))) {
    const attrs = m[1]; const body = m[2];
    const name = (attrs.match(/\bname=["']([^"']+)["']/) || [])[1];
    if (!name || !/^(server_id|user_id|custom_|zone_)/i.test(name)) continue;
    const opts = [];
    const optRe = /<option[^>]*value=["']([^"']*)["'][^>]*>([^<]*)<\/option>/gi;
    let o;
    while ((o = optRe.exec(body))) {
      if (o[1]) opts.push({ value: o[1], label: o[2].trim() });
    }
    selects.push({ name, options: opts.slice(0, 50), type: "select" });
  }
  // h4 section labels
  const sectionRe = /<h4[^>]*>([^<]*(?:MASUKKAN|INPUT|ISI|ID|SERVER|USERNAME|EMAIL|AKUN|KODE)[^<]*)<\/h4>/gi;
  const sections = [];
  while ((m = sectionRe.exec(html))) sections.push(m[1].trim());
  const title = (html.match(/<title>([^<]+)<\/title>/) || [])[1]?.trim() || null;
  return { title, sections, inputs, selects };
}

async function main() {
  const results = {};
  const failed = [];
  for (let i = 0; i < SLUGS.length; i++) {
    const slug = SLUGS[i];
    const url = `https://uniplay.id/game/${slug}`;
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, redirect: "follow" });
      if (!res.ok) { failed.push({ slug, status: res.status }); continue; }
      const html = await res.text();
      results[slug] = extract(html);
      console.error(`[${i + 1}/${SLUGS.length}] ${slug}: ${results[slug].inputs.length} inputs`);
    } catch (e) {
      failed.push({ slug, error: e.message });
      console.error(`[${i + 1}/${SLUGS.length}] ${slug}: FAIL ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 180)); // polite throttle
  }
  console.log(JSON.stringify({ results, failed }, null, 2));
}
main();
