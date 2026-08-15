export function relationshipsPaths() {
  return {
    '/api/v1/relationships': {
      get: {
        summary: 'List relationship edges between contacts',
        tags: ['Relationships'],
        parameters: [
          { name: 'contactId', in: 'query', schema: { type: 'integer' }, description: 'Filter edges touching this contact' },
        ],
        responses: { 200: { description: 'List of edges with contact names' } },
      },
      post: {
        summary: 'Create a relationship edge',
        tags: ['Relationships'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['contact_a', 'contact_b'],
                properties: {
                  contact_a: { type: 'integer' },
                  contact_b: { type: 'integer' },
                  relation_type: { type: 'string', enum: ['knows', 'family', 'friend', 'partner', 'colleague', 'neighbor', 'acquaintance', 'met-through'] },
                  note: { type: 'string' },
                },
              },
            },
          },
        },
        responses: { 201: { description: 'Created edge' }, 409: { description: 'Already exists' } },
      },
    },
    '/api/v1/relationships/{id}': {
      put: {
        summary: 'Update a relationship edge',
        tags: ['Relationships'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: { 200: { description: 'Updated edge' } },
      },
      delete: {
        summary: 'Delete a relationship edge',
        tags: ['Relationships'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: { 204: { description: 'Deleted' } },
      },
    },
    '/api/v1/relationships/graph': {
      get: {
        summary: 'Network graph data (nodes + edges)',
        tags: ['Relationships'],
        responses: { 200: { description: 'Nodes and edges' } },
      },
    },
    '/api/v1/relationships/common': {
      get: {
        summary: 'Common contacts per edge',
        tags: ['Relationships'],
        parameters: [
          { name: 'contactId', in: 'query', schema: { type: 'integer' }, description: 'Focus on edges touching this contact' },
        ],
        responses: { 200: { description: 'Edges with shared contacts' } },
      },
    },
    '/api/v1/relationships/tree': {
      get: {
        summary: 'Relationship tree (source contacts + shared connections)',
        tags: ['Relationships'],
        parameters: [
          { name: 'sourceIds', in: 'query', schema: { type: 'string' }, description: 'Comma-separated contact IDs to use as tree roots' },
        ],
        responses: { 200: { description: 'Tree structure with sources, branches, shared and commonToAll contacts' } },
      },
    },
    '/api/v1/relationships/interactions': {
      get: {
        summary: 'List interaction events',
        tags: ['Relationships'],
        parameters: [
          { name: 'contactId', in: 'query', schema: { type: 'integer' } },
          { name: 'q', in: 'query', schema: { type: 'string' } },
        ],
        responses: { 200: { description: 'List of interactions' } },
      },
      post: {
        summary: 'Create an interaction event',
        tags: ['Relationships'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['contact_id', 'occurred_at'],
                properties: {
                  contact_id: { type: 'integer' },
                  type: { type: 'string', enum: ['note', 'call', 'meeting', 'message', 'gift', 'other'] },
                  note: { type: 'string' },
                  occurred_at: { type: 'string', format: 'date' },
                },
              },
            },
          },
        },
        responses: { 201: { description: 'Created interaction' } },
      },
    },
    '/api/v1/relationships/interactions/{id}': {
      delete: {
        summary: 'Delete an interaction event',
        tags: ['Relationships'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: { 204: { description: 'Deleted' } },
      },
    },
    '/api/v1/relationships/anniversaries': {
      get: {
        summary: 'List anniversaries (with reminders synced)',
        tags: ['Relationships'],
        responses: { 200: { description: 'List of anniversaries' } },
      },
      post: {
        summary: 'Create an anniversary and sync calendar/reminder',
        tags: ['Relationships'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['contact_id', 'title', 'anniversary_date'],
                properties: {
                  contact_id: { type: 'integer' },
                  title: { type: 'string' },
                  anniversary_date: { type: 'string', pattern: '^\\d{2}-\\d{2}$', description: 'MM-DD' },
                  notes: { type: 'string' },
                  reminder_offset: { type: 'string' },
                  reminder_custom_amount: { type: 'integer' },
                  reminder_custom_unit: { type: 'string' },
                },
              },
            },
          },
        },
        responses: { 201: { description: 'Created anniversary' } },
      },
    },
    '/api/v1/relationships/anniversaries/{id}': {
      put: {
        summary: 'Update an anniversary',
        tags: ['Relationships'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: { 200: { description: 'Updated anniversary' } },
      },
      delete: {
        summary: 'Delete an anniversary (and its calendar/reminder artifacts)',
        tags: ['Relationships'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: { 204: { description: 'Deleted' } },
      },
    },
    '/api/v1/relationships/contacts/{id}': {
      patch: {
        summary: 'Update contact relationship_type and/or photo',
        tags: ['Relationships'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: { 200: { description: 'Updated contact' } },
      },
    },
    '/api/v1/relationships/meta/options': {
      get: {
        summary: 'Relationship module metadata (photo limits, allowed values)',
        tags: ['Relationships'],
        responses: { 200: { description: 'Metadata' } },
      },
    },
  };
}
