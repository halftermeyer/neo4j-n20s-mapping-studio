// Seed of the data lineage example (data-lineage-lpg v3).
// Statements 03 to 29 of the Neo4j Browser saved queries 'Data lineage Queries'.
// Statements end with ; at the end of a line.

// 03 Seed 2a: agents (people)
UNWIND [
  {id: 'demo:lineage:v2:agent:alice', name: 'Alice'},
  {id: 'demo:lineage:v2:agent:bob', name: 'Bob'},
  {id: 'demo:lineage:v2:agent:carol', name: 'Carol'}
] AS row
MERGE (n:Person:Agent {id: row.id})
  ON CREATE SET n.name = row.name;

// 04 Seed 2a: agents (software)
UNWIND [
  {id: 'demo:lineage:v2:agent:dbt', name: 'dbt Cloud'},
  {id: 'demo:lineage:v2:agent:tableau', name: 'Tableau Server'}
] AS row
MERGE (n:SoftwareAgent:Agent {id: row.id})
  ON CREATE SET n.name = row.name;

// 05 Seed 2a: agents (organizations)
UNWIND [
  {id: 'demo:lineage:v2:agent:data-platform', name: 'Data Platform team'}
] AS row
MERGE (n:Organization:Agent {id: row.id})
  ON CREATE SET n.name = row.name;

// 06 Seed 2b: logical datasets
UNWIND [
  {id: 'demo:lineage:v2:ds:raw.orders', namespace: 'demo:lineage:v2:postgres://pg1', name: 'raw.orders', system: 'postgres', kind: 'table'},
  {id: 'demo:lineage:v2:ds:raw.customers', namespace: 'demo:lineage:v2:postgres://pg1', name: 'raw.customers', system: 'postgres', kind: 'table'},
  {id: 'demo:lineage:v2:ds:ref.dq_rules', namespace: 'demo:lineage:v2:snowflake://acme', name: 'ref.dq_rules', system: 'snowflake', kind: 'table'},
  {id: 'demo:lineage:v2:ds:stg.orders', namespace: 'demo:lineage:v2:snowflake://acme', name: 'stg.orders', system: 'snowflake', kind: 'table'},
  {id: 'demo:lineage:v2:ds:stg.customers', namespace: 'demo:lineage:v2:snowflake://acme', name: 'stg.customers', system: 'snowflake', kind: 'table'},
  {id: 'demo:lineage:v2:ds:mart.revenue', namespace: 'demo:lineage:v2:snowflake://acme', name: 'mart.revenue', system: 'snowflake', kind: 'table'},
  {id: 'demo:lineage:v2:ds:dash.revenue', namespace: 'demo:lineage:v2:tableau://bi', name: 'dash.revenue', system: 'tableau', kind: 'dashboard'}
] AS row
MERGE (n:Dataset:Entity {id: row.id})
  ON CREATE SET n.kind = row.kind,
                n.name = row.name,
                n.namespace = row.namespace,
                n.system = row.system;

// 07 Seed 2b: logical columns
UNWIND [
  {id: 'demo:lineage:v2:col:raw.orders.unit_price', name: 'unit_price'},
  {id: 'demo:lineage:v2:col:raw.orders.quantity', name: 'quantity'},
  {id: 'demo:lineage:v2:col:raw.orders.discount', name: 'discount'},
  {id: 'demo:lineage:v2:col:stg.orders.price', name: 'price'},
  {id: 'demo:lineage:v2:col:stg.orders.qty', name: 'qty'},
  {id: 'demo:lineage:v2:col:stg.customers.customer_id', name: 'customer_id'},
  {id: 'demo:lineage:v2:col:stg.customers.country', name: 'country'},
  {id: 'demo:lineage:v2:col:mart.revenue.country', name: 'country'},
  {id: 'demo:lineage:v2:col:mart.revenue.amount', name: 'amount'}
] AS row
MERGE (n:Column:Entity {id: row.id})
  ON CREATE SET n.name = row.name;

// 08 Seed 2b: logical jobs
UNWIND [
  {id: 'demo:lineage:v2:job:stg_orders', namespace: 'demo:lineage:v2:airflow://prod', name: 'stg_orders'},
  {id: 'demo:lineage:v2:job:stg_customers', namespace: 'demo:lineage:v2:airflow://prod', name: 'stg_customers'},
  {id: 'demo:lineage:v2:job:mart_revenue', namespace: 'demo:lineage:v2:airflow://prod', name: 'mart_revenue'},
  {id: 'demo:lineage:v2:job:bi_refresh', namespace: 'demo:lineage:v2:airflow://prod', name: 'bi_refresh'}
] AS row
MERGE (n:Job:Entity {id: row.id})
  ON CREATE SET n.name = row.name,
                n.namespace = row.namespace;

// 09 Seed 2c: job versions
UNWIND [
  {id: 'demo:lineage:v2:jobv:stg_orders@git:9f01', codeRef: 'git:9f01', definitionHash: 'sha256:aa01', artifactRef: 'manifest:stg_orders@git:9f01'},
  {id: 'demo:lineage:v2:jobv:stg_orders@git:ab12', codeRef: 'git:ab12', definitionHash: 'sha256:bb12', artifactRef: 'manifest:stg_orders@git:ab12'},
  {id: 'demo:lineage:v2:jobv:stg_customers@git:77aa', codeRef: 'git:77aa', definitionHash: 'sha256:cc77', artifactRef: 'manifest:stg_customers@git:77aa'},
  {id: 'demo:lineage:v2:jobv:mart_revenue@git:cd34', codeRef: 'git:cd34', definitionHash: 'sha256:dd34', artifactRef: 'manifest:mart_revenue@git:cd34'},
  {id: 'demo:lineage:v2:jobv:bi_refresh@workbook:v12', codeRef: 'workbook:v12', definitionHash: 'sha256:ee12', artifactRef: 'manifest:bi_refresh@workbook:v12'}
] AS row
MERGE (n:JobVersion:Entity {id: row.id})
  ON CREATE SET n.artifactRef = row.artifactRef,
                n.codeRef = row.codeRef,
                n.definitionHash = row.definitionHash;

// 10 Seed 2d: dataset versions
UNWIND [
  {id: 'demo:lineage:v2:dsv:raw.orders@41', version: '41', generatedAt: datetime('2026-11-04T22:00:00Z'), validFrom: datetime('2026-11-04T22:00:00Z'), validTo: datetime('2026-11-05T22:00:00Z'), schemaHash: 'sha256:s1'},
  {id: 'demo:lineage:v2:dsv:raw.orders@42', version: '42', generatedAt: datetime('2026-11-05T22:00:00Z'), validFrom: datetime('2026-11-05T22:00:00Z'), schemaHash: 'sha256:s2'},
  {id: 'demo:lineage:v2:dsv:raw.customers@7', version: '7', generatedAt: datetime('2026-11-05T21:00:00Z'), validFrom: datetime('2026-11-05T21:00:00Z')},
  {id: 'demo:lineage:v2:dsv:ref.dq_rules@2', version: '2', generatedAt: datetime('2026-11-01T00:00:00Z'), validFrom: datetime('2026-11-01T00:00:00Z')},
  {id: 'demo:lineage:v2:dsv:stg.customers@4', version: '4', validFrom: datetime('2026-11-03T00:00:00Z'), validTo: datetime('2026-11-05T21:32:00Z')},
  {id: 'demo:lineage:v2:dsv:stg.customers@5', version: '5', generatedAt: datetime('2026-11-05T21:30:00Z'), publishedAt: datetime('2026-11-05T21:32:00Z'), validFrom: datetime('2026-11-05T21:32:00Z')},
  {id: 'demo:lineage:v2:dsv:stg.orders@16', version: '16', generatedAt: datetime('2026-11-04T23:10:00Z'), publishedAt: datetime('2026-11-04T23:12:00Z'), validFrom: datetime('2026-11-04T23:12:00Z'), validTo: datetime('2026-11-05T23:12:00Z'), invalidatedAt: datetime('2026-11-06T08:10:00Z')},
  {id: 'demo:lineage:v2:dsv:stg.orders@17', version: '17', generatedAt: datetime('2026-11-05T23:10:00Z'), publishedAt: datetime('2026-11-05T23:12:00Z'), validFrom: datetime('2026-11-05T23:12:00Z')},
  {id: 'demo:lineage:v2:dsv:stg.orders@16-backfill-1', version: '16-backfill-1', generatedAt: datetime('2026-11-06T08:10:00Z')},
  {id: 'demo:lineage:v2:dsv:mart.revenue@8', version: '8', generatedAt: datetime('2026-11-05T00:05:00Z'), publishedAt: datetime('2026-11-05T00:06:00Z'), validFrom: datetime('2026-11-05T00:06:00Z'), validTo: datetime('2026-11-06T00:06:00Z')},
  {id: 'demo:lineage:v2:dsv:mart.revenue@9', version: '9', generatedAt: datetime('2026-11-06T00:05:00Z'), publishedAt: datetime('2026-11-06T00:06:00Z'), validFrom: datetime('2026-11-06T00:06:00Z')},
  {id: 'demo:lineage:v2:dsv:dash.revenue@31', version: '31', generatedAt: datetime('2026-11-06T00:35:00Z'), publishedAt: datetime('2026-11-06T00:36:00Z'), validFrom: datetime('2026-11-06T00:36:00Z')}
] AS row
MERGE (n:DatasetVersion:Entity {id: row.id})
  ON CREATE SET n.generatedAt = row.generatedAt,
                n.invalidatedAt = row.invalidatedAt,
                n.publishedAt = row.publishedAt,
                n.schemaHash = row.schemaHash,
                n.validFrom = row.validFrom,
                n.validTo = row.validTo,
                n.version = row.version;

// 11 Seed 2e: column versions
UNWIND [
  {id: 'demo:lineage:v2:colv:raw.orders@41.unit_price', name: 'unit_price', dataType: 'NUMBER(10,2)', ordinal: 1, nullable: false},
  {id: 'demo:lineage:v2:colv:raw.orders@41.quantity', name: 'quantity', dataType: 'INTEGER', ordinal: 2, nullable: false},
  {id: 'demo:lineage:v2:colv:raw.orders@42.unit_price', name: 'unit_price', dataType: 'NUMBER(10,2)', ordinal: 1, nullable: false},
  {id: 'demo:lineage:v2:colv:raw.orders@42.quantity', name: 'quantity', dataType: 'INTEGER', ordinal: 2, nullable: false},
  {id: 'demo:lineage:v2:colv:raw.orders@42.discount', name: 'discount', dataType: 'NUMBER(4,3)', ordinal: 3, nullable: true},
  {id: 'demo:lineage:v2:colv:stg.orders@16.price', name: 'price', dataType: 'NUMBER(10,2)', ordinal: 1, nullable: false},
  {id: 'demo:lineage:v2:colv:stg.orders@16.qty', name: 'qty', dataType: 'INTEGER', ordinal: 2, nullable: false},
  {id: 'demo:lineage:v2:colv:stg.orders@17.price', name: 'price', dataType: 'NUMBER(12,4)', ordinal: 1, nullable: false},
  {id: 'demo:lineage:v2:colv:stg.orders@17.qty', name: 'qty', dataType: 'INTEGER', ordinal: 2, nullable: false},
  {id: 'demo:lineage:v2:colv:stg.customers@5.customer_id', name: 'customer_id', dataType: 'VARCHAR', ordinal: 1, nullable: false},
  {id: 'demo:lineage:v2:colv:stg.customers@5.country', name: 'country', dataType: 'VARCHAR', ordinal: 2, nullable: false},
  {id: 'demo:lineage:v2:colv:mart.revenue@9.country', name: 'country', dataType: 'VARCHAR', ordinal: 1, nullable: false},
  {id: 'demo:lineage:v2:colv:mart.revenue@9.amount', name: 'amount', dataType: 'NUMBER(14,2)', ordinal: 2, nullable: false}
] AS row
MERGE (n:ColumnVersion:Entity {id: row.id})
  ON CREATE SET n.dataType = row.dataType,
                n.name = row.name,
                n.nullable = row.nullable,
                n.ordinal = row.ordinal;

// 12 Seed 2f: runs
UNWIND [
  {id: 'demo:lineage:v2:run:990', status: 'SUCCESS', startedAt: datetime('2026-11-04T23:00:00Z'), endedAt: datetime('2026-11-04T23:10:00Z'), lastEventType: 'COMPLETE', lastEventTime: datetime('2026-11-04T23:10:00Z'), observedAt: datetime('2026-11-04T23:10:00Z'), parameters: '{"logical_date":"2026-11-04"}'},
  {id: 'demo:lineage:v2:run:989', status: 'SUCCESS', startedAt: datetime('2026-11-05T00:00:00Z'), endedAt: datetime('2026-11-05T00:05:00Z'), lastEventType: 'COMPLETE', lastEventTime: datetime('2026-11-05T00:05:00Z'), observedAt: datetime('2026-11-05T00:05:00Z'), parameters: '{"logical_date":"2026-11-04"}'},
  {id: 'demo:lineage:v2:run:1000', status: 'SUCCESS', startedAt: datetime('2026-11-05T21:20:00Z'), endedAt: datetime('2026-11-05T21:30:00Z'), lastEventType: 'COMPLETE', lastEventTime: datetime('2026-11-05T21:30:00Z'), observedAt: datetime('2026-11-05T21:30:00Z'), parameters: '{"logical_date":"2026-11-05"}'},
  {id: 'demo:lineage:v2:run:1001', status: 'SUCCESS', startedAt: datetime('2026-11-05T23:00:00Z'), endedAt: datetime('2026-11-05T23:10:00Z'), lastEventType: 'COMPLETE', lastEventTime: datetime('2026-11-05T23:10:00Z'), observedAt: datetime('2026-11-05T23:10:00Z'), parameters: '{"logical_date":"2026-11-05"}'},
  {id: 'demo:lineage:v2:run:1002', status: 'SUCCESS', startedAt: datetime('2026-11-06T00:00:00Z'), endedAt: datetime('2026-11-06T00:05:00Z'), lastEventType: 'COMPLETE', lastEventTime: datetime('2026-11-06T00:05:00Z'), observedAt: datetime('2026-11-06T00:05:00Z'), parameters: '{"logical_date":"2026-11-05"}'},
  {id: 'demo:lineage:v2:run:1003', status: 'SUCCESS', startedAt: datetime('2026-11-06T00:30:00Z'), endedAt: datetime('2026-11-06T00:35:00Z'), lastEventType: 'COMPLETE', lastEventTime: datetime('2026-11-06T00:35:00Z'), observedAt: datetime('2026-11-06T00:35:00Z'), parameters: '{"workbook":"revenue"}'},
  {id: 'demo:lineage:v2:run:1004', status: 'FAILED', startedAt: datetime('2026-11-06T06:00:00Z'), endedAt: datetime('2026-11-06T06:02:00Z'), lastEventType: 'FAIL', lastEventTime: datetime('2026-11-06T06:02:00Z'), observedAt: datetime('2026-11-06T06:02:00Z'), parameters: '{"logical_date":"2026-11-06"}'},
  {id: 'demo:lineage:v2:run:1006', status: 'SUCCESS', startedAt: datetime('2026-11-06T08:00:00Z'), endedAt: datetime('2026-11-06T08:10:00Z'), lastEventType: 'COMPLETE', lastEventTime: datetime('2026-11-06T08:10:00Z'), observedAt: datetime('2026-11-06T08:10:00Z'), parameters: '{"logical_date":"2026-11-04","mode":"backfill"}'}
] AS row
MERGE (n:Run:Activity {id: row.id})
  ON CREATE SET n.endedAt = row.endedAt,
                n.lastEventTime = row.lastEventTime,
                n.lastEventType = row.lastEventType,
                n.observedAt = row.observedAt,
                n.parameters = row.parameters,
                n.startedAt = row.startedAt,
                n.status = row.status;

// 13 Seed 2g: delegation
UNWIND [
  {from: 'demo:lineage:v2:agent:dbt', to: 'demo:lineage:v2:agent:data-platform'},
  {from: 'demo:lineage:v2:agent:tableau', to: 'demo:lineage:v2:agent:data-platform'}
] AS row
MATCH (a:Agent {id: row.from})
MATCH (b:Agent {id: row.to})
MERGE (a)-[r:ACTED_ON_BEHALF_OF]->(b);

// 14 Seed 2g: ownership and stewardship
UNWIND [
  {from: 'demo:lineage:v2:ds:raw.orders', to: 'demo:lineage:v2:agent:bob', role: 'owner'},
  {from: 'demo:lineage:v2:ds:raw.customers', to: 'demo:lineage:v2:agent:bob', role: 'owner'},
  {from: 'demo:lineage:v2:ds:ref.dq_rules', to: 'demo:lineage:v2:agent:alice', role: 'owner'},
  {from: 'demo:lineage:v2:ds:stg.orders', to: 'demo:lineage:v2:agent:alice', role: 'owner'},
  {from: 'demo:lineage:v2:ds:stg.customers', to: 'demo:lineage:v2:agent:alice', role: 'owner'},
  {from: 'demo:lineage:v2:ds:mart.revenue', to: 'demo:lineage:v2:agent:alice', role: 'owner'},
  {from: 'demo:lineage:v2:ds:dash.revenue', to: 'demo:lineage:v2:agent:carol', role: 'owner'},
  {from: 'demo:lineage:v2:ds:mart.revenue', to: 'demo:lineage:v2:agent:data-platform', role: 'steward'}
] AS row
MATCH (a:Entity {id: row.from})
MATCH (b:Agent {id: row.to})
MERGE (a)-[r:WAS_ATTRIBUTED_TO {role: row.role}]->(b);

// 15 Seed 2h: dataset has column
UNWIND [
  {from: 'demo:lineage:v2:ds:raw.orders', to: 'demo:lineage:v2:col:raw.orders.unit_price'},
  {from: 'demo:lineage:v2:ds:raw.orders', to: 'demo:lineage:v2:col:raw.orders.quantity'},
  {from: 'demo:lineage:v2:ds:raw.orders', to: 'demo:lineage:v2:col:raw.orders.discount'},
  {from: 'demo:lineage:v2:ds:stg.orders', to: 'demo:lineage:v2:col:stg.orders.price'},
  {from: 'demo:lineage:v2:ds:stg.orders', to: 'demo:lineage:v2:col:stg.orders.qty'},
  {from: 'demo:lineage:v2:ds:stg.customers', to: 'demo:lineage:v2:col:stg.customers.customer_id'},
  {from: 'demo:lineage:v2:ds:stg.customers', to: 'demo:lineage:v2:col:stg.customers.country'},
  {from: 'demo:lineage:v2:ds:mart.revenue', to: 'demo:lineage:v2:col:mart.revenue.country'},
  {from: 'demo:lineage:v2:ds:mart.revenue', to: 'demo:lineage:v2:col:mart.revenue.amount'}
] AS row
MATCH (a:Dataset:Entity {id: row.from})
MATCH (b:Column:Entity {id: row.to})
MERGE (a)-[r:HAS_COLUMN]->(b);

// 16 Seed 2h: dataset version of dataset
UNWIND [
  {from: 'demo:lineage:v2:dsv:raw.orders@41', to: 'demo:lineage:v2:ds:raw.orders'},
  {from: 'demo:lineage:v2:dsv:raw.orders@42', to: 'demo:lineage:v2:ds:raw.orders'},
  {from: 'demo:lineage:v2:dsv:raw.customers@7', to: 'demo:lineage:v2:ds:raw.customers'},
  {from: 'demo:lineage:v2:dsv:ref.dq_rules@2', to: 'demo:lineage:v2:ds:ref.dq_rules'},
  {from: 'demo:lineage:v2:dsv:stg.customers@4', to: 'demo:lineage:v2:ds:stg.customers'},
  {from: 'demo:lineage:v2:dsv:stg.customers@5', to: 'demo:lineage:v2:ds:stg.customers'},
  {from: 'demo:lineage:v2:dsv:stg.orders@16', to: 'demo:lineage:v2:ds:stg.orders'},
  {from: 'demo:lineage:v2:dsv:stg.orders@17', to: 'demo:lineage:v2:ds:stg.orders'},
  {from: 'demo:lineage:v2:dsv:stg.orders@16-backfill-1', to: 'demo:lineage:v2:ds:stg.orders'},
  {from: 'demo:lineage:v2:dsv:mart.revenue@8', to: 'demo:lineage:v2:ds:mart.revenue'},
  {from: 'demo:lineage:v2:dsv:mart.revenue@9', to: 'demo:lineage:v2:ds:mart.revenue'},
  {from: 'demo:lineage:v2:dsv:dash.revenue@31', to: 'demo:lineage:v2:ds:dash.revenue'}
] AS row
MATCH (a:DatasetVersion:Entity {id: row.from})
MATCH (b:Dataset:Entity {id: row.to})
MERGE (a)-[r:VERSION_OF_DATASET]->(b);

// 17 Seed 2h: dataset version has column version
UNWIND [
  {from: 'demo:lineage:v2:dsv:raw.orders@41', to: 'demo:lineage:v2:colv:raw.orders@41.unit_price'},
  {from: 'demo:lineage:v2:dsv:raw.orders@41', to: 'demo:lineage:v2:colv:raw.orders@41.quantity'},
  {from: 'demo:lineage:v2:dsv:raw.orders@42', to: 'demo:lineage:v2:colv:raw.orders@42.unit_price'},
  {from: 'demo:lineage:v2:dsv:raw.orders@42', to: 'demo:lineage:v2:colv:raw.orders@42.quantity'},
  {from: 'demo:lineage:v2:dsv:raw.orders@42', to: 'demo:lineage:v2:colv:raw.orders@42.discount'},
  {from: 'demo:lineage:v2:dsv:stg.orders@16', to: 'demo:lineage:v2:colv:stg.orders@16.price'},
  {from: 'demo:lineage:v2:dsv:stg.orders@16', to: 'demo:lineage:v2:colv:stg.orders@16.qty'},
  {from: 'demo:lineage:v2:dsv:stg.orders@17', to: 'demo:lineage:v2:colv:stg.orders@17.price'},
  {from: 'demo:lineage:v2:dsv:stg.orders@17', to: 'demo:lineage:v2:colv:stg.orders@17.qty'},
  {from: 'demo:lineage:v2:dsv:stg.customers@5', to: 'demo:lineage:v2:colv:stg.customers@5.customer_id'},
  {from: 'demo:lineage:v2:dsv:stg.customers@5', to: 'demo:lineage:v2:colv:stg.customers@5.country'},
  {from: 'demo:lineage:v2:dsv:mart.revenue@9', to: 'demo:lineage:v2:colv:mart.revenue@9.country'},
  {from: 'demo:lineage:v2:dsv:mart.revenue@9', to: 'demo:lineage:v2:colv:mart.revenue@9.amount'}
] AS row
MATCH (a:DatasetVersion:Entity {id: row.from})
MATCH (b:ColumnVersion:Entity {id: row.to})
MERGE (a)-[r:HAS_COLUMN_VERSION]->(b);

// 18 Seed 2h: column version of column
UNWIND [
  {from: 'demo:lineage:v2:colv:raw.orders@41.unit_price', to: 'demo:lineage:v2:col:raw.orders.unit_price'},
  {from: 'demo:lineage:v2:colv:raw.orders@41.quantity', to: 'demo:lineage:v2:col:raw.orders.quantity'},
  {from: 'demo:lineage:v2:colv:raw.orders@42.unit_price', to: 'demo:lineage:v2:col:raw.orders.unit_price'},
  {from: 'demo:lineage:v2:colv:raw.orders@42.quantity', to: 'demo:lineage:v2:col:raw.orders.quantity'},
  {from: 'demo:lineage:v2:colv:raw.orders@42.discount', to: 'demo:lineage:v2:col:raw.orders.discount'},
  {from: 'demo:lineage:v2:colv:stg.orders@16.price', to: 'demo:lineage:v2:col:stg.orders.price'},
  {from: 'demo:lineage:v2:colv:stg.orders@16.qty', to: 'demo:lineage:v2:col:stg.orders.qty'},
  {from: 'demo:lineage:v2:colv:stg.orders@17.price', to: 'demo:lineage:v2:col:stg.orders.price'},
  {from: 'demo:lineage:v2:colv:stg.orders@17.qty', to: 'demo:lineage:v2:col:stg.orders.qty'},
  {from: 'demo:lineage:v2:colv:stg.customers@5.customer_id', to: 'demo:lineage:v2:col:stg.customers.customer_id'},
  {from: 'demo:lineage:v2:colv:stg.customers@5.country', to: 'demo:lineage:v2:col:stg.customers.country'},
  {from: 'demo:lineage:v2:colv:mart.revenue@9.country', to: 'demo:lineage:v2:col:mart.revenue.country'},
  {from: 'demo:lineage:v2:colv:mart.revenue@9.amount', to: 'demo:lineage:v2:col:mart.revenue.amount'}
] AS row
MATCH (a:ColumnVersion:Entity {id: row.from})
MATCH (b:Column:Entity {id: row.to})
MERGE (a)-[r:VERSION_OF_COLUMN]->(b);

// 19 Seed 2h: job version of job
UNWIND [
  {from: 'demo:lineage:v2:jobv:stg_orders@git:9f01', to: 'demo:lineage:v2:job:stg_orders'},
  {from: 'demo:lineage:v2:jobv:stg_orders@git:ab12', to: 'demo:lineage:v2:job:stg_orders'},
  {from: 'demo:lineage:v2:jobv:stg_customers@git:77aa', to: 'demo:lineage:v2:job:stg_customers'},
  {from: 'demo:lineage:v2:jobv:mart_revenue@git:cd34', to: 'demo:lineage:v2:job:mart_revenue'},
  {from: 'demo:lineage:v2:jobv:bi_refresh@workbook:v12', to: 'demo:lineage:v2:job:bi_refresh'}
] AS row
MATCH (a:JobVersion:Entity {id: row.from})
MATCH (b:Job:Entity {id: row.to})
MERGE (a)-[r:VERSION_OF_JOB]->(b);

// 20 Seed 2i: run of job
UNWIND [
  {from: 'demo:lineage:v2:run:990', to: 'demo:lineage:v2:job:stg_orders'},
  {from: 'demo:lineage:v2:run:989', to: 'demo:lineage:v2:job:mart_revenue'},
  {from: 'demo:lineage:v2:run:1000', to: 'demo:lineage:v2:job:stg_customers'},
  {from: 'demo:lineage:v2:run:1001', to: 'demo:lineage:v2:job:stg_orders'},
  {from: 'demo:lineage:v2:run:1002', to: 'demo:lineage:v2:job:mart_revenue'},
  {from: 'demo:lineage:v2:run:1003', to: 'demo:lineage:v2:job:bi_refresh'},
  {from: 'demo:lineage:v2:run:1004', to: 'demo:lineage:v2:job:mart_revenue'},
  {from: 'demo:lineage:v2:run:1006', to: 'demo:lineage:v2:job:stg_orders'}
] AS row
MATCH (a:Run:Activity {id: row.from})
MATCH (b:Job:Entity {id: row.to})
MERGE (a)-[r:RUN_OF]->(b);

// 21 Seed 2i: run had plan (job version)
UNWIND [
  {from: 'demo:lineage:v2:run:990', to: 'demo:lineage:v2:jobv:stg_orders@git:9f01'},
  {from: 'demo:lineage:v2:run:989', to: 'demo:lineage:v2:jobv:mart_revenue@git:cd34'},
  {from: 'demo:lineage:v2:run:1000', to: 'demo:lineage:v2:jobv:stg_customers@git:77aa'},
  {from: 'demo:lineage:v2:run:1001', to: 'demo:lineage:v2:jobv:stg_orders@git:ab12'},
  {from: 'demo:lineage:v2:run:1002', to: 'demo:lineage:v2:jobv:mart_revenue@git:cd34'},
  {from: 'demo:lineage:v2:run:1003', to: 'demo:lineage:v2:jobv:bi_refresh@workbook:v12'},
  {from: 'demo:lineage:v2:run:1004', to: 'demo:lineage:v2:jobv:mart_revenue@git:cd34'},
  {from: 'demo:lineage:v2:run:1006', to: 'demo:lineage:v2:jobv:stg_orders@git:ab12'}
] AS row
MATCH (a:Run:Activity {id: row.from})
MATCH (b:JobVersion:Entity {id: row.to})
MERGE (a)-[r:HAD_PLAN]->(b);

// 22 Seed 2i: run associated with agent
UNWIND [
  {from: 'demo:lineage:v2:run:990', to: 'demo:lineage:v2:agent:dbt', role: 'executor'},
  {from: 'demo:lineage:v2:run:989', to: 'demo:lineage:v2:agent:dbt', role: 'executor'},
  {from: 'demo:lineage:v2:run:1000', to: 'demo:lineage:v2:agent:dbt', role: 'executor'},
  {from: 'demo:lineage:v2:run:1001', to: 'demo:lineage:v2:agent:dbt', role: 'executor'},
  {from: 'demo:lineage:v2:run:1002', to: 'demo:lineage:v2:agent:dbt', role: 'executor'},
  {from: 'demo:lineage:v2:run:1003', to: 'demo:lineage:v2:agent:tableau', role: 'executor'},
  {from: 'demo:lineage:v2:run:1004', to: 'demo:lineage:v2:agent:dbt', role: 'executor'},
  {from: 'demo:lineage:v2:run:1006', to: 'demo:lineage:v2:agent:dbt', role: 'executor'},
  {from: 'demo:lineage:v2:run:1006', to: 'demo:lineage:v2:agent:alice', role: 'triggeredBy'}
] AS row
MATCH (a:Run:Activity {id: row.from})
MATCH (b:Agent {id: row.to})
MERGE (a)-[r:WAS_ASSOCIATED_WITH {role: row.role}]->(b);

// 23 Seed 2i: run informed by run
UNWIND [
  {from: 'demo:lineage:v2:run:1002', to: 'demo:lineage:v2:run:1001'},
  {from: 'demo:lineage:v2:run:1002', to: 'demo:lineage:v2:run:1000'},
  {from: 'demo:lineage:v2:run:1003', to: 'demo:lineage:v2:run:1002'},
  {from: 'demo:lineage:v2:run:989', to: 'demo:lineage:v2:run:990'}
] AS row
MATCH (a:Run:Activity {id: row.from})
MATCH (b:Run:Activity {id: row.to})
MERGE (a)-[r:WAS_INFORMED_BY]->(b);

// 24 Seed 2j: runs used dataset versions
UNWIND [
  {from: 'demo:lineage:v2:run:990', to: 'demo:lineage:v2:dsv:raw.orders@41', role: 'input'},
  {from: 'demo:lineage:v2:run:989', to: 'demo:lineage:v2:dsv:stg.orders@16', role: 'input'},
  {from: 'demo:lineage:v2:run:989', to: 'demo:lineage:v2:dsv:stg.customers@4', role: 'input'},
  {from: 'demo:lineage:v2:run:989', to: 'demo:lineage:v2:dsv:ref.dq_rules@2', role: 'config'},
  {from: 'demo:lineage:v2:run:1000', to: 'demo:lineage:v2:dsv:raw.customers@7', role: 'input'},
  {from: 'demo:lineage:v2:run:1001', to: 'demo:lineage:v2:dsv:raw.orders@42', role: 'input'},
  {from: 'demo:lineage:v2:run:1002', to: 'demo:lineage:v2:dsv:stg.orders@17', role: 'input'},
  {from: 'demo:lineage:v2:run:1002', to: 'demo:lineage:v2:dsv:stg.customers@5', role: 'input'},
  {from: 'demo:lineage:v2:run:1002', to: 'demo:lineage:v2:dsv:ref.dq_rules@2', role: 'config'},
  {from: 'demo:lineage:v2:run:1003', to: 'demo:lineage:v2:dsv:mart.revenue@9', role: 'input'},
  {from: 'demo:lineage:v2:run:1004', to: 'demo:lineage:v2:dsv:stg.orders@17', role: 'input'},
  {from: 'demo:lineage:v2:run:1004', to: 'demo:lineage:v2:dsv:stg.customers@5', role: 'input'},
  {from: 'demo:lineage:v2:run:1004', to: 'demo:lineage:v2:dsv:ref.dq_rules@2', role: 'config'},
  {from: 'demo:lineage:v2:run:1006', to: 'demo:lineage:v2:dsv:raw.orders@41', role: 'input'}
] AS row
MATCH (a:Run:Activity {id: row.from})
MATCH (b:DatasetVersion:Entity {id: row.to})
MERGE (a)-[r:USED]->(b)
  ON CREATE SET r.role = row.role;

// 25 Seed 2j: dataset versions generated by runs
UNWIND [
  {from: 'demo:lineage:v2:dsv:stg.orders@16', to: 'demo:lineage:v2:run:990', role: 'output'},
  {from: 'demo:lineage:v2:dsv:mart.revenue@8', to: 'demo:lineage:v2:run:989', role: 'output'},
  {from: 'demo:lineage:v2:dsv:stg.customers@5', to: 'demo:lineage:v2:run:1000', role: 'output'},
  {from: 'demo:lineage:v2:dsv:stg.orders@17', to: 'demo:lineage:v2:run:1001', role: 'output'},
  {from: 'demo:lineage:v2:dsv:mart.revenue@9', to: 'demo:lineage:v2:run:1002', role: 'output'},
  {from: 'demo:lineage:v2:dsv:dash.revenue@31', to: 'demo:lineage:v2:run:1003', role: 'output'},
  {from: 'demo:lineage:v2:dsv:stg.orders@16-backfill-1', to: 'demo:lineage:v2:run:1006', role: 'output'}
] AS row
MATCH (a:DatasetVersion:Entity {id: row.from})
MATCH (b:Run:Activity {id: row.to})
MERGE (a)-[r:WAS_GENERATED_BY]->(b)
  ON CREATE SET r.role = row.role;

// 26 Seed 2k: invalidation by backfill
UNWIND [
  {from: 'demo:lineage:v2:dsv:stg.orders@16', to: 'demo:lineage:v2:run:1006', reason: 'backfill: price ignored discount'}
] AS row
MATCH (a:DatasetVersion:Entity {id: row.from})
MATCH (b:Run:Activity {id: row.to})
MERGE (a)-[r:WAS_INVALIDATED_BY]->(b)
  ON CREATE SET r.reason = row.reason;

// 27 Seed 2l: asserted dataset derivations
UNWIND [
  {from: 'demo:lineage:v2:dsv:stg.orders@16', to: 'demo:lineage:v2:dsv:raw.orders@41', runId: 'demo:lineage:v2:run:990', jobVersionId: 'demo:lineage:v2:jobv:stg_orders@git:9f01', source: 'DBT_MANIFEST', transformationType: 'DIRECT', transformationSubtype: 'TRANSFORMATION', evidenceRef: 'manifest:stg_orders@git:9f01', assertedAt: datetime('2026-11-06T09:00:00Z')},
  {from: 'demo:lineage:v2:dsv:stg.orders@17', to: 'demo:lineage:v2:dsv:raw.orders@42', runId: 'demo:lineage:v2:run:1001', jobVersionId: 'demo:lineage:v2:jobv:stg_orders@git:ab12', source: 'DBT_MANIFEST', transformationType: 'DIRECT', transformationSubtype: 'TRANSFORMATION', evidenceRef: 'manifest:stg_orders@git:ab12', assertedAt: datetime('2026-11-06T09:00:00Z')},
  {from: 'demo:lineage:v2:dsv:stg.orders@16-backfill-1', to: 'demo:lineage:v2:dsv:raw.orders@41', runId: 'demo:lineage:v2:run:1006', jobVersionId: 'demo:lineage:v2:jobv:stg_orders@git:ab12', source: 'DBT_MANIFEST', transformationType: 'DIRECT', transformationSubtype: 'TRANSFORMATION', evidenceRef: 'manifest:stg_orders@git:ab12', assertedAt: datetime('2026-11-06T09:00:00Z')},
  {from: 'demo:lineage:v2:dsv:stg.customers@5', to: 'demo:lineage:v2:dsv:raw.customers@7', runId: 'demo:lineage:v2:run:1000', jobVersionId: 'demo:lineage:v2:jobv:stg_customers@git:77aa', source: 'DBT_MANIFEST', transformationType: 'DIRECT', transformationSubtype: 'IDENTITY', evidenceRef: 'manifest:stg_customers@git:77aa', assertedAt: datetime('2026-11-06T09:00:00Z')},
  {from: 'demo:lineage:v2:dsv:mart.revenue@8', to: 'demo:lineage:v2:dsv:stg.orders@16', runId: 'demo:lineage:v2:run:989', jobVersionId: 'demo:lineage:v2:jobv:mart_revenue@git:cd34', source: 'DBT_MANIFEST', transformationType: 'DIRECT', transformationSubtype: 'AGGREGATION', evidenceRef: 'manifest:mart_revenue@git:cd34', assertedAt: datetime('2026-11-06T09:00:00Z')},
  {from: 'demo:lineage:v2:dsv:mart.revenue@8', to: 'demo:lineage:v2:dsv:stg.customers@4', runId: 'demo:lineage:v2:run:989', jobVersionId: 'demo:lineage:v2:jobv:mart_revenue@git:cd34', source: 'DBT_MANIFEST', transformationType: 'DIRECT', transformationSubtype: 'JOIN', evidenceRef: 'manifest:mart_revenue@git:cd34', assertedAt: datetime('2026-11-06T09:00:00Z')},
  {from: 'demo:lineage:v2:dsv:mart.revenue@9', to: 'demo:lineage:v2:dsv:stg.orders@17', runId: 'demo:lineage:v2:run:1002', jobVersionId: 'demo:lineage:v2:jobv:mart_revenue@git:cd34', source: 'DBT_MANIFEST', transformationType: 'DIRECT', transformationSubtype: 'AGGREGATION', evidenceRef: 'manifest:mart_revenue@git:cd34', assertedAt: datetime('2026-11-06T09:00:00Z')},
  {from: 'demo:lineage:v2:dsv:mart.revenue@9', to: 'demo:lineage:v2:dsv:stg.customers@5', runId: 'demo:lineage:v2:run:1002', jobVersionId: 'demo:lineage:v2:jobv:mart_revenue@git:cd34', source: 'DBT_MANIFEST', transformationType: 'DIRECT', transformationSubtype: 'JOIN', evidenceRef: 'manifest:mart_revenue@git:cd34', assertedAt: datetime('2026-11-06T09:00:00Z')},
  {from: 'demo:lineage:v2:dsv:dash.revenue@31', to: 'demo:lineage:v2:dsv:mart.revenue@9', runId: 'demo:lineage:v2:run:1003', jobVersionId: 'demo:lineage:v2:jobv:bi_refresh@workbook:v12', source: 'OPENLINEAGE_COLUMN_LINEAGE', transformationType: 'DIRECT', transformationSubtype: 'IDENTITY', evidenceRef: 'openlineage:event:run:1003:COMPLETE', assertedAt: datetime('2026-11-06T09:00:00Z')}
] AS row
MATCH (a:DatasetVersion:Entity {id: row.from})
MATCH (b:DatasetVersion:Entity {id: row.to})
MERGE (a)-[r:WAS_DERIVED_FROM {runId: row.runId, source: row.source}]->(b)
  ON CREATE SET r.assertedAt = row.assertedAt,
                r.evidenceRef = row.evidenceRef,
                r.jobVersionId = row.jobVersionId,
                r.transformationSubtype = row.transformationSubtype,
                r.transformationType = row.transformationType;

// 28 Seed 2m: asserted column derivations
UNWIND [
  {from: 'demo:lineage:v2:colv:stg.orders@16.price', to: 'demo:lineage:v2:colv:raw.orders@41.unit_price', runId: 'demo:lineage:v2:run:990', jobVersionId: 'demo:lineage:v2:jobv:stg_orders@git:9f01', source: 'SQL_PARSER', transformationType: 'DIRECT', transformationSubtype: 'IDENTITY', expression: 'unit_price', evidenceRef: 'sql:stg_orders@git:9f01', assertedAt: datetime('2026-11-06T09:00:00Z')},
  {from: 'demo:lineage:v2:colv:stg.orders@16.qty', to: 'demo:lineage:v2:colv:raw.orders@41.quantity', runId: 'demo:lineage:v2:run:990', jobVersionId: 'demo:lineage:v2:jobv:stg_orders@git:9f01', source: 'SQL_PARSER', transformationType: 'DIRECT', transformationSubtype: 'IDENTITY', expression: 'quantity', evidenceRef: 'sql:stg_orders@git:9f01', assertedAt: datetime('2026-11-06T09:00:00Z')},
  {from: 'demo:lineage:v2:colv:stg.orders@17.price', to: 'demo:lineage:v2:colv:raw.orders@42.unit_price', runId: 'demo:lineage:v2:run:1001', jobVersionId: 'demo:lineage:v2:jobv:stg_orders@git:ab12', source: 'SQL_PARSER', transformationType: 'DIRECT', transformationSubtype: 'TRANSFORMATION', expression: 'unit_price * (1 - discount)', evidenceRef: 'sql:stg_orders@git:ab12', assertedAt: datetime('2026-11-06T09:00:00Z')},
  {from: 'demo:lineage:v2:colv:stg.orders@17.price', to: 'demo:lineage:v2:colv:raw.orders@42.discount', runId: 'demo:lineage:v2:run:1001', jobVersionId: 'demo:lineage:v2:jobv:stg_orders@git:ab12', source: 'SQL_PARSER', transformationType: 'DIRECT', transformationSubtype: 'TRANSFORMATION', expression: 'unit_price * (1 - discount)', evidenceRef: 'sql:stg_orders@git:ab12', assertedAt: datetime('2026-11-06T09:00:00Z')},
  {from: 'demo:lineage:v2:colv:stg.orders@17.qty', to: 'demo:lineage:v2:colv:raw.orders@42.quantity', runId: 'demo:lineage:v2:run:1001', jobVersionId: 'demo:lineage:v2:jobv:stg_orders@git:ab12', source: 'SQL_PARSER', transformationType: 'DIRECT', transformationSubtype: 'IDENTITY', expression: 'quantity', evidenceRef: 'sql:stg_orders@git:ab12', assertedAt: datetime('2026-11-06T09:00:00Z')},
  {from: 'demo:lineage:v2:colv:mart.revenue@9.amount', to: 'demo:lineage:v2:colv:stg.orders@17.price', runId: 'demo:lineage:v2:run:1002', jobVersionId: 'demo:lineage:v2:jobv:mart_revenue@git:cd34', source: 'SQL_PARSER', transformationType: 'DIRECT', transformationSubtype: 'AGGREGATION', expression: 'sum(price * qty)', evidenceRef: 'sql:mart_revenue@git:cd34', assertedAt: datetime('2026-11-06T09:00:00Z')},
  {from: 'demo:lineage:v2:colv:mart.revenue@9.amount', to: 'demo:lineage:v2:colv:stg.orders@17.qty', runId: 'demo:lineage:v2:run:1002', jobVersionId: 'demo:lineage:v2:jobv:mart_revenue@git:cd34', source: 'SQL_PARSER', transformationType: 'DIRECT', transformationSubtype: 'AGGREGATION', expression: 'sum(price * qty)', evidenceRef: 'sql:mart_revenue@git:cd34', assertedAt: datetime('2026-11-06T09:00:00Z')},
  {from: 'demo:lineage:v2:colv:mart.revenue@9.amount', to: 'demo:lineage:v2:colv:stg.customers@5.customer_id', runId: 'demo:lineage:v2:run:1002', jobVersionId: 'demo:lineage:v2:jobv:mart_revenue@git:cd34', source: 'SQL_PARSER', transformationType: 'INDIRECT', transformationSubtype: 'JOIN', expression: 'join stg.customers on customer_id', evidenceRef: 'sql:mart_revenue@git:cd34', assertedAt: datetime('2026-11-06T09:00:00Z')},
  {from: 'demo:lineage:v2:colv:mart.revenue@9.country', to: 'demo:lineage:v2:colv:stg.customers@5.country', runId: 'demo:lineage:v2:run:1002', jobVersionId: 'demo:lineage:v2:jobv:mart_revenue@git:cd34', source: 'SQL_PARSER', transformationType: 'DIRECT', transformationSubtype: 'IDENTITY', expression: 'country', evidenceRef: 'sql:mart_revenue@git:cd34', assertedAt: datetime('2026-11-06T09:00:00Z')}
] AS row
MATCH (a:ColumnVersion:Entity {id: row.from})
MATCH (b:ColumnVersion:Entity {id: row.to})
MERGE (a)-[r:COLUMN_DERIVED_FROM {runId: row.runId, source: row.source}]->(b)
  ON CREATE SET r.assertedAt = row.assertedAt,
                r.evidenceRef = row.evidenceRef,
                r.expression = row.expression,
                r.jobVersionId = row.jobVersionId,
                r.transformationSubtype = row.transformationSubtype,
                r.transformationType = row.transformationType;

// 29 Step 3: materialize DEPENDS_ON
MATCH (o:DatasetVersion:Entity)-[:WAS_GENERATED_BY]->(r:Run:Activity)-[:USED]->(i:DatasetVersion:Entity)
WHERE r.id STARTS WITH 'demo:lineage:v2:'
MERGE (o)-[d:DEPENDS_ON {runId: r.id}]->(i)
  ON CREATE SET d.computedAt = datetime();
