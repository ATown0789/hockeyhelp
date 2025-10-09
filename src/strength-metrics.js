// src/strength-metrics.js
//
// Strength-of-competition helpers for your fantasy starter app.
//
// How it works (simple & robust):
// 1) We compute each NHL team's average projected FP across *all* of their players
//    (skaters + goalies) using your current weights (points OR categories).
//    - Intuition: teams projected to produce *less* FP overall tend to be weaker
//      in aggregate (roster quality, scoring, results).
// 2) We min–max normalize and invert so that: higher = easier opponent to attack.
// 3) You can then add a small FP bump (e.g., up to +10%) when two players are close.
//
// Notes:
// - This is deliberately lightweight (no external data).
// - You can swap the "pool" that builds weakness if you want a role-specific view later:
//      • For skaters attacking: use only goalies.json (goalie quality proxy).
//      • For goalies starting: use only skaters.json (opponent firepower proxy).

import skaters from "./data/skaters.json";
import goalies from "./data/goalies.json";
import NHL_SCHEDULE from "./data/schedule";
import { computeFPFromRow } from "./fp-calc";

function normalizeTeam(t) {
  return String(t || "")
    .toUpperCase()
    .replace(/[^A-Z]/g, "");
}

/** Build raw average FP per team from a list of rows and a weight object. */
function averageTeamFP(rows, weights) {
  const acc = new Map(); // team -> { sum, n }
  for (const row of rows) {
    const team = normalizeTeam(row.Team || row.team || row.TEAM);
    if (!team) continue;
    const fp = computeFPFromRow(row, weights);
    if (!Number.isFinite(fp)) continue;

    const prev = acc.get(team) || { sum: 0, n: 0 };
    prev.sum += fp;
    prev.n += 1;
    acc.set(team, prev);
  }
  const out = {};
  for (const [team, { sum, n }] of acc.entries())
    out[team] = sum / Math.max(n, 1);
  return out;
}

/** Min–max normalize a numeric object to [0,1]. */
function normalize01(obj) {
  const vals = Object.values(obj).filter((v) => Number.isFinite(v));
  if (vals.length === 0) return {}; // ← early out
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const range = max - min || 1;
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = (v - min) / range;
  return out;
}

/**
 * Build an opponent weakness map.
 * By default we combine both skaters and goalies to keep it stable.
 * If you want role-specific (e.g., skater-only or goalie-only), pass options.
 */
export function buildOpponentWeaknessMap({
  skaterWeights,
  goalieWeights,
  useSkaters = true,
  useGoalies = true,
} = {}) {
  const parts = [];

  if (useSkaters && skaterWeights) {
    const teamAvgSk = averageTeamFP(skaters, skaterWeights); // team -> avg FP (offense proxy)
    parts.push(teamAvgSk);
  }

  if (useGoalies && goalieWeights) {
    const teamAvgGo = averageTeamFP(goalies, goalieWeights); // team -> avg FP (team/goalie quality proxy)
    parts.push(teamAvgGo);
  }

  // Merge parts by averaging the available components
  const allTeams = new Set(parts.flatMap((p) => Object.keys(p)));
  const merged = {};
  for (const t of allTeams) {
    let s = 0;
    let c = 0;
    for (const p of parts) {
      if (t in p && Number.isFinite(p[t])) {
        s += p[t];
        c += 1;
      }
    }
    merged[t] = c ? s / c : 0;
  }

  // Now normalize and invert: higher => easier opponent to attack
  // (Teams with *lower* average FP become *higher* weakness.)
  const norm = normalize01(merged);
  const weakness = {};
  for (const [team, v] of Object.entries(norm)) weakness[team] = 1 - v;

  return weakness; // e.g., { CHI: 0.98, SJ: 0.90, TB: 0.22, ... }
}

/** Find the opponent a given team faces on a date (YYYY-MM-DD). */
export function getOpponent(date, team) {
  const day = NHL_SCHEDULE[date];
  if (!day) return null;
  const T = normalizeTeam(team);
  for (const g of day.games || []) {
    const home = normalizeTeam(g.home);
    const away = normalizeTeam(g.away);
    if (g.home === T) return g.away;
    if (g.away === T) return g.home;
  }
  return null;
}

/**
 * Adjust a single FP by opponent weakness.
 * maxBoost controls the maximum %-boost at weakness=1.0 (default +10%).
 */
export function adjustFPForOpponent(
  baseFP,
  opponentTeam,
  weaknessMap,
  maxBoost = 0.125
) {
  const w = opponentTeam
    ? Number(weaknessMap?.[normalizeTeam(opponentTeam)]) || 0
    : 0;
  return Number(baseFP) * (1 + Math.max(0, Math.min(1, w)) * maxBoost);
}

/**
 * Convenience: returns a new roster array with `adjFP` per player for a date.
 * Expects roster items like { name, team, fp } (your parsed roster shape).
 */
export function adjustRosterFPForDate(
  roster,
  date,
  weaknessMap,
  maxBoost = 0.1
) {
  return roster.map((p) => {
    const opp = getOpponent(date, p.team);
    const adjFP = adjustFPForOpponent(p.fp ?? 0, opp, weaknessMap, maxBoost);
    return { ...p, opponent: opp, adjFP };
  });
}

/**
 * Tiebreak helper:
 * If two players are within `threshold` (e.g., 0.10 = 10%) on base FP,
 * prefer the one with higher adjusted FP (opponent weakness bump).
 */
export function pickBetweenClose(
  a,
  b,
  date,
  weaknessMap,
  { threshold = 0.1, maxBoost = 0.1 } = {}
) {
  const fpA = Number(a.fp ?? 0);
  const fpB = Number(b.fp ?? 0);
  const close = Math.abs(fpA - fpB) <= Math.max(fpA, fpB) * threshold;

  if (!close) {
    // not close—just take higher base FP
    return fpA >= fpB ? a : b;
  }

  const oppA = getOpponent(date, a.team);
  const oppB = getOpponent(date, b.team);
  const adjA = adjustFPForOpponent(fpA, oppA, weaknessMap, maxBoost);
  const adjB = adjustFPForOpponent(fpB, oppB, weaknessMap, maxBoost);
  return adjA >= adjB
    ? { ...a, opponent: oppA, adjFP: adjA }
    : { ...b, opponent: oppB, adjFP: adjB };
}
