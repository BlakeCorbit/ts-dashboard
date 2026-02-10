/**
 * Triage rules engine.
 * Maps ticket patterns to categories, runbooks, and suggested actions.
 * Built from actual Confluence documentation and real ticket data.
 */

// Tags to ignore entirely
const IGNORE_TAGS = ['twilio_rejected', 'twilio_category', 'web', 'website', 'voicemail'];

// ─── TRIAGE RULES ────────────────────────────────────────────
// Each rule has:
//   match: function(ticket) -> boolean
//   category: string
//   subcategory: string
//   runbook: { title, url } (Confluence page)
//   suggestedAction: string (what to do)
//   priority: string (suggested priority if not already set)
//   autoTags: string[] (tags to add)

const RULES = [
  // ── ROs NOT SHOWING ──────────────────────────────────
  {
    name: 'ro-not-showing-napa',
    match: (t) => matchesAny(t, ['ro not showing', 'ro not transferr', 'ro not coming', 'ro not populating', 'ros not showing', 'ros not transfer', 'not showing up', 'not populating', 'not transferring', 'data transfer delay'])
      && matchesPOS(t, ['napaenterprise', 'napa_binary', 'napa', 'tracs']),
    category: 'POS Integration',
    subcategory: 'ROs Not Showing - NAPA TRACS',
    runbook: { title: 'Binary Troubleshooting', url: 'https://autovitals.atlassian.net/wiki/spaces/TS/pages/2505408515' },
    suggestedAction: 'Check Binary health in Retool (Broken Shop App). Verify NAPA TRACS binary client running on shop server. Check #alerts-bin-service for recent alerts.',
    priority: 'high',
    autoTags: ['triage_ro_missing', 'triage_napa'],
  },
  {
    name: 'ro-not-showing-mitchell',
    match: (t) => matchesAny(t, ['ro not showing', 'ro not transferr', 'ro not coming', 'ro not populating', 'ros not showing', 'not showing up', 'not transferring', 'not populating', 'data transfer delay'])
      && matchesPOS(t, ['mitchell_binary', 'mitchell', 'shopkey', 'av sync', 'avsync']),
    category: 'POS Integration',
    subcategory: 'ROs Not Showing - Mitchell/AV Sync',
    runbook: { title: 'AV Sync: Troubleshooting & Support', url: 'https://autovitals.atlassian.net/wiki/spaces/TS/pages/1273921601' },
    suggestedAction: 'Check if AV Sync shop (shop.autovitals.com > EIS > check AV Sync column). If AV Sync: check service status. If Binary: use Retool Broken Shop App.',
    priority: 'high',
    autoTags: ['triage_ro_missing', 'triage_mitchell'],
  },
  {
    name: 'ro-not-showing-protractor',
    match: (t) => matchesAny(t, ['ro not showing', 'ro not transferr', 'ro not coming', 'ro not populating', 'ros not showing', 'not showing up', 'not transferring', 'not populating', 'data transfer delay'])
      && matchesPOS(t, ['protractor_partner_api', 'protractor']),
    category: 'POS Integration',
    subcategory: 'ROs Not Showing - Protractor',
    runbook: { title: 'SOP: Retool - Simple Broken Shop v2', url: 'https://autovitals.atlassian.net/wiki/spaces/TS/pages/2558230545' },
    suggestedAction: 'Use Retool Broken Shop App with Shop ID. Partner API shop — check Partner API health. Verify shop config in Partner API admin.',
    priority: 'high',
    autoTags: ['triage_ro_missing', 'triage_protractor'],
  },
  {
    name: 'ro-not-showing-tekmetric',
    match: (t) => matchesAny(t, ['ro not showing', 'ro not transferr', 'ro not coming', 'ro not populating', 'ros not showing', 'not showing up', 'not transferring', 'not populating', 'data transfer delay'])
      && matchesPOS(t, ['tekmetric_partner_api', 'tekmetric_pos', 'tekmetric']),
    category: 'POS Integration',
    subcategory: 'ROs Not Showing - Tekmetric',
    runbook: { title: 'SOP: Retool - Simple Broken Shop v2', url: 'https://autovitals.atlassian.net/wiki/spaces/TS/pages/2558230545' },
    suggestedAction: 'Use Retool Broken Shop App. Partner API shop — check if Tekmetric API key still valid. Check for vehicle merge scenario.',
    priority: 'high',
    autoTags: ['triage_ro_missing', 'triage_tekmetric'],
  },
  {
    name: 'ro-not-showing-winworks',
    match: (t) => matchesAny(t, ['ro not showing', 'ro not transferr', 'ro not coming', 'ro not populating', 'ros not showing', 'not showing up', 'not transferring', 'not populating', 'data transfer delay'])
      && matchesPOS(t, ['winworks_binary', 'winworks']),
    category: 'POS Integration',
    subcategory: 'ROs Not Showing - Winworks',
    runbook: { title: 'Winworks Integration Troubleshooting Guide', url: 'https://autovitals.atlassian.net/wiki/spaces/TS/pages/2602795018' },
    suggestedAction: 'Follow Winworks troubleshooting guide. Check Status ID (0-5), verify SMSWebCommunicator service, test connectivity (ping/telnet/HTTP). Escalate to Michael Krits/Slav if needed.',
    priority: 'high',
    autoTags: ['triage_ro_missing', 'triage_winworks'],
  },
  {
    name: 'ro-not-showing-rowriter',
    match: (t) => matchesAny(t, ['ro not showing', 'ro not transferr', 'ro not coming', 'ro not populating', 'ros not showing', 'not showing up', 'not transferring', 'not populating', 'data transfer delay'])
      && matchesPOS(t, ['rowriter_binary', 'ro writer', 'rowriter']),
    category: 'POS Integration',
    subcategory: 'ROs Not Showing - RO Writer',
    runbook: { title: 'Binary Troubleshooting', url: 'https://autovitals.atlassian.net/wiki/spaces/TS/pages/2505408515' },
    suggestedAction: 'Use Retool Broken Shop App. Binary integration — check FTP data flow, verify binary client on shop server.',
    priority: 'high',
    autoTags: ['triage_ro_missing', 'triage_rowriter'],
  },
  {
    name: 'ro-not-showing-generic',
    match: (t) => matchesAny(t, ['ro not showing', 'ro not transferr', 'ro not coming', 'ro not populating', 'ros not showing', 'not showing up in autovital', 'not transferring', 'not populating', 'data transfer delay', 'no tiles', 'tiles not']),
    category: 'POS Integration',
    subcategory: 'ROs Not Showing - Unknown POS',
    runbook: { title: 'SOP: Retool - Simple Broken Shop v2', url: 'https://autovitals.atlassian.net/wiki/spaces/TS/pages/2558230545' },
    suggestedAction: 'Identify POS type first (shop.autovitals.com > EIS Shops). Then use Retool Broken Shop App. Follow Binary Troubleshooting or Partner API troubleshooting based on integration type.',
    priority: 'high',
    autoTags: ['triage_ro_missing'],
  },

  // ── OVERNIGHT COMPARE AND SYNC ──────────────────────
  {
    name: 'overnight-sync',
    match: (t) => matchesAny(t, ['overnight compare and sync', 'overnight compare & sync']),
    category: 'POS Integration',
    subcategory: 'Overnight Compare & Sync Alert',
    runbook: { title: 'Binary Troubleshooting', url: 'https://autovitals.atlassian.net/wiki/spaces/TS/pages/2505408515' },
    suggestedAction: 'Automated alert — check if shop data is now flowing. Use Retool to verify. If resolved overnight, close ticket. If still broken, escalate.',
    priority: 'normal',
    autoTags: ['triage_overnight_sync'],
  },

  // ── TEKMETRIC VEHICLE MERGE ──────────────────────────
  {
    name: 'tekmetric-merge',
    match: (t) => matchesAny(t, ['merge', 'merged vehicle', 'merged duplicate', 'history missing', 'lost history'])
      && matchesPOS(t, ['tekmetric_partner_api', 'tekmetric_pos', 'tekmetric']),
    category: 'Data Recovery',
    subcategory: 'Tekmetric Vehicle Merge',
    runbook: { title: 'Tekmetric Vehicle Merge Data Loss SOP', url: 'https://autovitals.atlassian.net/wiki/spaces/TS/pages/2565832707' },
    suggestedAction: 'Confirm merge with customer. Create JIRA ticket for Oleg with: SID, RO#, merge date, VIN, license plate, customer name. Send initial response template.',
    priority: 'high',
    autoTags: ['triage_data_recovery', 'triage_tekmetric_merge'],
  },

  // ── DELETED NOTES/IMAGES ─────────────────────────────
  {
    name: 'deleted-notes-images',
    match: (t) => matchesAny(t, ['deleted note', 'deleted image', 'missing note', 'missing image', 'notes disappeared', 'images disappeared', 'photos disappeared', 'lost notes', 'lost images', 'notes gone', 'images gone']),
    category: 'Data Recovery',
    subcategory: 'Deleted Notes/Images',
    runbook: { title: 'SOP: Recover Deleted Notes & Images', url: 'https://autovitals.atlassian.net/wiki/spaces/PM/pages/2569011243' },
    suggestedAction: 'Use Retool "Deleted Notes & Images Viewer v1" (requires VPN). Enter Shop ID and RO#. Recover and re-upload or email to shop.',
    priority: 'normal',
    autoTags: ['triage_data_recovery'],
  },

  // ── APP ISSUES (AV.X) ───────────────────────────────
  {
    name: 'avx-video-no-sound',
    match: (t) => matchesAny(t, ['video', 'sound', 'audio', 'no sound', 'no audio']),
    category: 'App Issue',
    subcategory: 'AV.X - Video No Sound',
    runbook: { title: 'Known AV.X Bugs and Issues', url: 'https://autovitals.atlassian.net/wiki/spaces/TS/pages/2811527169' },
    suggestedAction: 'Known bug in AV.X 6.9.6 — videos recording without sound. No fix yet. Document and link to existing JIRA if available.',
    priority: 'normal',
    autoTags: ['triage_avx_bug', 'triage_avx_video'],
  },
  {
    name: 'avx-crash-freeze',
    match: (t) => matchesAny(t, ['app crash', 'app freeze', 'app freez', 'freezing', 'crashing', 'glitch', 'lagging', 'lag', 'slow app', 'app not working', 'app half', 'white screen']),
    category: 'App Issue',
    subcategory: 'AV.X - Crash/Freeze/Performance',
    runbook: { title: 'Known AV.X Bugs and Issues', url: 'https://autovitals.atlassian.net/wiki/spaces/TS/pages/2811527169' },
    suggestedAction: 'Check known bugs list. Get device model, OS version, app version. Try: force close, clear cache, reinstall. If reproducible, create JIRA with steps.',
    priority: 'normal',
    autoTags: ['triage_avx_bug'],
  },
  {
    name: 'avx-camera-photo',
    match: (t) => matchesAny(t, ['camera', 'photo', 'picture', 'image not', 'upload', 'out of focus', 'blurry', 'not upload', 'media not upload']),
    category: 'App Issue',
    subcategory: 'AV.X - Camera/Photo/Upload',
    runbook: { title: 'Known AV.X Bugs and Issues', url: 'https://autovitals.atlassian.net/wiki/spaces/TS/pages/2811527169' },
    suggestedAction: 'Check known bugs. AV.X 6.9.6: image quality differs from preview. Get device info. Try: check storage space, permissions, restart app.',
    priority: 'normal',
    autoTags: ['triage_avx_bug', 'triage_avx_media'],
  },
  {
    name: 'image-editor-not-loading',
    match: (t) => matchesAny(t, ['image editor', 'notes editor', 'editor not loading', 'editor not working']),
    category: 'Platform Issue',
    subcategory: 'Image/Notes Editor Not Loading',
    runbook: null,
    suggestedAction: 'Check if issue is specific to one RO or all ROs. Try: clear cache (shop.autovitals.com/services/clearCache.asmx/Shop?shopid=X), verify browser compatibility.',
    priority: 'high',
    autoTags: ['triage_platform'],
  },

  // ── LOGIN / ACCESS ───────────────────────────────────
  {
    name: 'login-welcome-code',
    match: (t) => matchesAny(t, ['welcome code', 'personal code', 'login code', 'tablet code', 'what is my code', 'need code']),
    category: 'Login/Access',
    subcategory: 'Welcome/Personal Code Request',
    runbook: { title: 'Common Phone Support Requests', url: 'https://autovitals.atlassian.net/wiki/spaces/TS/pages/847740929' },
    suggestedAction: 'Look up: shop.autovitals.com > View EIS Shops > Find shop > Inspection tab > TVPx/tablet login codes. Send codes to requester.',
    priority: 'low',
    autoTags: ['triage_access', 'triage_welcome_code'],
  },
  {
    name: 'login-cant-access',
    match: (t) => matchesAny(t, ['can\'t log in', 'cannot log in', 'can\'t access', 'cannot access', 'locked out', 'login not working', 'unable to log', 'logs me out', 'tech login']),
    category: 'Login/Access',
    subcategory: 'Login Issues',
    runbook: { title: 'Common Phone Support Requests', url: 'https://autovitals.atlassian.net/wiki/spaces/TS/pages/847740929' },
    suggestedAction: 'Determine platform (TVP.x vs Legacy). Verify user exists in POS and AV. Try: update from POS button, verify welcome code, check if account active.',
    priority: 'normal',
    autoTags: ['triage_access'],
  },
  {
    name: 'add-tech-sa',
    match: (t) => matchesAny(t, ['add tech', 'new tech', 'add service advisor', 'new service advisor', 'tech not showing', 'add user', 'new employee']),
    category: 'Login/Access',
    subcategory: 'Add New Tech/SA',
    runbook: { title: 'Common Phone Support Requests', url: 'https://autovitals.atlassian.net/wiki/spaces/TS/pages/847740929' },
    suggestedAction: 'Must add in POS first, then AV picks them up. Admin clicks "update from POS" button. If code still not showing, click update button from code popup.',
    priority: 'low',
    autoTags: ['triage_access', 'triage_add_user'],
  },

  // ── EMAIL / SMS ──────────────────────────────────────
  {
    name: 'email-not-sending',
    match: (t) => matchesAny(t, ['email not send', 'email not deliver', 'email bouncing', 'mailgun', 'reminder not sent', 'checklist not sending', 'not receiving email']),
    category: 'Email/SMS',
    subcategory: 'Email Delivery Issues',
    runbook: { title: 'Email Issues and Troubleshooting', url: 'https://autovitals.atlassian.net/wiki/spaces/TS/pages/838270999' },
    suggestedAction: 'Identify email config type (AV-managed Google, promoted domain, or 3rd party). Check Mailgun domain status. Verify DNS records in Cloudflare/GoDaddy.',
    priority: 'normal',
    autoTags: ['triage_comms', 'triage_email'],
  },
  {
    name: 'sms-not-sending',
    match: (t) => matchesAny(t, ['text not send', 'sms not', 'text message not', 'not receiving text', 'twilio', 'messages not']),
    category: 'Email/SMS',
    subcategory: 'SMS/Text Delivery Issues',
    runbook: null,
    suggestedAction: 'Check Twilio number status in AMD (shop.autovitals.com). Verify messaging service configured. Check Twilio console for delivery errors. Test outbound message.',
    priority: 'normal',
    autoTags: ['triage_comms', 'triage_sms'],
  },

  // ── INSPECTION ISSUES ────────────────────────────────
  {
    name: 'inspection-issues',
    match: (t) => matchesAny(t, ['inspection', 'checklist', 'dvi', 'inspection sheet', 'inspection not', 'inspection coming up as completed']),
    category: 'Platform Issue',
    subcategory: 'Inspection Issues',
    runbook: null,
    suggestedAction: 'Determine specific issue: missing inspection, wrong status, template problem, or delivery issue. Check if inspection sheet configured correctly in shop settings.',
    priority: 'normal',
    autoTags: ['triage_platform', 'triage_inspection'],
  },

  // ── EMERGENCY (TAGGED) ──────────────────────────────
  {
    name: 'emergency-tagged',
    match: (t) => t.subject.toLowerCase().startsWith('(emergency)') || (t.tags || []).includes('high_slack'),
    category: 'Emergency',
    subcategory: 'Shop-Reported Emergency',
    runbook: { title: 'TS Emergency SOP v2', url: 'https://autovitals.atlassian.net/wiki/spaces/TS/pages/2821357573' },
    suggestedAction: 'Customer flagged as emergency. Prioritize. Check if part of a larger incident (3+ similar tickets). Follow Emergency SOP if pattern emerging.',
    priority: 'high',
    autoTags: ['triage_emergency'],
  },

  // ── BILLING / ACCOUNT ────────────────────────────────
  {
    name: 'billing-refund',
    match: (t) => matchesAny(t, ['refund', 'billing', 'cancel', 'payment', 'charge', 'invoice']),
    category: 'Account',
    subcategory: 'Billing/Cancellation',
    runbook: { title: 'Account Churn Process', url: 'https://autovitals.atlassian.net/wiki/spaces/PM/pages/911573388' },
    suggestedAction: 'Route to CS. Create Salesforce Task for CS Advisor. If cancellation: follow Account Churn Process. If billing question: check SaaS Optics.',
    priority: 'normal',
    autoTags: ['triage_account'],
  },

  // ── SMS / REMINDERS / TEXTS ───────────────────────────
  {
    name: 'sms-reminders',
    match: (t) => matchesAny(t, ['not getting text', 'not receiving text', 'reminder text', 'not sending text', 'appointment text', 'texts about appoint', 'av not sending reminder']),
    category: 'Email/SMS',
    subcategory: 'SMS Reminders Not Sending',
    runbook: null,
    suggestedAction: 'Check Twilio number in AMD. Verify messaging service. Check reminder settings in shop.autovitals.com > Settings > Communication. Test outbound message.',
    priority: 'normal',
    autoTags: ['triage_comms', 'triage_sms_reminder'],
  },

  // ── RO GENERIC (ticket says "RO" + number but doesn't say "not showing") ──
  {
    name: 'ro-generic',
    match: (t) => {
      const text = `${t.subject} ${t.description || ''}`.toLowerCase();
      return /\bro\s*#?\s*\d+/.test(text) || matchesAny(t, ['repair order', 'work order']);
    },
    category: 'POS Integration',
    subcategory: 'RO-Related Issue (Generic)',
    runbook: { title: 'SOP: Retool - Simple Broken Shop v2', url: 'https://autovitals.atlassian.net/wiki/spaces/TS/pages/2558230545' },
    suggestedAction: 'Ticket references a specific RO. Check if RO visible in TVP. If missing, follow broken shop diagnostic. If visible but wrong data, investigate specific fields.',
    priority: 'normal',
    autoTags: ['triage_ro_generic'],
  },

  // ── TABLET / TECHNICIAN NOT SHOWING ──────────────────
  {
    name: 'tablet-not-showing',
    match: (t) => matchesAny(t, ['not showing on tech', 'not on tablet', 'tech tablet', 'technician tablet', 'not showing up on tech', 'techs tablet']),
    category: 'POS Integration',
    subcategory: 'RO Not Showing on Tech Tablet',
    runbook: { title: 'SOP: Retool - Simple Broken Shop v2', url: 'https://autovitals.atlassian.net/wiki/spaces/TS/pages/2558230545' },
    suggestedAction: 'Check if RO is in TVP but not assigned to tech, or if data not flowing at all. Verify tech is added in POS and AV. Try update from POS.',
    priority: 'high',
    autoTags: ['triage_ro_missing', 'triage_tablet'],
  },

  // ── PASSWORD / SETTINGS ──────────────────────────────
  {
    name: 'password-reset',
    match: (t) => matchesAny(t, ['password', 'lost my password', 'forgot password', 'reset password', 'system settings password']),
    category: 'Login/Access',
    subcategory: 'Password Reset',
    runbook: { title: 'Common Phone Support Requests', url: 'https://autovitals.atlassian.net/wiki/spaces/TS/pages/847740929' },
    suggestedAction: 'Determine which system (TVP, BayIQ, POS admin). For TVP: look up codes in EIS Shops. For BayIQ: use terminal password reset. For shop settings: verify admin access.',
    priority: 'low',
    autoTags: ['triage_access', 'triage_password'],
  },

  // ── ADD USER (broader match) ─────────────────────────
  {
    name: 'add-user-broad',
    match: (t) => matchesAny(t, ['add a user', 'need to add', 'new user', 'i need to add']),
    category: 'Login/Access',
    subcategory: 'Add New User',
    runbook: { title: 'Common Phone Support Requests', url: 'https://autovitals.atlassian.net/wiki/spaces/TS/pages/847740929' },
    suggestedAction: 'Must add in POS first, then AV picks them up. Admin clicks "update from POS" button.',
    priority: 'low',
    autoTags: ['triage_access', 'triage_add_user'],
  },

  // ── TIME CLOCK / PAYROLL ─────────────────────────────
  {
    name: 'time-clock',
    match: (t) => matchesAny(t, ['time clock', 'clock in', 'clock out', 'payroll', 'tee time', 'teetimes', 'tee-time', 'job timer']),
    category: 'Platform Issue',
    subcategory: 'TeE-Times / Time Clock',
    runbook: null,
    suggestedAction: 'Check TeE-Times settings in shop.autovitals.com. Verify timer configuration. Common issue: job timer hours missing from report.',
    priority: 'normal',
    autoTags: ['triage_platform', 'triage_teetimes'],
  },

  // ── SLOW DAY BLAST ───────────────────────────────────
  {
    name: 'slow-day-blast',
    match: (t) => matchesAny(t, ['slow day blast', 'slow day']),
    category: 'Marketing',
    subcategory: 'Slow Day Blast',
    runbook: null,
    suggestedAction: 'Campaign Manager feature. Check campaign settings in campaignmanager2.autovitals.com. Verify shop has active campaign configured.',
    priority: 'low',
    autoTags: ['triage_marketing'],
  },

  // ── WEBSITE / PAGE REQUESTS ──────────────────────────
  {
    name: 'website-page-request',
    match: (t) => matchesAny(t, ['website', 'web page', 'landing page', 'radiator page', 'service page', 'needs page']),
    category: 'Website',
    subcategory: 'Website/Page Request',
    runbook: null,
    suggestedAction: 'Route to Web team (Web group in Zendesk). Check if DSX shop or standalone site.',
    priority: 'low',
    autoTags: ['triage_website'],
  },

  // ── VEHICLE ISSUES ───────────────────────────────────
  {
    name: 'vehicle-issue',
    match: (t) => matchesAny(t, ['vehicle changing', 'wrong vehicle', 'vehicle not', 'vin', 'license plate']),
    category: 'Platform Issue',
    subcategory: 'Vehicle Data Issue',
    runbook: null,
    suggestedAction: 'Check if vehicle data correct in POS. If vehicle switching/changing, could be VIN decoder issue or POS data mismatch.',
    priority: 'normal',
    autoTags: ['triage_platform', 'triage_vehicle'],
  },

  // ── BAYIQ ────────────────────────────────────────────
  {
    name: 'bayiq-rewards',
    match: (t) => matchesAny(t, ['rewards', 'bayiq', 'bay iq', 'loyalty', 'points']),
    category: 'BayIQ',
    subcategory: 'Rewards/BayIQ Issue',
    runbook: { title: 'Common BayIQ Support Tickets', url: 'https://autovitals.atlassian.net/wiki/spaces/PM/pages/960331777' },
    suggestedAction: 'Search All Rewards Users first. Common issues: registration, password reset, opt-out email addresses (pre-July 2023). Check BayIQ admin panel.',
    priority: 'low',
    autoTags: ['triage_bayiq'],
  },
];

// ─── HELPER FUNCTIONS ────────────────────────────────────────

function matchesAny(ticket, keywords) {
  const text = `${ticket.subject} ${ticket.description || ''}`.toLowerCase();
  return keywords.some(kw => text.includes(kw.toLowerCase()));
}

function matchesPOS(ticket, posIdentifiers) {
  const tags = (ticket.tags || []).map(t => t.toLowerCase());
  const text = `${ticket.subject} ${ticket.description || ''}`.toLowerCase();

  for (const id of posIdentifiers) {
    if (tags.includes(id)) return true;
    if (text.includes(id.toLowerCase())) return true;
  }
  return false;
}

// ─── TRIAGE ENGINE ───────────────────────────────────────────

class TriageEngine {
  constructor() {
    this.rules = RULES;
    this.ignoreTags = IGNORE_TAGS;
  }

  shouldIgnore(ticket) {
    return (ticket.tags || []).some(tag => this.ignoreTags.includes(tag.toLowerCase()));
  }

  /**
   * Triage a single ticket. Returns the first matching rule or a default.
   */
  triage(ticket) {
    if (this.shouldIgnore(ticket)) {
      return { ignored: true, reason: 'Matched ignore tag' };
    }

    for (const rule of this.rules) {
      try {
        if (rule.match(ticket)) {
          return {
            ignored: false,
            rule: rule.name,
            category: rule.category,
            subcategory: rule.subcategory,
            runbook: rule.runbook,
            suggestedAction: rule.suggestedAction,
            suggestedPriority: rule.priority,
            autoTags: rule.autoTags,
          };
        }
      } catch (err) {
        // Rule matching error — skip
        continue;
      }
    }

    return {
      ignored: false,
      rule: 'unmatched',
      category: 'Uncategorized',
      subcategory: 'No matching rule',
      runbook: null,
      suggestedAction: 'Manual review required. No automated triage rule matched this ticket.',
      suggestedPriority: null,
      autoTags: ['triage_unmatched'],
    };
  }

  /**
   * Triage a batch of tickets.
   */
  triageBatch(tickets) {
    return tickets.map(ticket => ({
      ticket,
      result: this.triage(ticket),
    }));
  }
}

module.exports = { TriageEngine };
