import { op } from '../helpers.js';

export function dashboardPaths() {
  return {
    '/api/v1/dashboard': { get: op({ summary: 'Get dashboard data', tag: 'Dashboard' }) },
  };
}
