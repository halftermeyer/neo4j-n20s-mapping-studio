// Plant telemetry: the second evaluation set (target: W3C SOSA). Deterministic:
// 8 gauges on 3 rigs, 500 ticks each (4000, every 10 s from 2026-10-01T00:00Z),
// 64 ten-minute rollups of 60 ticks, thresholds, work orders. Plain Cypher.

CREATE CONSTRAINT rigId_Rig_uniq IF NOT EXISTS FOR (n:Rig) REQUIRE n.rigId IS UNIQUE;
CREATE CONSTRAINT tag_Gauge_uniq IF NOT EXISTS FOR (n:Gauge) REQUIRE n.tag IS UNIQUE;
CREATE CONSTRAINT code_Metric_uniq IF NOT EXISTS FOR (n:Metric) REQUIRE n.code IS UNIQUE;
CREATE CONSTRAINT tickId_Tick_uniq IF NOT EXISTS FOR (n:Tick) REQUIRE n.tickId IS UNIQUE;
CREATE CONSTRAINT rollupId_Rollup_uniq IF NOT EXISTS FOR (n:Rollup) REQUIRE n.rollupId IS UNIQUE;
CREATE CONSTRAINT name_Method_uniq IF NOT EXISTS FOR (n:Method) REQUIRE n.name IS UNIQUE;
CREATE CONSTRAINT thresholdId_Threshold_uniq IF NOT EXISTS FOR (n:Threshold) REQUIRE n.thresholdId IS UNIQUE;
CREATE CONSTRAINT woNumber_WorkOrder_uniq IF NOT EXISTS FOR (n:WorkOrder) REQUIRE n.woNumber IS UNIQUE;
CREATE CONSTRAINT crewId_Crew_uniq IF NOT EXISTS FOR (n:Crew) REQUIRE n.crewId IS UNIQUE;

UNWIND [
  {rigId: 'R1', name: 'North-1', commissioned: date('2019-04-01')},
  {rigId: 'R2', name: 'North-2', commissioned: date('2021-09-15')},
  {rigId: 'R3', name: 'North-3', commissioned: date('2024-02-20')}
] AS row
MERGE (r:Rig {rigId: row.rigId}) SET r.name = row.name, r.commissioned = row.commissioned;

UNWIND [
  {code: 'PRESS', label: 'Standpipe pressure', unit: 'bar', base: 180.0, amp: 40.0},
  {code: 'TEMP', label: 'Mud temperature', unit: 'degC', base: 55.0, amp: 15.0},
  {code: 'RPM', label: 'Rotary speed', unit: 'rpm', base: 90.0, amp: 30.0},
  {code: 'FLOW', label: 'Mud flow', unit: 'l/min', base: 2400.0, amp: 400.0}
] AS row
MERGE (m:Metric {code: row.code}) SET m.label = row.label, m.unit = row.unit, m.base = row.base, m.amp = row.amp;

UNWIND [
  {tag: 'PT-101', rig: 'R1', metric: 'PRESS', model: 'Rosemount 3051', serial: 'A1001'},
  {tag: 'TT-102', rig: 'R1', metric: 'TEMP', model: 'Endress TMT82', serial: 'A1002'},
  {tag: 'ST-103', rig: 'R1', metric: 'RPM', model: 'Hall S-40', serial: 'A1003'},
  {tag: 'PT-201', rig: 'R2', metric: 'PRESS', model: 'Rosemount 3051', serial: 'B2001'},
  {tag: 'TT-202', rig: 'R2', metric: 'TEMP', model: 'Endress TMT82', serial: 'B2002'},
  {tag: 'FT-203', rig: 'R2', metric: 'FLOW', model: 'Krohne Optiflux', serial: 'B2003'},
  {tag: 'PT-301', rig: 'R3', metric: 'PRESS', model: 'Rosemount 3051', serial: 'C3001'},
  {tag: 'TT-302', rig: 'R3', metric: 'TEMP', model: 'Endress TMT82', serial: 'C3002'}
] AS row
MATCH (r:Rig {rigId: row.rig}), (m:Metric {code: row.metric})
MERGE (g:Gauge {tag: row.tag}) SET g.model = row.model, g.serial = row.serial
MERGE (g)-[:BOLTED_TO]->(r)
MERGE (g)-[:TRACKS]->(m);

// An older gauge, removed from the rig, replaced by PT-101: it reads nothing any more.
MERGE (old:Gauge {tag: 'PT-100'}) SET old.model = 'Rosemount 2051', old.serial = 'A0999'
WITH old
MATCH (g:Gauge {tag: 'PT-101'})
MERGE (g)-[x:REPLACED]->(old) SET x.on = date('2026-09-12');

// 500 ticks per gauge, every 10 seconds; values follow a sawtooth around the metric's base.
MATCH (g:Gauge)-[:BOLTED_TO]->(r:Rig), (g)-[:TRACKS]->(m:Metric)
UNWIND range(0, 499) AS i
CREATE (t:Tick {
  tickId: g.tag + '-' + toString(i),
  value: round(m.base + m.amp * toFloat((i * 7 + size(g.tag) * 13) % 50) / 50.0, 2),
  measuredAt: datetime('2026-10-01T00:00:00Z') + duration({seconds: i * 10}),
  quality: CASE WHEN i % 211 = 0 THEN 'BAD' WHEN i % 97 = 0 THEN 'SUSPECT' ELSE 'GOOD' END,
  seq: i
})
CREATE (g)-[:EMITS]->(t), (t)-[:ABOUT]->(m), (t)-[:ON]->(r);

MERGE (:Method {name: 'mean-10min', version: '2'});

// Ten-minute rollups: windows of 60 ticks (the first 480 ticks of each gauge).
MATCH (g:Gauge)-[:TRACKS]->(m:Metric), (meth:Method {name: 'mean-10min'})
UNWIND range(0, 7) AS w
MATCH (g)-[:EMITS]->(t:Tick) WHERE t.seq >= w * 60 AND t.seq < (w + 1) * 60
WITH g, m, meth, w, collect(t) AS ticks, avg(t.value) AS mean
CREATE (ru:Rollup {
  rollupId: g.tag + '-W' + toString(w),
  mean: round(mean, 3),
  windowStart: datetime('2026-10-01T00:00:00Z') + duration({seconds: w * 600}),
  windowEnd: datetime('2026-10-01T00:00:00Z') + duration({seconds: (w + 1) * 600})
})
CREATE (ru)-[:ABOUT]->(m), (ru)-[:COMPUTED_WITH]->(meth)
WITH ru, ticks
UNWIND ticks AS t
CREATE (ru)-[:ROLLUP_OF]->(t);

UNWIND [
  {thresholdId: 'TH-PRESS-HI', metric: 'PRESS', limit: 218.0, direction: 'above'},
  {thresholdId: 'TH-TEMP-HI', metric: 'TEMP', limit: 69.0, direction: 'above'}
] AS row
MERGE (th:Threshold {thresholdId: row.thresholdId}) SET th.limit = row.limit, th.direction = row.direction, th.metric = row.metric;

MATCH (th:Threshold), (t:Tick)-[:ABOUT]->(m:Metric {code: th.metric})
WHERE t.value > th.limit
CREATE (t)-[:TRIPPED]->(th);

UNWIND [
  {crewId: 'C1', name: 'Mechanical, day shift'},
  {crewId: 'C2', name: 'Instrumentation'}
] AS row
MERGE (c:Crew {crewId: row.crewId}) SET c.name = row.name;

UNWIND [
  {woNumber: 'WO-4411', rig: 'R1', crew: 'C2', opened: datetime('2026-09-12T07:30:00Z'), closed: datetime('2026-09-12T11:05:00Z'), summary: 'Replace standpipe pressure transmitter'},
  {woNumber: 'WO-4502', rig: 'R2', crew: 'C1', opened: datetime('2026-10-01T00:40:00Z'), closed: null, summary: 'Mud pump vibration'}
] AS row
MATCH (r:Rig {rigId: row.rig}), (c:Crew {crewId: row.crew})
MERGE (w:WorkOrder {woNumber: row.woNumber}) SET w.opened = row.opened, w.closed = row.closed, w.summary = row.summary
MERGE (w)-[:FOR_RIG]->(r)
MERGE (w)-[:SERVICED_BY]->(c);

// Helper properties of the seed, not part of the model.
MATCH (m:Metric) REMOVE m.base, m.amp;
MATCH (th:Threshold) REMOVE th.metric;
MATCH (t:Tick) REMOVE t.seq;
