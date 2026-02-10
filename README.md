# AutoVitals Tech Support Automation

Automation toolkit for the AutoVitals Tech Support team. Each project lives in its own folder with independent setup and documentation.

## Projects

### Priority 1: Incident Response
| Project | Description | Status |
|---|---|---|
| [`incident-detector`](./incident-detector/) | Auto-detect incidents by clustering similar Zendesk tickets (3+ in a short window) | In Progress |
| [`incident-responder`](./incident-responder/) | One-click incident declaration: creates Zendesk Problem ticket, posts to Slack, updates StatusPage, creates TVP Special Message | Planned |
| [`auto-tag-and-bag`](./auto-tag-and-bag/) | Auto-link child tickets to Problem ticket and send customer message during incidents | Planned |

### Priority 2: Self-Service & Deflection
| Project | Description | Status |
|---|---|---|
| [`self-service-lookup`](./self-service-lookup/) | Self-service welcome code and shop info lookup to reduce phone call volume | Planned |
| [`ticket-triage`](./ticket-triage/) | AI-powered Zendesk ticket categorization, routing, and auto-response suggestions | Planned |

### Priority 3: Workflow Automation
| Project | Description | Status |
|---|---|---|
| [`shop-reactivation`](./shop-reactivation/) | Guided workflow for the multi-step shop reactivation process | Planned |
| [`data-recovery`](./data-recovery/) | Streamlined deleted notes/images recovery with one-click restore to TVP | Planned |
| [`tekmetric-merge-detector`](./tekmetric-merge-detector/) | Auto-detect Tekmetric vehicle merges and create JIRA recovery tickets | Planned |

### Priority 4: Monitoring & Dashboards
| Project | Description | Status |
|---|---|---|
| [`health-monitor`](./health-monitor/) | Proactive Twilio/Mailgun/POS health checks with alerting | Planned |
| [`pos-dashboard`](./pos-dashboard/) | Unified real-time POS integration health dashboard | Planned |
| [`auto-metrics`](./auto-metrics/) | Auto-generated weekly Zendesk metrics and reporting | Planned |

## Tech Stack

- **Runtime:** Node.js
- **APIs:** Zendesk, Jira, Slack, Twilio, Mailgun, StatusPage
- **Hosting:** TBD (could run on existing infra or as scheduled tasks)

## Getting Started

Each project has its own `README.md` with setup instructions. See individual project folders.
