// The Map tab's "Share with an Alliance Partner" panel. It lists the partner teams, adds,
// updates and removes them through the relay with the team code this tab already holds, and
// copies each team's link and message. Nothing is asked of the relay until the panel is opened.
import { loadCloud } from './mapstore.js';
import {
  PARTNER_URL, buildText, checkCode, checkName, dateText, defaultCode, findRelay, isGuessable, isReleaseTag,
  normalCode, partnersCall, shareMessage,
} from './partnerdata.js';

const $ = (id) => document.getElementById(id);
const RECHECK_MS = 20000;

// viewedTag(): the build the map is showing, or null. onUnauthorized(message): the team code stopped working.
export function initShare({ viewedTag, onUnauthorized }) {
  const el = {
    panel: $('map-share'), disc: $('share-disc'), msgs: $('share-msgs'), list: $('share-list'), empty: $('share-empty'),
    form: $('share-form'), name: $('share-name'), code: $('share-code'), codeHint: $('share-code-hint'), build: $('share-build'),
    formHint: $('share-form-hint'), add: $('share-add'),
  };
  const S = { teams: null, loaded: 0, busy: false, confirm: null, codeEdited: false, copied: null, copyTimer: 0 };
  const fetchFn = (u, init) => fetch(u, init);

  /* ----- talking to the relay ----- */

  async function call(opts) {
    let rec = null;
    try { rec = await loadCloud(); } catch { /* partnersCall asks for the code */ }
    const base = (rec && rec.relay) || await findRelay({ fetchFn });
    const r = await partnersCall({ ...opts, base, teamCode: rec && rec.code, fetchFn });
    if (r.unauthorized) onUnauthorized(r.message);
    return r;
  }

  function note(kind, text) {
    el.msgs.textContent = '';
    if (!text) return;
    const li = document.createElement('li');
    li.className = 'line';
    li.dataset.kind = kind;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'ico');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', kind === 'good' ? '#i-check' : '#i-warn');
    svg.appendChild(use);
    const span = document.createElement('span');
    span.textContent = text;
    li.append(svg, span);
    el.msgs.appendChild(li);
  }

  function setBusy(on) {
    S.busy = on;
    el.add.disabled = on;
    el.list.querySelectorAll('button').forEach((b) => { if (!b.dataset.copy) b.disabled = on; });
  }

  async function refresh({ force = false } = {}) {
    if (S.busy || (!force && S.teams && Date.now() - S.loaded < RECHECK_MS)) return;
    setBusy(true);
    const r = await call({ method: 'GET' });
    setBusy(false);
    if (r.ok) { S.teams = r.teams; S.loaded = Date.now(); note('', ''); } else note('bad', r.message);
    render();
  }

  /* ----- the list ----- */

  const button = (text, data, cls = 'btn bordered') => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = text;
    Object.assign(b.dataset, data);
    return b;
  };

  function render() {
    renderBuilds();
    const teams = S.teams || [];
    el.empty.hidden = !(S.teams && !teams.length);
    el.list.textContent = '';
    teams.forEach((t, i) => {
      const li = document.createElement('li');
      const head = document.createElement('div');
      head.className = 'share-head';
      const name = document.createElement('p');
      name.className = 'share-name';
      name.textContent = t.name;
      head.append(name);

      const meta = document.createElement('p');
      meta.className = 'caption share-meta';
      const pw = document.createElement('span');
      pw.className = 'pw';
      pw.textContent = t.code;
      // Each part is one piece, so a narrow phone breaks the line between them, never inside "Newest build" or a date.
      const piece = (text) => {
        const s = document.createElement('span');
        s.className = 'nowrap';
        s.textContent = text;
        return s;
      };
      meta.append('Password ', pw, ' · ', piece(buildText(t.build)));
      if (t.added) meta.append(' · ', piece(`Added ${dateText(t.added)}`));
      if (isGuessable(t.code, t.name)) {
        const w = document.createElement('span');
        w.dataset.kind = 'warn';
        w.className = 'nowrap';
        w.textContent = ' · easy to guess';
        meta.append(w);
      }
      li.append(head, meta);

      if (S.confirm === t.name) {
        const box = document.createElement('div');
        box.className = 'share-confirm';
        box.setAttribute('role', 'group');
        box.setAttribute('aria-label', `Remove ${t.name}`);
        const text = document.createElement('span');
        text.textContent = `Remove ${t.name}? Their password stops working within a minute.`;
        // Cancel sits where the Remove link was, so a second tap there undoes the first instead of removing.
        const btns = document.createElement('span');
        btns.className = 'share-confirm-btns';
        btns.append(button('Remove', { remove: String(i) }, 'btn danger-fill'), button('Cancel', { cancel: '1' }));
        box.append(text, btns);
        li.append(box);
      } else {
        const row = document.createElement('div');
        row.className = 'share-actions';
        const grow = document.createElement('span');
        grow.className = 'grow';
        // The message has the link and the password, so it is the one to send; the link alone is the fallback.
        const copyMsg = button(S.copied === `msg-${i}` ? 'Copied' : 'Copy Message', { copy: 'msg', i: String(i) }, 'btn bordered accent-text primary');
        const copyLink = button(S.copied === `link-${i}` ? 'Copied' : 'Copy Link', { copy: 'link', i: String(i) });
        copyMsg.setAttribute('aria-label', `Copy Message for ${t.name}`);
        copyLink.setAttribute('aria-label', `Copy Link for ${t.name}`);
        const rm = button('Remove', { ask: String(i) }, 'link danger');
        rm.setAttribute('aria-label', `Remove ${t.name}`);
        row.append(copyMsg, copyLink, grow, rm);
        li.append(row);
      }
      el.list.appendChild(li);
    });
    paintForm();
  }

  function renderBuilds() {
    const tag = viewedTag();
    const want = isReleaseTag(tag) ? [[tag, `${buildText(tag)}, the one on this map`], ['latest', 'Always the newest build']] : [['latest', 'Always the newest build']];
    const now = Array.from(el.build.options || []).map((o) => o.value).join(',');
    if (now === want.map((w) => w[0]).join(',')) return;
    el.build.textContent = '';
    for (const [value, label] of want) {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = label;
      el.build.appendChild(o);
    }
  }

  // The button says Update when the name is already on the list, and the hint says when a password is easy to guess.
  function paintForm() {
    const name = checkName(el.name.value).value.toLowerCase();
    const known = !!name && (S.teams || []).some((t) => t.name.toLowerCase() === name);
    el.add.textContent = known ? 'Update Team' : 'Add Team';
    const code = normalCode(el.code.value);
    const easy = code.length >= 4 && isGuessable(code, el.name.value);
    el.codeHint.hidden = !easy;
    el.codeHint.textContent = easy ? 'Anyone at the event could guess this. A longer password is safer.' : '';
  }

  /* ----- copying ----- */

  async function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); return true; }
    } catch { /* try the older way */ }
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    } catch { return false; }
  }

  async function onCopy(kind, i) {
    const t = (S.teams || [])[i];
    if (!t) return;
    const text = kind === 'link' ? PARTNER_URL : shareMessage(t.code);
    if (await copyText(text)) {
      S.copied = `${kind === 'link' ? 'link' : 'msg'}-${i}`;
      note('good', kind === 'link' ? `Copied the link for ${t.name}.` : `Copied the message for ${t.name}. Paste it to them.`);
      clearTimeout(S.copyTimer);
      S.copyTimer = setTimeout(() => { S.copied = null; render(); }, 1800);
    } else {
      note('warn', `Couldn't copy here. Send them ${PARTNER_URL} with the password ${t.code}.`);
    }
    renderKeepingFocus(`[data-copy="${kind}"][data-i="${i}"]`);
  }

  function renderKeepingFocus(selector) {
    render();
    const b = el.list.querySelector(selector);
    if (b) b.focus();
  }

  /* ----- removing ----- */

  async function onRemove(i) {
    const t = (S.teams || [])[i];
    if (!t || S.busy) return;
    setBusy(true);
    const r = await call({ method: 'DELETE', name: t.name });
    setBusy(false);
    S.confirm = null;
    if (r.ok) {
      S.teams = r.teams; S.loaded = Date.now();
      note('good', `Removed ${t.name}. Their password stops working within a minute.`);
    } else if (r.status === 404) {
      await refresh({ force: true });
      note('warn', `${t.name} was already off the list.`);
    } else note('bad', r.message);
    render();
    const next = el.list.querySelectorAll('[data-ask]')[Math.min(i, (S.teams || []).length - 1)];
    (next || el.name).focus();
  }

  el.list.addEventListener('click', (e) => {
    const b = e.target && e.target.closest ? e.target.closest('button') : null;
    if (!b || !el.list.contains(b)) return;
    if (b.dataset.copy) { onCopy(b.dataset.copy, +b.dataset.i); return; }
    if (b.dataset.ask) {
      S.confirm = (S.teams || [])[+b.dataset.ask]?.name || null;
      renderKeepingFocus('[data-cancel]');
      return;
    }
    if (b.dataset.cancel) {
      const i = (S.teams || []).findIndex((t) => t.name === S.confirm);
      S.confirm = null;
      renderKeepingFocus(`[data-ask="${i}"]`);
      return;
    }
    if (b.dataset.remove) onRemove(+b.dataset.remove);
  });
  el.list.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && S.confirm) {
      const i = (S.teams || []).findIndex((t) => t.name === S.confirm);
      S.confirm = null;
      renderKeepingFocus(`[data-ask="${i}"]`);
    }
  });

  /* ----- adding ----- */

  el.name.addEventListener('input', () => {
    if (!S.codeEdited) el.code.value = defaultCode(el.name.value);
    el.formHint.hidden = true;
    paintForm();
  });
  el.code.addEventListener('input', () => {
    S.codeEdited = el.code.value !== '';
    el.formHint.hidden = true;
    paintForm();
  });

  el.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (S.busy) return;
    const name = checkName(el.name.value);
    const code = checkCode(el.code.value);
    const problem = !name.ok ? [name.message, el.name] : !code.ok ? [code.message, el.code] : null;
    if (problem) {
      el.formHint.textContent = problem[0];
      el.formHint.hidden = false;
      problem[1].focus();
      return;
    }
    setBusy(true);
    const r = await call({ method: 'POST', body: { name: name.value, code: code.value, build: el.build.value || 'latest' } });
    setBusy(false);
    if (!r.ok) {
      el.formHint.textContent = r.message;
      el.formHint.hidden = false;
      render();
      return;
    }
    const updated = r.status === 200;
    S.teams = r.teams; S.loaded = Date.now();
    el.name.value = ''; el.code.value = ''; S.codeEdited = false;
    note('good', `${updated ? 'Updated' : 'Added'} ${name.value}. Copy the message and send it to them.`);
    render();
    const i = S.teams.findIndex((t) => t.name.toLowerCase() === name.value.toLowerCase());
    const target = el.list.querySelector(`[data-copy="msg"][data-i="${i}"]`);
    if (target) target.focus();
  });

  el.disc.addEventListener('toggle', () => { if (el.disc.open) refresh(); });

  return {
    // Shown only with a team code; a new code (or none) drops the old list.
    setVisible(on) {
      if (el.panel.hidden === !on) return;
      el.panel.hidden = !on;
      S.teams = null; S.loaded = 0; S.confirm = null;
      el.list.textContent = '';
      note('', '');
      if (on && el.disc.open) refresh();
    },
    // The map moved to another build, so the build choice follows it.
    sync() { if (!el.panel.hidden) renderBuilds(); },
  };
}
