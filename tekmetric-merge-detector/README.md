# Tekmetric Merge Detector

Auto-detects when Tekmetric users merge vehicles (causing data loss in AutoVitals) and creates JIRA recovery tickets.

## The Problem

When a Tekmetric user merges duplicate vehicles, AutoVitals receives a "delete vehicle" command followed by a "vehicle update." The system processes the delete and removes all associated service history, inspections, and repair orders. Engineering is working on a permanent fix, but until then recovery is manual.

## What This Automates

1. **Monitor** the Partner API data pipeline for the delete+update pattern on Tekmetric shops
2. **Auto-detect** probable vehicle merges (delete followed by update on same customer within short window)
3. **Auto-create JIRA ticket** assigned to Oleg with all required info: SID, RO Number, Date, VIN, License Plate, Customer Name
4. **Auto-create Zendesk ticket** (or update existing) with initial customer communication using the approved template
5. **Track recovery status** — monitor JIRA ticket for completion, then auto-send confirmation email

## Status

Planned — scaffold only.

## Dependencies

- Partner API database monitoring (or listen to Azure Service Bus events)
- Jira API
- Zendesk API
