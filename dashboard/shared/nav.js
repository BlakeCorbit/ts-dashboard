(function(){
'use strict';
var pages = [
  { href: '/', label: 'Overview' },
  { href: '/people.html', label: 'People' },
  { href: '/tasks.html', label: 'Tasks' },
  { href: '/problems.html', label: 'PT Identifier' },
  { href: '/emergency.html', label: 'Emergency' },
  { href: '/reporting.html', label: 'Reporting' },
  { href: '/articles.html', label: 'Articles' },
  { href: '/churn.html', label: 'Churn Risk' },
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
  nav.appendChild(a);
});

var header = document.querySelector('.header');
if (header) header.parentNode.insertBefore(nav, header.nextSibling);

})();
