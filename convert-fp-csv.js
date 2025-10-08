// convert-fp-csv.js
// Usage: node convert-fp-csv.js Simplified-List.csv src/data/fp.js
// Converts your fantasy points CSV into JSON format for the app

import fs from "fs";
import path from "path";

// Helper to normalize player names
function keyName(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Simple CSV parser (handles quoted commas)
function parseCSV(text) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").filter(Boolean);
  const split = (line) => {
    const result = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === "," && !inQuotes) {
        result.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
    result.push(cur);
    return result.map((s) => s.trim());
  };

  const header = split(lines[0]).map((h) => h.toLowerCase());
  const rows = lines.slice(1).map((line) => {
    const cols = split(line);
    const obj = {};
    header.forEach((h, i) => (obj[h] = cols[i] ?? ""));
    return obj;
  });
  return rows;
}

function convertCSVtoJSON(csvPath, outPath) {
  if (!fs.existsSync(csvPath)) {
    console.error(`❌ CSV not found: ${csvPath}`);
    process.exit(1);
  }

  const text = fs.readFileSync(csvPath, "utf-8");
  const rows = parseCSV(text);
  const fpMap = {};

  for (const row of rows) {
    const name = (row["name"] || row["player"] || "").trim();
    if (!name) continue;

    const team = (row["team"] || row["tm"] || "").toUpperCase();
    const posRaw = (
      row["pos"] ||
      row["position"] ||
      row["positions"] ||
      ""
    ).trim();
    const fpStr = (
      row["fp"] ||
      row["fpts"] ||
      row["fantasy points"] ||
      row["fppg"] ||
      row["fp/g"] ||
      ""
    ).trim();
    const fp = parseFloat(fpStr.replace(/[^0-9.+-]/g, "")) || 0;

    const positions = posRaw ? posRaw.split(/[/|,\\s]+/).filter(Boolean) : [];

    fpMap[keyName(name)] = { team, positions, fp };
  }

  const output = `// Auto-generated from ${path.basename(
    csvPath
  )}\n// Run: node convert-fp-csv.js ${path.basename(
    csvPath
  )} src/data/fp.js\n\nconst FP_MAP = ${JSON.stringify(
    fpMap,
    null,
    2
  )};\nexport default FP_MAP;\n`;

  fs.writeFileSync(outPath, output, "utf-8");
  console.log(
    `✅ Created ${outPath} with ${Object.keys(fpMap).length} players.`
  );
}

// CLI
const [, , csvPath, outPath] = process.argv;
if (!csvPath || !outPath) {
  console.log(
    "Usage: node convert-fp-csv.js Simplified-List.csv src/data/fp.js"
  );
  process.exit(0);
}
convertCSVtoJSON(csvPath, outPath);
