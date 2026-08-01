'use strict';

// The eSMS services. Each is a persistent <webview> sharing one session
// (partition "persist:esms"), so you sign in once and switch freely.
const SERVICES = [
  { key: 'email', label: 'Email', url: 'https://send.esmsafrica.io',
    icon: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M22 7l-10 7L2 7"/>' },
  { key: 'sms', label: 'SMS', url: 'https://sms.esmsafrica.io',
    icon: '<path d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z"/>' },
  { key: 'smpp', label: 'SMPP', url: 'https://smpp.esmsafrica.io',
    icon: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>' },
  { key: 'admin', label: 'Admin', url: 'https://auth.esmsafrica.io/admin',
    icon: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/>' },
];

const nav = document.getElementById('nav');
const stage = document.getElementById('stage');
const unread = {};           // per-service unread counts
let active = null;

function iconSvg(paths) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
}

function updateBadgeTotal() {
  const total = Object.values(unread).reduce((a, b) => a + (b || 0), 0);
  window.esms.setBadge(total);
}

// Parse a leading "(3)" or "• 3" unread hint from a page title.
function parseUnread(title) {
  const m = (title || '').match(/^\s*\((\d+)\)/) || (title || '').match(/(\d+)\s+unread/i);
  return m ? parseInt(m[1], 10) : 0;
}

function build() {
  SERVICES.forEach((s) => {
    // rail button
    const btn = document.createElement('button');
    btn.className = 'svc';
    btn.dataset.key = s.key;
    btn.innerHTML = `${iconSvg(s.icon)}<span class="dot" data-dot="${s.key}"></span><span class="label">${s.label}</span>`;
    btn.addEventListener('click', () => show(s.key));
    nav.appendChild(btn);

    // webview
    const wv = document.createElement('webview');
    wv.dataset.key = s.key;
    wv.setAttribute('partition', 'persist:esms');
    wv.setAttribute('allowpopups', 'true');
    wv.setAttribute('src', s.url);
    wv.addEventListener('page-title-updated', (e) => {
      unread[s.key] = parseUnread(e.title);
      const dot = document.querySelector(`[data-dot="${s.key}"]`);
      if (dot) {
        dot.textContent = unread[s.key] > 99 ? '99+' : String(unread[s.key]);
        dot.classList.toggle('on', unread[s.key] > 0);
      }
      updateBadgeTotal();
    });
    stage.appendChild(wv);
  });
  show('email');
}

function show(key) {
  active = key;
  document.querySelectorAll('.svc').forEach((b) => b.classList.toggle('active', b.dataset.key === key));
  document.querySelectorAll('#stage webview').forEach((w) => w.classList.toggle('active', w.dataset.key === key));
}

// Menu / shortcut driven
window.esms.onSwitchService((key) => show(key));
window.esms.onReloadService(() => {
  const wv = document.querySelector(`#stage webview[data-key="${active}"]`);
  if (wv) wv.reload();
});

build();
