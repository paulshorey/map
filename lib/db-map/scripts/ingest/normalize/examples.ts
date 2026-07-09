import type { ChatMessage } from "../providers/deepinfra.js";
import type { LlmNormalizationOutput } from "./contracts.js";

interface Example {
  input: unknown;
  output: LlmNormalizationOutput;
}

const validPlace: Example = {
  input: {
    record_id: "example_place",
    source: { slug: "example_directory", profile: "place" },
    ingest_category: "botanical_garden",
    captured: {
      name: "Riverside Botanic Garden",
      city: "Example City",
      country_code: "US",
      website: "https://riverside-garden.example",
    },
    deterministic: {
      url_candidates: [
        {
          id: "url_1",
          value: "https://riverside-garden.example",
          path: "$.captured.website",
          roleHint: "official_candidate",
        },
      ],
      coordinate_candidates: [],
    },
  },
  output: {
    record: {
      record_id: "example_place",
      is_poi: true,
      invalid_reason: null,
      entity_kind: "place",
      display_name: "Riverside Botanic Garden",
      series_name: null,
      edition_year: null,
      aliases: [],
      description: null,
      venue: null,
      address: null,
      city: "Example City",
      region: null,
      country_code: "US",
      website_candidate_id: "url_1",
      phone_candidate_id: null,
      email_candidate_id: null,
      starts_at: null,
      ends_at: null,
      date_precision: null,
      attributes: [],
      warnings: ["coordinates_missing"],
      evidence: [
        { field: "display_name", paths: ["$.captured.name"] },
        { field: "city", paths: ["$.captured.city"] },
        { field: "country_code", paths: ["$.captured.country_code"] },
      ],
    },
  },
};

const validEvent: Example = {
  input: {
    record_id: "example_event",
    source: { slug: "example_events", profile: "event" },
    ingest_category: "music_festival",
    captured: {
      name: "Harbor Sounds Festival 2027",
      city: "Exampletown",
      region: "CA",
      country_code: "US",
    },
    raw: {
      name: "Harbor Sounds Festival 2027",
      start_date: "2027-06-31",
    },
    deterministic: {
      start_date: null,
      warnings: ["invalid_source_start_date"],
      url_candidates: [],
      coordinate_candidates: [],
    },
  },
  output: {
    record: {
      record_id: "example_event",
      is_poi: true,
      invalid_reason: null,
      entity_kind: "event_occurrence",
      display_name: "Harbor Sounds Festival",
      series_name: "Harbor Sounds Festival",
      edition_year: 2027,
      aliases: [],
      description: null,
      venue: null,
      address: null,
      city: "Exampletown",
      region: "CA",
      country_code: "US",
      website_candidate_id: null,
      phone_candidate_id: null,
      email_candidate_id: null,
      starts_at: null,
      ends_at: null,
      date_precision: null,
      attributes: [],
      warnings: ["invalid_source_start_date", "coordinates_missing"],
      evidence: [
        { field: "display_name", paths: ["$.captured.name"] },
        { field: "edition_year", paths: ["$.captured.name"] },
        { field: "city", paths: ["$.captured.city"] },
      ],
    },
  },
};

const invalidArticle: Example = {
  input: {
    record_id: "example_article",
    source: { slug: "example_blog", profile: "event" },
    ingest_category: "music_festival",
    raw: {
      title: "Ten festivals we hope to visit next summer",
      excerpt: "Our editors discuss rumors, tickets, and travel plans.",
      url: "https://blog.example/ten-festivals",
    },
    deterministic: {
      url_candidates: [
        {
          id: "url_1",
          value: "https://blog.example/ten-festivals",
          path: "$.raw.url",
          roleHint: "source_listing",
        },
      ],
      coordinate_candidates: [],
    },
  },
  output: {
    record: {
      record_id: "example_article",
      is_poi: false,
      invalid_reason: "article_not_poi",
      entity_kind: "article",
      display_name: null,
      series_name: null,
      edition_year: null,
      aliases: [],
      description: null,
      venue: null,
      address: null,
      city: null,
      region: null,
      country_code: null,
      website_candidate_id: null,
      phone_candidate_id: null,
      email_candidate_id: null,
      starts_at: null,
      ends_at: null,
      date_precision: null,
      attributes: [],
      warnings: [],
      evidence: [
        { field: "invalid_reason", paths: ["$.raw.title", "$.raw.excerpt"] },
      ],
    },
  },
};

const invalidOrganization: Example = {
  input: {
    record_id: "example_organization",
    source: { slug: "example_registry", profile: "place" },
    ingest_category: "botanical_garden",
    raw: {
      name: "Regional Horticultural Association",
      description: "A professional membership association.",
    },
    deterministic: { url_candidates: [], coordinate_candidates: [] },
  },
  output: {
    record: {
      record_id: "example_organization",
      is_poi: false,
      invalid_reason: "organization_not_place",
      entity_kind: "organization",
      display_name: null,
      series_name: null,
      edition_year: null,
      aliases: [],
      description: null,
      venue: null,
      address: null,
      city: null,
      region: null,
      country_code: null,
      website_candidate_id: null,
      phone_candidate_id: null,
      email_candidate_id: null,
      starts_at: null,
      ends_at: null,
      date_precision: null,
      attributes: [],
      warnings: [],
      evidence: [
        { field: "invalid_reason", paths: ["$.raw.name", "$.raw.description"] },
      ],
    },
  },
};

export function fewShotMessages(profile: string): ChatMessage[] {
  const examples = profile === "event" ? [validEvent, invalidArticle] : [validPlace, invalidOrganization];
  return examples.flatMap((example): ChatMessage[] => [
    {
      role: "user",
      content: JSON.stringify(example.input),
    },
    {
      role: "assistant",
      content: JSON.stringify(example.output),
    },
  ]);
}
