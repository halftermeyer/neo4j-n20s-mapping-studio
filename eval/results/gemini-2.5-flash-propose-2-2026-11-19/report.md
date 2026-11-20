# propose on lineage: gemini-2.5-flash, prompt propose/2

2026-11-19T22:37:30.722Z. Gold: examples/lineage/lineage-prov.aura.mapping.yaml.

| condition | pass | agree | agree or acceptable | related | different | false map | false ignore | ignore/defer | missing | DEPENDS_ON | check E/W | repaired | completed | dropped | oracle pass | tokens in/out | s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| full | 1 | 64/83 (77%) | 84% | 2 | 0 | 10 | 0 | 1 | 0 | ignore | 0/3 | 0 | 0 | 0 | 8/8 | 278878/29750 | 147 |
| full | 2 | 64/83 (77%) | 84% | 2 | 0 | 7 | 1 | 3 | 0 | ignore | 0/2 | 0 | 0 | 0 | 6/8 | 278858/33088 | 157 |
| full | 3 | 71/83 (86%) | 90% | 2 | 0 | 6 | 0 | 0 | 0 | map prov:wasInfluencedBy qualified prov:Influence | 0/3 | 1 | 0 | 0 | 8/8 | 289168/40903 | 193 |
| no-descriptions | 1 | 62/83 (75%) | 83% | 2 | 2 | 5 | 0 | 5 | 0 | map prov:wasDerivedFrom qualified prov:Derivation | 0/3 | 0 | 0 | 0 | 5/8 | 267343/39835 | 188 |
| no-descriptions | 2 | 66/83 (80%) | 80% | 3 | 1 | 9 | 0 | 4 | 0 | map prov:wasDerivedFrom qualified prov:Derivation | 0/8 | 0 | 0 | 0 | 4/8 | 267419/31528 | 149 |
| no-descriptions | 3 | 65/83 (78%) | 78% | 4 | 1 | 9 | 0 | 4 | 0 | map prov:wasDerivedFrom qualified prov:Derivation | 0/9 | 0 | 0 | 0 | 4/8 | 267419/32777 | 162 |
| gold-nodes | 1 | 27/38 (71%) | 82% | 2 | 0 | 5 | 0 | 0 | 0 | ignore | 0/7 | 0 | 0 | 0 | 8/8 | 158810/21058 | 104 |
| gold-nodes | 2 | 26/38 (68%) | 84% | 2 | 0 | 4 | 0 | 0 | 0 | ignore | 0/3 | 0 | 0 | 0 | 8/8 | 158792/25272 | 118 |
| gold-nodes | 3 | 28/38 (74%) | 79% | 2 | 0 | 6 | 0 | 0 | 0 | ignore | 0/8 | 0 | 0 | 0 | 8/8 | 158810/25593 | 117 |

Outcomes per decision: agree (same decision, same terms), acceptable (rdfs:label or rdfs:comment on a property the gold leaves out), related (sub/super term), different (other terms), false map (gold leaves it out, the proposal maps it), false ignore (gold maps it, the proposal leaves it out), ignore/defer (both leave it out, differently), missing (no answer). gold-nodes counts relationships only.

## full

Stability: 65/83 decisions identical in all 3 passes.

| confidence | decisions | agree |
|---|---|---|
| 0–0.5 | 0 | - |
| 0.5–0.8 | 19 | 32% |
| 0.8–0.95 | 131 | 76% |
| 0.95–1 | 99 | 94% |

| element | outcome | gold | proposed | passes |
|---|---|---|---|---|
| Dataset.name | false-ignore | rdfs:label | ignore | 1/3 |
| Dataset.retiredAt | false-map | ignore | prov:invalidatedAtTime | 3/3 |
| DatasetVersion.version | false-map | ignore | prov:value | 2/3 |
| DatasetVersion.publishedAt | ignore-vs-defer | ignore | defer | 1/3 |
| DatasetVersion.validFrom | ignore-vs-defer | ignore | defer | 1/3 |
| DatasetVersion.validTo | ignore-vs-defer | ignore | defer | 1/3 |
| JobVersion.codeRef | false-map | ignore | prov:value | 1/3 |
| JobVersion.codeRef | acceptable | ignore | rdfs:label | 1/3 |
| JobVersion.definitionHash | false-map | ignore | prov:value | 2/3 |
| JobVersion.definitionHash | acceptable | ignore | rdfs:label | 1/3 |
| JobVersion.artifactRef | false-map | ignore | prov:value | 1/3 |
| JobVersion.artifactRef | acceptable | ignore | rdfs:label | 1/3 |
| JobVersion.configRef | false-map | ignore | prov:value | 1/3 |
| JobVersion.configRef | acceptable | ignore | rdfs:label | 1/3 |
| DEPENDS_ON | false-map | ignore | prov:wasInfluencedBy qualified prov:Influence | 1/3 |
| WAS_DERIVED_FROM.source | acceptable | ignore | rdfs:comment | 2/3 |
| WAS_DERIVED_FROM.source | acceptable | ignore | rdfs:label | 1/3 |
| WAS_DERIVED_FROM.evidenceRef | acceptable | ignore | rdfs:comment | 1/3 |
| WAS_DERIVED_FROM.transformationType | acceptable | ignore | rdfs:label | 2/3 |
| WAS_DERIVED_FROM.transformationType | false-map | ignore | rdfs:label | 1/3 |
| WAS_DERIVED_FROM.transformationSubtype | acceptable | ignore | rdfs:comment | 2/3 |
| WAS_DERIVED_FROM.transformationSubtype | false-map | ignore | rdfs:comment | 1/3 |
| WAS_DERIVED_FROM.expression | acceptable | ignore | rdfs:comment | 3/3 |
| COLUMN_DERIVED_FROM.runId | false-map | defer | prov:hadActivity | 1/3 |
| COLUMN_DERIVED_FROM.jobVersionId | ignore-vs-defer | defer | ignore | 1/3 |
| COLUMN_DERIVED_FROM.expression | acceptable | ignore | rdfs:comment | 1/3 |
| HAS_COLUMN | false-map | ignore | prov:hadMember | 3/3 |
| HAS_COLUMN_VERSION | false-map | ignore | prov:hadMember | 3/3 |
| RUN_OF | false-map | ignore | prov:used qualified prov:Usage | 2/3 |
| RUN_OF | false-map | ignore | prov:wasInfluencedBy qualified prov:Influence | 1/3 |
| WAS_INFORMED_BY | related | prov:wasInformedBy | prov:wasInformedBy qualified prov:Communication | 3/3 |
| ACTED_ON_BEHALF_OF | related | prov:actedOnBehalfOf | prov:actedOnBehalfOf qualified prov:Delegation | 3/3 |

Pass 1:
- check: warning target.kind-mismatch relationships/r:4/properties/p:60/predicate; warning target.domain relationships/r:6/predicate; warning target.domain relationships/r:7/predicate
- oracle: all expressible checks pass

Pass 2:
- check: warning target.domain relationships/r:6/predicate; warning target.domain relationships/r:7/predicate
- oracle: q35-downstream-impact fail, q35-owners fail

Pass 3:
- invalid answers: relationships/r:3 ((element): map without predicate or qualified)
- repaired: WAS_DERIVED_FROM [answer.invalid]
- check: warning target.domain relationships/r:10/qualified/target; warning target.domain relationships/r:6/predicate; warning target.domain relationships/r:7/predicate
- oracle: all expressible checks pass

## no-descriptions

Stability: 65/83 decisions identical in all 3 passes.

| confidence | decisions | agree |
|---|---|---|
| 0–0.5 | 0 | - |
| 0.5–0.8 | 32 | 66% |
| 0.8–0.95 | 121 | 79% |
| 0.95–1 | 96 | 79% |

| element | outcome | gold | proposed | passes |
|---|---|---|---|---|
| Dataset.retiredAt | false-map | ignore | prov:invalidatedAtTime | 3/3 |
| DatasetVersion.publishedAt | ignore-vs-defer | ignore | defer | 3/3 |
| Job | different | (none) | prov:Plan | 3/3 |
| Run.parameters | ignore-vs-defer | ignore | defer | 2/3 |
| Run.parametersRef | ignore-vs-defer | ignore | defer | 2/3 |
| Person | different | prov:Person | (none) | 1/3 |
| WAS_GENERATED_BY | related | prov:wasGeneratedBy qualified prov:Generation | prov:wasGeneratedBy qualified prov:Generation | 1/3 |
| DEPENDS_ON | false-map | ignore | prov:wasDerivedFrom qualified prov:Derivation | 3/3 |
| WAS_DERIVED_FROM.runId | ignore-vs-defer | defer | ignore | 1/3 |
| WAS_DERIVED_FROM.runId | false-map | defer | prov:hadActivity | 2/3 |
| WAS_DERIVED_FROM.jobVersionId | ignore-vs-defer | defer | ignore | 1/3 |
| WAS_DERIVED_FROM.source | acceptable | ignore | rdfs:comment | 1/3 |
| WAS_DERIVED_FROM.evidenceRef | acceptable | ignore | rdfs:comment | 1/3 |
| WAS_DERIVED_FROM.transformationType | false-map | ignore | prov:hadRole | 2/3 |
| WAS_DERIVED_FROM.transformationSubtype | false-map | ignore | prov:hadRole | 2/3 |
| COLUMN_DERIVED_FROM.runId | false-map | defer | prov:hadActivity | 3/3 |
| COLUMN_DERIVED_FROM.jobVersionId | false-map | defer | prov:hadPlan | 2/3 |
| COLUMN_DERIVED_FROM.source | acceptable | ignore | rdfs:comment | 1/3 |
| COLUMN_DERIVED_FROM.evidenceRef | acceptable | ignore | rdfs:comment | 1/3 |
| COLUMN_DERIVED_FROM.transformationType | acceptable | ignore | rdfs:comment | 1/3 |
| COLUMN_DERIVED_FROM.transformationSubtype | acceptable | ignore | rdfs:comment | 1/3 |
| COLUMN_DERIVED_FROM.expression | acceptable | ignore | rdfs:comment | 1/3 |
| COLUMN_DERIVED_FROM.assertedAt | ignore-vs-defer | ignore | defer | 1/3 |
| HAS_COLUMN | false-map | ignore | prov:hadMember | 3/3 |
| HAS_COLUMN_VERSION | false-map | ignore | prov:hadMember | 3/3 |
| RUN_OF | ignore-vs-defer | ignore | defer | 3/3 |
| WAS_INFORMED_BY | related | prov:wasInformedBy | prov:wasInformedBy qualified prov:Communication | 3/3 |
| WAS_ATTRIBUTED_TO.role | related | prov:hadRole (values) | prov:hadRole (literal) | 2/3 |
| ACTED_ON_BEHALF_OF | related | prov:actedOnBehalfOf | prov:actedOnBehalfOf qualified prov:Delegation | 3/3 |

Pass 1:
- check: warning target.kind-mismatch relationships/r:4/properties/p:60/predicate; warning target.domain relationships/r:6/predicate; warning target.domain relationships/r:7/predicate
- oracle: q33-upstream-asserted-sources fail, q34-asserted-inputs fail, q34-potential-not-asserted fail

Pass 2:
- check: warning target.kind-mismatch relationships/r:14/properties/p:69/predicate; warning target.kind-mismatch relationships/r:2/properties/p:50/predicate; warning target.kind-mismatch relationships/r:3/properties/p:52/predicate; warning target.kind-mismatch relationships/r:4/properties/p:60/predicate; warning target.kind-mismatch relationships/r:4/properties/p:61/predicate; warning target.domain relationships/r:4/properties/p:61/predicate; warning target.domain relationships/r:6/predicate; warning target.domain relationships/r:7/predicate
- oracle: q33-upstream-asserted-sources fail, q34-asserted-inputs fail, q34-potential-not-asserted fail, q35-owners error (No value table at relationships/r:14/properties/p:69.)

Pass 3:
- check: warning target.domain relationships/r:1/qualified/target; warning target.range relationships/r:1/qualified/target; warning target.kind-mismatch relationships/r:14/properties/p:69/predicate; warning target.kind-mismatch relationships/r:3/properties/p:52/predicate; warning target.kind-mismatch relationships/r:4/properties/p:60/predicate; warning target.kind-mismatch relationships/r:4/properties/p:61/predicate; warning target.domain relationships/r:4/properties/p:61/predicate; warning target.domain relationships/r:6/predicate; warning target.domain relationships/r:7/predicate
- oracle: q33-upstream-asserted-sources fail, q34-asserted-inputs fail, q34-potential-not-asserted fail, q35-owners error (No value table at relationships/r:14/properties/p:69.)

## gold-nodes

Stability: 74/83 decisions identical in all 3 passes.

| confidence | decisions | agree |
|---|---|---|
| 0–0.5 | 0 | - |
| 0.5–0.8 | 9 | 0% |
| 0.8–0.95 | 63 | 71% |
| 0.95–1 | 42 | 86% |

| element | outcome | gold | proposed | passes |
|---|---|---|---|---|
| WAS_DERIVED_FROM.source | false-map | ignore | prov:wasAttributedTo | 2/3 |
| WAS_DERIVED_FROM.source | acceptable | ignore | rdfs:comment | 1/3 |
| WAS_DERIVED_FROM.evidenceRef | acceptable | ignore | rdfs:comment | 1/3 |
| WAS_DERIVED_FROM.transformationType | acceptable | ignore | rdfs:comment | 1/3 |
| WAS_DERIVED_FROM.transformationSubtype | acceptable | ignore | rdfs:comment | 1/3 |
| WAS_DERIVED_FROM.expression | acceptable | ignore | rdfs:comment | 3/3 |
| WAS_DERIVED_FROM.assertedAt | false-map | ignore | prov:generatedAtTime | 2/3 |
| COLUMN_DERIVED_FROM.runId | false-map | defer | prov:hadActivity | 2/3 |
| COLUMN_DERIVED_FROM.transformationType | acceptable | ignore | rdfs:comment | 1/3 |
| COLUMN_DERIVED_FROM.transformationSubtype | acceptable | ignore | rdfs:comment | 1/3 |
| COLUMN_DERIVED_FROM.expression | acceptable | ignore | rdfs:comment | 3/3 |
| HAS_COLUMN | false-map | ignore | prov:hadMember | 3/3 |
| HAS_COLUMN_VERSION | false-map | ignore | prov:hadMember | 3/3 |
| RUN_OF | false-map | ignore | prov:wasInfluencedBy qualified prov:Influence | 2/3 |
| RUN_OF | false-map | ignore | prov:used qualified prov:Usage | 1/3 |
| WAS_INFORMED_BY | related | prov:wasInformedBy | prov:wasInformedBy qualified prov:Communication | 3/3 |
| ACTED_ON_BEHALF_OF | related | prov:actedOnBehalfOf | prov:actedOnBehalfOf qualified prov:Delegation | 3/3 |

Pass 1:
- check: warning target.domain relationships/r:10/qualified/target; warning target.domain relationships/r:12/qualified/link; warning target.range relationships/r:12/qualified/link; warning target.domain relationships/r:3/properties/p:54/predicate; warning target.domain relationships/r:3/properties/p:59/predicate; warning target.domain relationships/r:6/predicate; warning target.domain relationships/r:7/predicate
- oracle: all expressible checks pass

Pass 2:
- check: warning target.kind-mismatch relationships/r:4/properties/p:60/predicate; warning target.domain relationships/r:6/predicate; warning target.domain relationships/r:7/predicate
- oracle: all expressible checks pass

Pass 3:
- check: warning target.domain relationships/r:10/qualified/target; warning target.domain relationships/r:12/qualified/link; warning target.range relationships/r:12/qualified/link; warning target.domain relationships/r:3/properties/p:54/predicate; warning target.domain relationships/r:3/properties/p:59/predicate; warning target.kind-mismatch relationships/r:4/properties/p:60/predicate; warning target.domain relationships/r:6/predicate; warning target.domain relationships/r:7/predicate
- oracle: all expressible checks pass

