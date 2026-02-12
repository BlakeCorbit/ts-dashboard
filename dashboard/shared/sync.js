// sync.js — Cross-tab state synchronization via BroadcastChannel
// Keeps multiple open tabs in sync when actions are taken
(function(){
'use strict';

var channel = null;
var handlers = {};
var tabId = Math.random().toString(36).slice(2, 8);

try {
  channel = new BroadcastChannel('ts-command-center');
  channel.onmessage = function(e) {
    if (!e.data || e.data.tab === tabId) return; // ignore own messages
    var list = handlers[e.data.type] || [];
    list.forEach(function(fn) {
      try { fn(e.data.data, e.data); } catch(err) { console.warn('sync handler error:', err); }
    });
  };
} catch(err) {
  // BroadcastChannel not supported — degrade silently
  console.warn('BroadcastChannel not available:', err.message);
}

window.CC = window.CC || {};
CC.sync = {
  tabId: tabId,

  // Broadcast an event to all other tabs
  emit: function(type, data) {
    if (!channel) return;
    try {
      channel.postMessage({ type: type, data: data, tab: tabId, at: Date.now() });
    } catch(e) {}
  },

  // Listen for events from other tabs
  on: function(type, callback) {
    handlers[type] = handlers[type] || [];
    handlers[type].push(callback);
  },

  // Remove listener
  off: function(type, callback) {
    if (!handlers[type]) return;
    handlers[type] = handlers[type].filter(function(fn) { return fn !== callback; });
  },
};

})();
