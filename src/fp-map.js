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

/** ===== Helpers ===== */
function keyName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function readProjectedGP(row) {
  // Try a few common keys (case/variant tolerant)
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
      if (Number.isFinite(v) && v > 0) return v; // allow decimals like 79.895
    }
  }
  return NaN;
}

function effectiveGP(row, useProjectedGP) {
  if (useProjectedGP) {
    const gp = readProjectedGP(row);
    if (Number.isFinite(gp)) return gp; // only fall back if missing/NaN
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

function adjFor(row) {
  const a = Number(row.ADJ);
  return Number.isFinite(a) && a > 0 ? a : 1;
}

function applyAdj(row, stat, val) {
  if (!Number.isFinite(val)) return NaN;
  // Only multiply the whitelisted stats
  if (SKATER_ADJ.has(stat) || GOALIE_ADJ.has(stat)) {
    return val * adjFor(row);
  }
  return val;
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

function skSeasonTotal(row, stat, gpEff) {
  // If Excel baked a total, apply ADJ and return
  const baked = Number(row[`${stat}_total`]);
  if (Number.isFinite(baked)) return applyAdj(row, stat, baked);

  // Percent stats pass through (then ADJ if stat is in SKATER_ADJ)
  if (String(stat).includes("%")) {
    const rate = readPercent01(row[stat]);
    return applyAdj(row, stat, rate);
  }

  // Per-game → season total via effective GP, then ADJ
  const vpg = readSkaterPerGame(row, stat);
  if (!Number.isFinite(vpg) || !Number.isFinite(gpEff)) return NaN;
  return applyAdj(row, stat, vpg * gpEff);
}

// Optional negSet for categories where lower is better (pass undefined for skaters)
function zSum(totals, keys, weights, tables, negSet) {
  let s = 0;
  for (const k of keys) {
    const w = Number(weights[k] ?? 0);
    if (!w) continue;

    const x = totals[k];
    if (!Number.isFinite(x)) continue;

    const mu = tables.means[k] ?? 0;
    const sd = tables.stds[k] ?? 0;
    const z = sd > 0 ? (x - mu) / sd : 0;

    const adj = negSet && negSet.has(k) ? -z : z;
    s += w * adj;
  }
  return s;
}

/** ===== Goalie helpers kept from your version (unchanged) ===== */
const GOALIE_ALIASES = {
  W: { key: "W", rate: false },
  L: { key: "L", rate: false },
  OTL: { key: "OTL", rate: false },
  SO: { key: "SO", rate: false },
  SV: { key: "SV", rate: false },
  "SV%": { key: "SV%", rate: true },
  GA: { key: "GA", rate: false },
  GS: { key: "GP", rate: false }, // UI “GS” mapped to raw GP total
  GAA: { key: "GA", rate: true }, // proxy rate via GA/GP behavior handled by z sign
};

// --- add near GOALIE_ALIASES ---
const SKATER_ALIASES = {
  G: { keys: ["G"] },
  A: { keys: ["A"] },
  // If PTS isn't in JSON, derive PTS = G + A (both per-game)
  PTS: {
    derive: (r) => Number(r.PTS ?? (Number(r.G) || 0) + (Number(r.A) || 0)),
  },
  // SOG sometimes appears as "S"
  SOG: { keys: ["SOG", "S"] },
  PPG: { keys: ["PPG"] },
  // If PPP missing, derive PPP = PPG + PPA (per-game)
  PPP: {
    derive: (r) => Number(r.PPP ?? (Number(r.PPG) || 0) + (Number(r.PPA) || 0)),
  },
  // +/- may be stored under alternate keys
  "+/-": { keys: ["+/-", "PlusMinus", "PM"] },
  GWG: { keys: ["GWG"] },
  // Normalize FO% to 0..1 (rate)
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

function readGoalieValue_Points(row, stat) {
  // Map UI -> JSON and handle rates
  if (stat === "SV%") return readSvPct(row); // rate 0..1
  if (stat === "GAA") return Number(row.GA); // treat GA/GP rate (your JSON has GA per-game)
  const alias = GOALIE_ALIASES[stat] || { key: stat };
  const v = Number(row[alias.key]);
  return Number.isFinite(v) ? v : NaN;
}

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
  // Fallback ratio
  const sv = Number(row.SV);
  const ga = Number(row.GA);
  const denom = sv + ga;
  if (Number.isFinite(sv) && Number.isFinite(ga) && denom > 0) {
    return sv / denom;
  }
  return NaN;
}

/** ===== Hook ===== */
export function useFPMap() {
  const { settings } = useSettings();
  if (typeof window !== "undefined") {
    window.gpDebug = (name) => {
      const r =
        skaters.find(
          (s) => (s.Player || s.Name || "").toLowerCase() === name.toLowerCase()
        ) ||
        goalies.find(
          (g) => (g.Player || g.Name || "").toLowerCase() === name.toLowerCase()
        );
      if (!r) return console.warn("Not found:", name);
      const proj = readProjectedGP(r);
      const eff = effectiveGP(r, settings.useProjectedGP);
      console.log({
        name: r.Player || r.Name,
        useProjectedGP: settings.useProjectedGP,
        projected_GP_from_row: proj,
        effective_GP_used: eff,
      });
    };
  }
  return useMemo(() => {
    const map = Object.create(null);
    const mode = settings.scoringMode;

    // =========================
    // POINTS (unchanged logic)
    // =========================
    if (mode === "points") {
      const RATE_SKATER = new Set(["FO%"]); // skater rates (no GP scaling)
      const RATE_GOALIE = new Set(["SV%", "GAA"]); // goalie rates (no GP scaling)

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

          const isRate = stat.includes("%"); // (FO% etc.)
          const base = isRate ? vpg_or_rate : vpg_or_rate * gp;
          fp += applyAdj(row, stat, base) * w;
        }
        return fp;
      }

      function pointsSeasonFP_Goalies(row, weights, gp) {
        let fp = 0;
        for (const stat in weights) {
          const w = Number(weights[stat]);
          if (!w) continue;
          if (stat === "GP") {
            if (Number.isFinite(gp)) fp += gp * w;
            continue;
          }

          // Map UI -> JSON; treat SV% and GAA as rates
          let raw =
            stat === "SV%"
              ? readSvPct(row)
              : stat === "GAA"
              ? Number(row.GA)
              : Number(row[(GOALIE_ALIASES[stat] || { key: stat }).key]);

          if (!Number.isFinite(raw)) continue;

          const isRate = stat === "SV%" || stat === "GAA";
          const base = isRate ? raw : raw * gp; // per-game × GP for counting
          fp += applyAdj(row, stat, base) * w;
        }
        return fp;
      }

      // Skaters (use projected GP when toggle is on; else 82)
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

    // --- SKATERS: per-game × effective GP (82 if not using projected);
    //              % stats normalized to 0..1 and NOT scaled; ignore GP
    // ---- Categories: skaters (per-game × effective GP; % pass-through); ignore GP
    const skKeys = Object.keys(settings.skaterWeights).filter(
      (k) => (settings.skaterWeights[k] ?? 0) > 0
    );

    const skTotalsList = skaters.map((r) => {
      const gpEff = effectiveGP(r, settings.useProjectedGP);
      const o = {};
      for (const stat of skKeys) {
        if (stat === "GP") continue; // never a skater category
        const t = skSeasonTotal(r, stat, gpEff); // ADJ applied inside
        if (Number.isFinite(t)) o[stat] = t;
      }
      return o;
    });

    const skTables = buildZTablesFromTotals(skTotalsList, skKeys);

    if (typeof window !== "undefined") {
      window.skCatDebug = (name) => {
        const i = skaters.findIndex(
          (r) =>
            (r.Player || r.Name || "").toLowerCase() ===
            String(name).toLowerCase()
        );
        if (i === -1) return console.warn("Skater not found:", name);

        const r = skaters[i];
        const useProj = !!settings.useProjectedGP; // <-- current toggle
        const gpEff = effectiveGP(r, useProj); // <-- same logic as production
        const totG = skSeasonTotal(r, "G", gpEff, true); // <-- applyAdj = true

        const mu = skTables.means.G ?? 0;
        const sd = skTables.stds.G ?? 0;
        const z = sd > 0 ? (totG - mu) / sd : 0;

        console.log({
          name: r.Player || r.Name,
          useProjectedGP: useProj,
          gpRaw: r.GP,
          gpEff,
          ADJ: r.ADJ,
          G_pg: r.G,
          G_total: totG,
          mean_G: mu,
          sd_G: sd,
          z,
          __ts: Date.now(), // helps confirm you’re seeing the latest function
        });
      };
    }

    // Optional parity probe for Goals:
    if (skKeys.includes("G")) {
      const mu = skTables.means.G ?? 0;
      const sd = skTables.stds.G ?? 0;
      const n = skTotalsList.reduce(
        (a, t) => a + (Number.isFinite(t.G) ? 1 : 0),
        0
      );
      console.log(
        `[Skaters:G] mean=${mu.toFixed(6)} sd=${sd.toFixed(6)} n=${n}`
      );
    }

    window.skCatDebug = (name) => {
      const i = skaters.findIndex(
        (r) => (r.Player || r.Name || "").toLowerCase() === name.toLowerCase()
      );
      if (i === -1) return console.warn("Skater not found");
      const r = skaters[i];
      const gp = effectiveGP(r, settings.useProjectedGP);
      const tot = skSeasonTotal(r, "G", gp, SKATER_ADJ.has("G")); // ← add 4th arg
      const mu = skTables.means.G ?? 0;
      const sd = skTables.stds.G ?? 0;
      const z = sd > 0 ? (tot - mu) / sd : 0;
      console.log({
        name: r.Player || r.Name,
        gp,
        ADJ: r.ADJ,
        G_pg: r.G,
        G_total: tot,
        mean_G: mu,
        sd_G: sd,
        z,
      });
    };

    // --- GOALIES: raw JSON with minimal normalization (as discussed)
    const gKeysUI = Object.keys(settings.goalieWeights).filter(
      (k) => (settings.goalieWeights[k] ?? 0) > 0
    );

    const gRawList = goalies.map((r) => {
      const o = {};
      const gpRaw = Number(r.GP) || 0;

      for (const uiStat of gKeysUI) {
        if (uiStat === "GP" || uiStat === "GS") {
          // never ADJ on GP/GS
          if (Number.isFinite(gpRaw)) o[uiStat] = gpRaw;
          continue;
        }

        if (uiStat === "SV%") {
          const svp = readSvPct(r); // 0..1
          if (Number.isFinite(svp)) o["SV%"] = applyAdj(r, "SV%", svp);
          continue;
        }

        if (uiStat === "GAA") {
          const gaa = Number(r.GA); // GA per game in your JSON
          if (Number.isFinite(gaa)) o["GAA"] = applyAdj(r, "GAA", gaa);
          continue;
        }

        // Counting stats assumed per-game → season total via raw GP, then ADJ
        const alias = GOALIE_ALIASES[uiStat] || { key: uiStat };
        let vpg = Number(r[alias.key]);
        if (!Number.isFinite(vpg)) continue;

        const total = gpRaw > 0 ? vpg * gpRaw : NaN;
        if (Number.isFinite(total)) o[uiStat] = applyAdj(r, uiStat, total);
      }

      return o;
    });

    const gTables = buildZTablesFromTotals(gRawList, gKeysUI);

    // --- Skater loop (z on season totals built above)
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

    // --- Goalie loop (use NEG_GOALIE for L/GA/GAA flip)
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
