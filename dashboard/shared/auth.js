(function(){
'use strict';

var PASSCODE_KEY = 'av_passcode';

// Skip auth for local dev
var isLocal = location.protocol === 'file:' || (location.hostname === 'localhost' && !location.port);
if (isLocal) {
  window.CCAuth = {
    getToken: function(){ return null; },
    logout: function(){}
  };
  return;
}

function getStoredPasscode() {
  return localStorage.getItem(PASSCODE_KEY);
}

function showLoginOverlay() {
  var overlay = document.createElement('div');
  overlay.id = 'auth-overlay';
  overlay.innerHTML =
    '<div class="auth-card">' +
      '<img src="assets/av-logo-white.png" alt="AutoVitals" style="height:36px;margin-bottom:20px">' +
      '<div class="auth-title">Tech Support Command Center</div>' +
      '<div class="auth-subtitle">Enter team passcode to continue</div>' +
      '<form id="auth-form" style="margin-top:24px">' +
        '<input id="auth-input" type="password" class="auth-input" placeholder="Passcode" autocomplete="off" autofocus>' +
        '<button type="submit" class="auth-btn">Sign In</button>' +
      '</form>' +
      '<div id="auth-error" class="auth-error"></div>' +
    '</div>';
  document.body.appendChild(overlay);

  var form = document.getElementById('auth-form');
  var input = document.getElementById('auth-input');
  var errEl = document.getElementById('auth-error');

  form.addEventListener('submit', function(e) {
    e.preventDefault();
    var code = input.value.trim();
    if (!code) return;

    // Disable button while checking
    var btn = form.querySelector('button');
    btn.disabled = true;
    btn.textContent = 'Checking...';
    errEl.style.display = 'none';

    fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode: code })
    }).then(function(r) {
      if (r.ok) {
        localStorage.setItem(PASSCODE_KEY, code);
        overlay.remove();
        location.reload();
      } else {
        errEl.textContent = 'Invalid passcode';
        errEl.style.display = 'block';
        btn.disabled = false;
        btn.textContent = 'Sign In';
        input.value = '';
        input.focus();
      }
    }).catch(function() {
      errEl.textContent = 'Connection error. Try again.';
      errEl.style.display = 'block';
      btn.disabled = false;
      btn.textContent = 'Sign In';
    });
  });

  // Focus input after render
  setTimeout(function(){ input.focus(); }, 50);
}

// Expose CCAuth globally
window.CCAuth = {
  getToken: function(){ return getStoredPasscode(); },
  logout: function(){
    localStorage.removeItem(PASSCODE_KEY);
    location.reload();
  }
};

// If no stored passcode, show login overlay
if (!getStoredPasscode()) {
  // Wait for DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', showLoginOverlay);
  } else {
    showLoginOverlay();
  }
}

})();
