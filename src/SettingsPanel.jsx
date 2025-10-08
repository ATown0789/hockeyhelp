// src/SettingsPanel.jsx
import React from "react";
import {
  useSettings,
  DEFAULT_SKATER_POINTS,
  DEFAULT_GOALIE_POINTS,
  DEFAULT_SKATER_CATS,
  DEFAULT_GOALIE_CATS,
} from "./settings";

const SKATER_KEYS = [
  "G",
  "A",
  "PTS",
  "SOG",
  "BLK",
  "HIT",
  "PPG",
  "PPP",
  "SHG",
  "SHP",
  "TOI",
  "+/-",
  "PIM",
  "GWG",
  "FOW",
  "FOL",
  "FO%",
];
const GOALIE_KEYS = ["W", "L", "OTL", "SO", "SV", "SV%", "GA", "GAA", "GS"];

export default function SettingsPanel() {
  const { settings, setSettings } = useSettings();
  const isPoints = settings.scoringMode === "points";

  const sk = settings.skaterWeights || {};
  const go = settings.goalieWeights || {};

  // Update handlers
  const updateSkater = (k, val) =>
    setSettings({
      ...settings,
      skaterWeights: { ...sk, [k]: Number(val) || 0 },
    });

  const updateGoalie = (k, val) =>
    setSettings({
      ...settings,
      goalieWeights: { ...go, [k]: Number(val) || 0 },
    });

  // Switch modes & load that mode's defaults
  const changeMode = (mode) => {
    const next =
      mode === "categories"
        ? {
            skaterWeights: { ...DEFAULT_SKATER_CATS },
            goalieWeights: { ...DEFAULT_GOALIE_CATS },
          }
        : {
            skaterWeights: { ...DEFAULT_SKATER_POINTS },
            goalieWeights: { ...DEFAULT_GOALIE_POINTS },
          };

    setSettings({ ...settings, scoringMode: mode, ...next });
  };

  return (
    <div style={{ padding: 16, display: "grid", gap: 16 }}>
      <h2 style={{ margin: 0 }}>Settings</h2>

      {/* Scoring mode */}
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <label style={{ fontWeight: 600 }}>Scoring Mode:</label>
        <select
          value={settings.scoringMode}
          onChange={(e) => changeMode(e.target.value)}
        >
          <option value="points">Points Scoring</option>
          <option value="categories">Category Scoring (0–1 weights)</option>
        </select>
      </div>

      <div className="small" style={{ marginTop: -8 }}>
        {isPoints
          ? "Points mode: enter points per stat (can be decimals/negative)."
          : "Categories mode: enter a weight 0–1 for each category. Tip: use 1 for equal weighting across all selected categories."}
      </div>

      {/* GP rule */}
      <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input
          type="checkbox"
          checked={!!settings.useProjectedGP}
          onChange={(e) =>
            setSettings({ ...settings, useProjectedGP: e.target.checked })
          }
        />
        Projected Games Played (uncheck to set all to 82 projected games played)
      </label>

      {/* Skater weights */}
      <fieldset
        style={{ border: "1px solid #444", borderRadius: 8, padding: 12 }}
      >
        <legend>
          Skater {isPoints ? "Points" : "Category"}{" "}
          {isPoints ? "Weights" : "Weights (0–1)"}
        </legend>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, minmax(160px, 1fr))",
            gap: 8,
          }}
        >
          {SKATER_KEYS.map((k) => (
            <label
              key={k}
              style={{ display: "flex", alignItems: "center", gap: 8 }}
            >
              <span style={{ width: 64 }}>{k}</span>
              <input
                type="number"
                step="0.1"
                min={isPoints ? undefined : 0}
                max={isPoints ? undefined : 1}
                value={sk[k] ?? 0}
                onChange={(e) => updateSkater(k, e.target.value)}
                style={{ width: 100 }}
              />
            </label>
          ))}
        </div>
      </fieldset>

      {/* Goalie weights */}
      <fieldset
        style={{ border: "1px solid #444", borderRadius: 8, padding: 12 }}
      >
        <legend>
          Goalie {isPoints ? "Points" : "Category"}{" "}
          {isPoints ? "Weights" : "Weights (0–1)"}
        </legend>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, minmax(160px, 1fr))",
            gap: 8,
          }}
        >
          {GOALIE_KEYS.map((k) => (
            <label
              key={k}
              style={{ display: "flex", alignItems: "center", gap: 8 }}
            >
              <span style={{ width: 64 }}>{k}</span>
              <input
                type="number"
                step="0.1"
                min={isPoints ? undefined : 0}
                max={isPoints ? undefined : 1}
                value={go[k] ?? 0}
                onChange={(e) => updateGoalie(k, e.target.value)}
                style={{ width: 100 }}
              />
            </label>
          ))}
        </div>
      </fieldset>
    </div>
  );
}
