import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { getSessionToken } from "./auth";
import { fetchUsage, Prices, UsageResult } from "./api";

let statusBarItem: vscode.StatusBarItem;
let dashboardPanel: vscode.WebviewPanel | undefined;
let refreshTimer: NodeJS.Timeout | undefined;

const REFRESH_INTERVAL_MS = 30 * 1000;
const WARNING_THROTTLE_MS = 30 * 60 * 1000;
const ACTIVE_DAYS_PER_MONTH = 22;

let lastWarningShownAt = 0;

interface UsageCache extends UsageResult {
  fetchedAt: string;
}

function getUsageCachePath(context: vscode.ExtensionContext): string {
  return path.join(context.globalStorageUri.fsPath, "usage_cache.json");
}

function loadPrices(extensionPath: string): Prices {
  const pricesPath = path.join(extensionPath, "prices.json");
  try {
    return JSON.parse(fs.readFileSync(pricesPath, "utf8")) as Prices;
  } catch {
    return {};
  }
}

function loadUsageCache(context: vscode.ExtensionContext): UsageCache | null {
  const cachePath = getUsageCachePath(context);
  try {
    if (fs.existsSync(cachePath)) {
      return JSON.parse(fs.readFileSync(cachePath, "utf8")) as UsageCache;
    }
  } catch { /* ignore */ }
  return null;
}

export function activate(context: vscode.ExtensionContext) {
  fs.mkdirSync(context.globalStorageUri.fsPath, { recursive: true });

  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.command = "cursorPace.openDashboard";
  statusBarItem.text = "$(pulse) Cursor Pace";
  statusBarItem.tooltip = "Open Cursor Pace Dashboard";
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorPace.openDashboard", () => {
      openDashboard(context);
    }),
    vscode.commands.registerCommand("cursorPace.refresh", () => {
      void runRefresh(context);
    }),
    vscode.commands.registerCommand("cursorPace.debugWarn", () => {
      const { dailyBudget } = getDailyBudget(context);
      const fakeSpend = dailyBudget * 0.85;
      updateStatusBar(fakeSpend, dailyBudget);
      vscode.window.showWarningMessage(
        `Cursor Pace: 85% of daily budget used ($${fakeSpend.toFixed(2)} / $${dailyBudget.toFixed(2)}).`
      );
    }),
    vscode.commands.registerCommand("cursorPace.debugOverBudget", () => {
      const { dailyBudget } = getDailyBudget(context);
      const fakeSpend = dailyBudget * 1.15;
      updateStatusBar(fakeSpend, dailyBudget);
      void vscode.window.showErrorMessage(
        `Cursor Pace [Debug]: You've used 115% of your daily budget. Please switch to 'auto' to avoid extra costs!`,
        { modal: true }
      );
    }),
    vscode.commands.registerCommand("cursorPace.debugUntracked", () => {
      vscode.window.showWarningMessage(
        `Cursor Pace: No price data for fake-model-v3, mystery-llm-7b — spend from these models can't be tracked.`
      );
    })
  );

  void runRefresh(context);

  refreshTimer = setInterval(() => {
    void runRefresh(context);
  }, REFRESH_INTERVAL_MS);
}

function openDashboard(context: vscode.ExtensionContext) {
  if (dashboardPanel) {
    dashboardPanel.reveal();
    return;
  }

  dashboardPanel = vscode.window.createWebviewPanel(
    "cursorPace",
    "Cursor Pace",
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true }
  );

  dashboardPanel.onDidDispose(() => {
    dashboardPanel = undefined;
  });

  dashboardPanel.webview.onDidReceiveMessage((msg) => {
    if (msg.type === "refresh") {
      void runRefresh(context);
    }
    if (msg.type === "saveSettings") {
      const cfg = vscode.workspace.getConfiguration("cursorPace");
      cfg.update("subscription", msg.subscription, true);
      cfg.update("monthlyBudget", msg.monthlyBudget, true);
      cfg.update("warnThreshold", msg.warnThreshold, true);
      vscode.window.showInformationMessage("Cursor Pace settings saved.");
      void updateWebview(context);
    }
  });

  void updateWebview(context);
}

async function updateWebview(context: vscode.ExtensionContext) {
  if (!dashboardPanel) return;

  const cache = loadUsageCache(context);
  const prices = loadPrices(context.extensionPath);
  const lastSyncedAt = cache?.fetchedAt ? new Date(cache.fetchedAt) : null;

  const cfg = vscode.workspace.getConfiguration("cursorPace");
  const settings = {
    subscription: cfg.get<string>("subscription", "ultra"),
    monthlyBudget: cfg.get<number>("monthlyBudget", 200),
    warnThreshold: cfg.get<number>("warnThreshold", 80),
    todaySpend: cache?.todaySpend ?? 0,
    monthSpend: cache?.monthSpend ?? 0,
    currentModel: cache?.currentModel ?? "unknown",
    monthActiveDaysSoFar: cache?.monthActiveDaysSoFar ?? 0,
  };

  const { dailyBudget, flatDailyBudget } = getDailyBudget(context);
  dashboardPanel.webview.html = getWebviewHtml(prices, settings, lastSyncedAt, dailyBudget, flatDailyBudget);
}

function getDailyBudget(context: vscode.ExtensionContext): { dailyBudget: number; flatDailyBudget: number } {
  const cfg = vscode.workspace.getConfiguration("cursorPace");
  const monthlyBudget = cfg.get<number>("monthlyBudget", 200);

  const cache = loadUsageCache(context);
  const todaySpend = cache?.todaySpend ?? 0;
  const monthSpend = cache?.monthSpend ?? 0;
  const monthActiveDaysSoFar = cache?.monthActiveDaysSoFar ?? 0;

  const flatDailyBudget = monthlyBudget / ACTIVE_DAYS_PER_MONTH;
  const spentBeforeToday = monthSpend - todaySpend;
  const remainingBudget = monthlyBudget - spentBeforeToday;
  const remainingActiveDays = Math.max(1, ACTIVE_DAYS_PER_MONTH - monthActiveDaysSoFar);
  const dailyBudget = Math.max(0, remainingBudget / remainingActiveDays);

  return { dailyBudget, flatDailyBudget };
}

function updateStatusBar(todaySpend: number, dailyBudget: number) {
  const pct = dailyBudget > 0 ? Math.round((todaySpend / dailyBudget) * 100) : 0;

  if (pct >= 100) {
    statusBarItem.text = `$(warning) ${pct}% of daily limit`;
    statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
  } else if (pct >= 80) {
    statusBarItem.text = `$(pulse) ${pct}% of daily limit`;
    statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
  } else {
    statusBarItem.text = `$(pulse) ${pct}% of daily limit`;
    statusBarItem.backgroundColor = undefined;
  }

  statusBarItem.tooltip = `Today: $${todaySpend.toFixed(2)} / $${dailyBudget.toFixed(2)}`;
}

async function runRefresh(context: vscode.ExtensionContext) {
  statusBarItem.text = "$(sync~spin) Refreshing...";
  try {
    const token = await getSessionToken(context.extensionPath);
    const cfg = vscode.workspace.getConfiguration("cursorPace");
    const subscription = cfg.get<string>("subscription", "ultra");
    const warnThreshold = cfg.get<number>("warnThreshold", 80);
    const planBudget = PLANS[subscription]?.effectiveBudget;
    if (planBudget !== null && planBudget !== undefined) {
      cfg.update("monthlyBudget", planBudget, true);
    }

    const prices = loadPrices(context.extensionPath);
    const result = await fetchUsage(token, prices);

    const cache: UsageCache = { ...result, fetchedAt: new Date().toISOString() };
    const cachePath = getUsageCachePath(context);
    fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));

    const { dailyBudget } = getDailyBudget(context);
    updateStatusBar(result.todaySpend, dailyBudget);

    const now = Date.now();
    const mayShowWarning = now - lastWarningShownAt >= WARNING_THROTTLE_MS;

    if (result.untrackedModelsToday.length > 0 && mayShowWarning) {
      lastWarningShownAt = now;
      vscode.window.showWarningMessage(
        `Cursor Pace: No price data for ${result.untrackedModelsToday.join(", ")} — run scripts/infer_prices.py to add them.`
      );
    }

    const pct = dailyBudget > 0 ? Math.round((result.todaySpend / dailyBudget) * 100) : 0;
    if (pct >= 100) {
      if (result.currentModel.toLowerCase() !== "auto" && result.currentModel !== "unknown" && mayShowWarning) {
        lastWarningShownAt = now;
        void vscode.window.showErrorMessage(
          `Cursor Pace: DAILY BUDGET EXCEEDED (${pct}%). Composer is set to ${result.currentModel}. Switch to auto!`,
          { modal: true }
        );
      } else if (mayShowWarning) {
        lastWarningShownAt = now;
        vscode.window.showWarningMessage(
          `Cursor Pace: You are ${pct}% over your daily budget ($${result.todaySpend.toFixed(2)} / $${dailyBudget.toFixed(2)}). Good job using auto!`
        );
      }
    } else if (pct >= warnThreshold && mayShowWarning) {
      lastWarningShownAt = now;
      vscode.window.showWarningMessage(
        `Cursor Pace: ${pct}% of daily budget used ($${result.todaySpend.toFixed(2)} / $${dailyBudget.toFixed(2)}).`
      );
    }

    void updateWebview(context);
  } catch (err: unknown) {
    statusBarItem.text = "$(error) Cursor Pace";
    statusBarItem.backgroundColor = undefined;
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Cursor Pace refresh failed: ${msg}`);
  }
}

function timeSince(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

interface PlanInfo {
  label: string;
  price: number | null;
  effectiveBudget: number | null;
  note: string;
}

const PLANS: Record<string, PlanInfo> = {
  hobby:    { label: "Hobby",   price: 0,    effectiveBudget: 0,    note: "Free — very limited model access" },
  pro:      { label: "Pro",     price: 20,   effectiveBudget: 20,   note: "$20/mo — ~$20 in model credits at API prices" },
  pro_plus: { label: "Pro+",    price: 60,   effectiveBudget: 60,   note: "$60/mo — 3× Pro, ~$60 in model credits" },
  ultra:    { label: "Ultra",   price: 200,  effectiveBudget: 400,  note: "$200/mo — 20× Pro, ~$400 in model credits (2× efficiency)" },
  teams:    { label: "Teams",   price: 40,   effectiveBudget: 40,   note: "$40/user/mo — ~$40 in model credits per user" },
  custom:   { label: "Custom",  price: null, effectiveBudget: null, note: "Set your own budget manually" },
};

function getWebviewHtml(
  prices: Prices,
  settings: {
    subscription: string;
    monthlyBudget: number;
    warnThreshold: number;
    todaySpend: number;
    monthSpend: number;
    currentModel: string;
    monthActiveDaysSoFar: number;
  },
  lastSyncedAt: Date | null,
  dailyBudget: number,
  flatDailyBudget: number
): string {
  const dailyPct = dailyBudget > 0 ? Math.round((settings.todaySpend / dailyBudget) * 100) : 0;
  const monthPct = settings.monthlyBudget > 0 ? Math.round((settings.monthSpend / settings.monthlyBudget) * 100) : 0;
  const budgetAdjusted = Math.abs(dailyBudget - flatDailyBudget) > 0.01;

  const priceEntries = Object.entries(prices)
    .sort((a, b) => b[1].cost_per_token - a[1].cost_per_token);

  const hasPrices = priceEntries.length > 0;

  const modelRows = priceEntries.map(([name, p]) => {
    const perMillion = (p.cost_per_token * 1_000_000).toFixed(4);
    const confidence = p.on_demand_tokens >= 1_000_000
      ? "high"
      : p.on_demand_tokens >= 100_000
        ? "medium"
        : "low";
    const tokensBasis = p.on_demand_tokens >= 1_000_000
      ? `${(p.on_demand_tokens / 1_000_000).toFixed(1)}M tokens`
      : `${(p.on_demand_tokens / 1_000).toFixed(0)}K tokens`;
    return `
    <tr>
      <td class="model-name">${name}</td>
      <td>$${perMillion}</td>
      <td class="confidence-${confidence}">${tokensBasis}</td>
    </tr>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Cursor Pace</title>
<style>
  :root {
    --bg: var(--vscode-editor-background);
    --fg: var(--vscode-editor-foreground);
    --border: var(--vscode-panel-border);
    --input-bg: var(--vscode-input-background);
    --input-fg: var(--vscode-input-foreground);
    --input-border: var(--vscode-input-border);
    --btn-bg: var(--vscode-button-background);
    --btn-fg: var(--vscode-button-foreground);
    --btn-hover: var(--vscode-button-hoverBackground);
    --table-header: var(--vscode-editorGroupHeader-tabsBackground);
    --highlight: var(--vscode-focusBorder);
    --muted: var(--vscode-descriptionForeground);
    --dropdown-bg: var(--vscode-dropdown-background);
    --dropdown-fg: var(--vscode-dropdown-foreground);
    --dropdown-border: var(--vscode-dropdown-border);
    --dropdown-list-bg: var(--vscode-dropdown-listBackground, var(--vscode-dropdown-background));
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: var(--vscode-font-family); font-size: 13px; color: var(--fg); background: var(--bg); padding: 24px; }
  h1 { font-size: 20px; font-weight: 600; margin-bottom: 4px; }
  .section { margin-bottom: 28px; }
  .section-title { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); margin-bottom: 10px; }
  .pace-card { display: flex; gap: 16px; flex-wrap: wrap; }
  .card { background: var(--table-header); border: 1px solid var(--border); border-radius: 6px; padding: 14px 18px; min-width: 150px; }
  .card-label { font-size: 11px; color: var(--muted); margin-bottom: 4px; }
  .card-value { font-size: 22px; font-weight: 600; }
  .card-unit { font-size: 12px; color: var(--muted); }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); padding: 6px 10px; background: var(--table-header); border-bottom: 1px solid var(--border); }
  td { padding: 8px 10px; border-bottom: 1px solid var(--border); }
  td.model-name { font-family: var(--vscode-editor-font-family); font-size: 12px; }
  .confidence-high { color: var(--vscode-testing-iconPassed, #4caf50); }
  .confidence-medium { color: var(--vscode-editorWarning-foreground, #cca700); }
  .confidence-low { color: var(--muted); }
  .settings-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; max-width: 480px; }
  .field label { display: block; font-size: 11px; color: var(--muted); margin-bottom: 4px; }
  .field input { width: 100%; background: var(--input-bg); color: var(--input-fg); border: 1px solid var(--input-border, var(--border)); border-radius: 3px; padding: 5px 8px; font-size: 13px; outline: none; }
  .field input:focus { border-color: var(--highlight); }
  body.vscode-dark .field input[type=number], body.vscode-high-contrast .field input[type=number] { color-scheme: dark; }
  body.vscode-light .field input[type=number] { color-scheme: light; }
  .field select { width: 100%; background: var(--dropdown-bg); color: var(--dropdown-fg); border: 1px solid var(--dropdown-border); border-radius: 3px; padding: 5px 8px; font-size: 13px; outline: none; appearance: none; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23888' d='M6 8L1 3h10z'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 8px center; cursor: pointer; }
  .field select:focus { border-color: var(--highlight); }
  .field select option { background: var(--dropdown-list-bg); color: var(--dropdown-fg); }
  body.vscode-dark .field select, body.vscode-high-contrast .field select { color-scheme: dark; }
  body.vscode-light .field select { color-scheme: light; }
  .actions { display: flex; gap: 8px; margin-top: 6px; }
  button { background: var(--btn-bg); color: var(--btn-fg); border: none; border-radius: 3px; padding: 6px 14px; font-size: 12px; cursor: pointer; }
  button:hover { background: var(--btn-hover); }
  .empty { color: var(--muted); padding: 20px 0; }
  .subtitle-row { display: flex; align-items: center; gap: 10px; margin-bottom: 24px; flex-wrap: wrap; }
  .subtitle-text { color: var(--muted); font-size: 12px; }
  .refresh-btn { display: inline-flex; align-items: center; background: transparent; color: var(--muted); border: none; padding: 0; font-size: 15px; cursor: pointer; line-height: 1; transition: color 0.15s; }
  .refresh-btn:hover { color: var(--fg); background: transparent; }
  .refresh-btn.spinning { animation: spin 1s linear infinite; }
  @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
  .table-overlay { display: none; position: absolute; inset: 0; background: var(--bg); opacity: 0.6; z-index: 5; }
  .table-overlay.visible { display: block; }
  .info-badge { display: inline-flex; align-items: center; justify-content: center; width: 14px; height: 14px; border-radius: 50%; border: 1px solid var(--muted); color: var(--muted); font-size: 10px; font-weight: 700; cursor: default; position: relative; margin-left: 5px; vertical-align: middle; line-height: 1; }
  .info-badge:hover .tooltip { display: block; }
  .tooltip { display: none; position: absolute; bottom: calc(100% + 6px); left: 50%; transform: translateX(-50%); background: var(--vscode-editorHoverWidget-background, #252526); border: 1px solid var(--vscode-editorHoverWidget-border, #454545); color: var(--vscode-editorHoverWidget-foreground, #ccc); font-size: 11px; font-weight: 400; padding: 6px 10px; border-radius: 4px; white-space: normal; width: max-content; max-width: 220px; line-height: 1.5; z-index: 10; pointer-events: none; }
  .hint { font-size: 11px; color: var(--muted); margin-top: 8px; }
</style>
</head>
<body>
<h1>Cursor Pace</h1>
<div class="subtitle-row">
  <span class="subtitle-text">Track and pace your Cursor AI spending</span>
  <span class="subtitle-text">·</span>
  <span class="subtitle-text" id="lastSynced">Last synced: ${lastSyncedAt ? timeSince(lastSyncedAt) : "never"}</span>
  <button class="refresh-btn" id="refreshBtn" onclick="refresh()" title="Refresh usage data">↻</button>
</div>

<div class="section">
  <div class="section-title">Daily Pace</div>
  <div class="pace-card">
    <div class="card">
      <div class="card-label">Today's Spend</div>
      <div class="card-value" style="${dailyPct >= 100 ? 'color:var(--vscode-errorForeground)' : dailyPct >= 80 ? 'color:var(--vscode-editorWarning-foreground)' : ''}">$${settings.todaySpend.toFixed(2)} <span class="card-unit">/ $${dailyBudget.toFixed(2)}</span></div>
    </div>
    <div class="card">
      <div class="card-label">Daily Usage</div>
      <div class="card-value" style="${dailyPct >= 100 ? 'color:var(--vscode-errorForeground)' : dailyPct >= 80 ? 'color:var(--vscode-editorWarning-foreground)' : ''}">${dailyPct}<span class="card-unit">%</span></div>
    </div>
    <div class="card">
      <div class="card-label">Daily Budget
        <span class="info-badge">i<span class="tooltip">${budgetAdjusted
          ? `Adjusted from $${flatDailyBudget.toFixed(2)} based on month-to-date spend.`
          : `$${settings.monthlyBudget} ÷ ${ACTIVE_DAYS_PER_MONTH} active days`}</span></span>
      </div>
      <div class="card-value"${budgetAdjusted ? ` style="color:${dailyBudget < flatDailyBudget ? 'var(--vscode-editorWarning-foreground)' : 'var(--vscode-testing-iconPassed)'}"` : ''}>$${dailyBudget.toFixed(2)} <span class="card-unit">/ day</span></div>
    </div>
    <div class="card">
      <div class="card-label">Month Spend
        <span class="info-badge">i<span class="tooltip">${PLANS[settings.subscription]?.note ?? "Custom budget"}</span></span>
      </div>
      <div class="card-value" style="${monthPct >= 100 ? 'color:var(--vscode-errorForeground)' : ''}">$${settings.monthSpend.toFixed(2)} <span class="card-unit">/ $${settings.monthlyBudget}</span></div>
    </div>
    <div class="card">
      <div class="card-label">Current Model</div>
      <div class="card-value" style="font-size:14px; font-family:var(--vscode-editor-font-family); ${settings.currentModel.toLowerCase() !== 'auto' && settings.currentModel !== 'unknown' ? 'color:var(--vscode-editorWarning-foreground)' : ''}">${settings.currentModel}</div>
    </div>
    <div class="card">
      <div class="card-label">Warn At</div>
      <div class="card-value">${settings.warnThreshold}<span class="card-unit">%</span></div>
    </div>
  </div>
</div>

<div class="section">
  <div class="section-title">Model Prices <span style="font-weight:400;text-transform:none">(from prices.json)</span></div>
  <div style="position:relative">
    <div class="table-overlay" id="tableOverlay"></div>
    ${hasPrices ? `
    <table>
      <thead>
        <tr>
          <th>Model</th>
          <th>$ / 1M tokens</th>
          <th>Based on
            <span class="info-badge">i<span class="tooltip">How many on-demand tokens were used to infer this price. More tokens = higher confidence.</span></span>
          </th>
        </tr>
      </thead>
      <tbody>${modelRows}</tbody>
    </table>
    <p class="hint">Run <code>python scripts/infer_prices.py</code> to update prices from your usage data.</p>` 
    : `<p class="empty">No prices loaded. Run <code>python scripts/infer_prices.py</code> to generate prices.json.</p>`}
  </div>
</div>

<div class="section">
  <div class="section-title">Settings</div>
  <div class="settings-grid">
    <div class="field" style="grid-column: 1 / -1">
      <label>Subscription Plan</label>
      <select id="subscription" onchange="onSubscriptionChange(this.value)">
        <option value="hobby"    ${settings.subscription === "hobby"    ? "selected" : ""}>Hobby — Free</option>
        <option value="pro"      ${settings.subscription === "pro"      ? "selected" : ""}>Pro — $20/mo (~$20 in credits)</option>
        <option value="pro_plus" ${settings.subscription === "pro_plus" ? "selected" : ""}>Pro+ — $60/mo (~$60 in credits)</option>
        <option value="ultra"    ${settings.subscription === "ultra"    ? "selected" : ""}>Ultra — $200/mo (~$400 in credits)</option>
        <option value="teams"    ${settings.subscription === "teams"    ? "selected" : ""}>Teams — $40/user/mo (~$40 in credits)</option>
        <option value="custom"   ${settings.subscription === "custom"   ? "selected" : ""}>Custom</option>
      </select>
    </div>
    <div class="field">
      <label>
        Effective Monthly Budget ($)
        <span class="info-badge">i<span class="tooltip">${PLANS[settings.subscription]?.note ?? "Set your own budget"}</span></span>
      </label>
      <input type="number" id="monthlyBudget" value="${settings.monthlyBudget}" min="0" ${settings.subscription !== "custom" ? 'readonly style="opacity:0.6"' : ""} />
    </div>
    <div class="field">
      <label>Warn Threshold (%)</label>
      <input type="number" id="warnThreshold" value="${settings.warnThreshold}" min="1" max="100" />
    </div>
  </div>
  <div class="actions" style="margin-top:14px">
    <button onclick="saveSettings()">Save Settings</button>
  </div>
</div>

<script>
  const vscode = acquireVsCodeApi();
  const PLANS = ${JSON.stringify(PLANS)};
  const ACTIVE_DAYS_PER_MONTH = ${ACTIVE_DAYS_PER_MONTH};
  function onSubscriptionChange(plan) {
    const info = PLANS[plan];
    const input = document.getElementById('monthlyBudget');
    if (info && info.effectiveBudget !== null) {
      input.value = info.effectiveBudget;
      input.readOnly = true;
      input.style.opacity = '0.6';
    } else {
      input.readOnly = false;
      input.style.opacity = '1';
    }
  }
  function saveSettings() {
    vscode.postMessage({
      type: 'saveSettings',
      subscription: document.getElementById('subscription').value,
      monthlyBudget: +document.getElementById('monthlyBudget').value,
      warnThreshold: +document.getElementById('warnThreshold').value,
    });
  }
  function refresh() {
    const btn = document.getElementById('refreshBtn');
    const overlay = document.getElementById('tableOverlay');
    const synced = document.getElementById('lastSynced');
    btn.classList.add('spinning');
    btn.disabled = true;
    btn.style.pointerEvents = 'none';
    if (overlay) overlay.classList.add('visible');
    if (synced) synced.textContent = 'Syncing...';
    vscode.postMessage({ type: 'refresh' });
  }
</script>
</body>
</html>`;
}

export function deactivate() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = undefined;
  }
}
