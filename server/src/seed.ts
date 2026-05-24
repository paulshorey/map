import { pool } from './db.js';

interface SeedPoi {
  name: string;
  category: string;
  description: string;
  lat: number;
  lng: number;
  address?: string;
  website?: string;
  hours?: string;
  photo_url?: string;
}

const POIS: SeedPoi[] = [
  // ── New York City ──────────────────────────────────────────────
  {
    name: 'Central Park',
    category: 'Park',
    description: 'An 843-acre urban park in the heart of Manhattan, featuring walking paths, a lake, a zoo, and open lawns. One of the most visited urban parks in the world.',
    lat: 40.7829,
    lng: -73.9654,
    address: 'New York, NY 10024',
    website: 'https://www.centralparknyc.org',
    hours: 'Open daily, 6:00 AM – 1:00 AM',
  },
  {
    name: 'Statue of Liberty',
    category: 'Historic Site',
    description: 'A colossal neoclassical sculpture on Liberty Island, a gift from France dedicated in 1886. The statue represents Libertas, the Roman goddess of freedom.',
    lat: 40.6892,
    lng: -74.0445,
    address: 'Liberty Island, New York, NY 10004',
    website: 'https://www.nps.gov/stli',
    hours: 'Open daily, 9:00 AM – 5:00 PM',
  },
  {
    name: 'The Metropolitan Museum of Art',
    category: 'Museum',
    description: 'The largest art museum in the Americas, housing over two million works spanning 5,000 years of art from around the globe.',
    lat: 40.7794,
    lng: -73.9632,
    address: '1000 Fifth Avenue, New York, NY 10028',
    website: 'https://www.metmuseum.org',
    hours: 'Sun–Tue, Thu: 10 AM–5 PM; Fri–Sat: 10 AM–9 PM; Closed Wed',
  },
  {
    name: 'Brooklyn Bridge',
    category: 'Historic Site',
    description: 'Completed in 1883, this iconic hybrid cable-stayed/suspension bridge connects Manhattan and Brooklyn. Walk or bike the pedestrian promenade for stunning skyline views.',
    lat: 40.7061,
    lng: -73.9969,
    address: 'Brooklyn Bridge, New York, NY 10038',
  },
  {
    name: 'Times Square',
    category: 'Viewpoint',
    description: 'A major commercial intersection and tourist destination in Midtown Manhattan, famous for its bright lights, Broadway theaters, and New Year\'s Eve ball drop.',
    lat: 40.7580,
    lng: -73.9855,
    address: 'Manhattan, NY 10036',
    website: 'https://www.timessquarenyc.org',
  },
  {
    name: 'Joe\'s Pizza',
    category: 'Restaurant',
    description: 'A legendary New York slice joint in Greenwich Village, serving classic thin-crust pizza since 1975. A favorite of locals and tourists alike.',
    lat: 40.7306,
    lng: -73.9969,
    address: '7 Carmine St, New York, NY 10014',
    website: 'https://www.joespizzanyc.com',
    hours: 'Open daily, 10:00 AM – 4:00 AM',
  },

  // ── San Francisco ──────────────────────────────────────────────
  {
    name: 'Golden Gate Bridge',
    category: 'Viewpoint',
    description: 'An Art Deco suspension bridge spanning the Golden Gate strait. At 1.7 miles long, its iconic International Orange towers have been a San Francisco symbol since 1937.',
    lat: 37.8199,
    lng: -122.4783,
    address: 'Golden Gate Bridge, San Francisco, CA 94129',
    website: 'https://www.goldengate.org',
  },
  {
    name: 'Alcatraz Island',
    category: 'Historic Site',
    description: 'A small island in San Francisco Bay, home to the infamous former federal penitentiary. Now a national historic landmark and popular tourist attraction.',
    lat: 37.8267,
    lng: -122.4230,
    address: 'Alcatraz Island, San Francisco, CA 94133',
    website: 'https://www.nps.gov/alca',
    hours: 'Ferries depart daily from Pier 33',
  },
  {
    name: 'Fisherman\'s Wharf',
    category: 'Shop',
    description: 'A bustling waterfront neighborhood known for seafood restaurants, souvenir shops, the Boudin Bakery, and sea lions lounging at Pier 39.',
    lat: 37.8080,
    lng: -122.4177,
    address: 'Fisherman\'s Wharf, San Francisco, CA 94133',
    website: 'https://www.fishermanswharf.org',
  },
  {
    name: 'Tartine Bakery',
    category: 'Cafe',
    description: 'World-renowned artisan bakery in the Mission District. Famous for its country bread, morning buns, and long lines of devoted fans.',
    lat: 37.7614,
    lng: -122.4241,
    address: '600 Guerrero St, San Francisco, CA 94110',
    website: 'https://www.tartinebakery.com',
    hours: 'Mon–Fri: 7:30 AM–7 PM; Sat–Sun: 8 AM–7 PM',
  },

  // ── London ─────────────────────────────────────────────────────
  {
    name: 'Tower of London',
    category: 'Historic Site',
    description: 'A historic castle on the north bank of the Thames, founded in 1066. Houses the Crown Jewels and has served as a royal palace, prison, and mint.',
    lat: 51.5081,
    lng: -0.0759,
    address: 'London EC3N 4AB, United Kingdom',
    website: 'https://www.hrp.org.uk/tower-of-london',
    hours: 'Tue–Sat: 9 AM–5:30 PM; Sun–Mon: 10 AM–5:30 PM',
  },
  {
    name: 'British Museum',
    category: 'Museum',
    description: 'The world\'s first public national museum, established in 1753. Its collection of eight million works includes the Rosetta Stone and the Elgin Marbles.',
    lat: 51.5194,
    lng: -0.1270,
    address: 'Great Russell St, London WC1B 3DG, United Kingdom',
    website: 'https://www.britishmuseum.org',
    hours: 'Open daily, 10:00 AM – 5:00 PM; Fri until 8:30 PM',
  },
  {
    name: 'Hyde Park',
    category: 'Park',
    description: 'One of London\'s eight Royal Parks, covering 350 acres. Features the Serpentine lake, Speaker\'s Corner, and the Diana Memorial Fountain.',
    lat: 51.5073,
    lng: -0.1657,
    address: 'Hyde Park, London W2 2UH, United Kingdom',
    website: 'https://www.royalparks.org.uk/hyde-park',
    hours: 'Open daily, 5:00 AM – midnight',
  },
  {
    name: 'Borough Market',
    category: 'Shop',
    description: 'London\'s most renowned food market, operating in some form since the 12th century. Over 100 stalls selling artisan foods, fresh produce, and street food.',
    lat: 51.5055,
    lng: -0.0910,
    address: '8 Southwark St, London SE1 1TL, United Kingdom',
    website: 'https://boroughmarket.org.uk',
    hours: 'Mon–Thu: 10 AM–5 PM; Fri: 10 AM–6 PM; Sat: 8 AM–5 PM',
  },

  // ── Paris ──────────────────────────────────────────────────────
  {
    name: 'Eiffel Tower',
    category: 'Viewpoint',
    description: 'The iron lattice tower on the Champ de Mars, built for the 1889 World\'s Fair. At 330 meters tall, it was the world\'s tallest structure for 41 years.',
    lat: 48.8584,
    lng: 2.2945,
    address: 'Champ de Mars, 5 Avenue Anatole France, 75007 Paris, France',
    website: 'https://www.toureiffel.paris',
    hours: 'Open daily, 9:30 AM – 11:45 PM',
  },
  {
    name: 'Louvre Museum',
    category: 'Museum',
    description: 'The world\'s largest and most-visited art museum, housed in a historic palace. Home to the Mona Lisa, the Venus de Milo, and over 380,000 objects.',
    lat: 48.8606,
    lng: 2.3376,
    address: 'Rue de Rivoli, 75001 Paris, France',
    website: 'https://www.louvre.fr',
    hours: 'Wed–Mon: 9 AM–6 PM; Closed Tue',
  },
  {
    name: 'Shakespeare and Company',
    category: 'Shop',
    description: 'An iconic independent bookstore on the Left Bank of the Seine, opened in 1951. Known for its tumbling shelves and literary history.',
    lat: 48.8526,
    lng: 2.3471,
    address: '37 Rue de la Bûcherie, 75005 Paris, France',
    website: 'https://shakespeareandcompany.com',
    hours: 'Open daily, 10:00 AM – 10:00 PM',
  },

  // ── Tokyo ──────────────────────────────────────────────────────
  {
    name: 'Senso-ji Temple',
    category: 'Historic Site',
    description: 'Tokyo\'s oldest temple, founded in 645 AD, located in Asakusa. The iconic Kaminarimon ("Thunder Gate") with its massive red lantern welcomes millions of visitors annually.',
    lat: 35.7148,
    lng: 139.7967,
    address: '2-3-1 Asakusa, Taito City, Tokyo 111-0032, Japan',
    website: 'https://www.senso-ji.jp',
    hours: 'Main hall: 6 AM – 5 PM; Grounds open 24 hours',
  },
  {
    name: 'Meiji Jingu Shrine',
    category: 'Historic Site',
    description: 'A Shinto shrine in a 170-acre forest in the heart of Tokyo, dedicated to Emperor Meiji and Empress Shoken. A peaceful oasis surrounded by 100,000 trees.',
    lat: 35.6764,
    lng: 139.6993,
    address: '1-1 Yoyogikamizonocho, Shibuya City, Tokyo 151-8557, Japan',
    website: 'https://www.meijijingu.or.jp',
    hours: 'Sunrise to sunset',
  },
  {
    name: 'Tsukiji Outer Market',
    category: 'Restaurant',
    description: 'The remaining outer market of the famous Tsukiji fish market, packed with stalls selling the freshest sushi, street food, Japanese knives, and kitchen tools.',
    lat: 35.6654,
    lng: 139.7707,
    address: '4-16-2 Tsukiji, Chuo City, Tokyo 104-0045, Japan',
    website: 'https://www.tsukiji.or.jp',
    hours: 'Most stalls: 5 AM – 2 PM; Closed Sun & holidays',
  },
  {
    name: 'Shibuya Crossing',
    category: 'Viewpoint',
    description: 'The world\'s busiest pedestrian crossing, where up to 3,000 people cross simultaneously from all directions when the lights change. Best viewed from the Starbucks above.',
    lat: 35.6595,
    lng: 139.7004,
    address: 'Shibuya, Tokyo 150-0043, Japan',
  },

  // ── Sydney ─────────────────────────────────────────────────────
  {
    name: 'Sydney Opera House',
    category: 'Museum',
    description: 'A multi-venue performing arts centre and architectural masterpiece. Its sail-shaped roof shells make it one of the most distinctive buildings of the 20th century.',
    lat: -33.8568,
    lng: 151.2153,
    address: 'Bennelong Point, Sydney NSW 2000, Australia',
    website: 'https://www.sydneyoperahouse.com',
    hours: 'Box office: Mon–Sat 9 AM–8:30 PM; Sun 9 AM–5 PM',
  },
  {
    name: 'Bondi Beach',
    category: 'Beach',
    description: 'One of Australia\'s most famous beaches, known for its golden sand, excellent surf, and the scenic Bondi to Coogee coastal walk.',
    lat: -33.8915,
    lng: 151.2767,
    address: 'Bondi Beach, Sydney NSW 2026, Australia',
    website: 'https://www.waverley.nsw.gov.au/recreation/beaches/bondi_beach',
  },
  {
    name: 'Royal Botanic Garden Sydney',
    category: 'Park',
    description: 'A stunning 74-acre garden on the shores of Sydney Harbour, established in 1816. Home to a remarkable collection of plants from Australia and around the world.',
    lat: -33.8642,
    lng: 151.2166,
    address: 'Mrs Macquaries Rd, Sydney NSW 2000, Australia',
    website: 'https://www.rbgsyd.nsw.gov.au',
    hours: 'Open daily, 7:00 AM – sunset',
  },

  // ── Rome ───────────────────────────────────────────────────────
  {
    name: 'Colosseum',
    category: 'Historic Site',
    description: 'The largest ancient amphitheatre ever built, completed in 80 AD. Could hold 50,000-80,000 spectators for gladiatorial contests and public spectacles.',
    lat: 41.8902,
    lng: 12.4922,
    address: 'Piazza del Colosseo, 1, 00184 Roma RM, Italy',
    website: 'https://parcocolosseo.it',
    hours: 'Open daily, 9:00 AM – 7:00 PM',
  },
  {
    name: 'Vatican Museums',
    category: 'Museum',
    description: 'One of the world\'s greatest art collections, including the Sistine Chapel with Michelangelo\'s ceiling. Over 70,000 works amassed by popes over centuries.',
    lat: 41.9065,
    lng: 12.4536,
    address: 'Viale Vaticano, 00165 Roma RM, Italy',
    website: 'https://www.museivaticani.va',
    hours: 'Mon–Sat: 9 AM–6 PM; Closed Sun (except last Sun of month)',
  },
  {
    name: 'Trastevere',
    category: 'Restaurant',
    description: 'A charming medieval neighborhood on the west bank of the Tiber, known for its narrow cobblestone streets, trattorias, and vibrant nightlife.',
    lat: 41.8867,
    lng: 12.4692,
    address: 'Trastevere, Rome, Italy',
  },

  // ── Barcelona ──────────────────────────────────────────────────
  {
    name: 'Sagrada Familia',
    category: 'Historic Site',
    description: 'Antoni Gaudí\'s unfinished masterpiece basilica, under construction since 1882. Its organic forms and stunning stained glass make it Barcelona\'s most visited monument.',
    lat: 41.4036,
    lng: 2.1744,
    address: 'C/ de Mallorca, 401, 08013 Barcelona, Spain',
    website: 'https://sagradafamilia.org',
    hours: 'Open daily, 9:00 AM – 8:00 PM',
  },
  {
    name: 'La Boqueria Market',
    category: 'Shop',
    description: 'Barcelona\'s most famous food market on La Rambla, dating back to 1217. Overflowing with fresh fruit, seafood, cured meats, and Catalan specialties.',
    lat: 41.3816,
    lng: 2.1719,
    address: 'La Rambla, 91, 08001 Barcelona, Spain',
    website: 'https://www.boqueria.barcelona',
    hours: 'Mon–Sat: 8 AM–8:30 PM; Closed Sun',
  },
  {
    name: 'Park Güell',
    category: 'Park',
    description: 'A public park of gardens and architectural elements designed by Antoni Gaudí, built between 1900 and 1914. A UNESCO World Heritage Site with mosaic-covered terraces.',
    lat: 41.4145,
    lng: 2.1527,
    address: '08024 Barcelona, Spain',
    website: 'https://parkguell.barcelona',
    hours: 'Open daily; hours vary by season',
  },

  // ── Cape Town ──────────────────────────────────────────────────
  {
    name: 'Table Mountain',
    category: 'Trail',
    description: 'A flat-topped mountain forming a prominent landmark overlooking Cape Town. Take the cableway or hike one of several routes for panoramic views of the city and coast.',
    lat: -33.9628,
    lng: 18.4098,
    address: 'Table Mountain National Park, Cape Town, South Africa',
    website: 'https://www.tablemountain.net',
    hours: 'Cableway: 8 AM – 7:30 PM (varies seasonally)',
  },
  {
    name: 'Kirstenbosch National Botanical Garden',
    category: 'Park',
    description: 'A world-renowned botanical garden nestled at the foot of Table Mountain. Features a tree canopy walkway and over 7,000 plant species native to southern Africa.',
    lat: -33.9875,
    lng: 18.4328,
    address: 'Rhodes Dr, Newlands, Cape Town, 7735, South Africa',
    website: 'https://www.sanbi.org/gardens/kirstenbosch',
    hours: 'Open daily, 8:00 AM – 6:00 PM',
  },

  // ── Rio de Janeiro ─────────────────────────────────────────────
  {
    name: 'Christ the Redeemer',
    category: 'Viewpoint',
    description: 'An Art Deco statue of Jesus Christ atop Corcovado mountain, standing 30 meters tall. One of the New Seven Wonders of the World, offering sweeping views of Rio.',
    lat: -22.9519,
    lng: -43.2105,
    address: 'Parque Nacional da Tijuca, Rio de Janeiro, Brazil',
    website: 'https://cristoredentoroficial.com.br',
    hours: 'Open daily, 8:00 AM – 7:00 PM',
  },
  {
    name: 'Copacabana Beach',
    category: 'Beach',
    description: 'A 4-kilometer crescent of golden sand in the heart of Rio, famous for its lively atmosphere, beachside kiosks, and the iconic black-and-white wave-patterned promenade.',
    lat: -22.9711,
    lng: -43.1822,
    address: 'Copacabana, Rio de Janeiro, Brazil',
  },

  // ── Bangkok ────────────────────────────────────────────────────
  {
    name: 'Grand Palace',
    category: 'Historic Site',
    description: 'A complex of buildings in the heart of Bangkok, serving as the official residence of the Kings of Siam since 1782. Includes the sacred Temple of the Emerald Buddha.',
    lat: 13.7500,
    lng: 100.4914,
    address: 'Na Phra Lan Rd, Phra Borom Maha Ratchawang, Bangkok 10200, Thailand',
    website: 'https://www.royalgrandpalace.th',
    hours: 'Open daily, 8:30 AM – 3:30 PM',
  },
  {
    name: 'Chatuchak Weekend Market',
    category: 'Shop',
    description: 'One of the world\'s largest outdoor markets with over 15,000 stalls spread across 35 acres. Everything from vintage clothing to handmade crafts and street food.',
    lat: 13.7999,
    lng: 100.5503,
    address: 'Kamphaeng Phet 2 Rd, Chatuchak, Bangkok 10900, Thailand',
    hours: 'Sat–Sun: 9 AM–6 PM',
  },

  // ── Amsterdam ──────────────────────────────────────────────────
  {
    name: 'Rijksmuseum',
    category: 'Museum',
    description: 'The Netherlands\' national museum dedicated to arts and history. Houses Rembrandt\'s "The Night Watch" and Vermeer\'s "The Milkmaid" among 8,000 objects on display.',
    lat: 52.3600,
    lng: 4.8852,
    address: 'Museumstraat 1, 1071 XX Amsterdam, Netherlands',
    website: 'https://www.rijksmuseum.nl',
    hours: 'Open daily, 9:00 AM – 5:00 PM',
  },
  {
    name: 'Vondelpark',
    category: 'Park',
    description: 'Amsterdam\'s largest and most famous park, spanning 120 acres. Popular with joggers, cyclists, and picnickers, with an open-air theatre in summer.',
    lat: 52.3579,
    lng: 4.8686,
    address: 'Vondelpark, Amsterdam, Netherlands',
    hours: 'Open 24 hours',
  },
  {
    name: 'Anne Frank House',
    category: 'Museum',
    description: 'The canal house where Anne Frank and her family hid from Nazi persecution during World War II. Now a museum dedicated to her life and diary.',
    lat: 52.3752,
    lng: 4.8840,
    address: 'Prinsengracht 263-267, 1016 GV Amsterdam, Netherlands',
    website: 'https://www.annefrank.org',
    hours: 'Open daily, 9:00 AM – 10:00 PM',
  },

  // ── Berlin ─────────────────────────────────────────────────────
  {
    name: 'Brandenburg Gate',
    category: 'Historic Site',
    description: 'An 18th-century neoclassical monument that became a symbol of German reunification. Standing at the end of Unter den Linden, it is Berlin\'s most iconic landmark.',
    lat: 52.5163,
    lng: 13.3777,
    address: 'Pariser Platz, 10117 Berlin, Germany',
  },
  {
    name: 'Museum Island',
    category: 'Museum',
    description: 'A UNESCO World Heritage Site comprising five world-renowned museums on an island in the Spree river, housing art and artifacts spanning 6,000 years.',
    lat: 52.5169,
    lng: 13.4019,
    address: 'Museumsinsel, 10178 Berlin, Germany',
    website: 'https://www.smb.museum',
    hours: 'Tue–Sun: 10 AM–6 PM; Closed Mon',
  },

  // ── Machu Picchu / Peru ────────────────────────────────────────
  {
    name: 'Machu Picchu',
    category: 'Historic Site',
    description: 'A 15th-century Inca citadel perched at 2,430 meters in the Andes. Rediscovered in 1911, it is one of the most extraordinary archaeological sites on Earth.',
    lat: -13.1631,
    lng: -72.5450,
    address: 'Aguas Calientes, Cusco Region, Peru',
    website: 'https://www.machupicchu.gob.pe',
    hours: 'Open daily, 6:00 AM – 5:00 PM',
  },

  // ── Iceland ────────────────────────────────────────────────────
  {
    name: 'Blue Lagoon',
    category: 'Beach',
    description: 'A geothermal spa in a lava field near Grindavik, known for its milky-blue mineral-rich waters. The silica and sulfur in the water are said to benefit the skin.',
    lat: 63.8804,
    lng: -22.4495,
    address: 'Norðurljósavegur 9, 240 Grindavík, Iceland',
    website: 'https://www.bluelagoon.com',
    hours: 'Open daily; hours vary seasonally',
  },

  // ── Yosemite / US ─────────────────────────────────────────────
  {
    name: 'Yosemite Valley',
    category: 'Trail',
    description: 'A glacial valley in the Sierra Nevada renowned for its granite cliffs, waterfalls, giant sequoias, and biodiversity. El Capitan and Half Dome draw climbers worldwide.',
    lat: 37.7456,
    lng: -119.5936,
    address: 'Yosemite National Park, CA 95389',
    website: 'https://www.nps.gov/yose',
    hours: 'Open 24 hours, year-round',
  },

  // ── Grand Canyon / US ─────────────────────────────────────────
  {
    name: 'Grand Canyon South Rim',
    category: 'Viewpoint',
    description: 'The most visited area of Grand Canyon National Park, offering breathtaking views into a mile-deep gorge carved by the Colorado River over millions of years.',
    lat: 36.0544,
    lng: -112.1401,
    address: 'Grand Canyon Village, AZ 86023',
    website: 'https://www.nps.gov/grca',
    hours: 'South Rim open 24 hours, year-round',
  },

  // ── Banff / Canada ─────────────────────────────────────────────
  {
    name: 'Lake Louise',
    category: 'Trail',
    description: 'A glacial lake in Banff National Park, famous for its turquoise waters set against the backdrop of the Victoria Glacier. A starting point for world-class hikes.',
    lat: 51.4254,
    lng: -116.1773,
    address: 'Lake Louise, Banff National Park, AB T0L 1E0, Canada',
    website: 'https://www.pc.gc.ca/en/pn-np/ab/banff',
  },

  // ── Petra / Jordan ─────────────────────────────────────────────
  {
    name: 'Petra',
    category: 'Historic Site',
    description: 'An ancient Nabataean city carved into rose-red cliffs, dating back to the 4th century BC. The Treasury (Al-Khazneh) is one of the most elaborate temples in the world.',
    lat: 30.3285,
    lng: 35.4444,
    address: 'Wadi Musa, Jordan',
    website: 'https://www.visitpetra.jo',
    hours: 'Open daily, 6:00 AM – 6:00 PM (summer); 6 AM – 4 PM (winter)',
  },

  // ── Angkor Wat / Cambodia ──────────────────────────────────────
  {
    name: 'Angkor Wat',
    category: 'Historic Site',
    description: 'The largest religious monument in the world, originally a Hindu temple complex built in the early 12th century. Its five iconic towers symbolize Mount Meru.',
    lat: 13.4125,
    lng: 103.8670,
    address: 'Krong Siem Reap, Cambodia',
    website: 'https://www.autoriteapsara.org',
    hours: 'Open daily, 5:00 AM – 6:00 PM',
  },

  // ── Great Barrier Reef / Australia ─────────────────────────────
  {
    name: 'Great Barrier Reef',
    category: 'Beach',
    description: 'The world\'s largest coral reef system, stretching over 2,300 km. Home to 1,500 species of fish, 400 types of coral, and visible from outer space.',
    lat: -18.2871,
    lng: 147.6992,
    address: 'Great Barrier Reef Marine Park, Queensland, Australia',
    website: 'https://www.gbrmpa.gov.au',
  },

  // ── Kyoto / Japan ──────────────────────────────────────────────
  {
    name: 'Fushimi Inari Shrine',
    category: 'Historic Site',
    description: 'Famous for its thousands of vermilion torii gates that wind through the forested trails of Mount Inari. The head shrine of Inari, the Shinto deity of rice.',
    lat: 35.2334,
    lng: 135.7681,
    address: '68 Fukakusa Yabunouchicho, Fushimi Ward, Kyoto 612-0882, Japan',
    website: 'https://inari.jp',
    hours: 'Open 24 hours',
  },

  // ── Santorini / Greece ─────────────────────────────────────────
  {
    name: 'Oia Village',
    category: 'Viewpoint',
    description: 'A picturesque village perched on the rim of a volcanic caldera, world-famous for its stunning sunsets, blue-domed churches, and white-washed buildings.',
    lat: 36.4618,
    lng: 25.3753,
    address: 'Oia, Santorini 847 02, Greece',
  },

  // ── Marrakech / Morocco ────────────────────────────────────────
  {
    name: 'Jemaa el-Fnaa',
    category: 'Shop',
    description: 'Marrakech\'s main square and marketplace, a UNESCO cultural heritage site. By day a maze of market stalls; by night transformed with food vendors, musicians, and storytellers.',
    lat: 31.6258,
    lng: -7.9891,
    address: 'Jemaa el-Fnaa, Marrakech 40000, Morocco',
  },

  // ── Vancouver ──────────────────────────────────────────────────
  {
    name: 'Stanley Park',
    category: 'Park',
    description: 'A 1,001-acre urban park bordering downtown Vancouver, nearly entirely surrounded by the Pacific Ocean. Features the seawall, totem poles, and old-growth forest.',
    lat: 49.3043,
    lng: -123.1443,
    address: 'Stanley Park, Vancouver, BC V6G 1Z4, Canada',
    website: 'https://vancouver.ca/parks-recreation-culture/stanley-park.aspx',
    hours: 'Open 24 hours',
  },

  // ── Seattle ────────────────────────────────────────────────────
  {
    name: 'Pike Place Market',
    category: 'Shop',
    description: 'One of the oldest continuously operated public farmers\' markets in the US, opened in 1907. Home to the original Starbucks, flying fish, and hundreds of local artisans.',
    lat: 47.6097,
    lng: -122.3425,
    address: '85 Pike St, Seattle, WA 98101',
    website: 'https://www.pikeplacemarket.org',
    hours: 'Open daily, 9:00 AM – 6:00 PM',
  },
];

async function seed() {
  const values: string[] = [];
  const params: (string | number | null)[] = [];
  let idx = 1;

  for (const poi of POIS) {
    values.push(
      `($${idx}, $${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4}, $${idx + 5}, $${idx + 6}, ST_SetSRID(ST_MakePoint($${idx + 7}, $${idx + 8}), 4326)::geography)`,
    );
    params.push(
      poi.name,
      poi.category,
      poi.description,
      poi.address ?? null,
      poi.website ?? null,
      poi.hours ?? null,
      poi.photo_url ?? null,
      poi.lng,
      poi.lat,
    );
    idx += 9;
  }

  await pool.query('DELETE FROM pois');
  await pool.query(
    `INSERT INTO pois (name, category, description, address, website, hours, photo_url, geom)
     VALUES ${values.join(', ')}`,
    params,
  );

  const { rows } = await pool.query('SELECT count(*) FROM pois');
  console.log(`Seeded ${rows[0].count} POIs across the globe`);
  await pool.end();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
