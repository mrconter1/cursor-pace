export interface Prices {
  [model: string]: {
    cost_per_token: number;
    on_demand_cost: number;
    on_demand_tokens: number;
  };
}

export interface UsageResult {
  todaySpend: number;
  monthSpend: number;
  currentModel: string;
  untrackedModelsToday: string[];
  monthActiveDaysSoFar: number;
}

import * as https from "https";

async function httpsGet(url: string, cookie: string): Promise<string> {
  const headers = {
    "Cookie": `WorkosCursorSessionToken=${cookie}`,
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  };

  // 1. Try globalThis.fetch first (modern, proxy-aware)
  try {
    const res = await fetch(url, { method: "GET", headers, redirect: "error" });
    if (res.ok) return await res.text();
    if (res.status === 500) {
      // Fall through to https.get if fetch gets a 500 — maybe the backend prefers it
    } else {
      throw new Error(`Fetch failed (HTTP ${res.status}). Session token may be expired.`);
    }
  } catch (err: any) {
    // If it's a "fetch failed" TypeError, fall through to https.get
    if (err.name !== "TypeError" || err.message !== "fetch failed") {
      throw err;
    }
  }

  // 2. Fallback to Node's https.get (bypasses proxy/VS Code stack)
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: "GET",
      headers,
    };

    const req = https.request(options, (res) => {
      if (res.statusCode && res.statusCode >= 300) {
        reject(new Error(`HTTPS fallback failed (HTTP ${res.statusCode}). Session token may be expired.`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });

    req.on("error", (err) => {
      reject(new Error(`Both fetch and https fallback failed. DNS/Network error: ${err.message}`));
    });
    req.end();
  });
}

function parseCsv(raw: string): Record<string, string>[] {
  const lines = raw.trim().split("\n");
  if (lines.length < 2) return [];

  const headers = lines[0].split(",").map((h) => h.replace(/^"|"$/g, "").trim());

  return lines.slice(1).map((line) => {
    const values: string[] = [];
    let current = "";
    let inQuotes = false;
    for (const ch of line) {
      if (ch === '"') { inQuotes = !inQuotes; }
      else if (ch === "," && !inQuotes) { values.push(current); current = ""; }
      else { current += ch; }
    }
    values.push(current);

    const row: Record<string, string> = {};
    headers.forEach((h, i) => { row[h] = (values[i] ?? "").trim(); });
    return row;
  });
}

export async function fetchUsage(token: string, prices: Prices): Promise<UsageResult> {
  const now = new Date();
  const nowMs = now.getTime();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();

  const url = `https://cursor.com/api/dashboard/export-usage-events-csv?startDate=${startOfMonth}&endDate=${nowMs}&strategy=tokens`;
  const raw = await httpsGet(url, token);
  const rows = parseCsv(raw);

  const todayKey = now.toISOString().slice(0, 10);
  const monthPrefix = todayKey.slice(0, 7);
  const recentCutoff = nowMs - 15 * 60 * 1000;

  const maxCpt = Math.max(0, ...Object.values(prices).map((p) => p.cost_per_token));

  let todaySpend = 0;
  let monthSpend = 0;
  let mostRecentTimestamp = 0;
  let mostRecentModel = "unknown";
  const untrackedSet = new Set<string>();
  const activeDaysSet = new Set<string>();

  for (const row of rows) {
    const model = (row["Model"] ?? "").trim();
    const kind = (row["Kind"] ?? "").trim();
    const dateRaw = (row["Date"] ?? "").trim();
    const total = parseInt(row["Total Tokens"] ?? "0", 10) || 0;
    const costRaw = (row["Cost"] ?? "").trim();

    if (!model || model.toLowerCase() === "auto") continue;
    if (kind === "Errored, No Charge") continue;

    const dateKey = dateRaw.slice(0, 10);
    if (!dateKey.startsWith(monthPrefix)) continue;

    if (dateKey !== todayKey) {
      activeDaysSet.add(dateKey);
    }

    const timestamp = new Date(dateRaw).getTime() || 0;
    if (timestamp > mostRecentTimestamp) {
      mostRecentTimestamp = timestamp;
      mostRecentModel = model;
    }

    let cost: number;
    if (kind === "On-Demand" && costRaw !== "Included" && costRaw !== "") {
      cost = parseFloat(costRaw) || 0;
    } else if (total > 0) {
      const price = prices[model];
      if (price) {
        cost = total * price.cost_per_token;
      } else {
        cost = total * maxCpt;
        if (dateKey === todayKey && timestamp >= recentCutoff) {
          untrackedSet.add(model);
        }
      }
    } else {
      cost = 0;
    }

    monthSpend += cost;
    if (dateKey === todayKey) {
      todaySpend += cost;
    }
  }

  return {
    todaySpend,
    monthSpend,
    currentModel: mostRecentModel,
    untrackedModelsToday: Array.from(untrackedSet),
    monthActiveDaysSoFar: activeDaysSet.size,
  };
}
