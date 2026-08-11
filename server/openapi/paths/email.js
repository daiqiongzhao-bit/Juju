import { op } from '../helpers.js';

export function emailPaths() {
  return {
    '/api/v1/email/config': {
      get: op({
        summary: 'Get SMTP email configuration (password masked)',
        tag: 'Email',
        admin: true,
      }),
      put: op({
        summary: 'Update SMTP email configuration',
        tag: 'Email',
        admin: true,
        stateChanging: true,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  host: { type: 'string' },
                  port: { type: 'integer' },
                  secure: { type: 'string', enum: ['ssl', 'starttls', 'none'] },
                  user: { type: 'string' },
                  pass: { type: 'string', description: 'Write-only. Omit to keep the stored password.' },
                  clearPassword: { type: 'boolean' },
                  fromAddress: { type: 'string' },
                  fromName: { type: 'string' },
                },
              },
            },
          },
        },
      }),
    },
    '/api/v1/email/test': {
      post: op({
        summary: 'Send a test email to validate SMTP settings',
        tag: 'Email',
        admin: true,
        stateChanging: true,
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { to: { type: 'string', description: 'Optional recipient override; defaults to the admin\'s linked email.' } },
              },
            },
          },
        },
      }),
    },
  };
}
