// convert-player.js (ESM, no rounding/truncation anywhere)
// usage:
//   node convert-player.js "skater-data.csv" "goalie-data.csv" src/data --coerce --pretty
//
// flags:
//   --coerce  -> parse numbers as JS numbers (Papa dynamicTyping) [optional]
//   --pretty  -> pretty-print JSON output                         [optional]

import fs from "node:fs";
import path from "node:path";
import Papa from "papaparse";

const args = process.argv.slice(2);
if (args.length < 3) {
  console.error(
    'Usage: node convert-player.js "<skaters.csv>" "<goalies.csv>" <outDir> [--coerce] [--pretty]'
  );
  process.exit(1);
}

const [skatersCsv, goaliesCsv, outDir, ...flags] = args;
const COERCE = flags.includes("--coerce");
const PRETTY = flags.includes("--pretty");

// ---------- header handling for sheets that have a "group title" row ----------
function pickHeaderIndex(lines) {
  const maxLook = Math.min(8, lines.length);
  let bestIdx = 0;
  let bestScore = -Infinity;

  for (let i = 0; i < maxLook; i++) {
    const line = lines[i] || "";
    const lc = line.toLowerCase();

    // tokens that strongly suggest a real header
    const hasPlayer = /(^|,)\s*(player|name)\s*(,|$)/i.test(line);
    const hasTeam = /(^|,)\s*team\s*(,|$)/i.test(line);
    const hasPos = /(^|,)\s*(pos|position)\s*(,|$)/i.test(line);
    const hasGP = /(^|,)\s*gp\s*(,|$)/i.test(line);

    // penalize lines that look like group titles (mostly empty + single label)
    const looksLikeGroup = /(player|skater|goalie)\s*stats/i.test(lc);

    // more non-empty cells is better
    const nonEmpty = line
      .split(",")
      .reduce((n, c) => n + (c.trim() ? 1 : 0), 0);

    const score =
      (hasPlayer ? 3 : 0) +
      (hasTeam ? 2 : 0) +
      (hasPos ? 1 : 0) +
      (hasGP ? 1 : 0) +
      nonEmpty * 0.1 +
      (looksLikeGroup ? -5 : 0);

    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  return bestIdx;
}

function normalizeCsv(text) {
  const withoutBOM = text.replace(/^\uFEFF/, "");
  const lines = withoutBOM.split(/\r?\n/);
  if (!lines.length) return withoutBOM;
  const headerIdx = pickHeaderIndex(lines);
  return lines.slice(headerIdx).join("\n");
}

// ---------- CSV -> rows (no rounding/truncation) ----------
function readCsv(filepath, { coerce = false } = {}) {
  const raw = fs.readFileSync(filepath, "utf8");
  const norm = normalizeCsv(raw);
  const parsed = Papa.parse(norm, {
    header: true,
    skipEmptyLines: "greedy",
    dynamicTyping: coerce, // ONLY parse as numbers/booleans if you pass --coerce
  });
  if (parsed.errors?.length) {
    console.warn(
      `Parse warnings in ${path.basename(filepath)}:`,
      parsed.errors.slice(0, 3)
    );
  }
  // filter fully empty rows (sometimes appear at end)
  const rows = (parsed.data || []).filter((row) =>
    Object.values(row).some(
      (v) => v !== null && v !== undefined && String(v).trim() !== ""
    )
  );
  // IMPORTANT: do NOT mutate numeric precision here.
  return rows;
}

// ---------- main ----------
fs.mkdirSync(outDir, { recursive: true });

const skaters = readCsv(skatersCsv, { coerce: COERCE });
const goalies = readCsv(goaliesCsv, { coerce: COERCE });

const sOut = path.join(outDir, "skaters.json");
const gOut = path.join(outDir, "goalies.json");

fs.writeFileSync(sOut, JSON.stringify(skaters, null, PRETTY ? 2 : 0));
fs.writeFileSync(gOut, JSON.stringify(goalies, null, PRETTY ? 2 : 0));

console.log(`Wrote:
  ${sOut}  (${skaters.length} rows)
  ${gOut}  (${goalies.length} rows)`);
