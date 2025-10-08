// scripts/merge-adj-from-list.js  (ESM)
// Usage:
//   node scripts/merge-adj-from-list.js "data/The List-Table 1-1.csv" src/data --pretty
//
// Reads:  <outDir>/skaters.json, <outDir>/goalies.json
// Writes: <outDir>/skaters.json, <outDir>/goalies.json  (adds .ADJ as a MULTIPLIER)

import fs from "node:fs";
import path from "node:path";
import Papa from "papaparse";

// ------------------------- arg parsing -------------------------
const ARGS = process.argv.slice(2);
const FLAGS = ARGS.filter((a) => a.startsWith("--"));
const POSITIONALS = ARGS.filter((a) => !a.startsWith("--"));

if (POSITIONALS.length < 2) {
  console.error(
    'Usage: node scripts/merge-adj-from-list.js "<list.csv>" [<list2.csv> ...] <outDir> [--pretty]'
  );
  process.exit(1);
}

const PRETTY = FLAGS.includes("--pretty");
const outDir = POSITIONALS[POSITIONALS.length - 1];
const listCsvs = POSITIONALS.slice(0, -1);

const SKATERS_PATH = path.join(outDir, "skaters.json");
const GOALIES_PATH = path.join(outDir, "goalies.json");

// ------------------------- helpers -------------------------
function keyName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function normalizeHeader(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[^\w%]/g, "");
}
function pickKey(headers, wanted) {
  const H = headers.map((h) => ({ raw: h, n: normalizeHeader(h) }));

  if (wanted === "name") {
    for (const c of ["player", "name", "playername"]) {
      const hit = H.find((h) => h.n === c);
      if (hit) return hit.raw;
    }
    return H.find((h) => /player|name/.test(h.n))?.raw ?? null;
  }

  if (wanted === "adj") {
    let hit = H.find((h) => h.n === "adj");
    if (hit) return hit.raw;
    hit = H.find((h) => h.n.includes("adj")); // "adjustment", "adj%", etc.
    if (hit) return hit.raw;
    if (headers.length >= 16) return headers[15]; // fallback: Excel column P (0-based)
  }
  return null;
}

// detect delimiter
function detectDelimiter(sample) {
  const counts = {
    ",": (sample.match(/,/g) || []).length,
    ";": (sample.match(/;/g) || []).length,
    "\t": (sample.match(/\t/g) || []).length,
  };
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] || ",";
}

// if export has title lines above header, slice down to header-ish
function sliceToHeader(text) {
  const lines = text.split(/\r?\n/);
  let start = 0;
  for (let i = 0; i < Math.min(lines.length, 12); i++) {
    const L = lines[i].toLowerCase();
    if (/(^|,|\t)(player|name)(,|\t)/.test(L)) {
      start = i;
      break;
    }
  }
  return lines.slice(start).join("\n");
}

// parse ADJ cell -> multiplier
function adjToMultiplier(raw) {
  if (raw === null || raw === undefined) return 1.0;
  const s = String(raw).trim();
  if (!s) return 1.0;

  const map = {
    "+++": 1.2,
    "++": 1.1,
    "+": 1.05,
    "---": 0.8,
    "--": 0.9,
    "-": 0.95,
  };
  if (map[s] !== undefined) return map[s];

  // numeric fallbacks:
  //  - "5%" -> 1.05
  //  - 0.05 -> 1.05 (delta)
  //  - 1.05 -> 1.05 (already multiplier)
  const pctMatch = s.match(/^(-?\d+(?:\.\d+)?)\s*%$/);
  if (pctMatch) {
    const p = Number(pctMatch[1]);
    if (Number.isFinite(p)) return 1 + p / 100;
  }

  const num = Number(s);
  if (Number.isFinite(num)) {
    if (num >= 0.5 && num <= 1.5) return num; // likely already a multiplier
    if (Math.abs(num) < 1) return 1 + num; // treat as delta
    return num; // e.g., 2 = 2x
  }

  return 1.0;
}

function readCsvRows(file) {
  if (!fs.existsSync(file)) throw new Error(`CSV not found: ${file}`);
  const raw = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  const headered = sliceToHeader(raw);
  const delimiter = detectDelimiter(headered);
  const parsed = Papa.parse(headered, {
    header: true,
    skipEmptyLines: "greedy",
    dynamicTyping: true,
    delimiter,
  });
  if (parsed.errors?.length) {
    console.warn(`[parse] ${path.basename(file)} —`, parsed.errors.slice(0, 3));
  }
  const headers = parsed.meta?.fields || [];
  const rows = (parsed.data || []).filter((r) =>
    Object.values(r).some(
      (v) => v !== null && v !== undefined && String(v).trim() !== ""
    )
  );
  return { headers, rows, delimiter };
}

function buildAdjMap(csvFiles) {
  const adjMap = new Map(); // normalized player name -> multiplier
  for (const file of csvFiles) {
    const { headers, rows, delimiter } = readCsvRows(file);
    const nameKey = pickKey(headers, "name");
    const adjKey = pickKey(headers, "adj");
    console.log(
      `[load] ${path.basename(file)} | delim=${JSON.stringify(
        delimiter
      )} | nameKey=${JSON.stringify(nameKey)} | adjKey=${JSON.stringify(
        adjKey
      )}`
    );
    if (!nameKey || !adjKey) {
      console.warn(
        `⚠️  ${path.basename(file)}: missing ${!nameKey ? "Player/Name" : ""}${
          !nameKey && !adjKey ? " and " : ""
        }${!adjKey ? "ADJ" : ""} headers`
      );
      continue;
    }
    let added = 0;
    for (const r of rows) {
      const nm = r[nameKey];
      const adjRaw = r[adjKey];
      if (nm == null || String(nm).trim() === "") continue;
      const k = keyName(nm);
      const mult = adjToMultiplier(adjRaw);
      adjMap.set(k, mult);
      added++;
    }
    console.log(`  → added ${added} ADJ entries`);
  }
  console.log(`[adjMap] total unique players with ADJ: ${adjMap.size}`);
  return adjMap;
}

function loadJson(file) {
  if (!fs.existsSync(file)) throw new Error(`JSON not found: ${file}`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, PRETTY ? 2 : 0));
}

function mergeAdjInto(players, adjMap) {
  let matched = 0,
    missing = 0;
  for (const row of players) {
    const nm = row.Player ?? row.Name ?? row.player ?? row.name;
    const k = keyName(nm);
    const mult = adjMap.get(k);
    if (mult !== undefined) {
      row.ADJ = mult;
      matched++;
    } else {
      row.ADJ ??= 1.0;
      missing++;
    }
  }
  return { matched, missing, total: players.length };
}

// ------------------------- main -------------------------
(async function main() {
  try {
    console.log(`[args] csvs=${JSON.stringify(listCsvs)}  outDir=${outDir}`);
    const adjMap = buildAdjMap(listCsvs);
    if (adjMap.size === 0) {
      console.error(
        "No ADJ values found. Ensure your CSV has 'Player'/'Name' and 'ADJ' (or ADJ is column P)."
      );
      process.exit(1);
    }

    const skaters = loadJson(SKATERS_PATH);
    const goalies = loadJson(GOALIES_PATH);

    const resS = mergeAdjInto(skaters, adjMap);
    const resG = mergeAdjInto(goalies, adjMap);

    writeJson(SKATERS_PATH, skaters);
    writeJson(GOALIES_PATH, goalies);

    console.log(`Merged ADJ as multipliers:`);
    console.log(
      `  Skaters: matched ${resS.matched}/${resS.total} (others left at 1.00)`
    );
    console.log(
      `  Goalies: matched ${resG.matched}/${resG.total} (others left at 1.00)`
    );
  } catch (err) {
    console.error(`[fatal] ${err?.message || err}`);
    console.error(err?.stack || "");
    process.exit(1);
  }
})();
