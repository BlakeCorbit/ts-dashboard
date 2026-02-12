// Shared reply templates used by triage-queue.js and create-problem.js

const REPLY_TEMPLATES = {
  'ROs not showing': 'We are aware of an issue affecting {pos}repair order syncing and are actively investigating. Your ticket has been linked to our investigation (ZD#{problemId}). We will update you as we have more information. Thank you for your patience.',
  'Data not syncing': 'We are aware of an issue affecting {pos}data syncing and are actively investigating. Your ticket has been linked to our investigation (ZD#{problemId}). We will update you as we have more information.',
  'TVP issues': 'We are aware of a platform issue and are actively working on resolution. Your ticket has been linked to our investigation (ZD#{problemId}). We will update you shortly.',
  'Email delivery': 'We are aware of an email delivery issue and are working with our provider to resolve it. Your ticket has been linked to our investigation (ZD#{problemId}).',
  'SMS delivery': 'We are aware of a text messaging issue and are working with our provider to resolve it. Your ticket has been linked to our investigation (ZD#{problemId}).',
  'Login/access': 'We are aware of login/access issues and are actively investigating. Your ticket has been linked to our investigation (ZD#{problemId}).',
  'Inspection issues': 'We are aware of an issue with inspections/photos and are actively investigating. Your ticket has been linked to our investigation (ZD#{problemId}).',
  'Media upload': 'We are aware of a media upload issue and are actively investigating. Your ticket has been linked to our investigation (ZD#{problemId}).',
  'Camera/photo issues': 'We are aware of a camera/photo issue on the mobile app and are actively investigating. Your ticket has been linked to our investigation (ZD#{problemId}).',
  'Audio/video issues': 'We are aware of an audio/video issue and are actively investigating. Your ticket has been linked to our investigation (ZD#{problemId}).',
  'App freezing/crashing': 'We are aware of app stability issues and are actively investigating. Your ticket has been linked to our investigation (ZD#{problemId}).',
  'Notification issues': 'We are aware of a notification delivery issue and are actively investigating. Your ticket has been linked to our investigation (ZD#{problemId}).',
  'Performance/errors': 'We are aware of performance issues and are actively investigating. Your ticket has been linked to our investigation (ZD#{problemId}).',
};

const DEFAULT_TEMPLATE = 'We are aware of an issue ({pattern}) and are actively investigating. Your ticket has been linked to our investigation (ZD#{problemId}). We will update you as we have more information.';

function buildReply(errorPattern, problemId, pos) {
  const posPrefix = pos ? pos.charAt(0).toUpperCase() + pos.slice(1) + ' ' : '';
  let template = REPLY_TEMPLATES[errorPattern] || DEFAULT_TEMPLATE;
  return template
    .replace('{pos}', posPrefix)
    .replace('{problemId}', String(problemId))
    .replace('{pattern}', errorPattern || 'the reported issue');
}

module.exports = { REPLY_TEMPLATES, DEFAULT_TEMPLATE, buildReply };
