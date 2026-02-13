// keyboard.js — Global keyboard shortcut manager
// Manages focus ring for card-based navigation + registered shortcuts
(function(){
'use strict';

var shortcuts = {};
var focusedIndex = -1;
var focusedSection = null; // 'triage' | 'incidents' | null
var helpVisible = false;

function getCards() {
  if (focusedSection === 'triage') return document.querySelectorAll('.triage-queue-card:not([style*="opacity: 0.5"])');
  if (focusedSection === 'incidents') return document.querySelectorAll('.incident-card');
  return [];
}

function setFocus(section, index) {
  // Remove old focus
  var old = document.querySelector('.kb-focused');
  if (old) old.classList.remove('kb-focused');

  focusedSection = section;
  focusedIndex = index;

  if (index < 0 || !section) return;

  var cards = getCards();
  if (index >= cards.length) { focusedIndex = cards.length - 1; index = focusedIndex; }
  if (index < 0) return;

  var card = cards[index];
  if (card) {
    card.classList.add('kb-focused');
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

function moveFocus(delta) {
  // Default to triage section if nothing focused
  if (!focusedSection) focusedSection = 'triage';

  var cards = getCards();
  if (!cards.length) return;

  var next = focusedIndex + delta;
  if (next < 0) next = 0;
  if (next >= cards.length) next = cards.length - 1;

  setFocus(focusedSection, next);
}

function getFocusedCard() {
  var cards = getCards();
  if (focusedIndex >= 0 && focusedIndex < cards.length) return cards[focusedIndex];
  return null;
}

function getFocusedTicketId() {
  var card = getFocusedCard();
  if (!card || !card.id) return null;
  // triage cards have id="tq-XXXXX"
  var m = card.id.match(/^tq-(\d+)$/);
  return m ? parseInt(m[1], 10) : null;
}

function showHelp() {
  if (helpVisible) { hideHelp(); return; }
  helpVisible = true;

  var overlay = document.createElement('div');
  overlay.id = 'kb-help-overlay';
  overlay.onclick = hideHelp;

  var box = document.createElement('div');
  box.id = 'kb-help-box';
  box.onclick = function(e) { e.stopPropagation(); };

  var h = '<div style="font-size:1rem;font-weight:700;color:var(--av-green);margin-bottom:16px">Keyboard Shortcuts</div>';
  h += '<div style="display:grid;grid-template-columns:auto 1fr;gap:6px 16px">';

  var groups = {};
  for (var key in shortcuts) {
    var s = shortcuts[key];
    var g = s.group || 'General';
    if (!groups[g]) groups[g] = [];
    groups[g].push({ key: key, desc: s.desc });
  }

  for (var group in groups) {
    h += '<div style="grid-column:1/-1;font-size:0.72rem;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.08em;margin-top:10px">' + group + '</div>';
    groups[group].forEach(function(item) {
      var display = item.key.replace('ctrl+', 'Ctrl+').replace('shift+', 'Shift+');
      h += '<div><kbd style="font-family:var(--font-mono);font-size:0.78rem;padding:2px 8px;background:var(--bg-input);border:1px solid var(--border);border-radius:4px;color:var(--av-green);font-weight:600">' + display + '</kbd></div>';
      h += '<div style="font-size:0.82rem;color:var(--text-secondary)">' + item.desc + '</div>';
    });
  }

  h += '</div>';
  h += '<div style="margin-top:16px;font-size:0.72rem;color:var(--text-muted)">Press <kbd style="font-family:var(--font-mono);padding:1px 5px;background:var(--bg-input);border:1px solid var(--border);border-radius:3px">?</kbd> or <kbd style="font-family:var(--font-mono);padding:1px 5px;background:var(--bg-input);border:1px solid var(--border);border-radius:3px">Esc</kbd> to close</div>';
  box.innerHTML = h;
  overlay.appendChild(box);
  document.body.appendChild(overlay);
}

function hideHelp() {
  helpVisible = false;
  var el = document.getElementById('kb-help-overlay');
  if (el) el.remove();
}

// Public API
window.CC = window.CC || {};
CC.keyboard = {
  register: function(key, desc, callback, group) {
    shortcuts[key.toLowerCase()] = { desc: desc, fn: callback, group: group || 'General' };
  },
  getFocused: function() { return { section: focusedSection, index: focusedIndex }; },
  setFocus: setFocus,
  moveFocus: moveFocus,
  getFocusedCard: getFocusedCard,
  getFocusedTicketId: getFocusedTicketId,
  clearFocus: function() { setFocus(null, -1); },
  showHelp: showHelp,
  hideHelp: hideHelp,
};

document.addEventListener('keydown', function(e) {
  // Skip if user is typing in an input/textarea/select
  var tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    if (e.key === 'Escape') { e.target.blur(); return; }
    return;
  }

  var key = e.key.toLowerCase();
  if (key === ' ') key = 'space';
  if (e.ctrlKey || e.metaKey) key = 'ctrl+' + key;
  if (e.shiftKey && key.length > 1) key = 'shift+' + key;

  var s = shortcuts[key];
  if (s) {
    e.preventDefault();
    s.fn(e);
  }
});

})();
