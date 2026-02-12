(function(){
'use strict';

var API = '/api/';
var ZD = 'https://bayiq.zendesk.com/agent/tickets/';
var JIRA = 'https://autovitals.atlassian.net/browse/';

var useStaticData = location.protocol === 'file:' || (location.hostname === 'localhost' && !location.port);

// Agent name for team coordination (stored in localStorage, prompted once)
var agentName = localStorage.getItem('ts_agent_name') || '';

function getAgentName() {
  if (!agentName) {
    agentName = prompt('Enter your name for team tracking:') || 'Anonymous';
    localStorage.setItem('ts_agent_name', agentName);
  }
  return agentName;
}

function api(path, opts) {
  if (useStaticData) {
    var map = {
      'metrics': 'data/metrics.json',
      'incidents': 'data/incidents.json',
      'tickets?hours=24': 'data/triage.json',
      'detect': 'data/detected.json',
      'agents': 'data/agents.json'
    };
    var file = map[path] || 'data/metrics.json';
    return fetch(file + '?_=' + Date.now()).then(function(r){ return r.ok ? r.json() : null; }).catch(function(){ return null; });
  }
  // Inject X-Agent header for team coordination
  opts = opts || {};
  opts.headers = opts.headers || {};
  if (!opts.headers['X-Agent'] && agentName) {
    opts.headers['X-Agent'] = agentName;
  }
  return fetch(API + path, opts).then(function(r){ return r.ok ? r.json() : r.json().then(function(e){ throw new Error(e.error); }); });
}

function esc(s){ if(!s)return''; var d=document.createElement('div'); d.textContent=s; return d.innerHTML; }
function fmt(n){ return n==null?'--':Number(n).toLocaleString('en-US'); }
function trunc(s,n){ return!s?'':s.length>n?s.slice(0,n)+'...':s; }
function relTime(iso){
  if(!iso)return'--';
  var ms=Date.now()-new Date(iso).getTime();
  if(ms<60000)return'just now';
  var m=Math.floor(ms/60000); if(m<60)return m+'m ago';
  var h=Math.floor(m/60); if(h<24)return h+'h ago';
  return Math.floor(h/24)+'d ago';
}
function ageH(iso){ return iso?(Date.now()-new Date(iso).getTime())/3600000:0; }
function dayLbl(d){ if(!d)return''; var x=new Date(d+'T12:00:00'); return['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][x.getDay()]+' '+(x.getMonth()+1)+'/'+x.getDate(); }
function fmtTime(iso){ if(!iso)return'--'; var d=new Date(iso); return d.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'}); }

function toast(msg, ok){
  var el=document.getElementById('toast');
  if(!el) return;
  el.textContent=msg;
  el.style.background=ok?'var(--av-green-dark)':'var(--accent-red)';
  el.classList.add('show');
  setTimeout(function(){ el.classList.remove('show'); }, 3000);
}

function hBar(title, items){
  var h='<div class="chart-card fade-in"><div class="chart-title">'+esc(title)+'</div>';
  if(items&&items.length){
    var mx=Math.max.apply(null,items.map(function(x){return x.count;}));
    h+='<div class="hbar-chart">';
    items.slice(0,8).forEach(function(x,i){
      var w=mx>0?(x.count/mx)*100:0;
      h+='<div class="hbar-row"><div class="hbar-label" title="'+esc(x.name)+'">'+esc(x.name)+'</div><div class="hbar-track"><div class="hbar-fill c'+i%8+'" style="width:'+w+'%"></div></div><div class="hbar-count">'+fmt(x.count)+'</div></div>';
    });
    h+='</div>';
  } else h+='<div class="no-data">No data</div>';
  h+='</div>';
  return h;
}

// Expose to window
window.CC = { api:api, esc:esc, fmt:fmt, trunc:trunc, relTime:relTime, ageH:ageH, dayLbl:dayLbl, fmtTime:fmtTime, toast:toast, hBar:hBar, ZD:ZD, JIRA:JIRA, getAgentName:getAgentName, agentName:agentName };

})();
