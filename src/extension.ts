import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { getSessionToken } from "./auth";
import { fetchCalibration } from "./api";

let statusBarItem: vscode.StatusBarItem;
let dashboardPanel: vscode.WebviewPanel | undefined;

function getCalibrationPath(context: vscode.ExtensionContext): string {
  return path.join(context.globalStorageUri.fsPath, "cost_calibration.json");
}

export function activate(context: vscode.ExtensionContext) {
  // Ensure global storage directory exists
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
    })
  );

  // In development, auto-refresh on every activation so F5 always gives fresh data
  if (context.extensionMode === vscode.ExtensionMode.Development) {
    void runRefresh(context);
  }
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
      cfg.update("monthlyBudget", msg.monthlyBudget, true);
      cfg.update("workingHoursPerDay", msg.workingHoursPerDay, true);
      cfg.update("warnThreshold", msg.warnThreshold, true);
      cfg.update("historyDays", msg.historyDays, true);
      vscode.window.showInformationMessage("Cursor Pace settings saved.");
      updateWebview(context);
    }
  });

  updateWebview(context);
}

function updateWebview(context: vscode.ExtensionContext) {
  if (!dashboardPanel) return;

  const calibrationPath = getCalibrationPath(context);
  let calibration: Record<string, unknown> = {};
  let lastSyncedAt: Date | null = null;

  if (fs.existsSync(calibrationPath)) {
    try {
      calibration = JSON.parse(fs.readFileSync(calibrationPath, "utf8"));
      lastSyncedAt = fs.statSync(calibrationPath).mtime;
    } catch {
      // ignore parse errors
    }
  }

  const cfg = vscode.workspace.getConfiguration("cursorPace");
  const meta = (calibration as Record<string, unknown>)["_meta"] as { activeDays?: number; historyDays?: number } | undefined;
  const settings = {
    monthlyBudget: cfg.get<number>("monthlyBudget", 200),
    workingHoursPerDay: cfg.get<number>("workingHoursPerDay", 8),
    warnThreshold: cfg.get<number>("warnThreshold", 80),
    historyDays: cfg.get<number>("historyDays", 90),
    activeDays: meta?.activeDays ?? null,
  };

  dashboardPanel.webview.html = getWebviewHtml(calibration, settings, lastSyncedAt);
}

async function runRefresh(context: vscode.ExtensionContext) {
  statusBarItem.text = "$(sync~spin) Refreshing...";
  try {
    const token = await getSessionToken(context.extensionPath);
    const historyDays = vscode.workspace.getConfiguration("cursorPace").get<number>("historyDays", 90);
    const calibration = await fetchCalibration(token, historyDays);
    const calibrationPath = getCalibrationPath(context);
    fs.writeFileSync(calibrationPath, JSON.stringify(calibration, null, 2));
    statusBarItem.text = "$(pulse) Cursor Pace";
    vscode.window.showInformationMessage("Cursor Pace: Data refreshed.");
    updateWebview(context);
  } catch (err: unknown) {
    statusBarItem.text = "$(error) Cursor Pace";
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

function getWebviewHtml(
  calibration: Record<string, unknown>,
  settings: {
    monthlyBudget: number;
    workingHoursPerDay: number;
    warnThreshold: number;
    historyDays: number;
    activeDays: number | null;
  },
  lastSyncedAt: Date | null
): string {
  // Scale active days from history window to a 30-day month equivalent
  const activeDaysPerMonth = settings.activeDays !== null
    ? Math.round(settings.activeDays / settings.historyDays * 30)
    : 22;
  const hourlyBudget = settings.monthlyBudget / (activeDaysPerMonth * settings.workingHoursPerDay);

  type ModelStats = {
    requests: number;
    total_tokens: number;
    on_demand_cost: number;
    on_demand_tokens: number;
    included_tokens: number;
    cost_per_token: number | null;
    total_estimated_cost: number | null;
  };

  const modelEntries = Object.entries(calibration as Record<string, ModelStats>)
    .filter(([key]) => key !== "_meta");

  const models = modelEntries
    .filter(([, s]) => s.cost_per_token !== null)
    .sort((a, b) => (b[1].total_estimated_cost ?? 0) - (a[1].total_estimated_cost ?? 0));

  const noDataModels = modelEntries
    .filter(([, s]) => s.cost_per_token === null);

  const hasData = models.length > 0;

  const modelRows = models
    .map(([name, s]) => {
      const cpt = s.cost_per_token!;
      const cptPer1M = (cpt * 1_000_000).toFixed(4);
      const estCost = s.total_estimated_cost?.toFixed(2) ?? "—";
      const reqsPerHour = Math.floor(hourlyBudget / (cpt * (s.total_tokens / s.requests)));
      return `
      <tr>
        <td class="model-name">${name}</td>
        <td>${s.requests.toLocaleString()}</td>
        <td>$${cptPer1M}</td>
        <td>$${estCost}</td>
        <td>${reqsPerHour > 0 ? `~${reqsPerHour}/hr` : "<1/hr"}</td>
      </tr>`;
    })
    .join("");

  const noDataRows = noDataModels
    .map(([name, s]) => `
      <tr class="muted">
        <td class="model-name">${name}</td>
        <td>${s.requests.toLocaleString()}</td>
        <td>—</td>
        <td>—</td>
        <td>—</td>
      </tr>`)
    .join("");

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
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: var(--vscode-font-family); font-size: 13px; color: var(--fg); background: var(--bg); padding: 24px; }
  h1 { font-size: 20px; font-weight: 600; margin-bottom: 4px; }
  .subtitle { color: var(--muted); margin-bottom: 24px; font-size: 12px; }
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
  tr.muted td { color: var(--muted); }
  .settings-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; max-width: 480px; }
  .field label { display: block; font-size: 11px; color: var(--muted); margin-bottom: 4px; }
  .field input { width: 100%; background: var(--input-bg); color: var(--input-fg); border: 1px solid var(--input-border, var(--border)); border-radius: 3px; padding: 5px 8px; font-size: 13px; outline: none; }
  .field input:focus { border-color: var(--highlight); }
  .field select { width: 100%; background: var(--input-bg); color: var(--input-fg); border: 1px solid var(--input-border, var(--border)); border-radius: 3px; padding: 5px 8px; font-size: 13px; outline: none; appearance: none; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23888' d='M6 8L1 3h10z'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 8px center; cursor: pointer; }
  .field select:focus { border-color: var(--highlight); }
  .actions { display: flex; gap: 8px; margin-top: 6px; }
  button { background: var(--btn-bg); color: var(--btn-fg); border: none; border-radius: 3px; padding: 6px 14px; font-size: 12px; cursor: pointer; }
  button:hover { background: var(--btn-hover); }
  button.secondary { background: transparent; color: var(--fg); border: 1px solid var(--border); }
  button.secondary:hover { background: var(--table-header); }
  .empty { color: var(--muted); padding: 20px 0; }
  .info-badge { display: inline-flex; align-items: center; justify-content: center; width: 14px; height: 14px; border-radius: 50%; border: 1px solid var(--muted); color: var(--muted); font-size: 10px; font-weight: 700; cursor: default; position: relative; margin-left: 5px; vertical-align: middle; line-height: 1; }
  .info-badge:hover .tooltip { display: block; }
  .tooltip { display: none; position: absolute; bottom: calc(100% + 6px); left: 50%; transform: translateX(-50%); background: var(--vscode-editorHoverWidget-background, #252526); border: 1px solid var(--vscode-editorHoverWidget-border, #454545); color: var(--vscode-editorHoverWidget-foreground, #ccc); font-size: 11px; font-weight: 400; padding: 6px 10px; border-radius: 4px; white-space: nowrap; z-index: 10; pointer-events: none; }
</style>
</head>
<body>
<h1>Cursor Pace</h1>
<p class="subtitle">Track and pace your Cursor AI spending &nbsp;·&nbsp; Last synced: ${lastSyncedAt ? timeSince(lastSyncedAt) : "never"}</p>

<div class="section">
  <div class="section-title">Hourly Pace</div>
  <div class="pace-card">
    <div class="card">
      <div class="card-label">Monthly Budget</div>
      <div class="card-value">$${settings.monthlyBudget} <span class="card-unit">/ mo</span></div>
    </div>
    <div class="card">
      <div class="card-label">Active Days
        <span class="info-badge">i<span class="tooltip">Days with requests ≥ (avg − 1 std dev) in your history.&#10;Excludes very low-usage days, keeps crunch days.</span></span>
      </div>
      <div class="card-value">${activeDaysPerMonth} <span class="card-unit">/ mo</span></div>
    </div>
    <div class="card">
      <div class="card-label">Hourly Budget</div>
      <div class="card-value">$${hourlyBudget.toFixed(2)} <span class="card-unit">/ hr</span></div>
    </div>
    <div class="card">
      <div class="card-label">Warn At</div>
      <div class="card-value">${settings.warnThreshold}<span class="card-unit">%</span></div>
    </div>
  </div>
</div>

<div class="section">
  <div class="section-title">Model Cost Data <span style="font-weight:400;text-transform:none">(last ${settings.historyDays === 90 ? "3 months" : "30 days"})</span></div>
  ${hasData ? `
  <table>
    <thead>
      <tr>
        <th>Model</th>
        <th>Requests</th>
        <th>Cost / 1M tokens</th>
        <th>Est. 30-day cost</th>
        <th>Pace at budget</th>
      </tr>
    </thead>
    <tbody>
      ${modelRows}
      ${noDataRows}
    </tbody>
  </table>` : `<p class="empty">No calibration data yet. Click Refresh to fetch usage data.</p>`}
</div>

<div class="section">
  <div class="section-title">Settings</div>
  <div class="settings-grid">
    <div class="field">
      <label>Monthly Budget ($)</label>
      <input type="number" id="monthlyBudget" value="${settings.monthlyBudget}" min="1" />
    </div>
    <div class="field">
      <label>Working Hours / Day</label>
      <input type="number" id="workingHoursPerDay" value="${settings.workingHoursPerDay}" min="1" max="24" />
    </div>
    <div class="field">
      <label>Warn Threshold (%)</label>
      <input type="number" id="warnThreshold" value="${settings.warnThreshold}" min="1" max="100" />
    </div>
    <div class="field" style="grid-column: 1 / -1">
      <label>Price History Window</label>
      <select id="historyDays">
        <option value="30" ${settings.historyDays !== 90 ? "selected" : ""}>Last 30 days</option>
        <option value="90" ${settings.historyDays === 90 ? "selected" : ""}>Last 3 months</option>
      </select>
    </div>
  </div>
  <div class="actions" style="margin-top:14px">
    <button onclick="saveSettings()">Save Settings</button>
    <button class="secondary" onclick="refresh()">↺ Refresh Data</button>
  </div>
</div>

<script>
  const vscode = acquireVsCodeApi();
  function saveSettings() {
    vscode.postMessage({
      type: 'saveSettings',
      monthlyBudget: +document.getElementById('monthlyBudget').value,
      workingHoursPerDay: +document.getElementById('workingHoursPerDay').value,
      warnThreshold: +document.getElementById('warnThreshold').value,
      historyDays: +document.getElementById('historyDays').value,
    });
  }
  function refresh() {
    vscode.postMessage({ type: 'refresh' });
  }
</script>
</body>
</html>`;
}

export function deactivate() {}
