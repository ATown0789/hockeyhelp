// src/settings.js
import React, { createContext, useContext, useMemo, useState } from "react";

/** ===== Defaults from your screenshot ===== **/

// POINTS scoring (numbers are points per stat)
export const DEFAULT_SKATER_POINTS = {
  G: 3,
  A: 3,
  PTS: 0,
  SOG: 0.5,
  BLK: 0.5,
  HIT: 0,
  PPG: 0,
  PPP: 1,
  SHG: 0,
  SHP: 1,
  TOI: 0,
  "+/-": 0,
  PIM: 0,
  GWG: 0,
  FOW: 0,
  FOL: 0,
  "FO%": 0,
};
export const DEFAULT_GOALIE_POINTS = {
  W: 3,
  L: 0,
  OTL: 0,
  SO: 1,
  SV: 0.5,
  "SV%": 0,
  GA: -3,
  GAA: 0,
  GS: 0,
};

// CATEGORIES scoring (0–1 weights; 1 = include equally)
export const DEFAULT_SKATER_CATS = {
  G: 1,
  A: 1,
  PTS: 0,
  SOG: 1,
  BLK: 1,
  HIT: 0,
  PPG: 0,
  PPP: 1,
  SHG: 0,
  SHP: 1,
  TOI: 0,
  "+/-": 1,
  PIM: 1,
  GWG: 0,
  FOW: 0,
  FOL: 0,
  "FO%": 0,
};
export const DEFAULT_GOALIE_CATS = {
  W: 1,
  L: 0,
  OTL: 0,
  SO: 0,
  SV: 0,
  "SV%": 1,
  GA: 0,
  GAA: 1,
  GS: 0,
};

/** ===== Provider with migration ===== **/

const defaultSettings = {
  scoringMode: "points", // "points" | "categories"
  skaterWeights: { ...DEFAULT_SKATER_POINTS },
  goalieWeights: { ...DEFAULT_GOALIE_POINTS },
  useProjectedGP: true, // FP/GP uses projected GP; off = 82
  forwardSeparation: true,
  teamsInLeague: 12,
};

function migrateSettings(raw) {
  if (!raw || typeof raw !== "object") return defaultSettings;

  const mode = raw.scoringMode === "categories" ? "categories" : "points";

  // Support very old shape { weights: {...} }
  const legacySkater =
    raw.weights && typeof raw.weights === "object" ? raw.weights : {};

  // Choose a base by mode, then layer user values
  const baseSkater =
    mode === "categories" ? DEFAULT_SKATER_CATS : DEFAULT_SKATER_POINTS;
  const baseGoalie =
    mode === "categories" ? DEFAULT_GOALIE_CATS : DEFAULT_GOALIE_POINTS;

  const skaterWeights = {
    ...baseSkater,
    ...(raw.skaterWeights || legacySkater || {}),
  };
  const goalieWeights = { ...baseGoalie, ...(raw.goalieWeights || {}) };

  return {
    ...defaultSettings,
    ...raw,
    scoringMode: mode,
    skaterWeights,
    goalieWeights,
  };
}

const Ctx = createContext({ settings: defaultSettings, setSettings: () => {} });

export function SettingsProvider({ children }) {
  const [settings, setSettings] = useState(() => {
    try {
      const saved = localStorage.getItem("fp-settings");
      return migrateSettings(saved ? JSON.parse(saved) : null);
    } catch {
      return defaultSettings;
    }
  });

  const value = useMemo(
    () => ({
      settings,
      setSettings: (next) => {
        const normalized = migrateSettings(next);
        try {
          localStorage.setItem("fp-settings", JSON.stringify(normalized));
        } catch {}
        setSettings(normalized);
      },
    }),
    [settings]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSettings() {
  return useContext(Ctx);
}
