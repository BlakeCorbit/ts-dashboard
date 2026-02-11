(function(){
'use strict';
var pages = [
  { href: '/', label: 'Overview' },
  { href: '/problems.html', label: 'PT Identifier' },
  { href: '/approval.html', label: 'Approval' },
  { href: '/emergency.html', label: 'Emergency' },
  { href: '/reporting.html', label: 'Reporting' },
  { href: '/articles.html', label: 'Articles' },
];

var path = location.pathname;
// Handle index.html and / both matching Overview
function isActive(href) {
  if (href === '/') return path === '/' || path === '/index.html' || path.endsWith('/index.html');
  return path === href || path.endsWith(href);
}

var nav = document.createElement('nav');
nav.className = 'main-nav';

pages.forEach(function(p) {
  var a = document.createElement('a');
  a.href = p.href;
  a.className = 'nav-link' + (isActive(p.href) ? ' active' : '');
  a.textContent = p.label;
  if (p.label === 'Approval') {
    // Add badge for pending approvals count
    var queue = JSON.parse(localStorage.getItem('approvalQueue') || '[]');
    if (queue.length > 0) {
      var badge = document.createElement('span');
      badge.className = 'nav-badge';
      badge.id = 'approval-badge';
      badge.textContent = queue.length;
      a.appendChild(badge);
    }
  }
  nav.appendChild(a);
});

var header = document.querySelector('.header');
if (header) header.parentNode.insertBefore(nav, header.nextSibling);

// Expose function to update badge from other pages
window.updateApprovalBadge = function() {
  var queue = JSON.parse(localStorage.getItem('approvalQueue') || '[]');
  var badge = document.getElementById('approval-badge');
  if (queue.length > 0) {
    if (!badge) {
      var approvalLink = nav.querySelectorAll('.nav-link')[2]; // Approval is 3rd
      badge = document.createElement('span');
      badge.className = 'nav-badge';
      badge.id = 'approval-badge';
      approvalLink.appendChild(badge);
    }
    badge.textContent = queue.length;
  } else if (badge) {
    badge.remove();
  }
};

})();
