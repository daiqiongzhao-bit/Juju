import { op, jsonBody, stringPathParam } from '../helpers.js';

export function modulesPaths() {
  return {
    '/api/v1/modules': {
      get: op({ summary: 'List installed extension modules', tag: 'Modules' }),
    },
    '/api/v1/modules/{id}': {
      patch: op({ summary: 'Enable or disable an extension module', tag: 'Modules', admin: true, params: [stringPathParam('id', 'Module ID')], stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/modules/assets/{id}/{assetPath}': {
      get: op({
        summary: 'Get protected extension module asset',
        tag: 'Modules',
        params: [
          stringPathParam('id', 'Module ID'),
          stringPathParam('assetPath', 'Asset path within the module'),
        ],
      }),
    },
  };
}
