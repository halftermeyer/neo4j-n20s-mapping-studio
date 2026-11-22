# propose on Data lineage to PROV-O: gemini-2.5-flash, prompt propose/4

**Commit 0ce718eeedb0**

2026-11-22T15:26:26.695Z.

| fingerprint | file | SHA-256 |
|---|---|---|
| lpg | aura-export.json | `690ece6966b05061793d802fa5b0ee2d364f7a743e0a1f2f1da1db18a5537d5c` |
| gold | lineage-prov.aura.mapping.yaml | `441bd992512be99c26be36dfb162f550af3ec56e4dfd1250090001d0cb8829ad` |
| oracle | oracle.aura.yaml | `cedb8baec10b756428ab63c9c4b4d0d11581c442e655ed25ae56bef9bf456ece` |
| seed | seed.cypher | `95dbe0525cfc895f6fa3bb1a8fa4d87096b01b6e1a550cffaee951a42cd55044` |
| target | targets/prov.nq | `95bc4a976f6ba48bbabc45724f88bc8461540920b6e6764884416e23119e8790` |
| src | src/ (33 files) | `f749d5e8682521d69960efe9e66631022d86164a06a9f88fb608b88c251150aa` |

Commit `0ce718eeedb077881cf3998fa0ef3c3c6d69dc4d` on eval/campaign-1, clean. Prompt propose/4, model gemini-2.5-flash.

| condition | pass | agree | agree, alternative or acceptable | alternative | related | different | false map | false ignore | ignore/defer | missing | check E/W | repaired | completed | dropped | oracle pass | tokens in/out | s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| full | 1 | 69/83 (83%) | 86% | 0 | 3 | 0 | 7 | 0 | 2 | 0 | 0/7 | 1 | 0 | 0 | 9/9 | 289110/33045 | 178 |
| full | 2 | 68/83 (82%) | 86% | 0 | 2 | 0 | 3 | 2 | 5 | 0 | 0/2 | 2 | 0 | 0 | 7/9 | 298358/32955 | 182 |
| full | 3 | 55/83 (66%) | 76% | 0 | 2 | 1 | 12 | 0 | 5 | 0 | 0/5 | 0 | 0 | 0 | 8/9 | 280357/36143 | 194 |
| no-descriptions | 1 | 66/83 (80%) | 87% | 0 | 2 | 1 | 5 | 0 | 3 | 0 | 0/5 | 0 | 0 | 0 | 5/9 | 268619/35367 | 191 |
| no-descriptions | 2 | 62/83 (75%) | 86% | 0 | 3 | 0 | 7 | 0 | 2 | 0 | 0/11 | 0 | 0 | 0 | 5/9 | 268583/31628 | 167 |
| no-descriptions | 3 | 58/83 (70%) | 82% | 0 | 2 | 2 | 9 | 0 | 2 | 0 | 0/3 | 0 | 0 | 0 | 5/9 | 268773/33274 | 180 |

### Safety net

Wrong decisions (neither gold nor alternative), and what caught them; Accept safe after an oracle run on the proposals: how many elements it would accept, how many of them hold a wrong decision.

| condition | pass | wrong | caught by check only | by oracle only | by both | by neither | Accept safe: elements (entries) | of which wrong | precision |
|---|---|---|---|---|---|---|---|---|---|
| full | 1 | 12 | 6 | 0 | 0 | 6 | 7 (9) | 0 | 100% |
| full | 2 | 12 | 2 | 1 | 0 | 9 | 9 (11) | 0 | 100% |
| full | 3 | 20 | 5 | 1 | 0 | 14 | 8 (10) | 0 | 100% |
| no-descriptions | 1 | 11 | 3 | 1 | 0 | 7 | 7 (8) | 0 | 100% |
| no-descriptions | 2 | 12 | 6 | 0 | 1 | 5 | 7 (8) | 0 | 100% |
| no-descriptions | 3 | 15 | 3 | 1 | 0 | 11 | 9 (12) | 0 | 100% |

### Traps

| condition | pass | trap | expected | proposed | outcome | check |
|---|---|---|---|---|---|---|
| full | 1 | DEPENDS_ON | left out; any PROV link fails q34-potential-not-asserted or q34-potential-no-influence | ignore | agree | - |
| full | 1 | HAS_COLUMN | left out; prov:hadMember gets target.domain | map prov:hadMember | false-map | target.domain |
| full | 2 | DEPENDS_ON | left out; any PROV link fails q34-potential-not-asserted or q34-potential-no-influence | ignore | agree | - |
| full | 2 | HAS_COLUMN | left out; prov:hadMember gets target.domain | ignore | agree | - |
| full | 3 | DEPENDS_ON | left out; any PROV link fails q34-potential-not-asserted or q34-potential-no-influence | map prov:wasInfluencedBy | false-map | - |
| full | 3 | HAS_COLUMN | left out; prov:hadMember gets target.domain | map prov:hadMember | false-map | target.domain |
| no-descriptions | 1 | DEPENDS_ON | left out; any PROV link fails q34-potential-not-asserted or q34-potential-no-influence | map prov:wasDerivedFrom qualified prov:Derivation | false-map | - |
| no-descriptions | 1 | HAS_COLUMN | left out; prov:hadMember gets target.domain | map prov:hadMember | false-map | target.domain |
| no-descriptions | 2 | DEPENDS_ON | left out; any PROV link fails q34-potential-not-asserted or q34-potential-no-influence | map prov:wasDerivedFrom qualified prov:Derivation | false-map | target.domain, target.range, target.domain |
| no-descriptions | 2 | HAS_COLUMN | left out; prov:hadMember gets target.domain | map prov:hadMember | false-map | target.domain |
| no-descriptions | 3 | DEPENDS_ON | left out; any PROV link fails q34-potential-not-asserted or q34-potential-no-influence | map prov:wasDerivedFrom qualified prov:Derivation | false-map | - |
| no-descriptions | 3 | HAS_COLUMN | left out; prov:hadMember gets target.domain | map prov:hadMember | false-map | target.domain |

Outcomes per decision: agree (same decision, same terms), alternative (a decision the set lists as as good as the gold), acceptable (rdfs:label or rdfs:comment on a property the gold leaves out), related (sub/super term), different (other terms), false map (gold leaves it out, the proposal maps it), false ignore (gold maps it, the proposal leaves it out), ignore/defer (both leave it out, differently), missing (no answer). gold-nodes counts relationships only.

## full

Stability: 56/83 decisions identical in all 3 passes.

| confidence | decisions | agree |
|---|---|---|
| 0–0.5 | 0 | - |
| 0.5–0.8 | 35 | 54% |
| 0.8–0.95 | 119 | 75% |
| 0.95–1 | 95 | 88% |

| element | outcome | gold | proposed | passes |
|---|---|---|---|---|
| Dataset.name | false-ignore | rdfs:label | ignore | 1/3 |
| Dataset.system | false-map | ignore | prov:atLocation | 2/3 |
| Dataset.retiredAt | false-map | ignore | prov:invalidatedAtTime | 2/3 |
| DatasetVersion.version | acceptable | ignore | rdfs:label | 1/3 |
| DatasetVersion.publishedAt | ignore-vs-defer | ignore | defer | 3/3 |
| Job | different | (none) | prov:Plan | 1/3 |
| Job.namespace | false-map | ignore | prov:atLocation | 2/3 |
| Job.name | false-ignore | rdfs:label | ignore | 1/3 |
| JobVersion.codeRef | false-map | ignore | prov:value | 1/3 |
| JobVersion.definitionHash | false-map | ignore | prov:value | 2/3 |
| JobVersion.artifactRef | false-map | ignore | prov:value | 1/3 |
| JobVersion.configRef | false-map | ignore | prov:value | 1/3 |
| DEPENDS_ON | false-map | ignore | prov:wasInfluencedBy | 1/3 |
| WAS_DERIVED_FROM.runId | false-map | defer | prov:hadActivity | 1/3 |
| WAS_DERIVED_FROM.runId | ignore-vs-defer | defer | ignore | 2/3 |
| WAS_DERIVED_FROM.jobVersionId | ignore-vs-defer | defer | ignore | 2/3 |
| WAS_DERIVED_FROM.source | acceptable | ignore | rdfs:comment | 1/3 |
| WAS_DERIVED_FROM.evidenceRef | ignore-vs-defer | ignore | defer | 1/3 |
| WAS_DERIVED_FROM.transformationType | acceptable | ignore | rdfs:label | 1/3 |
| WAS_DERIVED_FROM.transformationSubtype | acceptable | ignore | rdfs:comment | 1/3 |
| WAS_DERIVED_FROM.expression | acceptable | ignore | rdfs:comment | 3/3 |
| WAS_DERIVED_FROM.assertedAt | ignore-vs-defer | ignore | defer | 1/3 |
| COLUMN_DERIVED_FROM.runId | false-map | defer | prov:hadActivity | 2/3 |
| COLUMN_DERIVED_FROM.runId | ignore-vs-defer | defer | ignore | 1/3 |
| COLUMN_DERIVED_FROM.jobVersionId | ignore-vs-defer | defer | ignore | 2/3 |
| COLUMN_DERIVED_FROM.source | acceptable | ignore | rdfs:comment | 1/3 |
| COLUMN_DERIVED_FROM.transformationType | acceptable | ignore | rdfs:label | 1/3 |
| COLUMN_DERIVED_FROM.transformationSubtype | acceptable | ignore | rdfs:comment | 1/3 |
| COLUMN_DERIVED_FROM.expression | acceptable | ignore | rdfs:comment | 3/3 |
| HAS_COLUMN | false-map | ignore | prov:hadMember | 2/3 |
| HAS_COLUMN_VERSION | false-map | ignore | prov:hadMember | 3/3 |
| RUN_OF | false-map | ignore | prov:wasInfluencedBy qualified prov:Influence | 1/3 |
| RUN_OF | false-map | ignore | prov:hadPlan | 1/3 |
| WAS_INFORMED_BY | related | prov:wasInformedBy | prov:wasInformedBy qualified prov:Communication | 3/3 |
| ACTED_ON_BEHALF_OF | related | prov:actedOnBehalfOf | prov:actedOnBehalfOf qualified prov:Delegation | 3/3 |
| WAS_INVALIDATED_BY | related | prov:wasInvalidatedBy qualified prov:Invalidation | prov:wasInvalidatedBy qualified prov:Invalidation | 1/3 |

Pass 1:
- invalid answers: nodes/n:2 ((element): a node kind mapped without a class (it implies no kind that gives one): give its classes)
- repaired: Agent [answer.invalid]
- check: warning target.kind-mismatch nodes/n:7/properties/p:26/predicate; warning target.domain relationships/r:16/qualified/link; warning target.range relationships/r:16/qualified/link; warning target.kind-mismatch relationships/r:3/properties/p:52/predicate; warning target.kind-mismatch relationships/r:4/properties/p:60/predicate; warning target.domain relationships/r:6/predicate; warning target.domain relationships/r:7/predicate
- wrong and caught by nothing: Dataset.system (false-map: prov:atLocation), Dataset.retiredAt (false-map: prov:invalidatedAtTime), DatasetVersion.publishedAt (ignore-vs-defer: defer), COLUMN_DERIVED_FROM.jobVersionId (ignore-vs-defer: ignore), WAS_INFORMED_BY (related: prov:wasInformedBy qualified prov:Communication), ACTED_ON_BEHALF_OF (related: prov:actedOnBehalfOf qualified prov:Delegation)
- wrong and caught: Job.namespace by target.kind-mismatch; WAS_DERIVED_FROM.runId by target.kind-mismatch; COLUMN_DERIVED_FROM.runId by target.kind-mismatch; HAS_COLUMN by target.domain; HAS_COLUMN_VERSION by target.domain; WAS_INVALIDATED_BY by target.domain, target.range
- oracle: all expressible checks pass

Pass 2:
- invalid answers: nodes/n:2 ((element): a node kind mapped without a class (it implies no kind that gives one): give its classes), relationships/r:14 ((element): map without predicate or qualified)
- repaired: Agent [answer.invalid], WAS_ATTRIBUTED_TO [answer.invalid]
- check: warning target.domain relationships/r:10/qualified/target; warning target.domain relationships/r:7/predicate
- wrong and caught by nothing: DatasetVersion.publishedAt (ignore-vs-defer: defer), Job.name (false-ignore: ignore), JobVersion.definitionHash (false-map: prov:value), WAS_DERIVED_FROM.runId (ignore-vs-defer: ignore), WAS_DERIVED_FROM.jobVersionId (ignore-vs-defer: ignore), COLUMN_DERIVED_FROM.runId (ignore-vs-defer: ignore), COLUMN_DERIVED_FROM.jobVersionId (ignore-vs-defer: ignore), WAS_INFORMED_BY (related: prov:wasInformedBy qualified prov:Communication), ACTED_ON_BEHALF_OF (related: prov:actedOnBehalfOf qualified prov:Delegation)
- wrong and caught: Dataset.name by q35-downstream-impact, q35-owners; HAS_COLUMN_VERSION by target.domain; RUN_OF by target.domain
- oracle: q35-downstream-impact fail, q35-owners fail

Pass 3:
- check: warning target.kind-mismatch nodes/n:7/properties/p:26/predicate; warning target.domain relationships/r:10/predicate; warning target.kind-mismatch relationships/r:4/properties/p:60/predicate; warning target.domain relationships/r:6/predicate; warning target.domain relationships/r:7/predicate
- wrong and caught by nothing: Dataset.system (false-map: prov:atLocation), Dataset.retiredAt (false-map: prov:invalidatedAtTime), DatasetVersion.publishedAt (ignore-vs-defer: defer), Job (different: prov:Plan), JobVersion.codeRef (false-map: prov:value), JobVersion.definitionHash (false-map: prov:value), JobVersion.artifactRef (false-map: prov:value), JobVersion.configRef (false-map: prov:value), WAS_DERIVED_FROM.runId (ignore-vs-defer: ignore), WAS_DERIVED_FROM.jobVersionId (ignore-vs-defer: ignore), WAS_DERIVED_FROM.evidenceRef (ignore-vs-defer: defer), WAS_DERIVED_FROM.assertedAt (ignore-vs-defer: defer), WAS_INFORMED_BY (related: prov:wasInformedBy qualified prov:Communication), ACTED_ON_BEHALF_OF (related: prov:actedOnBehalfOf qualified prov:Delegation)
- wrong and caught: Job.namespace by target.kind-mismatch; DEPENDS_ON by q34-potential-no-influence; COLUMN_DERIVED_FROM.runId by target.kind-mismatch; HAS_COLUMN by target.domain; HAS_COLUMN_VERSION by target.domain; RUN_OF by target.domain
- oracle: q34-potential-no-influence fail

## no-descriptions

Stability: 63/83 decisions identical in all 3 passes.

| confidence | decisions | agree |
|---|---|---|
| 0–0.5 | 0 | - |
| 0.5–0.8 | 41 | 46% |
| 0.8–0.95 | 129 | 75% |
| 0.95–1 | 79 | 89% |

| element | outcome | gold | proposed | passes |
|---|---|---|---|---|
| Dataset.retiredAt | false-map | ignore | prov:invalidatedAtTime | 3/3 |
| DatasetVersion.publishedAt | ignore-vs-defer | ignore | defer | 1/3 |
| Job | different | (none) | prov:Plan | 2/3 |
| JobVersion | different | prov:Plan | (none) | 1/3 |
| JobVersion.codeRef | false-map | ignore | prov:value | 1/3 |
| JobVersion.definitionHash | false-map | ignore | prov:value | 1/3 |
| JobVersion.artifactRef | false-map | ignore | prov:value | 1/3 |
| JobVersion.configRef | false-map | ignore | prov:value | 1/3 |
| Run.parameters | ignore-vs-defer | ignore | defer | 1/3 |
| Run.parametersRef | ignore-vs-defer | ignore | defer | 1/3 |
| WAS_GENERATED_BY | related | prov:wasGeneratedBy qualified prov:Generation | prov:wasGeneratedBy qualified prov:Generation | 1/3 |
| DEPENDS_ON | false-map | ignore | prov:wasDerivedFrom qualified prov:Derivation | 3/3 |
| WAS_DERIVED_FROM.runId | false-map | defer | prov:hadActivity | 2/3 |
| WAS_DERIVED_FROM.jobVersionId | false-map | defer | prov:hadPlan | 1/3 |
| WAS_DERIVED_FROM.jobVersionId | ignore-vs-defer | defer | ignore | 1/3 |
| WAS_DERIVED_FROM.source | acceptable | ignore | rdfs:comment | 3/3 |
| WAS_DERIVED_FROM.evidenceRef | acceptable | ignore | rdfs:comment | 2/3 |
| WAS_DERIVED_FROM.transformationType | acceptable | ignore | rdfs:label | 1/3 |
| WAS_DERIVED_FROM.transformationType | acceptable | ignore | rdfs:comment | 2/3 |
| WAS_DERIVED_FROM.transformationSubtype | acceptable | ignore | rdfs:comment | 3/3 |
| WAS_DERIVED_FROM.expression | acceptable | ignore | rdfs:comment | 2/3 |
| COLUMN_DERIVED_FROM.runId | false-map | defer | prov:hadActivity | 1/3 |
| COLUMN_DERIVED_FROM.jobVersionId | ignore-vs-defer | defer | ignore | 1/3 |
| COLUMN_DERIVED_FROM.source | acceptable | ignore | rdfs:comment | 1/3 |
| COLUMN_DERIVED_FROM.source | acceptable | ignore | rdfs:label | 1/3 |
| COLUMN_DERIVED_FROM.evidenceRef | acceptable | ignore | rdfs:comment | 1/3 |
| COLUMN_DERIVED_FROM.transformationType | acceptable | ignore | rdfs:label | 3/3 |
| COLUMN_DERIVED_FROM.transformationSubtype | acceptable | ignore | rdfs:comment | 3/3 |
| COLUMN_DERIVED_FROM.expression | acceptable | ignore | rdfs:comment | 3/3 |
| HAS_COLUMN | false-map | ignore | prov:hadMember | 3/3 |
| HAS_COLUMN_VERSION | false-map | ignore | prov:hadMember | 3/3 |
| RUN_OF | ignore-vs-defer | ignore | defer | 2/3 |
| RUN_OF | false-map | ignore | prov:wasInfluencedBy qualified prov:Influence | 1/3 |
| WAS_INFORMED_BY | related | prov:wasInformedBy | prov:wasInformedBy qualified prov:Communication | 3/3 |
| ACTED_ON_BEHALF_OF | related | prov:actedOnBehalfOf | prov:actedOnBehalfOf qualified prov:Delegation | 3/3 |

Pass 1:
- check: warning target.domain relationships/r:15/qualified/link; warning target.range relationships/r:15/qualified/link; warning target.domain relationships/r:15/qualified/target; warning target.domain relationships/r:6/predicate; warning target.domain relationships/r:7/predicate
- wrong and caught by nothing: Dataset.retiredAt (false-map: prov:invalidatedAtTime), Job (different: prov:Plan), Run.parameters (ignore-vs-defer: defer), Run.parametersRef (ignore-vs-defer: defer), COLUMN_DERIVED_FROM.runId (false-map: prov:hadActivity), RUN_OF (ignore-vs-defer: defer), WAS_INFORMED_BY (related: prov:wasInformedBy qualified prov:Communication)
- wrong and caught: DEPENDS_ON by q34-asserted-inputs, q34-potential-not-asserted, q34-potential-no-influence; HAS_COLUMN by target.domain; HAS_COLUMN_VERSION by target.domain; ACTED_ON_BEHALF_OF by target.domain, target.range, target.domain
- oracle: q33-upstream-asserted-sources fail, q34-asserted-inputs fail, q34-potential-not-asserted fail, q34-potential-no-influence fail

Pass 2:
- check: warning target.domain relationships/r:1/qualified/link; warning target.range relationships/r:1/qualified/link; warning target.domain relationships/r:10/qualified/target; warning target.domain relationships/r:2/qualified/link; warning target.range relationships/r:2/qualified/link; warning target.domain relationships/r:2/qualified/target; warning target.kind-mismatch relationships/r:3/properties/p:52/predicate; warning target.kind-mismatch relationships/r:3/properties/p:53/predicate; warning target.domain relationships/r:3/properties/p:53/predicate; warning target.domain relationships/r:6/predicate; warning target.domain relationships/r:7/predicate
- wrong and caught by nothing: Dataset.retiredAt (false-map: prov:invalidatedAtTime), DatasetVersion.publishedAt (ignore-vs-defer: defer), COLUMN_DERIVED_FROM.jobVersionId (ignore-vs-defer: ignore), WAS_INFORMED_BY (related: prov:wasInformedBy qualified prov:Communication), ACTED_ON_BEHALF_OF (related: prov:actedOnBehalfOf qualified prov:Delegation)
- wrong and caught: WAS_GENERATED_BY by target.domain, target.range; DEPENDS_ON by target.domain, target.range, target.domain, q34-asserted-inputs, q34-potential-not-asserted, q34-potential-no-influence; WAS_DERIVED_FROM.runId by target.kind-mismatch; WAS_DERIVED_FROM.jobVersionId by target.kind-mismatch, target.domain; HAS_COLUMN by target.domain; HAS_COLUMN_VERSION by target.domain; RUN_OF by target.domain
- oracle: q33-upstream-asserted-sources fail, q34-asserted-inputs fail, q34-potential-not-asserted fail, q34-potential-no-influence fail

Pass 3:
- check: warning target.kind-mismatch relationships/r:3/properties/p:52/predicate; warning target.domain relationships/r:6/predicate; warning target.domain relationships/r:7/predicate
- wrong and caught by nothing: Dataset.retiredAt (false-map: prov:invalidatedAtTime), Job (different: prov:Plan), JobVersion (different: (none)), JobVersion.codeRef (false-map: prov:value), JobVersion.definitionHash (false-map: prov:value), JobVersion.artifactRef (false-map: prov:value), JobVersion.configRef (false-map: prov:value), WAS_DERIVED_FROM.jobVersionId (ignore-vs-defer: ignore), RUN_OF (ignore-vs-defer: defer), WAS_INFORMED_BY (related: prov:wasInformedBy qualified prov:Communication), ACTED_ON_BEHALF_OF (related: prov:actedOnBehalfOf qualified prov:Delegation)
- wrong and caught: DEPENDS_ON by q34-asserted-inputs, q34-potential-not-asserted, q34-potential-no-influence; WAS_DERIVED_FROM.runId by target.kind-mismatch; HAS_COLUMN by target.domain; HAS_COLUMN_VERSION by target.domain
- oracle: q33-upstream-asserted-sources fail, q34-asserted-inputs fail, q34-potential-not-asserted fail, q34-potential-no-influence fail

