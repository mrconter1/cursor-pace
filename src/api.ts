export interface ModelStats {
  requests: number;
  total_tokens: number;
  on_demand_cost: number;
  on_demand_tokens: number;
  included_tokens: number;
  cost_per_token: number | null;
  total_estimated_cost: number | null;
}

export interface CalibrationMeta {
  activeDays: number;
  historyDays: number;
  fetchedAt: string;
  todaySpend: number;
  monthSpend: number;
  monthActiveDaysSoFar: number;
  untrackedModelsToday: string[];
  currentModel: string;
}

export type Calibration = Record<string, ModelStats> & { _meta: CalibrationMeta };

async function httpsGet(url: string, cookie: string): Promise<string> {
  const res = await fetch(url, {
    method: "GET",
    headers: {
      "Cookie": `WorkosCursorSessionToken=${cookie}`,
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
    redirect: "error",
  });

  if (!res.ok) {
    throw new Error(`Auth failed (HTTP ${res.status}). Session token may be expired.`);
  }

  return res.text();
}

function parseCsv(raw: string): Record<string, string>[] {
  const lines = raw.trim().split("\n");
  if (lines.length < 2) return [];

  const headers = lines[0].split(",").map((h) => h.replace(/^"|"$/g, "").trim());

  return lines.slice(1).map((line) => {
    // Handle quoted fields containing commas
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

function emptyStats(): ModelStats {
  return {
    requests: 0,
    total_tokens: 0,
    on_demand_cost: 0,
    on_demand_tokens: 0,
    included_tokens: 0,
    cost_per_token: null,
    total_estimated_cost: null,
  };
}

function inferActiveDays(requestsPerDay: Map<string, number>): number {
  if (requestsPerDay.size === 0) return 0;

  const counts = Array.from(requestsPerDay.values());
  const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
  const variance = counts.reduce((sum, c) => sum + (c - mean) ** 2, 0) / counts.length;
  const std = Math.sqrt(variance);

  const lo = mean - std;
  return counts.filter((c) => c >= lo).length;
}

export async function fetchCalibration(token: string, days = 30): Promise<Calibration> {
  const nowMs = Date.now();
  const startMs = nowMs - days * 24 * 60 * 60 * 1000;
  const url = `https://cursor.com/api/dashboard/export-usage-events-csv?startDate=${startMs}&endDate=${nowMs}&strategy=tokens`;

  const raw = await httpsGet(url, token);
  const rows = parseCsv(raw);

  const stats: Record<string, ModelStats> = {};
  const requestsPerDay = new Map<string, number>();
  const now = new Date();
  const todayKey = now.toISOString().slice(0, 10);
  const monthPrefix = todayKey.slice(0, 7);

  interface CostRow { model: string; tokens: number; cost: number | null; timestamp: number; }
  const todayRows: CostRow[] = [];
  const monthRows: CostRow[] = [];
  const monthActiveDaysSet = new Set<string>();

  let mostRecentTimestamp = 0;
  let mostRecentModel = "unknown";

  for (const row of rows) {
    const model = row["Model"] ?? "";
    const kind = row["Kind"] ?? "";
    const dateRaw = row["Date"] ?? "";
    const total = parseInt(row["Total Tokens"] ?? "0", 10) || 0;
    const inputW = parseInt(row["Input (w/ Cache Write)"] ?? "0", 10) || 0;
    const inputWo = parseInt(row["Input (w/o Cache Write)"] ?? "0", 10) || 0;
    const cacheRead = parseInt(row["Cache Read"] ?? "0", 10) || 0;
    const output = parseInt(row["Output Tokens"] ?? "0", 10) || 0;
    const costRaw = row["Cost"] ?? "";

    const dateKey = dateRaw.slice(0, 10);
    if (dateKey) requestsPerDay.set(dateKey, (requestsPerDay.get(dateKey) ?? 0) + 1);

    const timestamp = new Date(dateRaw).getTime() || 0;
    if (timestamp > mostRecentTimestamp) {
      mostRecentTimestamp = timestamp;
      mostRecentModel = model;
    }

    if (!stats[model]) stats[model] = emptyStats();
    const s = stats[model];
    s.requests++;
    s.total_tokens += total;
    s.included_tokens += inputW + inputWo + cacheRead + output;

    if (kind === "On-Demand" && costRaw !== "Included" && costRaw !== "") {
      const cost = parseFloat(costRaw);
      if (!isNaN(cost)) {
        s.on_demand_cost += cost;
        s.on_demand_tokens += total;
      }
    } else {
      s.included_tokens += total;
    }

    if (model.toLowerCase() !== "auto" && dateKey.startsWith(monthPrefix)) {
      const directCost = (kind === "On-Demand" && costRaw !== "Included" && costRaw !== "")
        ? parseFloat(costRaw) || null
        : null;
      const row: CostRow = { model, tokens: total, cost: directCost, timestamp };
      if (dateKey === todayKey) {
        todayRows.push(row);
      } else {
        monthRows.push(row);
        monthActiveDaysSet.add(dateKey);
      }
    }
  }

  for (const s of Object.values(stats)) {
    if (s.on_demand_tokens > 0) {
      s.cost_per_token = s.on_demand_cost / s.on_demand_tokens;
      const estimatedIncluded = s.included_tokens * s.cost_per_token;
      s.total_estimated_cost = s.on_demand_cost + estimatedIncluded;
    }
  }

  const maxCpt = Math.max(
    0,
    ...Object.values(stats).map((s) => s.cost_per_token ?? 0)
  );

  const recentCutoff = nowMs - 15 * 60 * 1000;
  const untrackedSet = new Set<string>();

  function estimateSpend(rows: CostRow[]): number {
    let spend = 0;
    for (const r of rows) {
      if (r.cost !== null) {
        spend += r.cost;
      } else if (stats[r.model]?.cost_per_token) {
        spend += r.tokens * stats[r.model].cost_per_token!;
      } else {
        spend += r.tokens * maxCpt;
      }
    }
    return spend;
  }

  const todaySpend = estimateSpend(todayRows);
  const monthSpendExcludingToday = estimateSpend(monthRows);
  const monthSpend = monthSpendExcludingToday + todaySpend;

  for (const r of todayRows) {
    if (r.cost === null && !stats[r.model]?.cost_per_token && r.timestamp >= recentCutoff) {
      untrackedSet.add(r.model);
    }
  }

  const activeDays = inferActiveDays(requestsPerDay);

  return {
    ...stats,
    _meta: {
      activeDays,
      historyDays: days,
      fetchedAt: new Date().toISOString(),
      todaySpend,
      monthSpend,
      monthActiveDaysSoFar: monthActiveDaysSet.size,
      untrackedModelsToday: Array.from(untrackedSet),
      currentModel: mostRecentModel,
    },
  } as Calibration;
}
