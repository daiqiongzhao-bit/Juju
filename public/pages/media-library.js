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
        .mk-card{background:var(--bg,#fff);border:1px solid var(--border,#ddd);border-radius:12px;overflow:hidden;cursor:pointer;transition:.15s;display:flex;flex-direction:column}
        .mk-card:hover{transform:translateY(-2px);box-shadow:0 4px 14px rgba(0,0,0,.12)}
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
    </div>
  `;

  const state = { type: 'all', status: '', member: '', tag: '', q: '', page: 1, members: [] };
  const grid = container.querySelector('#mk-grid');

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
  container.querySelector('#mk-export').addEventListener('click', () => {
    window.open('/api/v1/media/export', '_blank');
  });

  function statusBadge(s) {
    return `<span class="mk-badge">${esc(t('media.status.' + s))}</span>`;
  }

  function cardHtml(it) {
    const cover = it.cover_url
      ? `<img src="${esc(it.cover_url)}" alt="">`
      : `<div>🎬</div>`;
    const stars = it.rating ? `<span class="mk-stars">${'★'.repeat(it.rating)}</span>` : '';
    return `<div class="mk-card" data-id="${it.id}">
      <div class="mk-cover">${cover}</div>
      <div class="mk-card-body">
        <div class="mk-card-title">${esc(it.title)}</div>
        <div class="mk-meta">${statusBadge(it.status)} ${stars}</div>
      </div>
    </div>`;
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
      grid.innerHTML = items.map(cardHtml).join('');
      grid.querySelectorAll('.mk-card').forEach((el) =>
        el.addEventListener('click', () => openDetail(parseInt(el.dataset.id, 10)))
      );
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
      item.cover_url ? `<img src="${esc(item.cover_url)}" style="max-width:120px;border-radius:8px">` : '—'
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
    openModal({ title: item.title, body });
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
        closeModal();
        load();
      } catch (e) {
        alert(t('common.error') || 'Fehler');
      }
    });
    body.querySelector('#d-del').addEventListener('click', async () => {
      if (!(await confirmModal(t('media.confirmDelete') || 'Wirklich löschen?'))) return;
      try {
        await api.del('/media/' + id);
        closeModal();
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
    openModal({ title: t('media.add'), body });
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
                  d.posterUrl || d.coverUrl ? `<img src="${esc(d.posterUrl || d.coverUrl)}">` : '<div>📄</div>'
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
        closeModal();
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
}
