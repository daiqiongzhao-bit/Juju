/**
 * Modul: KI für den Haushalts-Medizinschrank
 * Zweck: 1) Foto eines Medikamentenpackungs- oder Etiketts auswerten (Name,
 *           Form, Charge/Haltbarkeit, wenn lesbar) - OpenAI-kompatibles
 *           /chat/completions mit Bild-Content.
 *        2) Beipackzettel-Texte für ein Mittel generieren, das NICHT im
 *           eingebauten Katalog steht ("eingebaut zuerst, sonst KI").
 *
 * Beides folgt dem Muster aus ai-recipe.js: ein fetch, kein SDK, niemals throw -
 * Fehler kommen strukturiert zurück ({ ok:false, code, message }).
 * Die KI-Texte sind Ausschnitt-Orientierung, keine Packungsbeilage: die Ober-
 * fläche muss sie als "KI-generiert, bitte Arzt fragen" kennzeichnen.
 */

import { createLogger } from '../logger.js';
import * as aiConfig from './ai-config.js';

const log = createLogger('AIDrug');
const TIMEOUT_MS = 30000;

/** Extrahiert das erste JSON-Objekt aus einer (möglicherweise gesprochenen) Antwort. */
function extractJson(content) {
  if (!content) return null;
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : content;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function chatComplete(messages, { temperature = 0.2, timeoutMs = TIMEOUT_MS } = {}) {
  const cfg = aiConfig.getConfig();
  // Base URL 留空 = 走提供方预设（与 ai-recipe.js 同一约定）。之前药箱这边
  // 严格要求 baseUrl，导致「只选提供方、不填 Base URL」的用户菜谱能用、
  // 药箱却误报"未配置"——两边必须同样兜底（反馈 2026-10-28）。
  const baseUrl = cfg.baseUrl || aiConfig.providerByKey(cfg.provider).baseUrl || '';
  if (!cfg.enabled || !cfg.apiKey || !baseUrl || !cfg.model) {
    return { ok: false, code: 'not-configured', message: 'AI is not configured.' };
  }
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const response = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({ model: cfg.model, messages, temperature }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      log.warn('AI drug request failed', response.status, String(detail).slice(0, 200));
      return {
        ok: false,
        code: response.status === 401 || response.status === 403 ? 'auth' : 'http',
        message: 'The AI provider rejected the request.',
        status: response.status,
        latencyMs: Date.now() - startedAt,
      };
    }
    const payload = await response.json().catch(() => null);
    const content = payload?.choices?.[0]?.message?.content;
    return {
      ok: true,
      content: typeof content === 'string' ? content : '',
      latencyMs: Date.now() - startedAt,
    };
  } catch (err) {
    const aborted = err?.name === 'AbortError' || String(err?.message ?? '').includes('aborted');
    return { ok: false, code: aborted ? 'timeout' : 'network', message: aborted ? 'AI request timed out.' : 'Network error.' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Foto-Erkennung: Bild (data-URL) → Medikamenten-Angaben.
 * @param {string} imageDataUrl - „data:image/jpeg;base64,..."
 * @returns {Promise<{ok:boolean, code?:string, message?:string,
 *                     data?:{name?:string, form?:string, batch_no?:string,
 *                            expiry_date?:string, note?:string}}>}
 */
export async function scanMedicationPhoto(imageDataUrl) {
  const match = /^data:(image\/(?:png|jpe?g|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(imageDataUrl || ''));
  if (!match) return { ok: false, code: 'bad-image', message: 'Unsupported image format.' };
  // Grobe Größenbegrenzung: ~6 MB Base64 (≈4,5 MB Bild) reicht für ein Foto.
  if (match[2].length > 8_000_000) return { ok: false, code: 'too-large', message: 'Image too large.' };

  const system =
    'Du liest Medikamentenpackungen (chinesische und internationale). ' +
    'Antworte NUR mit JSON-Objekt, keine weiteren Wörter. Felder: ' +
    'name (Wirkstoff- oder Produktname, so kurz wie möglich), ' +
    'brand (Markenname auf der Packung, falls lesbar, sonst null), ' +
    'manufacturer (Hersteller, falls lesbar, sonst null), ' +
    'barcode (Strichcode-Ziffernfolge, falls lesbar, sonst null), ' +
    'form (Dosierform: 片剂/胶囊/颗粒/混悬液/软膏/喷雾/滴眼液/其他), ' +
    'batch_no (Produktions-/Chargennummer, falls lesbar, sonst null), ' +
    'expiry_date (Haltbarkeit als YYYY-MM-DD, falls lesbar, sonst null), ' +
    'note (max. 1 Satz zu dem, was auf der Packung sonst noch auffällt, sonst null). ' +
    'Wenn das Bild kein Medikament zeigt: {"error":"not-medication"}.';

  const result = await chatComplete([
    { role: 'system', content: system },
    {
      role: 'user',
      content: [
        { type: 'text', text: '识别这个药品包装上的信息。' },
        { type: 'image_url', image_url: { url: imageDataUrl } },
      ],
    },
  ]);
  if (!result.ok) return result;

  const parsed = extractJson(result.content);
  if (!parsed) return { ok: false, code: 'parse', message: 'AI response was not valid JSON.' };
  if (parsed.error === 'not-medication') {
    return { ok: false, code: 'not-medication', message: 'No medication recognized in the image.' };
  }
  const clean = (v) => (typeof v === 'string' && v.trim() && v !== 'null' ? v.trim().slice(0, 120) : undefined);
  const dateOk = /^\d{4}-\d{2}-\d{2}$/.test(String(parsed.expiry_date || ''));
  return {
    ok: true,
    data: {
      name: clean(parsed.name),
      brand: clean(parsed.brand),
      manufacturer: clean(parsed.manufacturer),
      barcode: clean(parsed.barcode),
      form: clean(parsed.form),
      batch_no: clean(parsed.batch_no),
      expiry_date: dateOk ? parsed.expiry_date : undefined,
      note: clean(parsed.note),
    },
  };
}

/**
 * Beipackzettel per KI generieren (nur wenn der Katalog nichts hat).
 * @param {string} name
 * @returns {Promise<{ok:boolean, code?:string, message?:string,
 *                     data?:{efficacy,indications,usage_text,cautions,info_source:string}}>}
 */
export async function aiLeaflet(name) {
  const clean = String(name || '').trim();
  if (!clean) return { ok: false, code: 'bad-name', message: 'Name is required.' };

  const system = [
    'Du schreibst kurze Beipackzettel-Zusammenfassungen für Hausapotheke-Apps (chinesische Medikamente).',
    'Antworte NUR mit JSON-Objekt: {"efficacy":"...","indications":"...","usage_text":"...","cautions":"..."}.',
    'efficacy: ≤25 Zeichen Wirkweise. indications: ≤80 Zeichen. usage_text: typische DOSIS für Erwachsene, ≤120 Zeichen.',
    'cautions: ≤120 Zeichen, MUSS Kontraindikationen und Wechselwirkungen nennen; bei rezeptpflichtigen Mitteln „处方药，须遵医嘱" ergänzen.',
    'Wenn der Begriff kein Medikament ist: {"error":"not-medication"}.',
    'Unbekannte Dosierung nie erfinden - dann "以说明书为准" schreiben.',
  ].join(' ');

  const result = await chatComplete([
    { role: 'system', content: system },
    { role: 'user', content: `药品名称：${clean}` },
  ]);
  if (!result.ok) return result;

  const parsed = extractJson(result.content);
  if (!parsed) return { ok: false, code: 'parse', message: 'AI response was not valid JSON.' };
  if (parsed.error === 'not-medication') {
    return { ok: false, code: 'not-medication', message: 'Not recognized as a medication.' };
  }
  const clip = (v, n) => (typeof v === 'string' && v.trim() && v !== 'null' ? v.trim().slice(0, n) : null);
  return {
    ok: true,
    data: {
      efficacy: clip(parsed.efficacy, 60),
      indications: clip(parsed.indications, 300),
      usage_text: clip(parsed.usage_text, 300),
      cautions: clip(parsed.cautions, 300),
      info_source: 'ai',
    },
  };
}
