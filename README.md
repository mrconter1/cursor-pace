# Cursor Pace

A Cursor extension that tracks your AI spending and keeps you on budget, day by day.

Cursor subscriptions come with a pool of model credits each month, but there's no built-in way to pace yourself. Cursor Pace fetches your real usage data, computes per-model cost rates, and gives you a daily budget that adjusts dynamically. If you overspend early in the month, the remaining days get tighter; if you're frugal, they loosen up.

When you're over your daily budget and not using `auto`, the extension shows a modal telling you to switch to auto. Soft warnings (e.g. approaching your daily limit) are shown at most every 30 minutes so you're not spammed.

## How it works

The extension reads your session token from Cursor's local database (no login required), fetches your usage history from Cursor's dashboard API, and derives cost-per-token rates from on-demand rows. Those rates are applied to included-plan usage to estimate spend. For models with no price data, it assumes worst-case pricing so your budget is never understated. The "current model" shown in the dashboard is taken from the most recent row in the usage export (what you last used), not from Cursor's settings.

Usage is refreshed every 30 seconds. The status bar shows your daily usage percentage and turns yellow at your warn threshold and red when you're over your daily budget. Click the status bar to open the dashboard: today's spend, daily budget (with month-to-date adjustment), month spend, current composer model, and a per-model cost table. Settings (subscription plan, monthly budget, warn threshold, history window) can be changed in the dashboard or in VS Code settings under Cursor Pace.

## Install

Download the latest `.vsix` from [Releases](https://github.com/mrconter1/cursor-pace/releases), then:

```
cursor --install-extension cursor-pace-0.1.0.vsix
```

Or install from the command palette: `Extensions: Install from VSIX...`

After installing, reload the window with `Ctrl+Shift+P` → `Developer: Reload Window`.

## Development

```
npm install
npm run compile && cursor --extensionDevelopmentPath=/path/to/cursor-pace
```

## Configuration

Settings are available under `Cursor Pace` in the settings UI, or in the extension's dashboard (`Cursor Pace: Open Dashboard` from the command palette).

| Setting | Default | Description |
|---|---|---|
| `cursorPace.subscription` | `ultra` | Your Cursor plan, sets the effective monthly budget automatically |
| `cursorPace.monthlyBudget` | `200` | Monthly budget in USD (editable when plan is set to `custom`) |
| `cursorPace.warnThreshold` | `80` | Warn when daily spend reaches this % of daily budget |
| `cursorPace.historyDays` | `90` | How far back to fetch usage data for cost calibration (30 or 90 days) |
