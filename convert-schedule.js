// Usage: node convert-schedule.js "NHL Schedule.json" src/data/schedule.js
import fs from "fs";
import path from "path";

const TZ = "America/Chicago";

function toISO(d) {
  if (!d || typeof d !== "string") return "";
  const dt = new Date(d);
  return isNaN(dt.getTime()) ? "" : dt.toISOString();
}
function partsInTZ(iso, tz) {
  const dt = new Date(iso);
  const dateFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const timeFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  const parts = Object.fromEntries(
    dateFmt.formatToParts(dt).map((p) => [p.type, p.value])
  );
  return {
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    timeLabel: timeFmt.format(dt),
  };
}
function formatCT(iso) {
  if (!iso) return "";
  const { dateKey, timeLabel } = partsInTZ(iso, TZ);
  return `${dateKey} ${timeLabel} CT`; // App strips the date visually
}
function ctDateKey(iso, fallbackDate) {
  if (iso) return partsInTZ(iso, TZ).dateKey;
  return (fallbackDate || "").slice(0, 10);
}
function toAbbr(x) {
  if (!x) return "";
  if (typeof x === "string") return x.toUpperCase();
  if (typeof x === "object") {
    // Sportsradar commonly uses "alias" for tri-code
    for (const k of [
      "alias",
      "abbr",
      "abbreviation",
      "triCode",
      "code",
      "teamAbbrev",
    ]) {
      const v = x[k];
      if (typeof v === "string" && v.length >= 2 && v.length <= 5)
        return v.toUpperCase();
    }
    if (x.name && typeof x.name === "string") return x.name.toUpperCase();
  }
  return "";
}

// <— THE SIMPLE PART YOU ASKED FOR —>
// Just look at broadcasts[], grab each .network, dedupe, done.
function getNetworksFromBroadcasts(game) {
  const arr = Array.isArray(game.broadcasts) ? game.broadcasts : [];
  return [
    ...new Set(
      arr
        .map((b) => (b && b.network ? String(b.network).trim() : ""))
        .filter(Boolean)
    ),
  ];
}

function normalizeSchedule(input) {
  const out = {};

  const add = (dateKey, away, home, iso, broadcasters) => {
    if (!dateKey || !away || !home) return;
    out[dateKey] ||= { teams: new Set(), games: [] };
    out[dateKey].teams.add(away);
    out[dateKey].teams.add(home);
    out[dateKey].games.push({
      away,
      home,
      startUTC: iso || "",
      startCT: iso ? formatCT(iso) : "",
      broadcasters,
      label: `${away} @ ${home}`,
    });
  };

  const parseOne = (g, providedDate) => {
    // time
    const iso = toISO(g.scheduled || g.start || g.startTime || g.date);
    const dateKey = ctDateKey(iso, providedDate);

    // teams
    const home = toAbbr(g.home || g.homeTeam || g.teams?.home);
    const away = toAbbr(g.away || g.awayTeam || g.teams?.away);

    // networks (only from game.broadcasts[].network)
    const broadcasters = getNetworksFromBroadcasts(g);

    return { dateKey, away, home, iso, broadcasters };
  };

  // Sportsradar: { games: [...] }
  if (input && Array.isArray(input.games)) {
    for (const g of input.games) {
      // allow array form ["AWY","HOME"] (fallback)
      if (Array.isArray(g) && g.length === 2) {
        const [A, H] = g;
        add(
          ctDateKey("", ""),
          String(A).toUpperCase(),
          String(H).toUpperCase(),
          "",
          []
        );
        continue;
      }
      const { dateKey, away, home, iso, broadcasters } = parseOne(g);
      add(dateKey, away, home, iso, broadcasters);
    }
  }
  // { "YYYY-MM-DD": [...] }
  else if (input && typeof input === "object" && !Array.isArray(input)) {
    for (const [d, arr] of Object.entries(input)) {
      if (Array.isArray(arr)) {
        for (const g of arr) {
          if (Array.isArray(g) && g.length === 2) {
            const [A, H] = g;
            add(
              ctDateKey("", d),
              String(A).toUpperCase(),
              String(H).toUpperCase(),
              "",
              []
            );
          } else {
            const { dateKey, away, home, iso, broadcasters } = parseOne(g, d);
            add(dateKey, away, home, iso, broadcasters);
          }
        }
      } else if (arr && typeof arr === "object") {
        const { dateKey, away, home, iso, broadcasters } = parseOne(arr, d);
        add(dateKey, away, home, iso, broadcasters);
      }
    }
  }
  // flat array
  else if (Array.isArray(input)) {
    for (const g of input) {
      const { dateKey, away, home, iso, broadcasters } = parseOne(g);
      add(dateKey, away, home, iso, broadcasters);
    }
  } else {
    throw new Error("Unrecognized schedule JSON shape.");
  }

  // finalize
  const finalOut = {};
  for (const d of Object.keys(out).sort()) {
    finalOut[d] = { teams: [...out[d].teams].sort(), games: out[d].games };
  }
  return finalOut;
}

// ---- CLI ----
const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
  console.log(
    'Usage: node convert-schedule.js "NHL Schedule.json" src/data/schedule.js'
  );
  process.exit(1);
}
const raw = JSON.parse(fs.readFileSync(inPath, "utf-8"));
const normalized = normalizeSchedule(raw);

const banner = `// Auto-generated from ${path.basename(
  inPath
)}\n// Run: node convert-schedule.js "${path.basename(inPath)}" ${outPath}\n\n`;
const body = `const NHL_SCHEDULE = ${JSON.stringify(
  normalized,
  null,
  2
)};\nexport default NHL_SCHEDULE;\n`;
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, banner + body, "utf-8");

console.log(
  `✅ Created ${outPath} · ${
    Object.keys(normalized).length
  } dates · ${Object.values(normalized).reduce(
    (a, v) => a + v.games.length,
    0
  )} games.`
);
