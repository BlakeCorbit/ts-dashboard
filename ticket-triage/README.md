# Ticket Triage

AI-powered Zendesk ticket categorization, routing, and auto-response suggestions.

## What It Does

1. **Auto-categorize** incoming tickets by type (POS integration, email/SMS, login, BayIQ, etc.)
2. **Auto-tag** with POS system, severity, and affected component
3. **Suggest resolution** — matches ticket to known issues and links to the correct Confluence runbook
4. **Auto-apply macros** for common scenarios (e.g., BayIQ password reset, welcome code request)
5. **Priority detection** — flags tickets from at-risk accounts (integrates with Salesforce)

## Approach

- Use Claude API or OpenAI to classify ticket text against known categories
- Match against a curated list of known issues and their resolution steps
- Fall back to keyword matching for simpler cases (reuse logic from `incident-detector`)

## Status

Planned — scaffold only.

## Dependencies

- Zendesk API (webhooks for new tickets, update API for tags/macros)
- Claude/OpenAI API for classification
- Confluence API for runbook links
- Salesforce API for account risk flags
