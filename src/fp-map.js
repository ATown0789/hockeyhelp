import { useMemo } from "react";
import { useSettings } from "./settings";
import skaters from "./data/skaters.json";
import goalies from "./data/goalies.json";

/** ===== Excel parity knobs ===== */
const STD_MODE = "sample"; // or "population" for STDEV.P

/** ===== Stat semantics ===== */
// Goalies with “lower is better” in Categories:
const NEG_GOALIE = new Set(["GA", "GAA", "L"]);

const SKATER_ADJ = new Set([
  "G",
  "A",
  "PTS",
  "SOG",
  "PPG",
  "PPP",
  "+/-",
  "GWG",
]);
const GOALIE_ADJ = new Set(["W", "L", "SV", "GA", "SV%", "GAA"]);

// Stats that are rates. Never multiply these by ADJ directly.
const RATE_STATS = new Set(["SV%", "GAA", "FO%"]);

/** ===== Helpers ===== */
function keyName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function readProjectedGP(row) {
  const candidates = [
    "GP",
    "Gp",
    "gp",
    "GP_proj",
    "Projected GP",
    "GPProjected",
  ];
  for (const k of candidates) {
    if (k in row) {
      const v = Number(row[k]);
      if (Number.isFinite(v) && v > 0) return v;
    }
  }
  return NaN;
}

function effectiveGP(row, useProjectedGP) {
  if (useProjectedGP) {
    const gp = readProjectedGP(row);
    if (Number.isFinite(gp)) return gp;
  }
  return 82;
}

// --- precise & stable STDEV.S (Welford)
function stableStatsSample(vals) {
  let n = 0,
    mean = 0,
    M2 = 0;
  for (const x of vals) {
    n++;
    const delta = x - mean;
    mean += delta / n;
    M2 += delta * (x - mean);
  }
  const variance = n > 1 ? M2 / (n - 1) : 0;
  return { mean, sd: Math.sqrt(variance) };
}

// z-scored weighted sum helper (works for skaters & goalies)
function zSum(totals, keys, weights, tables, negSet) {
  let s = 0;
  for (const k of keys) {
    const w = Number(weights[k] ?? 0);
    if (!w) continue;

    const x = Number(totals[k]);
    if (!Number.isFinite(x)) continue;

    const mu = Number(tables.means[k] ?? 0);
    const sd = Number(tables.stds[k] ?? 0);
    const z = sd > 0 ? (x - mu) / sd : 0;

    s += w * (negSet && negSet.has(k) ? -z : z);
  }
  return s;
}

function buildZTablesFromTotals(totalsList, keys) {
  const means = {},
    stds = {};
  for (const k of keys) {
    const vals = totalsList.map((t) => t[k]).filter(Number.isFinite);
    const { mean, sd } = stableStatsSample(vals);
    means[k] = mean;
    stds[k] = sd || 0;
  }
  return { means, stds };
}

function adjFor(row) {
  const a = Number(row.ADJ);
  return Number.isFinite(a) && a > 0 ? a : 1;
}

// Apply ADJ to counting stats only; never to rate stats.
function applyAdj(row, stat, val) {
  if (!Number.isFinite(val)) return NaN;
  if (RATE_STATS.has(stat)) return val; // no direct ADJ to rates
  if (SKATER_ADJ.has(stat) || GOALIE_ADJ.has(stat)) return val * adjFor(row);
  return val;
}

// --- percentage normalizer (0..1)
function readPercent01(raw) {
  if (typeof raw === "string") {
    const s = raw.trim();
    if (s.endsWith("%")) {
      const n = Number(s.slice(0, -1));
      return Number.isFinite(n) ? n / 100 : NaN;
    }
    const n = Number(s);
    return Number.isFinite(n) ? (n > 1 ? n / 100 : n) : NaN;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? (n > 1 ? n / 100 : n) : NaN;
}

/** ---- Skaters helpers ---- */
const SKATER_ALIASES = {
  G: { keys: ["G"] },
  A: { keys: ["A"] },
  PTS: {
    derive: (r) => Number(r.PTS ?? (Number(r.G) || 0) + (Number(r.A) || 0)),
  },
  SOG: { keys: ["SOG", "S"] },
  PPG: { keys: ["PPG"] },
  PPP: {
    derive: (r) => Number(r.PPP ?? (Number(r.PPG) || 0) + (Number(r.PPA) || 0)),
  },
  "+/-": { keys: ["+/-", "PlusMinus", "PM"] },
  GWG: { keys: ["GWG"] },
  "FO%": { derive: (r) => readPercent01(r["FO%"]) },
  GP: { keys: ["GP"] },
};

function readSkaterPerGame(row, stat) {
  const a = SKATER_ALIASES[stat];
  if (!a) {
    const v = Number(row[stat]);
    return Number.isFinite(v) ? v : NaN;
  }
  if (a.derive) {
    const v = a.derive(row);
    return Number.isFinite(v) ? v : NaN;
  }
  if (a.keys) {
    for (const k of a.keys) {
      const v = Number(row[k]);
      if (Number.isFinite(v)) return v;
    }
  }
  return NaN;
}

// Build skater season total respecting baked totals and ADJ-on-counts
function skSeasonTotal(row, stat, gpEff) {
  // If a baked total exists, trust it and DO NOT re-ADJ.
  const baked = Number(row[`${stat}_total`]);
  if (Number.isFinite(baked)) return baked;

  // Percent stats pass through (rate); no ADJ directly.
  if (String(stat).includes("%")) return readPercent01(row[stat]);

  // Per-game → season total via effective GP, then ADJ for allowed stats.
  const vpg = readSkaterPerGame(row, stat);
  if (!Number.isFinite(vpg) || !Number.isFinite(gpEff)) return NaN;
  return applyAdj(row, stat, vpg * gpEff);
}

/** ---- Goalies helpers ---- */
const GOALIE_ALIASES = {
  W: { key: "W", rate: false },
  L: { key: "L", rate: false },
  OTL: { key: "OTL", rate: false },
  SO: { key: "SO", rate: false },
  SV: { key: "SV", rate: false },
  "SV%": { key: "SV%", rate: true },
  GA: { key: "GA", rate: false },
  GS: { key: "GP", rate: false }, // UI “GS” mapped to raw GP total
  GAA: { key: "GA", rate: true }, // GA/GP rate
};

// Read SV% robustly. Accept 0–1, 0–100, or "91.5%". Fallback: SV/(SV+GA).
function readSvPct(row) {
  let v = row["SV%"];
  if (typeof v === "string") {
    const s = v.trim();
    if (s.endsWith("%")) {
      const f = Number(s.slice(0, -1));
      return Number.isFinite(f) ? f / 100 : NaN;
    }
    const f = Number(s);
    if (Number.isFinite(f)) v = f;
    else return NaN;
  }
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return NaN;
    return v > 1 ? v / 100 : v;
  }
  const sv = Number(row.SV),
    ga = Number(row.GA);
  const denom = sv + ga;
  if (Number.isFinite(sv) && Number.isFinite(ga) && denom > 0)
    return sv / denom;
  return NaN;
}

/** ===== Hook ===== */
export function useFPMap() {
  const { settings } = useSettings();

  return useMemo(() => {
    const map = Object.create(null);
    const mode = settings.scoringMode;

    // =========================
    // POINTS
    // =========================
    if (mode === "points") {
      function pointsSeasonFP_Skaters(row, weights, gp) {
        let fp = 0;
        for (const stat in weights) {
          const w = Number(weights[stat]);
          if (!w) continue;

          if (stat === "GP") {
            if (Number.isFinite(gp)) fp += gp * w;
            continue;
          }

          const vpg_or_rate = readSkaterPerGame(row, stat);
          if (!Number.isFinite(vpg_or_rate)) continue;

          // Rates (FO%) are NOT ADJ’ed directly; counts are.
          const isRate = stat.includes("%");
          const base = isRate ? vpg_or_rate : vpg_or_rate * gp;
          fp += applyAdj(row, stat, base) * w;
        }
        return fp;
      }

      function pointsSeasonFP_Goalies(row, weights, gp) {
        let fp = 0;

        // Precompute adjusted counting totals once
        const svTot = applyAdj(
          row,
          "SV",
          Number.isFinite(Number(row.SV)) && Number.isFinite(gp)
            ? Number(row.SV) * gp
            : NaN
        );
        const gaTot = applyAdj(
          row,
          "GA",
          Number.isFinite(Number(row.GA)) && Number.isFinite(gp)
            ? Number(row.GA) * gp
            : NaN
        );

        for (const stat in weights) {
          const w = Number(weights[stat]);
          if (!w) continue;

          if (stat === "GP") {
            if (Number.isFinite(gp)) fp += gp * w;
            continue;
          }

          if (stat === "SV%") {
            // Rebuild rate from ADJ'ed counts (ADJ cancels here; keeps SV% sane)
            const denom =
              (Number.isFinite(svTot) ? svTot : 0) +
              (Number.isFinite(gaTot) ? gaTot : 0);
            if (denom > 0) fp += (svTot / denom) * w;
            continue;
          }
          if (stat === "GAA") {
            // GA total is ADJ'ed; divide by GP to get GAA
            if (Number.isFinite(gaTot) && Number.isFinite(gp) && gp > 0) {
              fp += (gaTot / gp) * w;
            }
            continue;
          }

          // Other goalie stats are counting: per-game × GP, then ADJ
          const vpg = Number(row[(GOALIE_ALIASES[stat] || { key: stat }).key]);
          if (!Number.isFinite(vpg)) continue;
          const total = applyAdj(row, stat, vpg * gp);
          if (Number.isFinite(total)) fp += total * w;
        }
        return fp;
      }

      // Skaters
      for (const row of skaters) {
        const gp = effectiveGP(row, settings.useProjectedGP);
        const fpSeason = pointsSeasonFP_Skaters(
          row,
          settings.skaterWeights,
          gp
        );
        const fpg = gp > 0 ? fpSeason / gp : null;
        map[keyName(row.Player || row.Name)] = {
          team: row.Team || row.TEAM || "",
          positions: String(row.Pos || row.POS || "")
            .split(/[\/,\s]+/)
            .filter(Boolean),
          fp: fpSeason,
          fpg,
          row,
        };
      }

      // Goalies
      for (const row of goalies) {
        const gp = effectiveGP(row, settings.useProjectedGP);
        const fpSeason = pointsSeasonFP_Goalies(
          row,
          settings.goalieWeights,
          gp
        );
        const fpg = gp > 0 ? fpSeason / gp : null;
        map[keyName(row.Player || row.Name)] = {
          team: row.Team || row.TEAM || "",
          positions: ["G"],
          fp: fpSeason,
          fpg,
          row,
        };
      }

      return map;
    }

    // =========================
    // CATEGORIES
    // =========================

    // Skaters: per-game × effective GP (82 or projected), % pass-through; ignore GP
    const skKeys = Object.keys(settings.skaterWeights).filter(
      (k) => (settings.skaterWeights[k] ?? 0) > 0
    );

    const skTotalsList = skaters.map((r) => {
      const gpEff = effectiveGP(r, settings.useProjectedGP);
      const o = {};
      for (const stat of skKeys) {
        if (stat === "GP") continue; // GP is not a skater category
        const t = skSeasonTotal(r, stat, gpEff); // ADJ on counts inside, no ADJ on rates
        if (Number.isFinite(t)) o[stat] = t;
      }
      return o;
    });

    const skTables = buildZTablesFromTotals(skTotalsList, skKeys);

    // Goalies: build from raw JSON
    const gKeysUI = Object.keys(settings.goalieWeights).filter(
      (k) => (settings.goalieWeights[k] ?? 0) > 0
    );

    const gRawList = goalies.map((r) => {
      const o = {};
      const gpRaw = Number(r.GP) || 0;

      // Build ADJ’ed counting totals once (per-game -> total -> ADJ)
      const svTot =
        Number.isFinite(Number(r.SV)) && gpRaw > 0
          ? applyAdj(r, "SV", Number(r.SV) * gpRaw)
          : NaN;
      const gaTot =
        Number.isFinite(Number(r.GA)) && gpRaw > 0
          ? applyAdj(r, "GA", Number(r.GA) * gpRaw)
          : NaN;

      // Copy counting stats requested by user
      if (gKeysUI.includes("SV") && Number.isFinite(svTot)) o.SV = svTot;
      if (gKeysUI.includes("GA") && Number.isFinite(gaTot)) o.GA = gaTot;

      if (gKeysUI.includes("W") && Number.isFinite(Number(r.W)) && gpRaw > 0)
        o.W = applyAdj(r, "W", Number(r.W) * gpRaw);
      if (gKeysUI.includes("L") && Number.isFinite(Number(r.L)) && gpRaw > 0)
        o.L = applyAdj(r, "L", Number(r.L) * gpRaw);
      if (
        gKeysUI.includes("OTL") &&
        Number.isFinite(Number(r.OTL)) &&
        gpRaw > 0
      )
        o.OTL = applyAdj(r, "OTL", Number(r.OTL) * gpRaw);
      if (gKeysUI.includes("SO") && Number.isFinite(Number(r.SO)) && gpRaw > 0)
        o.SO = applyAdj(r, "SO", Number(r.SO) * gpRaw);

      // GP/GS are season totals straight from GP; never ADJ.
      if (gKeysUI.includes("GP") && Number.isFinite(gpRaw)) o.GP = gpRaw;
      if (gKeysUI.includes("GS") && Number.isFinite(gpRaw)) o.GS = gpRaw;

      // Rebuild rates from ADJ'ed counts
      if (gKeysUI.includes("SV%")) {
        const denom =
          (Number.isFinite(svTot) ? svTot : 0) +
          (Number.isFinite(gaTot) ? gaTot : 0);
        if (denom > 0) o["SV%"] = svTot / denom; // ADJ cancels here
      }
      if (gKeysUI.includes("GAA")) {
        if (Number.isFinite(gaTot) && gpRaw > 0) o.GAA = gaTot / gpRaw;
      }

      return o;
    });

    const gTables = buildZTablesFromTotals(gRawList, gKeysUI);

    // Skater loop (z on season totals built above)
    for (let i = 0; i < skaters.length; i++) {
      const r = skaters[i];
      const gpEff = effectiveGP(r, settings.useProjectedGP); // only for FPG display
      const totals = skTotalsList[i];

      const fpSeason = zSum(totals, skKeys, settings.skaterWeights, skTables);
      const fpg = gpEff > 0 ? fpSeason / gpEff : null;

      map[keyName(r.Player || r.Name)] = {
        team: r.Team || r.TEAM || "",
        positions: String(r.Pos || r.POS || "")
          .split(/[\/,\s]+/)
          .filter(Boolean),
        fp: fpSeason,
        fpg,
        row: r,
      };
    }

    // Goalie loop (use NEG_GOALIE for L/GA/GAA flip)
    for (let i = 0; i < goalies.length; i++) {
      const r = goalies[i];
      const gpEff = effectiveGP(r, settings.useProjectedGP); // only for FPG display
      const totals = gRawList[i];

      const fpSeason = zSum(
        totals,
        gKeysUI,
        settings.goalieWeights,
        gTables,
        NEG_GOALIE
      );
      const fpg = gpEff > 0 ? fpSeason / gpEff : null;

      map[keyName(r.Player || r.Name)] = {
        team: r.Team || r.TEAM || "",
        positions: ["G"],
        fp: fpSeason,
        fpg,
        row: r,
      };
    }

    return map;
  }, [settings]);
}
