// The member directory of a small professional community: act 1 of the demo.
// Its own labels (Member, Group), so it sits next to the lineage graph in the
// same database without touching it. Fictional people.

CREATE CONSTRAINT member_id IF NOT EXISTS FOR (m:Member) REQUIRE m.id IS UNIQUE;
CREATE CONSTRAINT member_email IF NOT EXISTS FOR (m:Member) REQUIRE m.email IS UNIQUE;
CREATE CONSTRAINT group_id IF NOT EXISTS FOR (g:Group) REQUIRE g.id IS UNIQUE;
CREATE CONSTRAINT member_id_exists IF NOT EXISTS FOR (m:Member) REQUIRE m.id IS NOT NULL;
CREATE CONSTRAINT group_id_exists IF NOT EXISTS FOR (g:Group) REQUIRE g.id IS NOT NULL;

UNWIND [
  {id: 'ana',    name: 'Ana Silva',      nick: 'ana',    email: 'ana@members.example',    homepage: 'https://people.example.org/ana',    birthday: '04-12'},
  {id: 'ben',    name: 'Ben Okafor',     nick: 'benno',  email: 'ben@members.example',    homepage: 'https://people.example.org/ben',    birthday: '11-02'},
  {id: 'chloe',  name: 'Chloé Martin',   nick: 'chloe',  email: 'chloe@members.example',  homepage: 'https://people.example.org/chloe',  birthday: '07-23'},
  {id: 'dev',    name: 'Dev Patel',      nick: 'dev',    email: 'dev@members.example',    homepage: 'https://people.example.org/dev',    birthday: '01-30'},
  {id: 'eli',    name: 'Eli Cohen',      nick: 'eli',    email: 'eli@members.example',    homepage: 'https://people.example.org/eli',    birthday: '09-05'},
  {id: 'fatima', name: 'Fatima Zahra',   nick: 'fatz',   email: 'fatima@members.example', homepage: 'https://people.example.org/fatima', birthday: '03-17'},
  {id: 'gus',    name: 'Gus Lindqvist',  nick: 'gus',    email: 'gus@members.example',    homepage: 'https://people.example.org/gus',    birthday: '12-08'},
  {id: 'hana',   name: 'Hana Sato',      nick: 'hana',   email: 'hana@members.example',   homepage: 'https://people.example.org/hana',   birthday: '06-21'}
] AS row
MERGE (m:Member {id: row.id})
SET m.name = row.name, m.nick = row.nick, m.email = row.email, m.homepage = row.homepage, m.birthday = row.birthday;

UNWIND [
  {id: 'graph-guild', name: 'Graph Guild', homepage: 'https://people.example.org/groups/graph-guild'},
  {id: 'rdf-circle',  name: 'RDF Circle',  homepage: 'https://people.example.org/groups/rdf-circle'}
] AS row
MERGE (g:Group {id: row.id})
SET g.name = row.name, g.homepage = row.homepage;

UNWIND [
  ['ana', 'ben'], ['ana', 'chloe'], ['ana', 'dev'], ['ben', 'eli'], ['chloe', 'fatima'],
  ['dev', 'gus'], ['eli', 'hana'], ['fatima', 'ana'], ['gus', 'hana'], ['hana', 'chloe']
] AS pair
MATCH (a:Member {id: pair[0]}), (b:Member {id: pair[1]})
MERGE (a)-[:KNOWS]->(b);

UNWIND [
  ['ana', 'graph-guild'], ['ben', 'graph-guild'], ['dev', 'graph-guild'], ['gus', 'graph-guild'],
  ['chloe', 'rdf-circle'], ['eli', 'rdf-circle'], ['fatima', 'rdf-circle'], ['hana', 'rdf-circle'], ['ana', 'rdf-circle']
] AS pair
MATCH (m:Member {id: pair[0]}), (g:Group {id: pair[1]})
MERGE (m)-[:MEMBER_OF]->(g);
