/**
 * Seite: Medienbibliothek (Media Library)
 * Filme/Serien, Musik, Bücher. Optional TMDB / OpenLibrary-Anreicherung.
 */

import { api } from '/api.js';
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { openModal, closeModal, confirmModal, mountFooter } from '/components/modal.js';

const TYPE_TABS = [
  { key: 'all', label: () => t('media.tabAll') },
  { key: 'movie', label: () => t('media.type.movie') },
  { key: 'music', label: () => t('media.type.music') },
  { key: 'book', label: () => t('media.type.book') },
];
const STATUSES = ['wish', 'doing', 'finished'];

// Cover-Hosts, die der Server fuer das Frontend proxyt (GET /api/v1/media/img).
// TMDB / OpenLibrary / iTunes-CDN / Google Books sind in manchen Netzen (z. B.
// CN) nicht direkt erreichbar.
const COVER_PROXY_HOSTS = ['image.tmdb.org', 'openlibrary.org', 'covers.openlibrary.org', 'books.google.com'];
const COVER_PROXY_SUFFIXES = ['.mzstatic.com'];
function coverSrc(url) {
  if (!url) return url;
  try {
    const u = new URL(url, location.origin);
    const allowed =
      u.protocol === 'https:'
      && (COVER_PROXY_HOSTS.includes(u.hostname) || COVER_PROXY_SUFFIXES.some((sfx) => u.hostname.endsWith(sfx)));
    if (allowed) {
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
      <div class="mk-head">
        <h2>${esc(t('media.title'))}</h2>
        <div class="mk-spacer"></div>
        <button class="mk-btn ghost" id="mk-group">${esc(t('media.groupByStatus'))}</button>
        <button class="mk-btn ghost" id="mk-select">${esc(t('media.selectMode'))}</button>
        <button class="mk-btn ghost" id="mk-export">${esc(t('media.export'))}</button>
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
          `<label class="mk-member-chip"><input type="checkbox" data-uid="${m.id}" ${
            sel.has(m.id) ? 'checked' : ''
          }> ${esc(m.name || m.display_name || ('#' + m.id))}</label>`
      )
      .join('')}</div>`;
  }
  function getPickedMembers(root) {
    return Array.from(root.querySelectorAll('.mk-member-picker input:checked')).map((x) => parseInt(x.dataset.uid, 10));
  }

  // Per-Mitglied-Watch-Status (Migration 140): uid -> gewählter Status ('' = reset).
  function getMemberStatuses(root) {
    const out = [];
    for (const sel of root.querySelectorAll('.mk-member-status')) {
      const uid = parseInt(sel.dataset.uid, 10);
      out.push({ uid, status: sel.value || null });
    }
    return out;
  }

  // Mitglieder-Chips mit individuellem Status-Select (Detail-Ansicht).
  function memberPickerWithStatus(item) {
    return `<div class="mk-member-picker" id="d-members">${state.members
      .map((m) => {
        const rel = (item.members || []).find((x) => x.uid === m.id);
        const st = rel?.memberStatus || '';
        return `<div class="mk-member-chip mk-member-chip--row ${rel ? 'checked' : ''}" data-uid="${m.id}">
          <label><input type="checkbox" data-uid="${m.id}" ${rel ? 'checked' : ''}> ${esc(m.name || m.display_name || '#' + m.id)}</label>
          <select class="mk-member-status" data-uid="${m.id}">
            <option value="">—</option>
            ${STATUSES.map((s) => `<option value="${s}" ${st === s ? 'selected' : ''}>${esc(t('media.status.' + s))}</option>`).join('')}
          </select>
        </div>`;
      })
      .join('')}</div>`;
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
      <div class="mk-field"><label>${esc(t('media.members'))}</label>${memberPickerWithStatus(item)}</div>
      <div class="mk-field"><label><input type="checkbox" id="d-private" ${item.is_private ? 'checked' : ''}> ${esc(t('media.private'))}</label></div>
      <div class="modal-panel__footer">
        <button class="mk-btn ghost" id="d-del">${esc(t('media.delete'))}</button>
        <div class="mk-spacer" style="flex:1"></div>
        <button class="mk-btn" id="d-save">${esc(t('media.save'))}</button>
      </div>
    `;
    openModal({
      title: item.title,
      content: '',
      onSave: (panel) => {
        panel.querySelector('.modal-panel__body').replaceChildren(body);
        mountFooter(panel);
      },
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
        // Individuelle Mitglieder-Status nachziehen (best-effort, blockiert nicht)
        for (const ms of getMemberStatuses(body)) {
          if (!payload.members.includes(ms.uid)) continue;
          try {
            await api.put('/media/' + id + '/member-status', { uid: ms.uid, status: ms.status });
          } catch { /* einzelne Fehlschläge ignorieren */ }
        }
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
    // Datenquelle je Medientyp: Film/Serie -> TMDB, Musik -> iTunes,
    // Buch -> OpenLibrary + Google Books. "手动录入" ist immer dabei.
    const typeLabels = Object.fromEntries(TYPE_TABS.filter((x) => x.key !== 'all').map((x) => [x.key, x.label()]));
    const SOURCES_BY_TYPE = {
      movie: [{ key: 'tmdb', label: 'TMDB' }],
      music: [{ key: 'itunes', label: 'iTunes' }],
      book: [{ key: 'openlib', label: 'OpenLibrary' }, { key: 'gbooks', label: 'Google Books' }],
    };
    const SEARCH_EP = { tmdb: '/media/search/tmdb', openlib: '/media/search/openlib', gbooks: '/media/search/gbooks', itunes: '/media/search/itunes' };
    const MANUAL_KEY = 'manual';

    let addType = 'movie';
    let addSource = 'tmdb';
    let addRating = 0;
    let addData = []; // letzte Suchergebnisse

    const body = document.createElement('div');
    body.className = 'mk-modal-body mk-add';

    const sourceChipsHtml = () =>
      [...SOURCES_BY_TYPE[addType], { key: MANUAL_KEY, label: t('media.manual') }]
        .map((s) => `<button type="button" class="mk-seg__btn ${s.key === addSource ? 'active' : ''}" data-src="${s.key}">${esc(s.label)}</button>`)
        .join('');

    body.innerHTML = `
      <div class="mk-add__section">
        <div class="mk-add__label">${esc(t('media.type.label'))}</div>
        <div class="mk-seg" id="a-type-seg">
          ${Object.entries(typeLabels).map(([k, v]) => `<button type="button" class="mk-seg__btn ${k === addType ? 'active' : ''}" data-type="${k}">${esc(v)}</button>`).join('')}
        </div>
      </div>
      <div class="mk-add__section">
        <div class="mk-add__label">${esc(t('media.source'))}</div>
        <div class="mk-seg mk-seg--sm" id="a-src-seg">${sourceChipsHtml()}</div>
      </div>
      <div class="mk-add__search" id="a-search">
        <input id="a-q" placeholder="${esc(t('media.searchPlaceholder'))}">
        <button class="mk-btn" id="a-go">${esc(t('media.search'))}</button>
      </div>
      <div class="mk-search-results" id="a-results" hidden></div>
      <div class="mk-add__form">
        <div class="mk-grid2">
          <div class="mk-field"><label>${esc(t('media.title'))}</label><input id="a-title"></div>
          <div class="mk-field"><label>${esc(t('media.cover'))} (URL)</label><input id="a-cover" placeholder="https://..."></div>
        </div>
        <div class="mk-grid2">
          <div class="mk-field"><label>${esc(t('media.status.label'))}</label>
            <select id="a-status">${STATUSES.map((s) => `<option value="${s}">${esc(t('media.status.' + s))}</option>`).join('')}</select></div>
          <div class="mk-field"><label>${esc(t('media.rating'))}</label><div id="a-stars">${starsInput(0)}</div></div>
        </div>
        <div class="mk-field"><label>${esc(t('media.comment'))}</label><textarea id="a-comment" rows="2"></textarea></div>
        <div class="mk-field"><label>${esc(t('media.members'))}</label>${memberPicker([])}</div>
        <div class="mk-field mk-field--inline"><label><input type="checkbox" id="a-private"> ${esc(t('media.private'))}</label></div>
      </div>
      <div class="modal-panel__footer mk-add__footer">
        <span id="a-msg" class="mk-add__msg"></span>
        <button class="mk-btn" id="a-save">${esc(t('media.save'))}</button>
      </div>
    `;
    openModal({
      title: t('media.add'),
      content: '',
      onSave: (panel) => {
        panel.querySelector('.modal-panel__body').replaceChildren(body);
        mountFooter(panel);
      },
    });
    wireStars(body.querySelector('#a-stars'));
    body.querySelector('#a-stars').addEventListener('click', (e) => {
      if (e.target.dataset.v) addRating = parseInt(e.target.dataset.v, 10);
    });

    const results = body.querySelector('#a-results');
    const searchBox = body.querySelector('#a-search');
    const msg = body.querySelector('#a-msg');

    function syncSearchVisibility() {
      const manual = addSource === MANUAL_KEY;
      searchBox.style.display = manual ? 'none' : '';
      results.hidden = manual || !addData.length;
      if (manual) body.querySelector('#a-title').focus();
    }

    function paintSources() {
      body.querySelector('#a-src-seg').innerHTML = sourceChipsHtml();
      body.querySelectorAll('#a-src-seg .mk-seg__btn').forEach((el) =>
        el.addEventListener('click', () => {
          addSource = el.dataset.src;
          body.querySelectorAll('#a-src-seg .mk-seg__btn').forEach((x) => x.classList.toggle('active', x === el));
          addData = [];
          results.innerHTML = '';
          results.hidden = true;
          syncSearchVisibility();
        })
      );
    }

    body.querySelectorAll('#a-type-seg .mk-seg__btn').forEach((el) =>
      el.addEventListener('click', () => {
        addType = el.dataset.type;
        body.querySelectorAll('#a-type-seg .mk-seg__btn').forEach((x) => x.classList.toggle('active', x === el));
        addSource = SOURCES_BY_TYPE[addType][0].key;
        addData = [];
        results.innerHTML = '';
        results.hidden = true;
        paintSources();
        syncSearchVisibility();
      })
    );
    paintSources();
    syncSearchVisibility();

    async function doSearch() {
      const q = body.querySelector('#a-q').value.trim();
      if (!q || addSource === MANUAL_KEY) return;
      results.hidden = false;
      results.innerHTML = `<div class="mk-empty">${esc(t('media.loading'))}</div>`;
      try {
        addData = (await api.get(SEARCH_EP[addSource] + '?q=' + encodeURIComponent(q))).data || [];
        results.innerHTML = addData.length
          ? addData
              .map(
                (d, i) => `<div class="mk-search-row" data-i="${i}">${
                  d.posterUrl || d.coverUrl ? `<img src="${esc(coverSrc(d.posterUrl || d.coverUrl))}">` : '<div class="mk-search-row__ph">📄</div>'
                }<div class="mk-search-row__body"><div><b>${esc(d.title)}</b></div><div style="font-size:12px;color:#888">${esc(
                  [d.releaseDate || d.publishDate || '', d.authors || ''].filter(Boolean).join(' · ')
                )}</div>${d.overview ? `<div class="mk-search-row__ov">${esc(String(d.overview).slice(0, 80))}</div>` : ''}</div></div>`
              )
              .join('')
          : `<div class="mk-empty">${esc(t('media.noResult'))}</div>`;
        results.querySelectorAll('.mk-search-row').forEach((el) =>
          el.addEventListener('click', () => {
            const d = addData[parseInt(el.dataset.i, 10)];
            body.querySelector('#a-title').value = d.title || '';
            body.querySelector('#a-cover').value = d.posterUrl || d.coverUrl || '';
            body.querySelector('#a-comment').value = [d.authors, d.overview].filter(Boolean).join('\n').slice(0, 500);
            results.querySelectorAll('.mk-search-row').forEach((x) => x.classList.remove('picked'));
            el.classList.add('picked');
          })
        );
      } catch {
        results.innerHTML = `<div class="mk-empty">${esc(t('media.searchFailed'))}</div>`;
      }
    }
    body.querySelector('#a-go').addEventListener('click', doSearch);
    body.querySelector('#a-q').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        doSearch();
      }
    });

    body.querySelector('#a-save').addEventListener('click', async () => {
      const title = body.querySelector('#a-title').value.trim();
      if (!title) {
        msg.textContent = t('media.titleRequired') || 'Titel erforderlich';
        msg.classList.add('mk-add__msg--err');
        body.querySelector('#a-title').focus();
        return;
      }
      const payload = {
        mediaType: addType,
        title,
        coverUrl: body.querySelector('#a-cover').value.trim() || null,
        status: body.querySelector('#a-status').value,
        rating: addRating,
        comment: body.querySelector('#a-comment').value,
        isPrivate: body.querySelector('#a-private').checked,
        members: getPickedMembers(body),
        tags: [],
      };
      const saveBtn = body.querySelector('#a-save');
      saveBtn.disabled = true;
      try {
        await api.post('/media/add', payload);
        // force:true → nach erfolgreichem Speichern NICHT nach „Änderungen verwerfen?" fragen
        closeModal({ force: true });
        load();
      } catch {
        saveBtn.disabled = false;
        msg.textContent = t('common.error') || 'Fehler';
        msg.classList.add('mk-add__msg--err');
      }
    });
  }

  // init
  state.members = await loadMembersList();
  memberEl.innerHTML =
    `<option value="">${esc(t('media.allMembers'))}</option>` +
    state.members.map((m) => `<option value="${m.id}">${esc(m.name || m.display_name || '#' + m.id)}</option>`).join('');
  await load();
}
