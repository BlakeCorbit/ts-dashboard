# Shop Reactivation Wizard

Guided workflow that automates the multi-step shop reactivation process.

## Current Manual Process (5 steps)

1. SQL query to check deactivation date
2. Execute stored procedure to reactivate
3. Verify POS integration (Partner API or Binary)
4. Recover Mailgun domain and Twilio phone number
5. Test email and text messaging

## What This Automates

Single interface (Retool app or web UI) where you:

1. Enter ShopID
2. Click "Check Status" → shows deactivation date, POS type, integration status
3. Click "Reactivate" → runs the stored proc, checks integration
4. Auto-detects if Twilio number was released or Mailgun domain was removed
5. Offers one-click recovery for each (repurchase number, re-add domain, run SetupShop API)
6. Auto-runs cache clearing on all 4 URLs
7. Sends test email and text, shows results
8. Generates a summary of what was done for the ticket

## Status

Planned — scaffold only.

## Dependencies

- SQL Server access (avdbprod)
- Twilio API
- Mailgun API
- shop.autovitals.com cache clear endpoints
- tvpxapp1/tvpxapp2 cache clear endpoints
