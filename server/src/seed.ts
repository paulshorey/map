import { pool } from './db.js';

const CATEGORIES = [
  'Restaurant',
  'Cafe',
  'Park',
  'Museum',
  'Hotel',
  'Bar',
  'Shop',
  'Viewpoint',
  'Trail',
  'Beach',
  'Campsite',
  'Historic Site',
];

const CITY_CLUSTERS: Array<{
  name: string;
  lat: number;
  lng: number;
  radius: number;
  count: number;
}> = [
  { name: 'New York', lat: 40.7128, lng: -74.006, radius: 0.15, count: 80 },
  { name: 'San Francisco', lat: 37.7749, lng: -122.4194, radius: 0.1, count: 70 },
  { name: 'Chicago', lat: 41.8781, lng: -87.6298, radius: 0.12, count: 60 },
  { name: 'Denver', lat: 39.7392, lng: -104.9903, radius: 0.1, count: 50 },
  { name: 'Austin', lat: 30.2672, lng: -97.7431, radius: 0.08, count: 50 },
  { name: 'Seattle', lat: 47.6062, lng: -122.3321, radius: 0.1, count: 50 },
  { name: 'Portland', lat: 45.5152, lng: -122.6784, radius: 0.08, count: 40 },
  { name: 'Miami', lat: 25.7617, lng: -80.1918, radius: 0.1, count: 40 },
  { name: 'Boston', lat: 42.3601, lng: -71.0589, radius: 0.08, count: 40 },
  { name: 'Los Angeles', lat: 34.0522, lng: -118.2437, radius: 0.2, count: 70 },
  { name: 'London', lat: 51.5074, lng: -0.1278, radius: 0.15, count: 60 },
  { name: 'Paris', lat: 48.8566, lng: 2.3522, radius: 0.1, count: 50 },
  { name: 'Tokyo', lat: 35.6762, lng: 139.6503, radius: 0.15, count: 60 },
  { name: 'Sydney', lat: -33.8688, lng: 151.2093, radius: 0.12, count: 50 },
  { name: 'Berlin', lat: 52.52, lng: 13.405, radius: 0.1, count: 40 },
  { name: 'Barcelona', lat: 41.3874, lng: 2.1686, radius: 0.08, count: 40 },
  { name: 'Amsterdam', lat: 52.3676, lng: 4.9041, radius: 0.06, count: 30 },
  { name: 'Rome', lat: 41.9028, lng: 12.4964, radius: 0.08, count: 40 },
  { name: 'Bangkok', lat: 13.7563, lng: 100.5018, radius: 0.1, count: 40 },
  { name: 'Cape Town', lat: -33.9249, lng: 18.4241, radius: 0.1, count: 30 },
  { name: 'Rio de Janeiro', lat: -22.9068, lng: -43.1729, radius: 0.1, count: 30 },
  { name: 'Vancouver', lat: 49.2827, lng: -123.1207, radius: 0.08, count: 30 },
];

function randomInCluster(center: number, radius: number): number {
  return center + (Math.random() - 0.5) * 2 * radius;
}

const ADJECTIVES = [
  'Golden', 'Silver', 'Grand', 'Old', 'New', 'Little', 'Great',
  'Sunny', 'Misty', 'Hidden', 'Royal', 'Blue', 'Green', 'Red',
  'Wild', 'Cozy', 'Rustic', 'Urban', 'Quiet', 'Lively',
];

const NOUNS: Record<string, string[]> = {
  Restaurant: ['Kitchen', 'Grill', 'Bistro', 'Diner', 'Table', 'Plate'],
  Cafe: ['Brew', 'Bean', 'Cup', 'Roast', 'Press', 'Latte'],
  Park: ['Gardens', 'Green', 'Meadow', 'Commons', 'Grove', 'Fields'],
  Museum: ['Gallery', 'Museum', 'Archive', 'Collection', 'Hall', 'Center'],
  Hotel: ['Inn', 'Lodge', 'Suites', 'Hotel', 'Resort', 'Stay'],
  Bar: ['Pub', 'Tavern', 'Lounge', 'Bar', 'Saloon', 'Tap Room'],
  Shop: ['Market', 'Store', 'Emporium', 'Boutique', 'Trading Co', 'Goods'],
  Viewpoint: ['Overlook', 'Vista', 'Point', 'Summit', 'Lookout', 'View'],
  Trail: ['Trail', 'Path', 'Walk', 'Loop', 'Route', 'Way'],
  Beach: ['Beach', 'Shore', 'Cove', 'Bay', 'Sands', 'Coast'],
  Campsite: ['Camp', 'Grounds', 'Site', 'Retreat', 'Wilderness', 'Base'],
  'Historic Site': ['Monument', 'Landmark', 'Heritage', 'Memorial', 'Ruins', 'Fort'],
};

function generateName(category: string): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const nouns = NOUNS[category] ?? ['Place'];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  return `The ${adj} ${noun}`;
}

function generateDescription(name: string, category: string, city: string): string {
  const descriptions = [
    `A wonderful ${category.toLowerCase()} located in the heart of ${city}.`,
    `${name} is one of ${city}'s most beloved ${category.toLowerCase()}s.`,
    `Discover ${name}, a fantastic ${category.toLowerCase()} in ${city}.`,
    `Visit ${name} for an unforgettable ${category.toLowerCase()} experience in ${city}.`,
  ];
  return descriptions[Math.floor(Math.random() * descriptions.length)];
}

async function seed() {
  const values: string[] = [];
  const params: (string | number)[] = [];
  let paramIdx = 1;

  for (const cluster of CITY_CLUSTERS) {
    for (let i = 0; i < cluster.count; i++) {
      const category = CATEGORIES[Math.floor(Math.random() * CATEGORIES.length)];
      const name = generateName(category);
      const description = generateDescription(name, category, cluster.name);
      const lat = randomInCluster(cluster.lat, cluster.radius);
      const lng = randomInCluster(cluster.lng, cluster.radius);

      values.push(
        `($${paramIdx}, $${paramIdx + 1}, $${paramIdx + 2}, ST_SetSRID(ST_MakePoint($${paramIdx + 3}, $${paramIdx + 4}), 4326)::geography)`,
      );
      params.push(name, category, description, lng, lat);
      paramIdx += 5;
    }
  }

  await pool.query(`DELETE FROM pois`);
  await pool.query(
    `INSERT INTO pois (name, category, description, geom) VALUES ${values.join(', ')}`,
    params,
  );

  const { rows } = await pool.query('SELECT count(*) FROM pois');
  console.log(`Seeded ${rows[0].count} POIs`);
  await pool.end();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
