import { op, jsonBody, idParam } from '../helpers.js';

export function healthPaths() {
  return {
    '/api/v1/health/vitals': {
      get: op({ summary: 'List vital measurements', tag: 'Health', description: 'Scoped to the viewer; `?user_id=` filters to a family member (only their `family`-visible rows). Optional `type`, `from`, `to` filters.' }),
      post: op({ summary: 'Create a vital measurement', tag: 'Health', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/health/vitals/{id}': {
      patch: op({ summary: 'Update a vital measurement', tag: 'Health', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete a vital measurement', tag: 'Health', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/health/medications': {
      get: op({ summary: 'List medications', tag: 'Health', description: 'Scoped to the viewer; `?user_id=` and `?active=` filters supported.' }),
      post: op({ summary: 'Create a medication', tag: 'Health', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/health/medications/{id}': {
      patch: op({ summary: 'Update a medication', tag: 'Health', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete a medication', tag: 'Health', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/health/medications/{id}/schedules': {
      get: op({ summary: 'List a medication\'s intake schedules', tag: 'Health', params: [idParam()] }),
      post: op({ summary: 'Add an intake schedule to a medication', tag: 'Health', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/health/schedules/{id}': {
      patch: op({ summary: 'Update an intake schedule', tag: 'Health', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete an intake schedule', tag: 'Health', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/health/medications/{id}/logs': {
      get: op({ summary: 'List a medication\'s dose log', tag: 'Health', params: [idParam()], description: 'Optional `from`/`to` filters on `scheduled_at`.' }),
      post: op({ summary: 'Add a dose-log entry', tag: 'Health', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/health/logs/{id}/take': {
      post: op({ summary: 'Mark a dose as taken', tag: 'Health', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/health/logs/{id}/skip': {
      post: op({ summary: 'Mark a dose as skipped', tag: 'Health', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/health/labs': {
      get: op({ summary: 'List lab reports (with results)', tag: 'Health', description: 'Scoped to the viewer; `?user_id=`, `from`, `to` filters supported.' }),
      post: op({ summary: 'Create a lab report with analyte results', tag: 'Health', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/health/labs/{id}': {
      get: op({ summary: 'Get a lab report (with results)', tag: 'Health', params: [idParam()] }),
      patch: op({ summary: 'Update lab report header fields', tag: 'Health', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete a lab report', tag: 'Health', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/health/labs/{id}/results': {
      post: op({ summary: 'Add an analyte result to a lab report', tag: 'Health', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/health/results/{id}': {
      delete: op({ summary: 'Delete an analyte result', tag: 'Health', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/health/activities': {
      get: op({ summary: 'List activities', tag: 'Health', description: 'Scoped to the viewer; `?user_id=`, `type`, `from`, `to` filters supported.' }),
      post: op({ summary: 'Create an activity', tag: 'Health', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/health/activities/{id}': {
      patch: op({ summary: 'Update an activity', tag: 'Health', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete an activity', tag: 'Health', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/health/export/vitals': {
      get: op({ summary: 'Export vital measurements as CSV', tag: 'Health', description: 'Scoped to the viewer; `?user_id=`, `from`, `to` filters supported. Returns `text/csv`.' }),
    },
    '/api/v1/health/export/activities': {
      get: op({ summary: 'Export activities as CSV', tag: 'Health', description: 'Scoped to the viewer; `?user_id=`, `from`, `to` filters supported. Returns `text/csv`.' }),
    },
    '/api/v1/health/export/labs': {
      get: op({ summary: 'Export lab reports (one row per analyte) as CSV', tag: 'Health', description: 'Scoped to the viewer; `?user_id=`, `from`, `to` filters supported. Returns `text/csv`.' }),
    },
    '/api/v1/health/export/meds-logs': {
      get: op({ summary: 'Export medication dose logs as CSV', tag: 'Health', description: 'Scoped to the viewer; `?user_id=`, `from`, `to` filters supported. Returns `text/csv`.' }),
    },
    '/api/v1/health/cycle/periods': {
      get: op({ summary: 'List menstrual period episodes', tag: 'Health', description: 'Scoped to the viewer; `?user_id=`, `from`, `to` filters supported.' }),
      post: op({ summary: 'Log a menstrual period episode', tag: 'Health', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/health/cycle/periods/{id}': {
      patch: op({ summary: 'Update a period episode', tag: 'Health', params: [idParam()], stateChanging: true, requestBody: jsonBody(null) }),
      delete: op({ summary: 'Delete a period episode', tag: 'Health', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/health/cycle/logs': {
      get: op({ summary: 'List cycle day logs (flow, symptoms, mood)', tag: 'Health', description: 'Scoped to the viewer; `?user_id=`, `from`, `to` filters supported.' }),
      post: op({ summary: 'Upsert a cycle day log (one per person and day)', tag: 'Health', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/health/cycle/logs/{id}': {
      delete: op({ summary: 'Delete a cycle day log', tag: 'Health', params: [idParam()], stateChanging: true }),
    },
    '/api/v1/health/cycle/settings': {
      get: op({ summary: 'Get the viewer\'s cycle prediction settings', tag: 'Health' }),
      put: op({ summary: 'Update the viewer\'s cycle prediction settings', tag: 'Health', stateChanging: true, requestBody: jsonBody(null) }),
    },
    '/api/v1/health/export/cycle': {
      get: op({ summary: 'Export period history as CSV', tag: 'Health', description: 'Scoped to the viewer; `?user_id=`, `from`, `to` filters supported. Returns `text/csv`.' }),
    },
  };
}
