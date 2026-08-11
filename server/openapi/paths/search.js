import { op } from '../helpers.js';

export function searchPaths() {
  return {
    '/api/v1/search': { get: op({ summary: 'Search across modules', tag: 'Search' }) },
  };
}
