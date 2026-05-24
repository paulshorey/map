import type { FastifyInstance } from 'fastify';

const FREE_PROVIDERS = [
  'openfreemap-liberty',
  'openfreemap-positron',
  'openfreemap-bright',
  'stadia-outdoors',
  'stamen-terrain',
  'alidade-satellite',
  'alidade-smooth',
  'carto-voyager',
  'carto-positron',
  'carto-dark-matter',
  'opentopomap',
];

const PREMIUM_EXTRAS = [
  'thunderforest-outdoors',
  'thunderforest-landscape',
];

export async function meRoutes(app: FastifyInstance) {
  /**
   * Stub /me endpoint. When auth is wired (Phase 6), this reads the
   * authenticated user's tier from the database and computes allowed
   * providers server-side.
   */
  app.get('/me', async (_req, reply) => {
    const tier = 'free';
    const allowedProviders =
      tier === 'premium'
        ? [...FREE_PROVIDERS, ...PREMIUM_EXTRAS]
        : FREE_PROVIDERS;

    reply.send({
      id: 'anonymous',
      tier,
      allowedProviders,
    });
  });
}
