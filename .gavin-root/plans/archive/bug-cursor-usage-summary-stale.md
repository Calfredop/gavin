---
order: 8192
labels: bug
title: [bug] Cursor usage shows empty after usage-summary went stale
status: Done
complexity: moderate
---
Cursor limits in the usage panel are wrong or empty. Gavin still probed `GET https://cursor.com/api/usage-summary` with a session cookie; that endpoint answers 200 with `totalPercentUsed`/`auto`/`api` all 0 while DashboardService still has real percentages.

## Diagnosis

- [x] Live compare: cookie `usage-summary` → 0%; Bearer `GetCurrentPeriodUsage` → ~26% + displayMessage
- [x] Switch Cursor probe to `POST https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage` with Bearer token + Connect-Protocol-Version: 1
- [x] Parse `planUsage` percents + ms `billingCycleEnd`; keep capped on-demand from `spendLimitUsage` when present
- [x] Update unit fixtures; keep old usage-summary shape parsing as fallback
- [x] Human test: after rebuilding the desktop app, open the usage panel — Cursor Total/Auto should match cursor.com dashboard (~26% on this account), not 0%
  Result (2026-10-21): passed
