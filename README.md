# Cursor Pace

A Cursor extension that tracks your AI spending and keeps you on budget, day by day.

Cursor subscriptions come with a pool of model credits each month, but there's no built-in way to pace yourself. Cursor Pace fetches your real usage data, computes per-model cost rates, and gives you a daily budget that adjusts dynamically. If you overspend early in the month, the remaining days get tighter. If you're frugal, they loosen up.

When you hit your daily limit, the extension nags you every 5 minutes to switch to `auto` (which is free) for the rest of the day.

## How it works

The extension reads your session token from Cursor's local database (no login required), fetches your usage history CSV from Cursor's dashboard API, and derives cost-per-token rates from on-demand rows. These rates are then applied to included-plan usage to estimate your real spend. For models with no price data, it assumes worst-case pricing so your budget is never understated.

Every 5 minutes, the extension refreshes and updates the status bar with your current daily usage percentage. The status bar turns yellow at your warn threshold and red when you're over your daily budget.

## Install

Download the latest `.vsix` from [Releases](../../releases), then:

```
cursor --install-extension cursor-pace-0.1.0.vsix
```

Or install from the command palette: `Extensions: Install from VSIX...`

## Development

```
npm install
npm run compile && cursor --extensionDevelopmentPath=C:\path\to\cursor-pace
```

## Configuration

Settings are available under `Cursor Pace` in the settings UI, or in the extension's dashboard (`Cursor Pace: Open Dashboard` from the command palette).

| Setting | Default | Description |
|---|---|---|
| `cursorPace.subscription` | `ultra` | Your Cursor plan, sets the effective monthly budget automatically |
| `cursorPace.monthlyBudget` | `200` | Monthly budget in USD (editable when plan is set to `custom`) |
| `cursorPace.warnThreshold` | `80` | Warn when daily spend reaches this % of daily budget |
| `cursorPace.historyDays` | `90` | How far back to fetch usage data for cost calibration (30 or 90 days) |
