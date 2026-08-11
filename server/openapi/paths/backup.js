import { op, jsonBody } from '../helpers.js';

export function backupPaths() {
  return {
    '/api/v1/backup/status': {
      get: op({
        summary: 'Get backup status',
        tag: 'Backup',
        admin: true,
      }),
    },
    '/api/v1/backup/database': {
      get: op({
        summary: 'Download database backup',
        tag: 'Backup',
        admin: true,
        responses: {
          200: {
            description: 'Database backup file',
            content: {
              'application/octet-stream': {
                schema: { type: 'string', format: 'binary' },
              },
            },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/backup/restore': {
      post: op({
        summary: 'Restore database backup',
        tag: 'Backup',
        admin: true,
        stateChanging: true,
        requestBody: {
          required: true,
          description: 'Raw database backup file.',
          content: {
            'application/octet-stream': {
              schema: { type: 'string', format: 'binary' },
            },
          },
        },
        responses: {
          200: { description: 'Database restored' },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/backup/trigger': {
      post: op({
        summary: 'Run a manual local backup',
        tag: 'Backup',
        admin: true,
        stateChanging: true,
      }),
    },
    '/api/v1/backup/webdav/config': {
      get: op({
        summary: 'Get WebDAV backup configuration',
        tag: 'Backup',
        admin: true,
        description: 'Returns the scheduler WebDAV backup target status with the password masked/omitted.',
      }),
      put: op({
        summary: 'Update WebDAV backup configuration',
        tag: 'Backup',
        admin: true,
        stateChanging: true,
        requestBody: jsonBody(null),
      }),
    },
    '/api/v1/backup/webdav/test': {
      post: op({
        summary: 'Test WebDAV backup connection',
        tag: 'Backup',
        admin: true,
        stateChanging: true,
        requestBody: jsonBody(null),
      }),
    },
    '/api/v1/backup/webdav/files': {
      get: op({
        summary: 'List remote WebDAV backup files',
        tag: 'Backup',
        admin: true,
      }),
    },
    '/api/v1/backup/webdav/trigger': {
      post: op({
        summary: 'Create and upload a WebDAV backup',
        tag: 'Backup',
        admin: true,
        stateChanging: true,
      }),
    },
  };
}
