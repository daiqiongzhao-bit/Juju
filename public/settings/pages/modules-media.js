import { t } from '/i18n.js';
import { api } from '/api.js';
import { confirmModal } from '/components/modal.js';

/**
 * Blatt: Medien-Metadaten (影视书库数据源)
 * Zentrale Konfiguration der externen Anreicherung für die Medienbibliothek:
 * TMDB (Film/Serie, Key + optionaler Proxy) und OpenLibrary (Bücher). Die
 * Suche für Musik (iTunes) und der zweite Buchanbieter (Google Books) laufen
 * ohne Schlüssel und sind deshalb reine Hinweise auf diesem Blatt.
 * Vorher lebte dieser Dialog hinter dem "⚙ TMDB"-Button in der Medienbibliothek.
 */

function renderPage(container, cfg) {
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <section class="settings-section">
      <h2 class="settings-section__title">${t('settings.mediaTitle')}</h2>
      <div class="settings-card">
        <h3 class="settings-card__title">${t('settings.mediaTmdbCardTitle')}</h3>
        <p class="settings-card-description">${t('settings.mediaDescription')}</p>

        <div class="settings-sync-info">
          <span class="form-label">TMDB</span>
          <span class="settings-sync-info__status${cfg.tmdbConfigured ? ' settings-sync-info__status--connected' : ''}">
            ${cfg.tmdbConfigured ? t('settings.mediaStatusOk') : t('settings.mediaStatusMissing')}
          </span>
        </div>

        <form class="settings-form settings-form--compact" id="media-config-form" novalidate autocomplete="off">
          <div class="form-group">
            <label class="form-label" for="media-tmdb-key">${t('settings.mediaTmdbKey')}</label>
            <input class="form-input" id="media-tmdb-key" type="password" autocomplete="new-password"
                   placeholder="${t('settings.mediaTmdbKeyPlaceholder')}">
            <p class="form-hint">${t('settings.mediaTmdbKeyHint')}</p>
          </div>
          <div class="form-group">
            <label class="form-label" for="media-tmdb-proxy">${t('settings.mediaTmdbProxy')}</label>
            <input class="form-input" id="media-tmdb-proxy" type="url" value="${cfg.tmdbProxyUrl || ''}"
                   placeholder="https://...">
            <p class="form-hint">${t('settings.mediaTmdbProxyHint')}</p>
          </div>
          <div class="form-group">
            <label class="form-label settings-check" for="media-openlib">
              <input type="checkbox" id="media-openlib" ${cfg.openlibraryEnable ? 'checked' : ''}>
              ${t('settings.mediaOpenlibLabel')}
            </label>
          </div>
          <div id="media-form-error" class="form-error" role="alert" hidden></div>
          <div class="settings-form-actions">
            <button type="submit" class="btn btn--primary">${t('common.save')}</button>
          </div>
        </form>
      </div>

      <div class="settings-card">
        <h3 class="settings-card__title">${t('settings.embyCardTitle')}</h3>
        <p class="settings-card-description">${t('settings.embyCardDesc')}</p>

        <div class="settings-sync-info">
          <span class="form-label">Emby</span>
          <span class="settings-sync-info__status${cfg.embyConfigured ? ' settings-sync-info__status--connected' : ''}">
            ${cfg.embyConfigured ? t('settings.embyStatusOk') : t('settings.embyStatusMissing')}
          </span>
        </div>

        <form class="settings-form settings-form--compact" id="emby-config-form" novalidate autocomplete="off">
          <div class="form-group">
            <label class="form-label" for="emby-url">${t('settings.embyUrl')}</label>
            <input class="form-input" id="emby-url" type="url" value="${cfg.embyUrl || ''}"
                   placeholder="http://192.168.1.10:8096">
            <p class="form-hint">${t('settings.embyUrlHint')}</p>
          </div>
          <div class="form-group">
            <label class="form-label" for="emby-key">${t('settings.embyKey')}</label>
            <input class="form-input" id="emby-key" type="password" autocomplete="new-password"
                   placeholder="${t('settings.embyKeyPlaceholder')}">
            <p class="form-hint">${t('settings.embyKeyHint')}</p>
          </div>
          <div class="form-group">
            <label class="form-label" for="emby-user">${t('settings.embyUser')}</label>
            <select class="form-input" id="emby-user">
              <option value="">${t('settings.embyUserAuto')}</option>
            </select>
            <p class="form-hint">${t('settings.embyUserHint')}</p>
          </div>
          <div id="emby-form-msg" class="form-hint" role="status" hidden></div>
          <div class="settings-form-actions">
            <button type="button" class="btn btn--ghost" id="emby-test">${t('settings.embyTest')}</button>
            <button type="submit" class="btn btn--primary">${t('common.save')}</button>
            <button type="button" class="btn btn--primary" id="emby-sync">${t('settings.embySync')}</button>
            <button type="button" class="btn btn--secondary" id="emby-import">${t('settings.embyImport')}</button>
          </div>
        </form>
      </div>

      <div class="settings-card">
        <h3 class="settings-card__title">${t('settings.mediaFreeSourcesTitle')}</h3>
        <p class="settings-card-description">${t('settings.mediaFreeSourcesDesc')}</p>
        <ul style="margin:8px 0 0;padding-left:18px;font-size:13px;line-height:1.9;color:var(--color-text-secondary,#555)">
          <li><strong>TMDB</strong> — ${t('settings.mediaSourceMovies')}</li>
          <li><strong>iTunes</strong> — ${t('settings.mediaSourceMusic')}</li>
          <li><strong>OpenLibrary</strong> · <strong>Google Books</strong> — ${t('settings.mediaSourceBooks')}</li>
        </ul>
      </div>
    </section>
  `);
}

export async function render(container, { user }) {
  let cfg = {};
  try {
    cfg = (await api.get('/media/config')).data || {};
  } catch { /* Formular bleibt leer */ }
  renderPage(container, cfg);

  const form = container.querySelector('#media-config-form');
  const errorElement = container.querySelector('#media-form-error');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorElement.hidden = true;
    const key = container.querySelector('#media-tmdb-key').value.trim();
    const proxy = container.querySelector('#media-tmdb-proxy').value.trim();
    const openlib = container.querySelector('#media-openlib').checked;
    try {
      const res = await api.put('/media/config', { tmdbApiKey: key, tmdbProxyUrl: proxy, openlibraryEnable: openlib });
      const d = res.data || {};
      window.yuvomi?.showToast(
        d.tmdbConfigured ? t('settings.mediaSavedOk') : t('settings.mediaSavedNoKey'),
        'success'
      );
      await render(container, { user });
    } catch (error) {
      const status = error?.status || error?.code;
      errorElement.textContent = status === 403
        ? t('settings.mediaForbidden')
        : (error?.message || t('common.errorGeneric'));
      errorElement.hidden = false;
    }
  });

  window.lucide?.createIcons({ el: container });

  // ---- Emby: Konfiguration / Test / Watched-Sync ----
  const embyMsg = container.querySelector('#emby-form-msg');
  const showEmbyMsg = (text) => {
    if (!embyMsg) return;
    embyMsg.textContent = text || '';
    embyMsg.hidden = !text;
  };

  function populateEmbyUsers(users, savedId) {
    const sel = container.querySelector('#emby-user');
    if (!sel || !Array.isArray(users) || !users.length) return;
    const current = sel.value;
    sel.replaceChildren();
    const auto = document.createElement('option');
    auto.value = '';
    auto.textContent = t('settings.embyUserAuto');
    sel.appendChild(auto);
    for (const u of users) {
      if (!u?.id) continue;
      const opt = document.createElement('option');
      opt.value = u.id;
      opt.textContent = u.name || u.id;
      sel.appendChild(opt);
    }
    const want = savedId || current;
    if (want && users.some((u) => u.id === want)) sel.value = want;
  }

  async function saveEmbyConfig() {
    const url = container.querySelector('#emby-url').value.trim();
    const key = container.querySelector('#emby-key').value.trim();
    const userSel = container.querySelector('#emby-user');
    const userId = userSel ? userSel.value.trim() : '';
    const res = await api.put('/media/emby/config', { url, apiKey: key, userId });
    return res.data || {};
  }

  container.querySelector('#emby-config-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    showEmbyMsg('');
    try {
      const d = await saveEmbyConfig();
      window.yuvomi?.showToast(d.configured ? t('settings.embySavedOk') : t('settings.embySavedEmpty'), 'success');
      await render(container, { user });
    } catch (error) {
      showEmbyMsg(error?.message || t('common.errorGeneric'));
    }
  });

  container.querySelector('#emby-test')?.addEventListener('click', async () => {
    showEmbyMsg(t('settings.embyTesting'));
    try {
      await saveEmbyConfig();
      const r = (await api.post('/media/emby/test')).data || {};
      populateEmbyUsers(r.users, cfg.embyUserId);
      showEmbyMsg(t('settings.embyTestOk', { name: r.serverName || 'Emby', version: r.version || '' }));
    } catch (error) {
      showEmbyMsg((error?.message || t('common.errorGeneric')));
    }
  });

  container.querySelector('#emby-sync')?.addEventListener('click', async (event) => {
    const btn = event.currentTarget;
    showEmbyMsg(t('settings.embySyncing'));
    btn.disabled = true;
    try {
      await saveEmbyConfig();
      const r = (await api.post('/media/emby/sync')).data || {};
      showEmbyMsg(
        t('settings.embySyncDone', {
          matched: r.matched || 0,
          updated: r.updated || 0,
          emby: r.embyItems || 0,
        })
      );
    } catch (error) {
      showEmbyMsg(error?.message || t('common.errorGeneric'));
    } finally {
      btn.disabled = false;
    }
  });

  container.querySelector('#emby-import')?.addEventListener('click', async (event) => {
    const btn = event.currentTarget;
    const ok = await confirmModal(t('settings.embyImportConfirm'));
    if (!ok) return;
    showEmbyMsg(t('settings.embyImporting'));
    btn.disabled = true;
    try {
      await saveEmbyConfig();
      const r = (await api.post('/media/emby/import')).data || {};
      showEmbyMsg(t('settings.embyImportDone', { imported: r.imported || 0, skipped: r.skipped || 0 }));
    } catch (error) {
      showEmbyMsg(error?.message || t('common.errorGeneric'));
    } finally {
      btn.disabled = false;
    }
  });

  // Bereits konfiguriert? Nutzerliste stillschweigend laden, gespeicherten Nutzer vorauswählen.
  if (cfg.embyConfigured) {
    api.post('/media/emby/test')
      .then((r) => populateEmbyUsers((r.data || {}).users, cfg.embyUserId))
      .catch(() => { /* Server nicht erreichbar — Auto-Auswahl bleibt */ });
  }
}
