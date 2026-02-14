(function(){
'use strict';
var HASH = '21fe4f465e08689650fb8cebe984cdb622a776f678a90558c90901325cebd887';

async function sha256(str) {
  var buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(function(b){ return b.toString(16).padStart(2,'0'); }).join('');
}

async function check() {
  var stored = sessionStorage.getItem('ts_auth');
  if (stored === HASH) { show(); return; }
  hide();
  var pw = prompt('Enter password:');
  if (!pw) { document.body.innerHTML = '<div style="text-align:center;padding:60px;color:#f85149;font-size:1.2rem;font-family:system-ui">Access denied.</div>'; return; }
  var h = await sha256(pw);
  if (h === HASH) { sessionStorage.setItem('ts_auth', h); show(); }
  else { document.body.innerHTML = '<div style="text-align:center;padding:60px;color:#f85149;font-size:1.2rem;font-family:system-ui">Wrong password.</div>'; }
}

function hide() {
  var el = document.getElementById('app-root');
  if (el) el.style.display = 'none';
}
function show() {
  var el = document.getElementById('app-root');
  if (el) el.style.display = '';
}

check();
})();
