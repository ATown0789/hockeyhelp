// fp-calc.js
export function computeFPFromRow(row, weights) {
  let fp = 0;
  for (const stat in weights) {
    if (Object.prototype.hasOwnProperty.call(row, stat)) {
      const v = Number(row[stat]);
      const w = Number(weights[stat]);
      if (!Number.isNaN(v) && !Number.isNaN(w)) fp += v * w;
    }
  }
  return fp;
}

// Helper: decide which GP to use for FP/GP
function getEffectiveGP(row, settings, gpField = "GP") {
  const projectedGP = Number(row[gpField]);
  if (settings?.useProjectedGP && projectedGP > 0) return projectedGP;
  return 82; // fallback when not using projections (or missing GP)
}

// Build display object with FP and FP/GP (FP stays totals; FP/GP uses effective GP)
export function buildPlayerDisplay(
  row,
  {
    weights,
    settings,
    gpField = "GP",
    nameField = "Name",
    teamField = "Team",
    posField = "POS",
  } = {}
) {
  const FP = computeFPFromRow(row, weights);
  const GP = getEffectiveGP(row, settings, gpField);
  const FPperGP = GP > 0 ? FP / GP : null;

  const POS = (row[posField] ?? "").toString().replace(/[ ,]+/g, "/");
  const TEAM = row[teamField] ?? row.Team ?? row.TEAM ?? "";
  const Name = row[nameField] ?? row.Player ?? row.PlayerName ?? "";

  return {
    Name,
    TEAM,
    POS,
    FP: FP,
    FPperGP: FPperGP == null ? null : FPperGP,
    GP, // expose the effective GP we used (handy to show in UI if you want)
    _row: row,
  };
}
