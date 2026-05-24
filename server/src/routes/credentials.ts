import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';

function resolveUserId(_req: { headers: Record<string, string | string[] | undefined> }): string {
  return 'guest';
}

export async function credentialsRoutes(app: FastifyInstance) {
  app.get('/providers/:providerId/credentials', async (req, reply) => {
    const { providerId } = req.params as { providerId: string };
    const userId = resolveUserId(req);

    const { rows } = await pool.query(
      'SELECT tier FROM users WHERE id = $1',
      [userId],
    );

    if (!rows[0] || rows[0].tier !== 'premium') {
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
