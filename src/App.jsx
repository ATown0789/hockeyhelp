import React, { useEffect, useMemo, useState } from "react";

/* ===== Data & Hooks ===== */
import NHL_SCHEDULE from "./data/schedule";
import { useFPMap } from "./fp-map";
import { useSettings } from "./settings";

/* ===== UI Components ===== */
import SettingsPanel from "./SettingsPanel";
import GameStrip from "./GameStrip";

/* ===== Opponent Strength ===== */
import {
  buildOpponentWeaknessMap,
  getOpponent,
  adjustFPForOpponent,
} from "./strength-metrics";

/* ===== Constants ===== */
const DEFAULT_SLOTS = { C: 2, LW: 2, RW: 2, D: 4, G: 2, UTIL: 2 };
const SLOT_KEYS = ["C", "LW", "RW", "D", "UTIL", "G"];

/* =============================================================================
   Helpers
============================================================================= */
function keyName(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Returns "YYYY-MM-DD" in America/Chicago
function todayKeyCT() {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  // en-CA gives YYYY-MM-DD
  return fmt.format(new Date());
}

function normalizeTeam(t) {
  return String(t || "")
    .toUpperCase()
    .replace(/[^A-Z]/g, "");
}

function teamsPlayingOn(date) {
  return new Set(
    (NHL_SCHEDULE[date]?.teams ?? []).map((t) => normalizeTeam(t))
  );
}

function parseRosterText(text, FP_MAP) {
  const lines = String(text)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  return lines.map((line) => {
    const p = line.split(",").map((s) => s.trim());
    const name = p[0] || "";
    const fp = FP_MAP[keyName(name)];
    const team = normalizeTeam(p[1] || fp?.team || "");
    const posStr = p[2] || (fp?.positions ?? []).join("/");
    return {
      raw: line,
      name,
      team,
      positions: posStr.split(/[\/|,\s]+/).filter(Boolean),
      fp: fp?.fp ?? 0,
    };
  });
}

function pretty(n) {
  if (n == null || Number.isNaN(Number(n))) return "0.0";
  return Number(n).toLocaleString(undefined, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
}

/* --- Games strip helpers --- */
function timeOnlyCT(startCT) {
  // startCT looks like: "YYYY-MM-DD 7:00 PM CT"
  if (!startCT) return "";
  const parts = String(startCT).split(" ");
  return parts.length >= 4 ? parts.slice(1).join(" ") : startCT;
}

function onlyNetworkNames(list) {
  // Strip qualifiers like (National), (Home), HD, etc.
  const rm =
    /\b(home|away|national|regional|internet|web|stream|radio|intl)\b/i;
  return [
    ...new Set(
      (list || [])
        .map(String)
        .map((s) =>
          s
            .replace(
              /\((?:home|away|national|regional|internet|web|stream|radio|intl)\)/gi,
              ""
            )
            .replace(
              /\s*-\s*(home|away|national|regional|internet|web|stream|radio|intl)\b/gi,
              ""
            )
            .replace(/\bHD\b/gi, "")
            .replace(/\s{2,}/g, " ")
            .trim()
        )
        .filter((s) => s && !rm.test(s))
    ),
  ];
}

/* =============================================================================
   Core: optimize starters (now opponent-aware)
============================================================================= */
function canPlaySlot(p, slot) {
  if (slot === "G") return p.positions.includes("G");
  if (slot === "UTIL") return !p.positions.includes("G");
  return p.positions.includes(slot);
}

function listSlots(slots) {
  const arr = [];
  for (const k of ["C", "LW", "RW", "D", "G", "UTIL"]) {
    for (let i = 0; i < slots[k]; i++) arr.push(k);
  }
  return arr;
}

function lowestInSlot(starters, slot) {
  const list = starters[slot];
  if (!list?.length) return null;
  let idx = 0;
  let min = list[0].adjFP ?? list[0].fp ?? -Infinity;
  for (let i = 1; i < list.length; i++) {
    const v = list[i].adjFP ?? list[i].fp ?? -Infinity;
    if (v < min) {
      min = v;
      idx = i;
    }
  }
  return { idx, player: list[idx], val: min };
}

/** Try to place `benchP` by possibly bumping a weaker starter and
 *  recursively relocating the bumped player into another eligible slot.
 *  Depth-limited DFS so it stays fast & safe in the browser.
 */

function tryPromote(benchP, starters, slots, depth = 0, maxDepth = 6) {
  // Consider all slots benchP can play (UTIL counts if skater)
  const eligSlots = Object.keys(slots).filter((s) => canPlaySlot(benchP, s));

  for (const s of eligSlots) {
    const cap = slots[s];
    const list = starters[s];

    // 1) If there's room, just put them in.
    if (list.length < cap) {
      list.push(benchP);
      return true;
    }

    // 2) Otherwise, see if they beat the weakest in that slot.
    const weakest = lowestInSlot(starters, s);
    const benchVal = benchP.adjFP ?? benchP.fp ?? -Infinity;

    // 2.5) Two-hop improvement even if benchVal <= weakest.val
    if (weakest) {
      const bumped = weakest.player;
      const bumpedVal = bumped.adjFP ?? bumped.fp ?? -Infinity;

      // Where else can the bumped player go?
      const rehomeSlots = Object.keys(slots).filter(
        (t) => t !== s && canPlaySlot(bumped, t)
      );

      for (const t of rehomeSlots) {
        const listT = starters[t];
        const capT = slots[t];

        // If t has room, we'd have placed earlier; skip
        if (listT.length < capT) continue;

        const weakestT = lowestInSlot(starters, t);
        if (!weakestT) continue;

        // Net gain if we (a) put benchP into s and (b) move bumped into t, replacing weakestT
        const gain = benchVal - weakest.val + (bumpedVal - weakestT.val);

        if (gain > 0) {
          // Apply the two-hop swap
          list.splice(weakest.idx, 1, benchP); // benchP into s
          listT.splice(weakestT.idx, 1, bumped); // bumped into t (kicks weakestT)
          return true;
        }
      }
    }

    if (weakest && benchVal > weakest.val) {
      const bumped = weakest.player;

      // Tentatively replace
      list.splice(weakest.idx, 1, benchP);

      if (depth >= maxDepth) {
        // no more room to shuffle → revert and skip
        list.splice(weakest.idx, 1, bumped);
      } else {
        // Try to re-home the bumped player in some other slot (including UTIL if allowed)
        const otherSlots = Object.keys(slots).filter(
          (t) => t !== s && canPlaySlot(bumped, t)
        );

        for (const t of otherSlots) {
          const capT = slots[t];
          const listT = starters[t];

          // (a) if room → done
          if (listT.length < capT) {
            listT.push(bumped);
            return true;
          }

          // (b) recursive bumping
          const weakestT = lowestInSlot(starters, t);
          const bumpedVal = bumped.adjFP ?? bumped.fp ?? -Infinity;

          if (weakestT && bumpedVal > weakestT.val) {
            const bumped2 = weakestT.player;
            listT.splice(weakestT.idx, 1, bumped);

            // recursively try to place bumped2
            if (tryPromote(bumped2, starters, slots, depth + 1, maxDepth)) {
              return true;
            }

            // revert if that didn’t pan out
            listT.splice(weakestT.idx, 1, weakestT.player);
          }
        }

        // Couldn’t re-home bumped → revert original replacement
        list.splice(weakest.idx, 1, bumped);
      }
    }
  }

  return false;
}

function optimizeStarters(date, roster, slots, weaknessMap, maxBoost = 0.1) {
  const playingTeams = teamsPlayingOn(date);
  const rawPlaying = roster.filter((p) => p.team && playingTeams.has(p.team));
  const notPlaying = roster.filter((p) => !p.team || !playingTeams.has(p.team));

  // Enrich with opponent + adj
  const playing = rawPlaying.map((p) => {
    const opponent = getOpponent(date, p.team);
    const adjFP = adjustFPForOpponent(
      p.fp ?? 0,
      opponent,
      weaknessMap,
      maxBoost
    );
    return { ...p, opponent, adjFP };
  });

  const used = new Set();
  const starters = { C: [], LW: [], RW: [], D: [], G: [], UTIL: [] };

  // 1) Global best-first fill
  const sorted = [...playing].sort(
    (a, b) => (b.adjFP ?? b.fp) - (a.adjFP ?? a.fp)
  );
  for (const p of sorted) {
    // main slots first
    let placed = false;
    for (const pos of ["C", "LW", "RW", "D", "G"]) {
      if (!canPlaySlot(p, pos)) continue;
      if (starters[pos].length < slots[pos]) {
        starters[pos].push(p);
        used.add(p.name);
        placed = true;
        break;
      }
    }
    if (
      !placed &&
      canPlaySlot(p, "UTIL") &&
      starters.UTIL.length < slots.UTIL
    ) {
      starters.UTIL.push(p);
      used.add(p.name);
    }
  }

  // 2) Try to promote strong bench guys via short swap chains
  const bench = playing
    .filter((p) => !used.has(p.name))
    .sort((a, b) => (b.adjFP ?? b.fp) - (a.adjFP ?? a.fp));

  for (const b of bench) {
    if (tryPromote(b, starters, slots, 0, 3)) {
      used.add(b.name);
    }
  }

  // Rebuild bench after promotions
  const benchFinal = playing
    .filter((p) => !Object.values(starters).some((arr) => arr.includes(p)))
    .sort((a, b) => (b.adjFP ?? b.fp) - (a.adjFP ?? a.fp));

  return { starters, bench: benchFinal, notPlaying };
}

/* =============================================================================
   Component
============================================================================= */
export default function App() {
  const FP_MAP = useFPMap();
  const { settings } = useSettings();

  /* --- Date state --- */
  const dateKeys = Object.keys(NHL_SCHEDULE).sort();
  const today = todayKeyCT();

  const exactIdx = dateKeys.findIndex((k) => k === today);
  const nextIdx = dateKeys.findIndex((k) => k >= today);
  const initialIndex =
    exactIdx !== -1
      ? exactIdx
      : nextIdx !== -1
      ? nextIdx
      : Math.max(0, dateKeys.length - 1);

  const [dateIndex, setDateIndex] = useState(initialIndex);
  const date = dateKeys[dateIndex] ?? dateKeys[0] ?? "2025-10-07";

  /* --- UI state --- */
  const [showSettings, setShowSettings] = useState(false);
  const [useOpponentWeakness, setUseOpponentWeakness] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem("useOpponentWeakness") ?? "true");
    } catch {
      return true;
    }
  });

  /* --- Slot config --- */
  const [slots, setSlots] = useState(() => {
    try {
      const saved = localStorage.getItem("slot-config");
      return saved ? JSON.parse(saved) : DEFAULT_SLOTS;
    } catch {
      return DEFAULT_SLOTS;
    }
  });

  const bump = (k, d) => {
    const limits = { D: 8, G: 3, default: 4 };
    const max = k in limits ? limits[k] : limits.default;
    const v = Math.max(0, Math.min(max, (slots[k] ?? 0) + d));
    const next = { ...slots, [k]: v };
    setSlots(next);
    try {
      localStorage.setItem("slot-config", JSON.stringify(next));
    } catch {}
  };

  /* --- Roster --- */
  const BUILT_IN_ROSTER = [
    "Brayden Point,TBL,C",
    "Jack Hughes,NJ,C/LW",
    "Carter Verhaeghe,FLA,LW",
    "Andrei Svechnikov,CAR,LW/RW",
    "David Pastrnak,BOS,RW",
    "Mika Zibanejad,NYR,C/RW",
    "Moritz Seider,DET,D",
    "Rasmus Dahlin,BUF,D",
    "Adam Fox,NYR,D",
    "Darnell Nurse,EDM,D",
    "Nazem Kadri,CGY,C",
    "Alexis Lafreniere,NYR,LW/RW",
    "Alex DeBrincat,DET,LW/RW",
    "Aaron Ekblad,FLA,D",
    "Dylan Cozens,BUF,C",
    "Nikita Zadorov,BOS,D",
    "Jeremy Lauzon,VGK,D",
    "Dustin Wolf,CGY,G",
    "Stuart Skinner,EDM,G",
    "Linus Ullmark,OTT,G",
  ].join("\n");

  const [rosterText, setRosterText] = useState(() => {
    try {
      return localStorage.getItem("userRoster") || BUILT_IN_ROSTER;
    } catch {
      return BUILT_IN_ROSTER;
    }
  });

  // Persist roster automatically
  useEffect(() => {
    try {
      localStorage.setItem("userRoster", rosterText);
    } catch {}
  }, [rosterText]);

  /* --- Opponent weakness map (rebuilds if user changes weights) --- */
  const WEAKNESS = useMemo(
    () =>
      buildOpponentWeaknessMap({
        skaterWeights: settings.skaterWeights,
        goalieWeights: settings.goalieWeights,
        useSkaters: true,
        useGoalies: true,
      }),
    [settings.skaterWeights, settings.goalieWeights]
  );

  // --- TEMP DEBUG: Log opponent difficulty table in console ---
  useEffect(() => {
    if (!WEAKNESS) return;
    const sorted = Object.entries(WEAKNESS)
      .sort((a, b) => b[1] - a[1])
      .map(([team, val], i) => ({
        Team: team,
        Weakness: val.toFixed(3),
      }));
    console.table(sorted);
  }, [WEAKNESS]);

  useEffect(() => {
    try {
      localStorage.setItem(
        "useOpponentWeakness",
        JSON.stringify(useOpponentWeakness)
      );
    } catch {}
  }, [useOpponentWeakness]);

  /* --- Derived data --- */
  const parsed = useMemo(
    () => parseRosterText(rosterText, FP_MAP),
    [rosterText, FP_MAP]
  );

  const result = useMemo(
    () => optimizeStarters(date, parsed, slots, WEAKNESS, 0.1),
    [date, parsed, slots, WEAKNESS, useOpponentWeakness]
  );

  const rosterTeams = useMemo(
    () => new Set(parsed.map((p) => p.team).filter(Boolean)),
    [parsed]
  );

  const playingCount = parsed.filter((p) =>
    teamsPlayingOn(date).has(p.team)
  ).length;
  const totalNeeded = SLOT_KEYS.reduce((acc, k) => acc + (slots[k] || 0), 0);

  /* --- Normalize games for UI --- */
  const rawGames = NHL_SCHEDULE[date]?.games ?? [];
  const normGames = rawGames.map((g) =>
    Array.isArray(g)
      ? {
          away: g[0],
          home: g[1],
          startCT: "",
          broadcasters: [],
          label: `${g[0]} @ ${g[1]}`,
        }
      : {
          away: g.away,
          home: g.home,
          startCT: g.startCT || "",
          broadcasters: onlyNetworkNames(
            Array.isArray(g.broadcasters) ? g.broadcasters : []
          ),
          label: g.label || `${g.away} @ ${g.home}`,
        }
  );
  const teams = NHL_SCHEDULE[date]?.teams ?? [];
  const gameCount = normGames.length;

  /* =============================================================================
     Render
  ============================================================================= */
  return (
    <div className="container">
      {/* Header */}
      <div className="header">
        <div>
          <h1 className="h1">Fantasy Start Optimizer</h1>
          <div className="sub">
            Game-day view • Highlights your teams • Auto-starts best FP at each
            slot • Adjustable position counts
            <br />
            Fantasy Points (FP) from The Athletic’s pre-season projections (Dom
            Luszczyszyn’s model).
          </div>
        </div>

        <div
          className="buttons"
          style={{ gap: 8, display: "flex", alignItems: "center" }}
        >
          <button
            className="ghost"
            onClick={() => setDateIndex((i) => Math.max(0, i - 1))}
            disabled={dateIndex === 0}
            title="Previous day"
          >
            ◀
          </button>
          <div className="pill">📅 {date}</div>
          <button
            className="ghost"
            onClick={() =>
              setDateIndex((i) => Math.min(dateKeys.length - 1, i + 1))
            }
            disabled={dateIndex >= dateKeys.length - 1}
            title="Next day"
          >
            ▶
          </button>

          <button
            className="ghost"
            onClick={() => setShowSettings((s) => !s)}
            title="Open settings"
            style={{ marginLeft: 8 }}
          >
            {showSettings ? "Close Settings" : "Settings ⚙️"}
          </button>
        </div>
      </div>

      {/* Settings */}
      {showSettings && (
        <div
          style={{
            border: "1px solid #555",
            borderRadius: 10,
            margin: "8px 0 16px",
            background: "rgba(0,0,0,0.25)",
          }}
        >
          <SettingsPanel
            useOpponentWeakness={useOpponentWeakness}
            setUseOpponentWeakness={setUseOpponentWeakness}
          />
        </div>
      )}

      {/* Games Strip */}
      {normGames.length === 0 ? (
        <div className="gameCard muted">No games listed.</div>
      ) : (
        <GameStrip>
          {normGames.map((g, i) => (
            <div className="gameCard" key={i}>
              <div className="gameTeams">
                <span
                  className={`teamAbbr ${
                    rosterTeams.has(g.away) ? "isMine" : ""
                  }`}
                >
                  {g.away}
                </span>
                {" @ "}
                <span
                  className={`teamAbbr ${
                    rosterTeams.has(g.home) ? "isMine" : ""
                  }`}
                >
                  {g.home}
                </span>
              </div>
              {g.startCT ? (
                <div className="gameTime">{timeOnlyCT(g.startCT)}</div>
              ) : null}
              {g.broadcasters?.length ? (
                <div className="gameNet">{g.broadcasters.join(", ")}</div>
              ) : null}
            </div>
          ))}
        </GameStrip>
      )}

      {/* Main Grid */}
      <div className="grid">
        {/* Left: Inputs */}
        <div style={{ display: "grid", gap: 16 }}>
          <section className="card">
            <div className="cardTitle">Your Roster</div>
            <div className="small">
              One player per line. CSV also works:{" "}
              <code>Name,TEAM,POS/POS</code>.
            </div>
            <textarea
              className="textarea"
              value={rosterText}
              onChange={(e) => setRosterText(e.target.value)}
            />
          </section>

          <section className="card">
            <div className="cardTitle">Position Configuration</div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 12,
              }}
            >
              {SLOT_KEYS.map((k) => (
                <div key={k} className="slotBox">
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      marginBottom: 6,
                    }}
                  >
                    <span>{k}</span>
                    <span>{slots[k]}</span>
                  </div>
                  <div
                    style={{ display: "flex", alignItems: "center", gap: 8 }}
                  >
                    <button className="outline" onClick={() => bump(k, -1)}>
                      -
                    </button>
                    <div className="progressWrap">
                      <div
                        className="progressFill"
                        style={{
                          width: `${
                            ((slots[k] || 0) /
                              (k === "D" ? 8 : k === "G" ? 3 : 4)) *
                            100
                          }%`,
                        }}
                      />
                    </div>
                    <button className="outline" onClick={() => bump(k, +1)}>
                      +
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="card">
            <div className="cardTitle">Today’s Availability</div>
            <div className="small">Total games today: {gameCount}</div>
            <br />
            <div className="small">
              {playingCount} of {parsed.length} have a game. You need{" "}
              {totalNeeded} starters.
            </div>
            <br />
            <div className="small">
              <div>Teams playing:</div>
              <ul className="teamColumns">
                {teams.map((team) => (
                  <li
                    key={team}
                    className={rosterTeams.has(team) ? "isMine" : ""}
                  >
                    {team}
                  </li>
                ))}
              </ul>
            </div>
          </section>
        </div>

        {/* Right: Outputs */}
        <div style={{ display: "grid", gap: 16 }}>
          <section className="card sectionStarters">
            <div className="cardTitle">Starters</div>
            {SLOT_KEYS.map((k) => (
              <div key={k} style={{ marginBottom: 12 }}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    marginBottom: 6,
                  }}
                >
                  <strong>{k}</strong>
                  <span className="small">max {slots[k]}</span>
                </div>
                <div
                  style={{
                    display: "grid",
                    gap: 8,
                    gridTemplateColumns: "1fr 1fr",
                  }}
                >
                  {result.starters[k].length === 0 && (
                    <div className="muted">No eligible players.</div>
                  )}
                  {result.starters[k].map((p) => (
                    <div key={`${k}-${p.name}`} className="playerRow">
                      <div>
                        <div style={{ fontWeight: 600 }}>{p.name}</div>
                        <div className="muted">
                          {p.team} • {p.positions.join("/")}
                          {p.opponent ? `  •  vs ${p.opponent}` : ""}
                        </div>
                      </div>
                      {useOpponentWeakness && p.adjFP != null ? (
                        <div className="statColumns">
                          <div className="col">
                            <div className="label">FP</div>
                            <div className="value">{pretty(p.fp)}</div>
                          </div>
                          <div className="col">
                            <div className="label">Adj FP</div>
                            <div className="value">{pretty(p.adjFP)}</div>
                          </div>
                        </div>
                      ) : (
                        <div style={{ textAlign: "right" }}>
                          FP {pretty(p.fp)}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </section>

          <section className="card sectionBench">
            <div className="cardTitle">Bench (playing but extra)</div>
            {result.bench.length === 0 ? (
              <div className="muted">No extras today.</div>
            ) : (
              <div
                style={{
                  display: "grid",
                  gap: 8,
                  gridTemplateColumns: "1fr 1fr",
                }}
              >
                {result.bench.map((p) => (
                  <div key={`bench-${p.name}`} className="playerRow">
                    <div>
                      <div style={{ fontWeight: 600 }}>{p.name}</div>
                      <div className="muted">
                        {p.team} • {p.positions.join("/")}
                      </div>
                    </div>
                    {useOpponentWeakness && p.adjFP != null ? (
                      <div className="statColumns">
                        <div className="col">
                          <div className="label">FP</div>
                          <div className="value">{pretty(p.fp)}</div>
                        </div>
                        <div className="col">
                          <div className="label">Adj FP</div>
                          <div className="value">{pretty(p.adjFP)}</div>
                        </div>
                      </div>
                    ) : (
                      <div style={{ textAlign: "right" }}>
                        FP {pretty(p.fp)}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="card sectionNoGame">
            <div className="cardTitle">No Game</div>
            {result.notPlaying.length === 0 ? (
              <div className="muted">Everyone plays — nice!</div>
            ) : (
              <div
                style={{
                  display: "grid",
                  gap: 8,
                  gridTemplateColumns: "1fr 1fr",
                }}
              >
                {result.notPlaying.map((p) => (
                  <div key={`nogame-${p.name}`} className="playerRow">
                    <div>
                      <div style={{ fontWeight: 600 }}>{p.name}</div>
                      <div className="muted">
                        {p.team} • {p.positions.join("/")}
                      </div>
                    </div>
                    <div>FP {pretty(p.fp)}</div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
