# Cursor Pace

VS Code/Cursor extension that tracks your Cursor AI spending and paces usage against an hourly budget. Fetches real usage data from Cursor's dashboard API and tells you how many requests per hour you can afford.

## Features

- Reads auth automatically from Cursor's local database — no login needed
- Fetches usage history (30 or 90 days) from Cursor's API
- Computes per-model cost rates from on-demand rows, extrapolates across included plan tokens
- Shows an hourly pace per model: how many requests/hr you can make and stay on budget
- Dashboard accessible via command palette (`Cursor Pace: Open Dashboard`)

## Setup

```bash
npm install
npm run compile
```

## Running in Development

```bash
npm run compile && cursor --extensionDevelopmentPath=C:\path\to\cursor-pace
```

## Configuration

All settings are available in VS Code settings under `Cursor Pace`:

| Setting | Default | Description |
|---|---|---|
| `cursorPace.subscription` | `ultra` | Your Cursor plan (hobby/pro/pro_plus/ultra/teams/custom) |
| `cursorPace.monthlyBudget` | `200` | Monthly budget in USD |
| `cursorPace.workingHoursPerDay` | `8` | Working hours/day for hourly pace calculation |
| `cursorPace.warnThreshold` | `80` | Warn at this % of hourly budget (not yet active) |
| `cursorPace.historyDays` | `90` | How far back to fetch usage data (30 or 90) |
