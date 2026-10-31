import { op } from '../helpers.js';

/**
 * Allgemeiner Datenimport (CSV/JSON).
 * Admin-only — importiert in Module, die der ganze Haushalt sieht.
 */
export function importPaths() {
  return {
    '/api/v1/import/modules': {
      get: op({
        summary: 'List import targets with their mappable fields',
        tag: 'Import',
        admin: true,
      }),
    },
    '/api/v1/import/preview': {
      post: op({
        summary: 'Parse an upload and return headers, up to 20 preview rows and a suggested column mapping',
        tag: 'Import',
        admin: true,
        stateChanging: true,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['module', 'content'],
                properties: {
                  module: { type: 'string', enum: ['tasks', 'contacts', 'shopping', 'recipes'] },
                  format: { type: 'string', enum: ['csv', 'json'], default: 'csv' },
                  content: { type: 'string', description: 'File contents (max 8 MB).' },
                  filename: { type: 'string' },
                  hasHeader: { type: 'boolean', default: true },
                  delimiter: { type: 'string', description: 'Single character; auto-detected when omitted.' },
                },
              },
            },
          },
        },
      }),
    },
    '/api/v1/import/run': {
      post: op({
        summary: 'Import rows; per-row failures are reported, never rolled back as a batch',
        tag: 'Import',
        admin: true,
        stateChanging: true,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['module', 'content', 'mapping'],
                properties: {
                  module: { type: 'string', enum: ['tasks', 'contacts', 'shopping', 'recipes'] },
                  format: { type: 'string', enum: ['csv', 'json'], default: 'csv' },
                  content: { type: 'string' },
                  filename: { type: 'string' },
                  hasHeader: { type: 'boolean', default: true },
                  delimiter: { type: 'string' },
                  mapping: { type: 'object', description: 'Target field -> zero-based source column index.' },
                  dry_run: { type: 'boolean', default: false },
                  skip_duplicates: { type: 'boolean', default: true, description: 'Idempotency: rows already imported are skipped.' },
                },
              },
            },
          },
        },
      }),
    },
    '/api/v1/import/history': {
      get: op({
        summary: 'Recent import batches with created/skipped/failed counters',
        tag: 'Import',
        admin: true,
      }),
    },
  };
}

/**
 * KI-Rezeptgenerierung. Konfiguration ist Admin-only, die Erzeugung offen
 * für alle angemeldeten Mitglieder.
 */
export function aiPaths() {
  return {
    '/api/v1/ai/config': {
      get: op({
        summary: 'Get AI provider configuration (API key masked)',
        tag: 'AI',
        admin: true,
      }),
      put: op({
        summary: 'Update AI provider configuration',
        tag: 'AI',
        admin: true,
        stateChanging: true,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  provider: { type: 'string', enum: ['openai', 'deepseek', 'qwen', 'custom'] },
                  baseUrl: { type: 'string', description: 'Empty uses the provider preset.' },
                  apiKey: { type: 'string', description: 'Write-only, SM4-encrypted at rest. Omit to keep the stored key.' },
                  clearKey: { type: 'boolean' },
                  model: { type: 'string' },
                  enabled: { type: 'boolean' },
                },
              },
            },
          },
        },
      }),
    },
    '/api/v1/ai/test': {
      post: op({
        summary: 'Send a minimal request to verify endpoint, key and model',
        tag: 'AI',
        admin: true,
        stateChanging: true,
      }),
    },
    '/api/v1/ai/recipes/generate': {
      post: op({
        summary: 'Generate a structured recipe from a natural-language request (degrades to plain text)',
        tag: 'AI',
        stateChanging: true,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['prompt'],
                properties: {
                  prompt: { type: 'string', maxLength: 2000 },
                  servings: { type: 'integer' },
                },
              },
            },
          },
        },
      }),
    },
  };
}
