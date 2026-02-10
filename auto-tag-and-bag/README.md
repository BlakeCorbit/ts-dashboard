# Auto Tag-and-Bag

Automatically links child tickets to a Problem ticket during incidents and sends the approved customer message.

## What It Does

Once a Zendesk Problem ticket exists for an incident:

1. Monitors new incoming tickets in real-time
2. Matches tickets to the active incident (using the same clustering logic as `incident-detector`)
3. Automatically links matching tickets as children of the Problem ticket
4. Sends the approved customer message to each linked ticket
5. Logs all actions for audit trail

## Why This Matters

During incidents, one of your 3-person team is entirely dedicated to manually linking tickets ("Tag and Bag" role in the SOP). This frees that person up to help with Engineering coordination or customer communication instead.

## Status

Planned — scaffold only.

## Dependencies

- Zendesk API (ticket linking, public replies)
- Shares clustering logic with `incident-detector`
