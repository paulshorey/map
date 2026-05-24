import type { FastifyInstance } from 'fastify';

export async function credentialsRoutes(app: FastifyInstance) {
  /**
   * Stub credentials endpoint. When auth + entitlements are wired (Phase 7),
   * this checks the user's tier and returns the provider API key only for
   * premium users. The key is stored server-side as an env var.
   */
  app.get('/providers/:providerId/credentials', async (req, reply) => {
    const { providerId } = req.params as { providerId: string };

    // TODO: check auth + tier
    const tier = 'free';
    if (tier !== 'premium') {
      return reply.code(403).send({ error: 'Premium subscription required' });
    }

    const keyMap: Record<string, string | undefined> = {
      thunderforest: process.env.THUNDERFOREST_API_KEY,
    };

    const providerBase = providerId.split('-')[0];
    const apiKey = keyMap[providerBase];

    if (!apiKey) {
      return reply.code(404).send({ error: 'No credentials for this provider' });
    }

    reply.send({ apiKey });
  });
}
