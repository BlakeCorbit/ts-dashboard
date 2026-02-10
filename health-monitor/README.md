# Health Monitor

Proactive health checks for Twilio, Mailgun, and POS integrations — alert before customers notice.

## What It Monitors

### Twilio
- Is the phone number still active/purchased?
- Is the messaging service configured correctly?
- Are outbound messages being delivered? (check Twilio message logs for failures)
- Is call forwarding working?

### Mailgun
- Is the domain verified?
- Is the domain active (not disabled/suspended)?
- Are emails being delivered? (check Mailgun stats for bounce rates)
- Are DNS records still correct?

### POS Integrations
- Extends existing SQL monitoring with a unified dashboard view
- Tracks degradation trends (increasing delay between parsed/unparsed rows)
- Alerts on shops approaching the alert threshold before they breach it

## Alert Channels

- Slack #team-technical-support for TS-relevant issues
- Slack #alerts for engineering-level issues
- Daily digest email summarizing health across all shops

## Status

Planned — scaffold only.
