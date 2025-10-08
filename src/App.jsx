import React, { useEffect, useMemo, useState } from "react";
import NHL_SCHEDULE from "./data/schedule";
import { useFPMap } from "./fp-map";
import SettingsPanel from "./SettingsPanel";
import GameStrip from "./GameStrip";

const DEFAULT_SLOTS = { C: 2, LW: 2, RW: 2, D: 4, G: 2, UTIL: 2 };
const SLOT_KEYS = ["C", "LW", "RW", "D", "G", "UTIL"];

function keyName(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function teamsPlayingOn(date) {
  return new Set((NHL_SCHEDULE[date]?.teams ?? []).map((t) => t.toUpperCase()));
}
function parseRosterText(text, FP_MAP) {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  return lines.map((line) => {
    const p = line.split(",").map((s) => s.trim());
    const name = p[0] || "";
    const fp = FP_MAP[keyName(name)];
    const team = (p[1] || fp?.team || "").toUpperCase();
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
function optimizeStarters(date, roster, slots) {
  const playing = roster.filter(
    (p) => p.team && teamsPlayingOn(date).has(p.team)
  );
  const notPlaying = roster.filter(
    (p) => !p.team || !teamsPlayingOn(date).has(p.team)
  );

  const used = new Set();
  const starters = { C: [], LW: [], RW: [], D: [], G: [], UTIL: [] };
  const take = (pos, n, elig) => {
    for (let i = 0; i < n; i++) {
      const cand = playing
        .filter((p) => !used.has(p.name) && elig(p))
        .sort((a, b) => b.fp - a.fp);
      if (!cand.length) break;
      used.add(cand[0].name);
      starters[pos].push(cand[0]);
    }
  };
  const is = (p, t) => p.positions.includes(t);
  take("C", slots.C, (p) => is(p, "C"));
  take("LW", slots.LW, (p) => is(p, "LW"));
  take("RW", slots.RW, (p) => is(p, "RW"));
  take("D", slots.D, (p) => is(p, "D"));
  take("G", slots.G, (p) => is(p, "G"));
  take(
    "UTIL",
    slots.UTIL,
    (p) => ["C", "LW", "RW", "D"].some((k) => is(p, k)) && !is(p, "G")
  );
  const bench = playing
    .filter((p) => !used.has(p.name))
    .sort((a, b) => b.fp - a.fp);
  return { starters, bench, notPlaying };
}
function pretty(n) {
  if (n == null || Number.isNaN(Number(n))) return "0.0000";
  return Number(n).toLocaleString(undefined, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
}

// --- helpers for games strip ---
function timeOnlyCT(startCT) {
  // startCT from converter looks like: "YYYY-MM-DD 7:00 PM CT"
  if (!startCT) return "";
  const parts = String(startCT).split(" ");
  return parts.length >= 4 ? parts.slice(1).join(" ") : startCT;
}
function onlyNetworkNames(list) {
  // Safety if schedule still contains qualifiers — strip common tags
  const rm =
    /\\b(home|away|national|regional|internet|web|stream|radio|intl)\\b/i;
  return [
    ...new Set(
      (list || [])
        .map(String)
        .map((s) =>
          s
            .replace(
              /\\((?:home|away|national|regional|internet|web|stream|radio|intl)\\)/gi,
              ""
            ) // remove (National) etc
            .replace(
              /\\s*-\\s*(home|away|national|regional|internet|web|stream|radio|intl)\\b/gi,
              ""
            )
            .replace(/\\bHD\\b/gi, "")
            .replace(/\\s{2,}/g, " ")
            .trim()
        )
        .filter((s) => s && !rm.test(s)) // drop pure qualifier tokens
    ),
  ];
}

export default function App() {
  const FP_MAP = useFPMap();
  const dateKeys = Object.keys(NHL_SCHEDULE).sort();
  const [dateIndex, setDateIndex] = useState(0);
  const date = dateKeys[dateIndex] ?? dateKeys[0] ?? "2025-10-07";
  const [showSettings, setShowSettings] = useState(false);

  const [slots, setSlots] = useState(() => {
    try {
      const saved = localStorage.getItem("slot-config");
      return saved ? JSON.parse(saved) : DEFAULT_SLOTS;
    } catch {
      return DEFAULT_SLOTS;
    }
  });

  // Built-in default roster (used only if nothing saved yet)
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

  // Load once from localStorage (fallback to built-in)
  const [rosterText, setRosterText] = useState(() => {
    try {
      return localStorage.getItem("userRoster") || BUILT_IN_ROSTER;
    } catch {
      return BUILT_IN_ROSTER;
    }
  });

  // Persist roster changes automatically
  useEffect(() => {
    try {
      localStorage.setItem("userRoster", rosterText);
    } catch {}
  }, [rosterText]);

  const parsed = useMemo(
    () => parseRosterText(rosterText, FP_MAP),
    [rosterText, FP_MAP]
  );
  const result = useMemo(
    () => optimizeStarters(date, parsed, slots),
    [date, parsed, slots]
  );
  // Set of team abbreviations from your current roster
  const rosterTeams = useMemo(
    () => new Set(parsed.map((p) => p.team).filter(Boolean)),
    [parsed]
  );

  const playingCount = parsed.filter((p) =>
    teamsPlayingOn(date).has(p.team)
  ).length;
  const totalNeeded = SLOT_KEYS.reduce((acc, k) => acc + slots[k], 0);

  const bump = (k, d) => {
    const max = k === "D" ? 6 : k === "G" ? 3 : 3;
    const v = Math.max(0, Math.min(max, slots[k] + d));
    const next = { ...slots, [k]: v };
    setSlots(next);
    localStorage.setItem("slot-config", JSON.stringify(next));
  };

  // Normalize games for UI
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

  return (
    <div className="container">
      <div className="header">
        <div>
          <h1 className="h1">Fantasy Start Optimizer</h1>
          <div className="sub">
            Game-day view • Highlights your teams • Auto-starts best FP at each
            slot • Adjustable position counts <br />
            Fantasy Points (FP) is from The Athletic’s pre-season projections
            based on Dom Luszczyszyn's model.
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

          {/* NEW: Settings toggle */}
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

      {/* NEW: slide-in-ish panel container */}
      {showSettings && (
        <div
          style={{
            border: "1px solid #555",
            borderRadius: 10,
            margin: "8px 0 16px",
            background: "rgba(0,0,0,0.25)",
          }}
        >
          <SettingsPanel />
        </div>
      )}

      {/* Games strip across the top */}
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

      <div className="grid">
        {/* Left column */}
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
                            (slots[k] / (k === "D" ? 6 : k === "G" ? 3 : 3)) *
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

        {/* Right column */}
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
                        </div>
                      </div>
                      <div>
                        FP {pretty(p.fp)}
                        {p.fpg ? `  •  FP/GP ${pretty(p.fpg)}` : ""}
                      </div>
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
                    <div>FP {pretty(p.fp)}</div>
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
