import Fastify, { LogController, type FastifyError } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { config } from './config';
import { inLanguage, languageFrom, t } from './lib/i18n';
import { fastifyLogStream, log } from './lib/log';
import { HttpError, NotConfiguredError, UpstreamError } from './lib/upstream';
import { apiRoutes } from './routes';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export async function buildApp() {
  const app = Fastify({
    logger: { level: config.logLevel, stream: fastifyLogStream },
    logController: new LogController({ disableRequestLogging: config.logLevel !== 'debug' }),
    trustProxy: config.trustProxy,
    bodyLimit: 1024 * 1024,
  });

  await app.register(cookie);

  // Everything a request produces for people comes out in its language (see lib/i18n).
  app.addHook('onRequest', (req, _reply, done) => {
    inLanguage(languageFrom(req.headers['x-tuna-lang'] ?? req.headers['accept-language']), done);
  });

  app.setErrorHandler((err: FastifyError | Error, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message });
    if (err instanceof NotConfiguredError) return reply.code(503).send({ error: err.message, service: err.service });
    if (err instanceof UpstreamError) {
      // Navidrome saying no to the saved token means the session is over; anything else is the service's problem.
      const status = err.service === 'Navidrome' && err.status === 401 ? 401 : [400, 403, 404, 409, 422].includes(err.status) ? err.status : 502;
      if (status === 502) log.warn('services', `${err.service} failed (${err.status || 'no answer'}) for ${req.method} ${req.url.split('?')[0]}`, err.message);
      return reply.code(status).send({ error: err.message, service: err.service });
    }
    const status = (err as FastifyError).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: err.message });
    log.error('server', `${req.method} ${req.url.split('?')[0]} failed`, err);
    return reply.code(500).send({ error: t('Something went wrong on the Tuna server') });
  });

  // Cookie-authenticated writes must come from our own app: browsers won't send this header
  // (or a JSON body) cross-site without a CORS preflight we never approve.
  app.addHook('onRequest', async (req) => {
    if (!MUTATING.has(req.method) || !req.url.startsWith('/api/')) return;
    const json = (req.headers['content-type'] ?? '').includes('application/json');
    if (json || req.headers['x-tuna'] || req.headers.authorization?.startsWith('Bearer ')) return;
    throw new HttpError(403, 'Missing X-Tuna header');
  });

  await app.register(apiRoutes, { prefix: '/api' });

  if (config.publicDir) {
    await app.register(fastifyStatic, {
      root: config.publicDir,
      // Files are looked up when asked for, so a new web build shows without a restart.
      wildcard: true,
      setHeaders: (reply, filePath) => {
        // Vite fingerprints everything under assets/, so those can be cached forever.
        reply.header('cache-control', /[\\/]assets[\\/]/.test(filePath) ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
    // Client-side routes (/album/123, /artist/…) all load the app shell.
    app.setNotFoundHandler((req, reply) => {
      if (req.method !== 'GET' || req.url.startsWith('/api/') || req.url.startsWith('/assets/')) return reply.code(404).send({ error: t('Not found') });
      return reply.header('cache-control', 'no-cache').sendFile('index.html');
    });
  }

  return app;
}
