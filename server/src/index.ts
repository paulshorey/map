import Fastify from 'fastify';
import cors from '@fastify/cors';
import { poisRoutes } from './routes/pois.js';
import { meRoutes } from './routes/me.js';
import { credentialsRoutes } from './routes/credentials.js';

const app = Fastify({ logger: true });

await app.register(cors, {
  origin: [
    'http://localhost:5173',
    'http://localhost:4173',
    'http://127.0.0.1:5173',
  ],
  credentials: true,
});

await app.register(poisRoutes);
await app.register(meRoutes);
await app.register(credentialsRoutes);

app.get('/health', async () => ({ status: 'ok' }));

const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || '0.0.0.0';

try {
  await app.listen({ port, host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
