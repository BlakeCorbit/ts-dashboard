# Incident Detector

Monitors Zendesk ticket creation in real-time and auto-detects potential incidents by clustering similar tickets.

## How It Works

1. Polls Zendesk API every 60 seconds for new tickets
2. Extracts key features: POS type, error keywords, affected shop, subject/description text
3. Clusters tickets by similarity within a configurable time window (default: 15 minutes)
4. When 3+ similar tickets cluster together, fires an alert to Slack #emergency-updates
5. Includes ticket links, affected shops, and a suggested incident summary

## Setup

```bash
cd incident-detector
npm install
cp .env.example .env
# Fill in your Zendesk, Slack credentials in .env
```

## Configuration

Edit `.env`:
- `ZENDESK_SUBDOMAIN` - Your Zendesk subdomain (e.g., `bayiq`)
- `ZENDESK_EMAIL` - Agent email for API auth
- `ZENDESK_API_TOKEN` - Zendesk API token
- `SLACK_WEBHOOK_URL` - Slack incoming webhook for #emergency-updates
- `CLUSTER_THRESHOLD` - Number of similar tickets to trigger alert (default: 3)
- `CLUSTER_WINDOW_MINUTES` - Time window for clustering (default: 15)
- `POLL_INTERVAL_SECONDS` - How often to check for new tickets (default: 60)

## Running

```bash
# Development
npm run dev

# Production
npm start
```

## Alert Format

When an incident is detected, Slack receives:

```
:rotating_light: POTENTIAL INCIDENT DETECTED
Cluster: 4 tickets in 12 minutes
Pattern: POS Integration - Tekmetric - ROs not syncing
Affected shops: Shop A (SID 1234), Shop B (SID 5678), Shop C (SID 9012), Shop D (SID 3456)
Tickets: ZD#12345, ZD#12346, ZD#12347, ZD#12348
```
