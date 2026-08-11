import { buildPaths } from './openapi/paths/index.js';
import { apiTags } from './openapi/tags.js';
import { schemas } from './openapi/schemas.js';

function buildOpenApiSpec(req, appVersion) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Yuvomi API',
      version: appVersion,
      description: 'OpenAPI documentation for the Yuvomi family organizer backend.',
    },
    servers: [{ url: '/', description: 'Current origin' }],
    tags: apiTags,
    paths: buildPaths(),
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'API token sent in the Authorization header as `Bearer <token>`.',
        },
        apiKeyAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'X-API-Key',
          description: 'API token sent in the `X-API-Key` header. `API-Key` is also accepted for MCP compatibility.',
        },
        cookieAuth: {
          type: 'apiKey',
          in: 'cookie',
          name: 'yuvomi.sid',
          description: 'Browser session cookie. State-changing requests also require `X-CSRF-Token`.',
        },
      },
      responses: {
        BadRequest: {
          description: 'Bad request',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
        },
        Unauthorized: {
          description: 'Authentication required or invalid credentials/token',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
        },
        Forbidden: {
          description: 'Permission denied',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
        },
        InternalServerError: {
          description: 'Internal server error',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
        },
      },
      schemas,
    },
  };
}

export { buildOpenApiSpec };
