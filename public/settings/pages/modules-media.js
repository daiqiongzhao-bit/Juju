import { t } from '/i18n.js';
import { api } from '/api.js';

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
}
