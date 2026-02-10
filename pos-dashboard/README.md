# POS Dashboard

Unified real-time dashboard showing the health of all POS integrations at a glance.

## What It Shows

- **All POS integrations** with current status (healthy/degraded/down)
- **Last data received** timestamp per shop
- **Data pipeline latency** (time between POS event and TVP availability)
- **Active incidents** and affected shops
- **Trend graphs** for data flow volume and latency
- **Quick filters** by POS type, status, shop name

## Data Source

Queries the same SQL monitoring data that powers the StatusPage alerts, but presents it in a unified view instead of scattered email alerts.

## Implementation Options

- **Retool dashboard** — fastest to build, already have access
- **Standalone web app** — more control, can be shared more broadly
- **Grafana** — if engineering already uses it for other monitoring

## Status

Planned — scaffold only.
