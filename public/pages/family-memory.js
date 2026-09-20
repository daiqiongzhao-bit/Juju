/**
 * Seite: Familienerinnerungen (Family Memory)
 * Gemeinsame Medien, Reisen, Lebenereignisse – Zeitleiste.
 */

import { api } from '/api.js';
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { openModal, closeModal, confirmModal } from '/components/modal.js';

const TYPES = ['commonMedia', 'travel', 'lifeEvent'];

async function loadMembersList() {
  for (const ep of ['/family/members', '/users', '/family']) {
    try {
      const r = await api.get(ep);
      const data = r.data || r;
      if (Array.isArray(data)) return data;
      if (Array.isArray(data.members)) return data.members;
      if (Array.isArray(data.users)) return data.users;
    } catch {
      /* nächster Endpoint */
    }
  }
  return [];
}

export async function render(container, { user } = {}) {
  container.innerHTML = `
    <div class="fm-page">
      <style>
        .fm-page{max-width:1000px;margin:0 auto;padding:18px}
        .fm-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:14px}
        .fm-head h2{margin:0;font-size:20px}
        .fm-spacer{flex:1}
        .fm-filters{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}
        .fm-filters input,.fm-filters select{padding:7px 10px;border:1px solid var(--border,#ddd);border-radius:8px;background:var(--bg,#fff);color:var(--text,#222)}
        .fm-timeline{position:relative;border-left:3px solid var(--accent,#3b82f6);margin-left:8px;padding-left:18px}
        .fm-item{background:var(--bg,#fff);border:1px solid var(--border,#ddd);border-radius:12px;padding:12px 14px;margin-bottom:14px;position:relative}
        .fm-item h3{margin:0 0 4px;font-size:16px}
        .fm-meta{font-size:12px;color:#888;margin-bottom:6px}
        .fm-desc{font-size:14px;color:var(--text,#333);white-space:pre-wrap}
        .fm-photos{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
        .fm-photos img{width:90px;height:90px;object-fit:cover;border-radius:8px}
        .fm-photo-ref{font-size:11px;color:#666;background:#f1f5f9;border-radius:6px;padding:4px 6px;display:inline-block;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .fm-tag{display:inline-block;background:#f1f5f9;border-radius:8px;padding:1px 7px;font-size:11px;margin:2px}
        .fm-type{display:inline-block;padding:1px 8px;border-radius:10px;font-size:11px;background:#eef2ff;color:#4338ca;margin-left:6px}
        .fm-empty{text-align:center;color:#999;padding:40px}
        button.fm-btn{padding:7px 14px;border-radius:8px;border:1px solid var(--accent,#3b82f6);background:var(--accent,#3b82f6);color:#fff;cursor:pointer;font-size:13px}
        button.fm-btn.ghost{background:transparent;color:var(--accent,#3b82f6)}
        .fm-modal-body{padding:16px;max-width:560px;max-height:80vh;overflow:auto}
        .fm-field{margin-bottom:12px}
        .fm-field label{display:block;font-size:12px;color:#777;margin-bottom:4px}
        .fm-field input,.fm-field textarea,.fm-field select{width:100%;padding:8px;border:1px solid var(--border,#ddd);border-radius:8px;background:var(--bg,#fff);color:var(--text,#222);box-sizing:border-box}
      </style>
      <div class="fm-head">
        <h2>${esc(t('memory.title'))}</h2>
        <div class="fm-spacer"></div>
        <button class="fm-btn ghost" id="fm-export">${esc(t('memory.export'))}</button>
        <button class="fm-btn" id="fm-add">+ ${esc(t('memory.add'))}</button>
      </div>
      <div class="fm-filters">
        <select id="fm-type"><option value="">${esc(t('memory.allTypes'))}</option>${TYPES.map(
          (s) => `<option value="${s}">${esc(t('memory.type.' + s))}</option>`
        ).join('')}</select>
        <select id="fm-member"><option value="">${esc(t('memory.allMembers'))}</option></select>
        <input id="fm-tag" placeholder="${esc(t('memory.tag'))}" style="width:110px">
        <input id="fm-q" placeholder="${esc(t('memory.searchPlaceholder'))}" style="min-width:180px">
      </div>
      <div class="fm-timeline" id="fm-list"><div class="fm-empty">${esc(t('memory.loading'))}</div></div>
    </div>
  `;

  const state = { type: '', member: '', tag: '', q: '', members: [] };
  const list = container.querySelector('#fm-list');

  const typeEl = container.querySelector('#fm-type');
  const memberEl = container.querySelector('#fm-member');
  const tagEl = container.querySelector('#fm-tag');
  const qEl = container.querySelector('#fm-q');
  let debounce;
  qEl.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      state.q = qEl.value.trim();
      load();
    }, 300);
  });
  typeEl.addEventListener('change', () => {
    state.type = typeEl.value;
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
  container.querySelector('#fm-add').addEventListener('click', () => openAdd());
  container.querySelector('#fm-export').addEventListener('click', () => window.open('/api/v1/memory/export', '_blank'));

  // Fotos: entweder eine URL oder eine strukturierte DMS-Referenz {kind:'dms',...}
  function splitRefs(refs = []) {
    const urls = [];
    const dms = [];
    for (const p of refs || []) {
      if (typeof p === 'string') urls.push(p);
      else if (p && p.kind === 'dms') dms.push(`${p.accountId}:${p.dmsId}`);
    }
    return { urls, dms };
  }

  function buildRefs(urlStr, dmsStr) {
    const refs = String(urlStr || '').split(',').map((x) => x.trim()).filter(Boolean);
    for (const entry of String(dmsStr || '').split(',').map((x) => x.trim()).filter(Boolean)) {
      const idx = entry.indexOf(':');
      const a = idx > 0 ? entry.slice(0, idx).trim() : '';
      const b = idx > 0 ? entry.slice(idx + 1).trim() : '';
      if (a && b) refs.push({ kind: 'dms', accountId: Number(a), dmsId: b });
    }
    return refs;
  }

  function itemHtml(it) {
    const photos = (it.photo_refs || [])
      .map((p) => {
        if (typeof p === 'string') {
          return /^https?:\/\//.test(p)
            ? `<img src="${esc(p)}" alt="" loading="lazy">`
            : `<span class="fm-photo-ref">${esc(p)}</span>`;
        }
        if (p && p.kind === 'dms') {
          const src = `/api/v1/memory/photo?accountId=${encodeURIComponent(p.accountId)}&dmsId=${encodeURIComponent(p.dmsId)}`;
          return `<img class="fm-photo-dms" src="${esc(src)}" alt="DMS ${esc(p.dmsId)}" loading="lazy">`;
        }
        return `<span class="fm-photo-ref">${esc(JSON.stringify(p))}</span>`;
      })
      .join('');
    const tags = (it.tags || []).map((tg) => `<span class="fm-tag">${esc(tg)}</span>`).join('');
    const members = (it.members || []).map((m) => esc(m.name || '#' + m.uid)).join(', ');
    const lock = it.is_locked ? ' 🔒' : '';
    return `<div class="fm-item" data-id="${it.id}">
      <h3>${esc(it.title)}${lock}<span class="fm-type">${esc(t('memory.type.' + it.type))}</span></h3>
      <div class="fm-meta">${esc((it.event_time || '').slice(0, 10) || '')} · ${esc(it.location || '')} · ${esc(members)}</div>
      <div class="fm-desc">${esc(it.description || '')}</div>
      ${photos ? `<div class="fm-photos">${photos}</div>` : ''}
      ${tags ? `<div>${tags}</div>` : ''}
    </div>`;
  }

  async function load() {
    list.innerHTML = `<div class="fm-empty">${esc(t('memory.loading'))}</div>`;
    try {
      const params = new URLSearchParams();
      if (state.type) params.set('type', state.type);
      if (state.member) params.set('member', state.member);
      if (state.tag) params.set('tag', state.tag);
      if (state.q) params.set('q', state.q);
      const r = await api.get('/memory/list?' + params.toString());
      const items = (r.data || []).filter(
        (it) => !(it.is_locked && it.creator_uid && user && it.creator_uid !== user.id)
      );
      if (!items.length) {
        list.innerHTML = `<div class="fm-empty">${esc(t('memory.empty'))}</div>`;
        return;
      }
      list.innerHTML = items.map(itemHtml).join('');
      list.querySelectorAll('.fm-item').forEach((el) =>
        el.addEventListener('click', () => openDetail(parseInt(el.dataset.id, 10)))
      );
    } catch {
      list.innerHTML = `<div class="fm-empty">${esc(t('common.error') || 'Fehler')}</div>`;
    }
  }

  function memberPicker(selected) {
    const sel = new Set(selected || []);
    return `<div class="fm-member-picker">${state.members
      .map(
        (m) =>
          `<label class="fm-tag"><input type="checkbox" data-uid="${m.id}" ${
            sel.has(m.id) ? 'checked' : ''
          }> ${esc(m.name || m.display_name || '#' + m.id)}</label>`
      )
      .join('')}</div>`;
  }
  function getPicked(root) {
    return Array.from(root.querySelectorAll('.fm-member-picker input:checked')).map((x) => parseInt(x.dataset.uid, 10));
  }

  async function openDetail(id) {
    let item;
    try {
      item = (await api.get('/memory/' + id)).data;
    } catch {
      return;
    }
    const body = document.createElement('div');
    body.className = 'fm-modal-body';
    body.innerHTML = `
      <h3>${esc(item.title)}</h3>
      <div class="fm-field"><label>${esc(t('memory.type.label'))}</label>
        <select id="d-type">${TYPES.map(
          (s) => `<option value="${s}" ${item.type === s ? 'selected' : ''}>${esc(t('memory.type.' + s))}</option>`
        ).join('')}</select></div>
      <div class="fm-field"><label>${esc(t('memory.eventTime'))}</label><input id="d-time" type="date" value="${esc((item.event_time || '').slice(0, 10))}"></div>
      <div class="fm-field"><label>${esc(t('memory.location'))}</label><input id="d-loc" value="${esc(item.location || '')}"></div>
      <div class="fm-field"><label>${esc(t('memory.description'))}</label><textarea id="d-desc" rows="3">${esc(item.description || '')}</textarea></div>
      <div class="fm-field"><label>${esc(t('memory.photos'))} (URLs, durch Komma getrennt)</label><input id="d-photos" value="${esc(splitRefs(item.photo_refs).urls.join(', '))}"></div>
      <div class="fm-field"><label>${esc(t('memory.dmsRefs'))}</label><input id="d-dms" placeholder="1:42" value="${esc(splitRefs(item.photo_refs).dms.join(', '))}"></div>
      <div class="fm-field"><label>${esc(t('memory.tags'))}</label><input id="d-tags" value="${esc((item.tags || []).join(', '))}"></div>
      <div class="fm-field"><label>${esc(t('memory.members'))}</label>${memberPicker((item.members || []).map((m) => m.uid))}</div>
      <div class="fm-field"><label><input type="checkbox" id="d-lock" ${item.is_locked ? 'checked' : ''}> ${esc(t('memory.locked'))}</label></div>
      <div style="display:flex;gap:8px;margin-top:10px">
        <button class="fm-btn ghost" id="d-del">${esc(t('memory.delete'))}</button>
        <div class="fm-spacer" style="flex:1"></div>
        <button class="fm-btn" id="d-save">${esc(t('memory.save'))}</button>
      </div>
    `;
    openModal({
      title: item.title,
      content: '',
      onSave: (panel) => panel.querySelector('.modal-panel__body').replaceChildren(body),
    });
    body.querySelector('#d-save').addEventListener('click', async () => {
      const payload = {
        type: body.querySelector('#d-type').value,
        event_time: body.querySelector('#d-time').value || null,
        location: body.querySelector('#d-loc').value,
        description: body.querySelector('#d-desc').value,
        photo_refs: buildRefs(body.querySelector('#d-photos').value, body.querySelector('#d-dms').value),
        tags: body.querySelector('#d-tags').value.split(',').map((x) => x.trim()).filter(Boolean),
        is_locked: body.querySelector('#d-lock').checked,
        members: getPicked(body),
      };
      try {
        await api.put('/memory/' + id, payload);
        closeModal();
        load();
      } catch {
        alert(t('common.error') || 'Fehler');
      }
    });
    body.querySelector('#d-del').addEventListener('click', async () => {
      if (!(await confirmModal(t('memory.confirmDelete') || 'Wirklich löschen?'))) return;
      try {
        await api.delete('/memory/' + id);
        closeModal();
        load();
      } catch {}
    });
  }

  function openAdd() {
    const body = document.createElement('div');
    body.className = 'fm-modal-body';
    body.innerHTML = `
      <div class="fm-field"><label>${esc(t('memory.type.label'))}</label>
        <select id="a-type">${TYPES.map((s) => `<option value="${s}">${esc(t('memory.type.' + s))}</option>`).join('')}</select></div>
      <div class="fm-field"><label>${esc(t('memory.title'))}</label><input id="a-title"></div>
      <div class="fm-field"><label>${esc(t('memory.eventTime'))}</label><input id="a-time" type="date"></div>
      <div class="fm-field"><label>${esc(t('memory.location'))}</label><input id="a-loc"></div>
      <div class="fm-field"><label>${esc(t('memory.description'))}</label><textarea id="a-desc" rows="3"></textarea></div>
      <div class="fm-field"><label>${esc(t('memory.photos'))} (URLs, Komma-getrennt)</label><input id="a-photos" placeholder="https://..."></div>
      <div class="fm-field"><label>${esc(t('memory.dmsRefs'))}</label><input id="a-dms" placeholder="1:42"></div>
      <div class="fm-field"><label>${esc(t('memory.tags'))}</label><input id="a-tags"></div>
      <div class="fm-field"><label>${esc(t('memory.members'))}</label>${memberPicker([])}</div>
      <div class="fm-field"><label><input type="checkbox" id="a-lock"> ${esc(t('memory.locked'))}</label></div>
      <div style="display:flex;gap:8px"><div class="fm-spacer" style="flex:1"></div><button class="fm-btn" id="a-save">${esc(t('memory.save'))}</button></div>
    `;
    openModal({
      title: t('memory.add'),
      content: '',
      onSave: (panel) => panel.querySelector('.modal-panel__body').replaceChildren(body),
    });
    body.querySelector('#a-save').addEventListener('click', async () => {
      const title = body.querySelector('#a-title').value.trim();
      if (!title) {
        alert(t('memory.titleRequired') || 'Titel erforderlich');
        return;
      }
      const payload = {
        type: body.querySelector('#a-type').value,
        title,
        event_time: body.querySelector('#a-time').value || null,
        location: body.querySelector('#a-loc').value,
        description: body.querySelector('#a-desc').value,
        photo_refs: buildRefs(body.querySelector('#a-photos').value, body.querySelector('#a-dms').value),
        tags: body.querySelector('#a-tags').value.split(',').map((x) => x.trim()).filter(Boolean),
        is_locked: body.querySelector('#a-lock').checked,
        members: getPicked(body),
      };
      try {
        await api.post('/memory/add', payload);
        closeModal();
        load();
      } catch {
        alert(t('common.error') || 'Fehler');
      }
    });
  }

  state.members = await loadMembersList();
  memberEl.innerHTML =
    `<option value="">${esc(t('memory.allMembers'))}</option>` +
    state.members.map((m) => `<option value="${m.id}">${esc(m.name || m.display_name || '#' + m.id)}</option>`).join('');
  await load();
}
