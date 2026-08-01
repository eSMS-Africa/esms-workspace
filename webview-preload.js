'use strict';

/*
 * Runs inside every service <webview>. Its only job is a first-party
 * password vault for eSMS login pages: when you sign in it offers to
 * remember the password (encrypted by the OS keychain via the main
 * process), and next time it fills the form for you - the same thing
 * Apple Passwords does in Safari, but working the same way on macOS,
 * Windows and Linux. It never touches non-eSMS pages.
 */

const { ipcRenderer } = require('electron');

const IS_ESMS = /(^|\.)esmsafrica\.io$/i.test(location.hostname);

if (IS_ESMS) {
  let filled = false;      // fill the form only once per page load
  let lastSave = 0;        // debounce save prompts

  // Find the username + password fields of the visible login form.
  function findFields() {
    const pw = document.querySelector('input[type="password"], input[autocomplete="current-password"]');
    if (!pw) return null;
    const scope = pw.form || document;
    const user =
      scope.querySelector('input[autocomplete="username"]') ||
      scope.querySelector('input[type="email"]') ||
      scope.querySelector('input[name*="email" i]') ||
      scope.querySelector('input[name*="user" i]') ||
      scope.querySelector('input[type="text"], input[type="tel"]');
    return { user, pw, form: pw.form };
  }

  // Set a value the way a real keypress would, so Svelte/React state updates.
  function setValue(el, val) {
    if (!el || val == null) return;
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  let chipEl = null;
  function chip(text) {
    if (chipEl) chipEl.remove();
    chipEl = document.createElement('div');
    chipEl.setAttribute('role', 'status');
    chipEl.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ff8a3d" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>' +
      '<span></span>';
    chipEl.lastChild.textContent = text;
    chipEl.style.cssText =
      'position:fixed;z-index:2147483647;left:18px;bottom:18px;display:flex;gap:8px;align-items:center;' +
      'background:#1f1b17;color:#fff;font:500 12.5px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;' +
      'padding:9px 13px;border-radius:11px;box-shadow:0 12px 34px rgba(0,0,0,.4);opacity:0;transform:translateY(10px);' +
      'transition:opacity .25s ease,transform .25s ease;pointer-events:none;';
    document.documentElement.appendChild(chipEl);
    requestAnimationFrame(() => { chipEl.style.opacity = '1'; chipEl.style.transform = 'none'; });
    setTimeout(() => {
      if (!chipEl) return;
      chipEl.style.opacity = '0'; chipEl.style.transform = 'translateY(10px)';
      setTimeout(() => { if (chipEl) { chipEl.remove(); chipEl = null; } }, 300);
    }, 3400);
  }

  async function tryFill() {
    if (filled) return;
    const f = findFields();
    if (!f || !f.pw) return;
    let creds = null;
    try { creds = await ipcRenderer.invoke('vault-get', location.origin); } catch (_) {}
    if (!creds || !creds.password) return;
    filled = true;
    if (f.user && creds.username && !f.user.value) setValue(f.user, creds.username);
    if (!f.pw.value) setValue(f.pw, creds.password);
    chip('Filled from eSMS Keychain');
  }

  function maybeSave() {
    const now = Date.now();
    if (now - lastSave < 1500) return;
    const f = findFields();
    if (!f || !f.pw || !f.pw.value) return;
    lastSave = now;
    ipcRenderer
      .invoke('vault-save', { origin: location.origin, username: f.user ? f.user.value : '', password: f.pw.value })
      .then((ok) => { if (ok) chip('Password saved to eSMS Keychain'); })
      .catch(() => {});
  }

  function init() {
    tryFill();

    // Standard form submit (Enter or a submit button).
    document.addEventListener('submit', maybeSave, true);
    // Fallback for SPA login buttons that don't fire a form submit.
    document.addEventListener('click', (e) => {
      const btn = e.target && e.target.closest && e.target.closest('button, [type="submit"], input[type="submit"]');
      if (btn) setTimeout(maybeSave, 0);
    }, true);
    // Enter inside a password field.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target && e.target.matches && e.target.matches('input')) setTimeout(maybeSave, 0);
    }, true);

    // Login forms often render after first paint (SPA) - watch briefly.
    const obs = new MutationObserver(() => { if (!filled && findFields()) tryFill(); });
    try { obs.observe(document.documentElement, { childList: true, subtree: true }); } catch (_) {}
    setTimeout(() => { try { obs.disconnect(); } catch (_) {} }, 15000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
}
