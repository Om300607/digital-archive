// Tiny DOM helpers: element builder, toast, bottom sheets, confirm/text prompts.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'for') el.htmlFor = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in el && !k.includes('-') && k !== 'list' && k !== 'style') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

let toastTimer;
export function toast(message, { error = false } = {}) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.className = `show${error ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, error ? 5000 : 2600);
}

/**
 * Bottom sheet. `render()` returns the body node; call `update()` to rebuild it after state changes.
 * Returns { close, update, element }.
 */
export function openSheet(title, render, { onClose, full = false, dismissable = true } = {}) {
  const root = document.getElementById('sheet-root');
  const backdrop = h('div', { class: 'backdrop' });
  const sheet = h('div', { class: `sheet${full ? ' full' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title });
  const titleEl = h('h2', {}, title);
  const closeBtn = h('button', { class: 'icon-btn', 'aria-label': 'Close', onClick: () => close() }, '✕');
  if (!dismissable) closeBtn.hidden = true;
  let body = render();
  sheet.append(h('div', { class: 'sheet-head' }, titleEl, closeBtn), body);
  backdrop.append(sheet);
  root.append(backdrop);

  const previouslyFocused = document.activeElement;
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey);
    backdrop.remove();
    onClose?.();
    previouslyFocused?.focus?.();
  }
  function onKey(e) { if (e.key === 'Escape' && dismissable) close(); }
  document.addEventListener('keydown', onKey);
  backdrop.addEventListener('pointerdown', (e) => { if (e.target === backdrop && dismissable) close(); });

  return {
    close,
    element: sheet,
    update(newTitle) {
      if (closed) return;
      if (newTitle) titleEl.textContent = newTitle;
      const next = render();
      body.replaceWith(next);
      body = next;
    },
  };
}

export function askConfirm({ title, message, confirmText = 'OK', cancelText = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    let answer = false;
    const sheet = openSheet(title, () => h('div', {},
      h('p', {}, message),
      h('div', { class: 'btn-row' },
        h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, onClick: () => { answer = true; sheet.close(); } }, confirmText),
        h('button', { class: 'btn', onClick: () => sheet.close() }, cancelText),
      ),
    ), { onClose: () => resolve(answer) });
  });
}

export function askText({ title, label, value = '', confirmText = 'Save', maxLength = 255 }) {
  return new Promise((resolve) => {
    let answer = null;
    const input = h('input', { type: 'text', value, maxLength, id: 'ask-text', autocomplete: 'off' });
    const submit = () => { answer = input.value; sheet.close(); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    const sheet = openSheet(title, () => h('div', {},
      h('div', { class: 'field' }, h('label', { for: 'ask-text' }, label), input),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn primary', onClick: submit }, confirmText),
        h('button', { class: 'btn', onClick: () => sheet.close() }, 'Cancel'),
      ),
    ), { onClose: () => resolve(answer) });
    setTimeout(() => { input.focus(); input.select(); }, 30);
  });
}

export const formatDate = (ms) =>
  ms ? new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Unknown';
export const formatDay = (ms) => (ms ? new Date(ms).toLocaleDateString(undefined, { dateStyle: 'medium' }) : 'Unknown');
