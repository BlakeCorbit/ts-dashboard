# Incident Responder

One-click incident declaration that cascades updates to all systems simultaneously.

## What It Does

When you declare an incident (via Slack command or Retool button), it:

1. Creates a Zendesk **Problem** ticket with incident details
2. Posts standardized alert to Slack **#incident-updates** using your workflow template format
3. Updates **StatusPage** component status (DOWN)
4. Creates **TVP Special Message** (for full outages only)
5. Creates **JIRA INC** ticket linked to the Zendesk Problem
6. Optionally updates **voicemail** routing via RingCentral

When you resolve the incident, it reverses everything:
- StatusPage back to UP
- Removes TVP Special Message
- Posts resolution to #incident-updates
- Reverts voicemail

## Status

Planned — scaffold only. See `incident-detector` for the first working project.

## Dependencies

- Zendesk API
- Slack API (or Webhook)
- StatusPage API
- Jira API
- TVP Admin API (shop.autovitals.com)
- RingCentral API (optional, for voicemail)
