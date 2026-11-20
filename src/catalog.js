// Vocabularies a project can take as RDF targets without knowing where they
// live: Turtle documents of their publishers. A target from the catalog is
// fetched once, pinned by its SHA-256 in the project lock, and kept as a file
// next to the project, so that check and propose read it like any target file.
// SKOS and FOAF are not here: their publishers serve RDF/XML only.

export const CATALOG = [
  { id: 'prov', title: 'W3C PROV-O', prefix: 'prov', namespace: 'http://www.w3.org/ns/prov#', url: 'https://www.w3.org/ns/prov-o.ttl',
    description: 'Provenance: entities, activities, agents, derivation, generation, usage, attribution, with qualified forms.' },
  { id: 'dcat', title: 'W3C DCAT 3', prefix: 'dcat', namespace: 'http://www.w3.org/ns/dcat#', url: 'https://www.w3.org/ns/dcat3.ttl',
    description: 'Data catalogs: catalogs, datasets, distributions, data services, versions.' },
  { id: 'dcterms', title: 'DCMI Metadata Terms', prefix: 'dcterms', namespace: 'http://purl.org/dc/terms/', url: 'https://www.dublincore.org/specifications/dublin-core/dcmi-terms/dublin_core_terms.ttl',
    description: 'General metadata: title, description, creator, created, modified, identifier, rights.' },
  { id: 'org', title: 'W3C Organization Ontology', prefix: 'org', namespace: 'http://www.w3.org/ns/org#', url: 'https://www.w3.org/ns/org.ttl',
    description: 'Organizations, units, memberships, roles, posts, sites.' },
  { id: 'time', title: 'W3C OWL-Time', prefix: 'time', namespace: 'http://www.w3.org/2006/time#', url: 'https://www.w3.org/2006/time.ttl',
    description: 'Instants, intervals, durations, and their relations.' },
  { id: 'schema', title: 'Schema.org', prefix: 'schema', namespace: 'https://schema.org/', url: 'https://schema.org/version/latest/schemaorg-current-https.ttl',
    description: 'General-purpose web vocabulary: people, organizations, products, events, places, creative works (large).' },
  { id: 'shacl', title: 'W3C SHACL', prefix: 'sh', namespace: 'http://www.w3.org/ns/shacl#', url: 'https://www.w3.org/ns/shacl.ttl',
    description: 'Shapes vocabulary, for validation steps.' },
];

export const catalogEntry = (id) => CATALOG.find((c) => c.id === id) ?? null;
