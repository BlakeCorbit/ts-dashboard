# Auto Metrics

Auto-generated weekly Zendesk metrics and reporting — no more manual data pulling.

## What It Generates

### Weekly Report (auto-sent every Monday)
- Total tickets opened/closed/backlog
- Tickets by category (POS, email/SMS, login, BayIQ, etc.)
- Average first response time
- Average resolution time
- Top 5 most common issues
- Incidents count and duration
- SLA compliance rate
- Tickets per team member

### Monthly Trends
- Ticket volume trend (is it growing?)
- Category breakdown trend (what's getting worse/better?)
- Resolution time trend
- Customer satisfaction (if CSAT enabled)

### Ad-hoc Queries
- "How many Tekmetric tickets did we get this month?"
- "What's our average response time for POS issues?"
- "Which shops create the most tickets?"

## Delivery

- Slack message to #team-technical-support (weekly summary)
- Email to Blake (full report)
- Dashboard in Retool or web app (interactive)

## Status

Planned — scaffold only.

## Dependencies

- Zendesk Reporting/Search API
- Slack API (for delivery)
