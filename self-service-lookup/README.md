# Self-Service Lookup

Self-service portal for common phone call requests: welcome codes, shop info, platform type, app install instructions.

## What It Does

Provides a simple web interface (or Zendesk bot) that handles the most common phone support requests:

1. **Welcome/Personal Codes** — Enter shop name, phone, or ID → get codes instantly
2. **Platform Type** — Shows whether shop is on Legacy TVP, TVP.x, or Data.x (Hybrid)
3. **Web Portal URL** — Generates the correct login URL for the shop's platform
4. **App Install Instructions** — Step-by-step with the shop's specific welcome code pre-filled
5. **Existing Ticket Status** — Check on an open ticket without calling

## Data Source

Queries the same data as shop.autovitals.com > View EIS Shops, but exposed through a simpler interface.

## Status

Planned — scaffold only.

## Options

- **Zendesk Answer Bot** — Integrate with Zendesk's AI to deflect tickets
- **Standalone web page** — Simple Node.js app with search
- **Slack bot** — For internal team use (Brien/Jacob can look up codes without navigating the admin portal)
