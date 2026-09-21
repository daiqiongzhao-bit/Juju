/**
 * Seite: Medienbibliothek (Media Library)
 * Filme/Serien, Musik, Bücher. Optional TMDB / OpenLibrary-Anreicherung.
 */

import { api } from '/api.js';
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { openModal, closeModal, confirmModal } from '/components/modal.js';

const TYPE_TABS = [
  { key: 'all', label: () => t('media.tabAll') },
  { key: 'movie', label: () => t('media.type.movie') },
  { key: 'music', label: () => t('media.type.music') },
  { key: 'book', label: () => t('media.type.book') },
];
const STATUSES = ['wish', 'doing', 'finished'];

// Cover-Hosts, die der Server fuer das Frontend proxyt (GET /api/v1/media/img).
// TMDB / OpenLibrary sind in manchen Netzen (z. B. CN) nicht direkt erreichbar.
const COVER_PROXY_HOSTS = ['image.tmdb.org', 'openlibrary.org', 'covers.openlibrary.org'];
function coverSrc(url) {
  if (!url) return url;
  try {
    const u = new URL(url, location.origin);
    if (u.protocol === 'https:' && COVER_PROXY_HOSTS.includes(u.hostname)) {
      return '/api/v1/media/img?src=' + encodeURIComponent(url);
    }
  } catch {
    /* relative/ungültige URL unverändert lassen */
  }
  return url;
}

function starsInput(current) {
  let html = '<span class="mk-stars" data-stars>';
  for (let i = 1; i <= 5; i++) {
    html += `<span class="mk-star ${i <= (current || 0) ? 'on' : ''}" data-v="${i}">★</span>`;
  }
  html += '</span>';
  return html;
}

async function loadMembersList() {
  for (const ep of ['/family/members', '/users', '/family']) {
    try {
      const r = await api.get(ep);
      const data = r.data || r;
      if (Array.isArray(data)) return data;
      if (Array.isArray(data.members)) return data.members;
      if (Array.isArray(data.users)) return data.users;
    } catch {
      /* versuche nächsten Endpoint */
    }
  }
  return [];
}

export async function render(container, { user } = {}) {
  container.innerHTML = `
    <div class="mk-page">
      <style>
        .mk-page{max-width:1100px;margin:0 auto;padding:18px}
        .mk-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:14px}
        .mk-head h2{margin:0;font-size:20px}
        .mk-spacer{flex:1}
        .mk-tabs{display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap}
        .mk-tab{padding:6px 14px;border:1px solid var(--border,#ddd);border-radius:20px;cursor:pointer;background:var(--bg,#fff);color:var(--text,#222)}
        .mk-tab.active{background:var(--accent,#3b82f6);color:#fff;border-color:var(--accent,#3b82f6)}
        .mk-filters{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}
        .mk-filters input,.mk-filters select{padding:7px 10px;border:1px solid var(--border,#ddd);border-radius:8px;background:var(--bg,#fff);color:var(--text,#222)}
        .mk-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:14px}
        .mk-card{background:var(--bg,#fff);border:1px solid var(--border,#ddd);border-radius:12px;overflow:hidden;cursor:pointer;transition:.15s;display:flex;flex-direction:column;position:relative}
        .mk-card:hover{transform:translateY(-2px);box-shadow:0 4px 14px rgba(0,0,0,.12)}
        .mk-card.selected{outline:2px solid var(--accent,#3b82f6);outline-offset:-2px}
        .mk-card__check{position:absolute;top:6px;left:6px;z-index:2;background:rgba(255,255,255,.9);border-radius:6px;padding:2px 4px;line-height:0}
        .mk-group{margin-bottom:22px}
        .mk-group__head{font-size:13px;font-weight:600;color:#666;margin:0 0 8px;display:flex;gap:8px;align-items:center}
        .mk-group__head .mk-badge{background:#e0e7ff}
        .mk-bar{position:sticky;bottom:12px;display:none;align-items:center;gap:10px;background:var(--accent,#3b82f6);color:#fff;padding:10px 16px;border-radius:12px;box-shadow:0 6px 20px rgba(0,0,0,.2);margin-top:14px;z-index:5}
        .mk-bar.show{display:flex}
        .mk-cover{aspect-ratio:2/3;background:#eef;display:flex;align-items:center;justify-content:center;font-size:30px;color:#9aa}
        .mk-cover img{width:100%;height:100%;object-fit:cover}
        .mk-card-body{padding:8px 10px}
        .mk-card-title{font-weight:600;font-size:14px;line-height:1.3;max-height:38px;overflow:hidden}
        .mk-meta{font-size:12px;color:#888;margin-top:4px;display:flex;justify-content:space-between;align-items:center}
        .mk-badge{display:inline-block;padding:1px 8px;border-radius:10px;font-size:11px;background:#eef2ff;color:#4338ca}
        .mk-stars{color:#f5b301;cursor:pointer;font-size:15px}
        .mk-star{opacity:.35}
        .mk-star.on{opacity:1}
        .mk-empty{text-align:center;color:#999;padding:40px}
        button.mk-btn{padding:7px 14px;border-radius:8px;border:1px solid var(--accent,#3b82f6);background:var(--accent,#3b82f6);color:#fff;cursor:pointer;font-size:13px}
        button.mk-btn.ghost{background:transparent;color:var(--accent,#3b82f6)}
        .mk-modal-body{padding:16px;max-width:560px;max-height:80vh;overflow:auto}
        .mk-field{margin-bottom:12px}
        .mk-field label{display:block;font-size:12px;color:#777;margin-bottom:4px}
        .mk-field input,.mk-field textarea,.mk-field select{width:100%;padding:8px;border:1px solid var(--border,#ddd);border-radius:8px;background:var(--bg,#fff);color:var(--text,#222);box-sizing:border-box}
        .mk-search-results{max-height:240px;overflow:auto;border:1px solid var(--border,#ddd);border-radius:8px}
        .mk-search-row{display:flex;gap:10px;padding:8px;border-bottom:1px solid var(--border,#ddd);align-items:center;cursor:pointer}
        .mk-search-row:hover{background:var(--hover,#f5f5f5)}
        .mk-search-row img{width:40px;height:56px;object-fit:cover;border-radius:4px}
        .mk-member-chip{display:inline-flex;gap:4px;align-items:center;background:#eef2ff;color:#4338ca;border-radius:12px;padding:2px 8px;font-size:12px;margin:2px}
        .mk-tag{display:inline-block;background:#f1f5f9;border-radius:8px;padding:1px 7px;font-size:11px;margin:2px}
      </style>
      <div class="mk-head">
        <h2>${esc(t('media.title'))}</h2>
        <div class="mk-spacer"></div>
        <button class="mk-btn ghost" id="mk-group">${esc(t('media.groupByStatus'))}</button>
        <button class="mk-btn ghost" id="mk-select">${esc(t('media.selectMode'))}</button>
        <button class="mk-btn ghost" id="mk-export">${esc(t('media.export'))}</button>
        ${user && user.role === 'admin' ? `<button class="mk-btn ghost" id="mk-tmdb-config">⚙ TMDB</button>` : ''}
        <button class="mk-btn" id="mk-add">+ ${esc(t('media.add'))}</button>
      </div>
      <div class="mk-tabs" id="mk-tabs"></div>
      <div class="mk-filters">
        <input id="mk-q" placeholder="${esc(t('media.searchPlaceholder'))}" style="min-width:200px">
        <select id="mk-status"><option value="">${esc(t('media.allStatus'))}</option>${STATUSES.map(
          (s) => `<option value="${s}">${esc(t('media.status.' + s))}</option>`
        ).join('')}</select>
        <select id="mk-member"><option value="">${esc(t('media.allMembers'))}</option></select>
        <input id="mk-tag" placeholder="${esc(t('media.tag'))}" style="width:120px">
      </div>
      <div class="mk-grid" id="mk-grid"><div class="mk-empty">${esc(t('media.loading'))}</div></div>
      <div class="mk-bar" id="mk-bar">
        <span id="mk-bar-count"></span>
        <div class="mk-spacer" style="flex:1"></div>
        <button class="mk-btn ghost" id="mk-bar-cancel" style="border-color:#fff;color:#fff">${esc(t('media.cancelSelect'))}</button>
        <button class="mk-btn" id="mk-bar-del" style="background:#7f1d1d;border-color:#7f1d1d">${esc(t('media.batchDelete'))}</button>
      </div>
    </div>
  `;

  const state = { type: 'all', status: '', member: '', tag: '', q: '', page: 1, members: [], selectMode: false, selected: new Set(), groupByStatus: false };
  const grid = container.querySelector('#mk-grid');
  const bar = container.querySelector('#mk-bar');

  // Tabs
  const tabsEl = container.querySelector('#mk-tabs');
  tabsEl.innerHTML = TYPE_TABS.map(
    (tb) => `<div class="mk-tab ${tb.key === state.type ? 'active' : ''}" data-type="${tb.key}">${esc(tb.label())}</div>`
  ).join('');
  tabsEl.querySelectorAll('.mk-tab').forEach((el) =>
    el.addEventListener('click', () => {
      state.type = el.dataset.type;
      tabsEl.querySelectorAll('.mk-tab').forEach((x) => x.classList.toggle('active', x === el));
      state.page = 1;
      load();
    })
  );

  // Filters
  const qEl = container.querySelector('#mk-q');
  const statusEl = container.querySelector('#mk-status');
  const memberEl = container.querySelector('#mk-member');
  const tagEl = container.querySelector('#mk-tag');
  let debounce;
  qEl.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      state.q = qEl.value.trim();
      state.page = 1;
      load();
    }, 300);
  });
  statusEl.addEventListener('change', () => {
    state.status = statusEl.value;
    load();
  });
  memberEl.addEventListener('change', () => {
    state.member = memberEl.value;
    load();
  });
  tagEl.addEventListener('change', () => {
    state.tag = tagEl.value.trim();
    load();
  });

  container.querySelector('#mk-add').addEventListener('click', () => openAdd());

  // Batch-Auswahl-Modus
  container.querySelector('#mk-select').addEventListener('click', () => toggleSelectMode());
  container.querySelector('#mk-bar-cancel').addEventListener('click', () => toggleSelectMode(false));
  container.querySelector('#mk-bar-del').addEventListener('click', () => doBatchDelete());

  // Gruppieren nach Status (wish/doing/finished)
  container.querySelector('#mk-group').addEventListener('click', (e) => {
    state.groupByStatus = !state.groupByStatus;
    e.currentTarget.classList.toggle('active', state.groupByStatus);
    e.currentTarget.style.background = state.groupByStatus ? 'var(--accent,#3b82f6)' : 'transparent';
    e.currentTarget.style.color = state.groupByStatus ? '#fff' : 'var(--accent,#3b82f6)';
    load();
  });

  const tmdbCfgBtn = container.querySelector('#mk-tmdb-config');
  if (tmdbCfgBtn) tmdbCfgBtn.addEventListener('click', () => openTmdbConfig());
  container.querySelector('#mk-export').addEventListener('click', () => {
    window.open('/api/v1/media/export', '_blank');
  });

  function statusBadge(s) {
    return `<span class="mk-badge">${esc(t('media.status.' + s))}</span>`;
  }

  function cardHtml(it) {
    const cover = it.cover_url
      ? `<img src="${esc(coverSrc(it.cover_url))}" alt="">`
      : `<div>🎬</div>`;
    const stars = it.rating ? `<span class="mk-stars">${'★'.repeat(it.rating)}</span>` : '';
    const check = state.selectMode
      ? `<div class="mk-card__check"><input type="checkbox" data-id="${it.id}" ${state.selected.has(it.id) ? 'checked' : ''}></div>`
      : '';
    return `<div class="mk-card ${state.selectMode && state.selected.has(it.id) ? 'selected' : ''}" data-id="${it.id}">
      ${check}
      <div class="mk-cover">${cover}</div>
      <div class="mk-card-body">
        <div class="mk-card-title">${esc(it.title)}</div>
        <div class="mk-meta">${statusBadge(it.status)} ${stars}</div>
      </div>
    </div>`;
  }

  // Wiret Klick/Checkbox-Auswahl für die aktuell gerenderten Karten.
  function wireCards() {
    grid.querySelectorAll('.mk-card').forEach((el) => {
      const id = parseInt(el.dataset.id, 10);
      if (state.selectMode) {
        el.addEventListener('click', (e) => {
          if (e.target.closest('.mk-card__check')) return;
          const cb = el.querySelector('.mk-card__check input');
          if (!cb) return;
          cb.checked = !cb.checked;
          cb.dispatchEvent(new Event('change'));
        });
      } else {
        el.addEventListener('click', () => openDetail(id));
      }
    });
    if (state.selectMode) {
      grid.querySelectorAll('.mk-card__check input').forEach((cb) => {
        cb.addEventListener('change', () => {
          const id = parseInt(cb.dataset.id, 10);
          if (cb.checked) state.selected.add(id);
          else state.selected.delete(id);
          cb.closest('.mk-card').classList.toggle('selected', cb.checked);
          updateBar();
        });
      });
    }
  }

  function toggleSelectMode(force) {
    state.selectMode = typeof force === 'boolean' ? force : !state.selectMode;
    if (!state.selectMode) state.selected.clear();
    const btn = container.querySelector('#mk-select');
    btn.textContent = state.selectMode ? t('media.cancelSelect') : t('media.selectMode');
    btn.classList.toggle('active', state.selectMode);
    btn.style.background = state.selectMode ? 'var(--accent,#3b82f6)' : 'transparent';
    btn.style.color = state.selectMode ? '#fff' : 'var(--accent,#3b82f6)';
    bar.classList.toggle('show', state.selectMode);
    updateBar();
    load();
  }

  function updateBar() {
    const el = container.querySelector('#mk-bar-count');
    if (el) el.textContent = t('media.selected', { count: state.selected.size });
  }

  async function doBatchDelete() {
    if (!state.selected.size) return;
    if (!(await confirmModal(t('media.confirmDeleteBatch', { count: state.selected.size })))) return;
    try {
      await api.post('/media/batch-delete', { ids: [...state.selected] });
      toggleSelectMode(false);
    } catch {
      alert(t('common.error') || 'Fehler');
    }
  }

  async function load() {
    grid.innerHTML = `<div class="mk-empty">${esc(t('media.loading'))}</div>`;
    try {
      const params = new URLSearchParams();
      if (state.type !== 'all') params.set('type', state.type);
      if (state.status) params.set('status', state.status);
      if (state.member) params.set('member', state.member);
      if (state.tag) params.set('tag', state.tag);
      if (state.q) params.set('q', state.q);
      params.set('page', state.page);
      const r = await api.get('/media/list?' + params.toString());
      const items = (r.data || []).filter((it) => !(it.is_private && it.creator_uid && user && it.creator_uid !== user.id));
      if (!items.length) {
        grid.innerHTML = `<div class="mk-empty">${esc(t('media.empty'))}</div>`;
        return;
      }
      if (state.groupByStatus) {
        // Nach Status gruppieren, innerhalb der Gruppe die Server-Sortierung
        // (updated_at DESC) beibehalten — Object.groupBy wäre ES2024, hier bewusst
        // ein einfacher Bucket-Aufbau für breitere Browser-Unterstützung.
        const buckets = new Map(STATUSES.map((s) => [s, []]));
        for (const it of items) {
          if (!buckets.has(it.status)) buckets.set(it.status, []);
          buckets.get(it.status).push(it);
        }
        grid.innerHTML = [...buckets.entries()]
          .filter(([, arr]) => arr.length)
          .map(
            ([status, arr]) =>
              `<div class="mk-group"><h3 class="mk-group__head">${statusBadge(status)}<span>${arr.length}</span></h3>
                 <div class="mk-grid">${arr.map(cardHtml).join('')}</div></div>`
          )
          .join('');
      } else {
        grid.innerHTML = items.map(cardHtml).join('');
      }
      wireCards();
    } catch (e) {
      grid.innerHTML = `<div class="mk-empty">${esc(t('common.error') || 'Fehler')}</div>`;
    }
  }

  function memberPicker(selected) {
    const sel = new Set(selected || []);
    return `<div class="mk-member-picker">${state.members
      .map(
        (m) =>
          `<label class="mk-tag"><input type="checkbox" data-uid="${m.id}" ${
            sel.has(m.id) ? 'checked' : ''
          }> ${esc(m.name || m.display_name || ('#' + m.id))}</label>`
      )
      .join('')}</div>`;
  }
  function getPickedMembers(root) {
    return Array.from(root.querySelectorAll('.mk-member-picker input:checked')).map((x) => parseInt(x.dataset.uid, 10));
  }

  async function openDetail(id) {
    let item;
    try {
      item = (await api.get('/media/' + id)).data;
    } catch {
      return;
    }
    const body = document.createElement('div');
    body.className = 'mk-modal-body';
    body.innerHTML = `
      <h3>${esc(item.title)}</h3>
      <div class="mk-field"><label>${esc(t('media.cover'))}</label>${
      item.cover_url ? `<img src="${esc(coverSrc(item.cover_url))}" style="max-width:120px;border-radius:8px">` : '—'
    }</div>
      <div class="mk-field"><label>${esc(t('media.status.label'))}</label>
        <select id="d-status">${STATUSES.map(
          (s) => `<option value="${s}" ${item.status === s ? 'selected' : ''}>${esc(t('media.status.' + s))}</option>`
        ).join('')}</select></div>
      <div class="mk-field"><label>${esc(t('media.rating'))}</label><div id="d-stars">${starsInput(item.rating)}</div></div>
      <div class="mk-field"><label>${esc(t('media.watchDate'))}</label><input id="d-watch" type="date" value="${esc((item.watch_date || '').slice(0, 10))}"></div>
      <div class="mk-field"><label>${esc(t('media.tags'))}</label><input id="d-tags" value="${esc((item.tags || []).join(', '))}"></div>
      <div class="mk-field"><label>${esc(t('media.comment'))}</label><textarea id="d-comment" rows="3">${esc(item.comment || '')}</textarea></div>
      <div class="mk-field"><label>${esc(t('media.members'))}</label>${memberPicker((item.members || []).map((m) => m.uid))}</div>
      <div class="mk-field"><label><input type="checkbox" id="d-private" ${item.is_private ? 'checked' : ''}> ${esc(t('media.private'))}</label></div>
      <div style="display:flex;gap:8px;margin-top:10px">
        <button class="mk-btn ghost" id="d-del">${esc(t('media.delete'))}</button>
        <div class="mk-spacer" style="flex:1"></div>
        <button class="mk-btn" id="d-save">${esc(t('media.save'))}</button>
      </div>
    `;
    openModal({
      title: item.title,
      content: '',
      onSave: (panel) => panel.querySelector('.modal-panel__body').replaceChildren(body),
    });
    wireStars(body.querySelector('#d-stars'));
    let rating = item.rating || 0;
    body.querySelector('#d-stars').addEventListener('click', (e) => {
      if (e.target.dataset.v) rating = parseInt(e.target.dataset.v, 10);
    });
    body.querySelector('#d-save').addEventListener('click', async () => {
      const tags = body.querySelector('#d-tags').value.split(',').map((x) => x.trim()).filter(Boolean);
      const payload = {
        status: body.querySelector('#d-status').value,
        rating,
        comment: body.querySelector('#d-comment').value,
        watchDate: body.querySelector('#d-watch').value || null,
        tags,
        isPrivate: body.querySelector('#d-private').checked,
        members: getPickedMembers(body),
      };
      try {
        await api.put('/media/' + id, payload);
        await api.post('/media/' + id + '/member', { members: payload.members });
        // force:true → nach erfolgreichem Speichern NICHT nach „Änderungen verwerfen?" fragen
        closeModal({ force: true });
        load();
      } catch (e) {
        alert(t('common.error') || 'Fehler');
      }
    });
    body.querySelector('#d-del').addEventListener('click', async () => {
      if (!(await confirmModal(t('media.confirmDelete') || 'Wirklich löschen?'))) return;
      try {
        await api.delete('/media/' + id);
        closeModal({ force: true });
        load();
      } catch {}
    });
  }

  function wireStars(root) {
    root.addEventListener('click', (e) => {
      if (!e.target.dataset.v) return;
      const v = parseInt(e.target.dataset.v, 10);
      root.querySelectorAll('.mk-star').forEach((s) => s.classList.toggle('on', parseInt(s.dataset.v, 10) <= v));
    });
  }

  function openAdd() {
    const body = document.createElement('div');
    body.className = 'mk-modal-body';
    body.innerHTML = `
      <div class="mk-tabs" id="a-tabs">
        <div class="mk-tab active" data-src="tmdb">TMDB</div>
        <div class="mk-tab" data-src="openlib">OpenLibrary</div>
        <div class="mk-tab" data-src="manual">${esc(t('media.manual'))}</div>
      </div>
      <div id="a-search" style="margin:10px 0">
        <input id="a-q" placeholder="${esc(t('media.searchPlaceholder'))}" style="width:70%"> <button class="mk-btn" id="a-go">${esc(t('media.search'))}</button>
      </div>
      <div class="mk-search-results" id="a-results"></div>
      <div id="a-form" style="margin-top:10px">
        <div class="mk-field"><label>${esc(t('media.type.label'))}</label>
          <select id="a-type">${TYPE_TABS.filter((x) => x.key !== 'all').map(
            (x) => `<option value="${x.key}">${esc(x.label())}</option>`
          ).join('')}</select></div>
        <div class="mk-field"><label>${esc(t('media.title'))}</label><input id="a-title"></div>
        <div class="mk-field"><label>${esc(t('media.cover'))} (URL)</label><input id="a-cover" placeholder="https://..."></div>
        <div class="mk-field"><label>${esc(t('media.status.label'))}</label>
          <select id="a-status">${STATUSES.map((s) => `<option value="${s}">${esc(t('media.status.' + s))}</option>`).join('')}</select></div>
        <div class="mk-field"><label>${esc(t('media.rating'))}</label><div id="a-stars">${starsInput(0)}</div></div>
        <div class="mk-field"><label>${esc(t('media.comment'))}</label><textarea id="a-comment" rows="2"></textarea></div>
        <div class="mk-field"><label>${esc(t('media.members'))}</label>${memberPicker([])}</div>
        <div class="mk-field"><label><input type="checkbox" id="a-private"> ${esc(t('media.private'))}</label></div>
        <div style="display:flex;gap:8px"><div class="mk-spacer" style="flex:1"></div><button class="mk-btn" id="a-save">${esc(t('media.save'))}</button></div>
      </div>
    `;
    openModal({
      title: t('media.add'),
      content: '',
      onSave: (panel) => panel.querySelector('.modal-panel__body').replaceChildren(body),
    });
    let rating = 0;
    wireStars(body.querySelector('#a-stars'));
    body.querySelector('#a-stars').addEventListener('click', (e) => {
      if (e.target.dataset.v) rating = parseInt(e.target.dataset.v, 10);
    });

    const tabs = body.querySelector('#a-tabs');
    const results = body.querySelector('#a-results');
    const searchBox = body.querySelector('#a-search');
    tabs.querySelectorAll('.mk-tab').forEach((el) =>
      el.addEventListener('click', () => {
        tabs.querySelectorAll('.mk-tab').forEach((x) => x.classList.toggle('active', x === el));
        const src = el.dataset.src;
        searchBox.style.display = src === 'manual' ? 'none' : '';
        results.innerHTML = '';
        if (src === 'manual') {
          body.querySelector('#a-title').focus();
        }
      })
    );

    body.querySelector('#a-go').addEventListener('click', async () => {
      const src = tabs.querySelector('.mk-tab.active').dataset.src;
      const q = body.querySelector('#a-q').value.trim();
      if (!q) return;
      results.innerHTML = `<div class="mk-empty">${esc(t('media.loading'))}</div>`;
      try {
        let data = [];
        if (src === 'tmdb') data = (await api.get('/media/search/tmdb?q=' + encodeURIComponent(q))).data || [];
        else if (src === 'openlib') data = (await api.get('/media/search/openlib?q=' + encodeURIComponent(q))).data || [];
        results.innerHTML = data.length
          ? data
              .map(
                (d, i) => `<div class="mk-search-row" data-i="${i}">${
                  d.posterUrl || d.coverUrl ? `<img src="${esc(coverSrc(d.posterUrl || d.coverUrl))}">` : '<div>📄</div>'
                }<div><div><b>${esc(d.title)}</b></div><div style="font-size:12px;color:#888">${esc(
                  d.releaseDate || d.publishDate || d.authors || ''
                )}</div></div></div>`
              )
              .join('')
          : `<div class="mk-empty">${esc(t('media.noResult'))}</div>`;
        results.querySelectorAll('.mk-search-row').forEach((el) =>
          el.addEventListener('click', () => {
            const d = data[parseInt(el.dataset.i, 10)];
            body.querySelector('#a-title').value = d.title || '';
            body.querySelector('#a-cover').value = d.posterUrl || d.coverUrl || '';
            body.querySelector('#a-type').value = d.kind === 'book' ? 'book' : d.kind === 'music' ? 'music' : 'movie';
            body.querySelector('#a-comment').value = d.overview || '';
          })
        );
      } catch {
        results.innerHTML = `<div class="mk-empty">${esc(t('media.searchFailed'))}</div>`;
      }
    });

    body.querySelector('#a-save').addEventListener('click', async () => {
      const title = body.querySelector('#a-title').value.trim();
      if (!title) {
        alert(t('media.titleRequired') || 'Titel erforderlich');
        return;
      }
      const tags = [];
      const payload = {
        mediaType: body.querySelector('#a-type').value,
        title,
        coverUrl: body.querySelector('#a-cover').value.trim() || null,
        status: body.querySelector('#a-status').value,
        rating,
        comment: body.querySelector('#a-comment').value,
        isPrivate: body.querySelector('#a-private').checked,
        members: getPickedMembers(body),
        tags,
      };
      try {
        await api.post('/media/add', payload);
        // force:true → nach erfolgreichem Speichern NICHT nach „Änderungen verwerfen?" fragen
        closeModal({ force: true });
        load();
      } catch {
        alert(t('common.error') || 'Fehler');
      }
    });
  }

  // init
  state.members = await loadMembersList();
  memberEl.innerHTML =
    `<option value="">${esc(t('media.allMembers'))}</option>` +
    state.members.map((m) => `<option value="${m.id}">${esc(m.name || m.display_name || '#' + m.id)}</option>`).join('');
  await load();

  async function openTmdbConfig() {
    const body = document.createElement('div');
    body.className = 'mk-modal-body';
    body.innerHTML = `
      <div class="mk-field"><label>TMDB API Key</label>
        <input id="c-key" type="password" placeholder="输入 TMDB v3 API Key" autocomplete="off"></div>
      <div class="mk-field"><label>TMDB 代理 URL（可选，用于国内网络访问）</label>
        <input id="c-proxy" placeholder="https://...（可选）"></div>
      <div class="mk-field"><label><input type="checkbox" id="c-ol"> 启用 OpenLibrary（书籍搜索）</label></div>
      <div id="c-msg" style="font-size:12px;min-height:16px"></div>
      <div style="display:flex;gap:8px"><div class="mk-spacer" style="flex:1"></div>
        <button class="mk-btn ghost" id="c-cancel">${esc(t('common.cancel') || '取消')}</button>
        <button class="mk-btn" id="c-save">${esc(t('common.save') || '保存')}</button></div>
    `;
    openModal({ title: t('media.tmdbConfig') || 'TMDB 设置', content: '', onSave: (panel) => panel.querySelector('.modal-panel__body').replaceChildren(body) });
    const msg = body.querySelector('#c-msg');
    try {
      const cfg = (await api.get('/media/config')).data || {};
      body.querySelector('#c-proxy').value = cfg.tmdbProxyUrl || '';
      body.querySelector('#c-ol').checked = !!cfg.openlibraryEnable;
      msg.style.color = cfg.tmdbConfigured ? '#16a34a' : '#b45309';
      msg.textContent = cfg.tmdbConfigured ? 'TMDB 已配置：如需更换请填写新 Key，留空则保留原 Key' : '尚未配置 TMDB Key';
    } catch { /* 配置读取失败不影响表单 */ }
    body.querySelector('#c-cancel').addEventListener('click', () => closeModal());
    body.querySelector('#c-save').addEventListener('click', async () => {
      const key = body.querySelector('#c-key').value.trim();
      const proxy = body.querySelector('#c-proxy').value.trim();
      const ol = body.querySelector('#c-ol').checked;
      msg.style.color = '#666'; msg.textContent = '保存中…';
      try {
        const r = await api.put('/media/config', { tmdbApiKey: key, tmdbProxyUrl: proxy, openlibraryEnable: ol });
        const d = r.data || {};
        msg.style.color = '#16a34a';
        msg.textContent = d.tmdbConfigured ? '已保存：TMDB 配置成功' : '已保存：TMDB Key 为空（已清空）';
        setTimeout(() => closeModal({ force: true }), 900);
      } catch (e) {
        msg.style.color = '#dc2626';
        const status = e && e.status ? e.status : (e && e.code);
        msg.textContent = status === 403 ? '需要管理员权限' : ('保存失败：' + (e?.message || '未知错误'));
      }
    });
  }
}
