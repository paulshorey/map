import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';

export async function poisRoutes(app: FastifyInstance) {
  app.get('/pois', async (req, reply) => {
    const { bbox, zoom, category } = req.query as Record<string, string>;

    if (!bbox) {
      return reply.code(400).send({ error: 'bbox query parameter is required' });
    }

    const parts = bbox.split(',').map(Number);
    if (parts.length !== 4 || parts.some(Number.isNaN)) {
      return reply.code(400).send({ error: 'bbox must be minLng,minLat,maxLng,maxLat' });
    }

    const [w, s, e, n] = parts;
    const z = Number(zoom) || 0;
    const limit = z < 6 ? 500 : 5000;

    const { rows } = await pool.query(
      `
      SELECT jsonb_build_object(
        'type', 'FeatureCollection',
        'features', COALESCE(jsonb_agg(feature), '[]'::jsonb)
      ) AS geojson
      FROM (
        SELECT jsonb_build_object(
          'type', 'Feature',
          'id', id,
          'geometry', ST_AsGeoJSON(geom::geometry, 6)::jsonb,
          'properties', jsonb_build_object(
            'id', id, 'name', name, 'category', category, 'photo_url', photo_url
          )
        ) AS feature
        FROM pois
        WHERE geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)::geography
          AND ($5::text IS NULL OR category = $5)
        LIMIT $6
      ) sub
      `,
      [w, s, e, n, category ?? null, limit],
    );

    reply
      .header('cache-control', 'public, max-age=30, stale-while-revalidate=300')
      .send(rows[0].geojson);
  });

  app.get('/pois/:id', async (req, reply) => {
    const { id } = req.params as { id: string };

    const { rows } = await pool.query(
      `SELECT id, name, category, description, photo_url,
              ST_AsGeoJSON(geom::geometry, 6)::jsonb AS geometry
       FROM pois WHERE id = $1`,
      [id],
    );

    if (!rows[0]) {
      return reply.code(404).send({ error: 'POI not found' });
    }

    reply.send(rows[0]);
  });
}
