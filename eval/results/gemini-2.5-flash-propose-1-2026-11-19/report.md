# propose on lineage: gemini-2.5-flash, prompt propose/1

2026-11-19T22:10:32.484Z. Gold: examples/lineage/lineage-prov.aura.mapping.yaml.

| condition | pass | agree | related | different | false map | false ignore | ignore/defer | missing | DEPENDS_ON | check E/W | repaired | dropped | oracle pass | tokens in/out | s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| full | 1 | 53/83 (64%) | 2 | 6 | 15 | 0 | 6 | 1 | none | 0/5 | 0 | 0 | 5/8 | 278315/33426 | 174 |
| full | 2 | 59/83 (71%) | 3 | 0 | 12 | 0 | 5 | 4 | none | 0/5 | 0 | 0 | 8/8 | 278257/39170 | 208 |
| full | 3 | 50/83 (60%) | 1 | 5 | 21 | 0 | 5 | 1 | none | 0/5 | 0 | 0 | 4/8 | 278491/34740 | 178 |
| no-descriptions | 1 | 55/83 (66%) | 4 | 1 | 21 | 0 | 2 | 0 | map prov:wasDerivedFrom qualified prov:Derivation | 0/7 | 0 | 0 | 5/8 | 267464/34575 | 170 |
| no-descriptions | 2 | 51/83 (61%) | 3 | 5 | 15 | 0 | 2 | 7 | none | 0/6 | 0 | 0 | 5/8 | 265807/40600 | 199 |
| no-descriptions | 3 | 55/83 (66%) | 1 | 6 | 14 | 0 | 1 | 6 | map qualified prov:Derivation | 0/6 | 1 | 0 | 5/8 | 275172/36289 | 181 |
| gold-nodes | 1 | 18/38 (47%) | 3 | 3 | 4 | 0 | 0 | 10 | none | 0/5 | 0 | 0 | 1/8 | 157996/24435 | 117 |
| gold-nodes | 2 | 25/38 (66%) | 4 | 0 | 9 | 0 | 0 | 0 | ignore | 0/7 | 0 | 0 | 7/8 | 158593/21791 | 104 |
| gold-nodes | 3 | 28/38 (74%) | 3 | 0 | 6 | 0 | 0 | 1 | none | 0/2 | 0 | 0 | 8/8 | 158467/23187 | 112 |

Outcomes per decision: agree (same decision, same terms), related (sub/super term), different (other terms), false map (gold leaves it out, the proposal maps it), false ignore (gold maps it, the proposal leaves it out), ignore/defer (both leave it out, differently), missing (no answer). gold-nodes counts relationships only.

## full

Stability: 53/83 decisions identical in all 3 passes.

| confidence | decisions | agree |
|---|---|---|
| 0–0.5 | 0 | - |
| 0.5–0.8 | 16 | 25% |
| 0.8–0.95 | 139 | 62% |
| 0.95–1 | 88 | 82% |

| element | outcome | gold | proposed | passes |
|---|---|---|---|---|
| Dataset.retiredAt | false-map | ignore | prov:invalidatedAtTime | 3/3 |
| DatasetVersion.version | false-map | ignore | rdfs:label | 1/3 |
| DatasetVersion.version | false-map | ignore | prov:value | 2/3 |
| DatasetVersion.publishedAt | ignore-vs-defer | ignore | defer | 2/3 |
| DatasetVersion.validFrom | ignore-vs-defer | ignore | defer | 2/3 |
| DatasetVersion.validTo | ignore-vs-defer | ignore | defer | 2/3 |
| DatasetVersion.schemaHash | false-map | ignore | prov:value | 2/3 |
| Job | different | (none) | prov:Plan | 2/3 |
| Job | missing | map | none | 1/3 |
| Job.namespace | missing | ignore | none | 1/3 |
| Job.name | missing | map | none | 1/3 |
| JobVersion.codeRef | false-map | ignore | prov:value | 3/3 |
| JobVersion.definitionHash | false-map | ignore | prov:value | 3/3 |
| JobVersion.artifactRef | false-map | ignore | prov:value | 3/3 |
| JobVersion.configRef | false-map | ignore | prov:value | 3/3 |
| Run.parameters | ignore-vs-defer | ignore | defer | 2/3 |
| Run.parametersRef | ignore-vs-defer | ignore | defer | 1/3 |
| USED | different | prov:used qualified prov:Usage | qualified prov:Usage | 2/3 |
| WAS_GENERATED_BY | different | prov:wasGeneratedBy qualified prov:Generation | qualified prov:Generation | 1/3 |
| WAS_GENERATED_BY | related | prov:wasGeneratedBy qualified prov:Generation | prov:wasGeneratedBy qualified prov:Generation | 1/3 |
| WAS_GENERATED_BY.role | related | prov:hadRole (values) | prov:hadRole (literal) | 1/3 |
| DEPENDS_ON | missing | ignore | none | 3/3 |
| WAS_DERIVED_FROM.runId | ignore-vs-defer | defer | ignore | 2/3 |
| WAS_DERIVED_FROM.runId | false-map | defer | prov:hadActivity | 1/3 |
| WAS_DERIVED_FROM.jobVersionId | ignore-vs-defer | defer | ignore | 2/3 |
| WAS_DERIVED_FROM.source | false-map | ignore | rdfs:comment | 1/3 |
| WAS_DERIVED_FROM.evidenceRef | false-map | ignore | rdfs:comment | 1/3 |
| WAS_DERIVED_FROM.transformationType | false-map | ignore | rdfs:label | 1/3 |
| WAS_DERIVED_FROM.transformationType | false-map | ignore | rdfs:comment | 1/3 |
| WAS_DERIVED_FROM.transformationSubtype | false-map | ignore | rdfs:comment | 2/3 |
| WAS_DERIVED_FROM.expression | false-map | ignore | rdfs:comment | 3/3 |
| COLUMN_DERIVED_FROM.runId | false-map | defer | prov:hadActivity | 3/3 |
| COLUMN_DERIVED_FROM.jobVersionId | ignore-vs-defer | defer | ignore | 2/3 |
| COLUMN_DERIVED_FROM.source | false-map | ignore | rdfs:comment | 1/3 |
| COLUMN_DERIVED_FROM.transformationType | false-map | ignore | prov:hadRole | 1/3 |
| COLUMN_DERIVED_FROM.transformationType | false-map | ignore | rdfs:comment | 1/3 |
| COLUMN_DERIVED_FROM.transformationSubtype | false-map | ignore | prov:hadRole | 1/3 |
| COLUMN_DERIVED_FROM.transformationSubtype | false-map | ignore | rdfs:comment | 1/3 |
| COLUMN_DERIVED_FROM.expression | false-map | ignore | rdfs:comment | 3/3 |
| HAS_COLUMN | false-map | ignore | prov:hadMember | 3/3 |
| HAS_COLUMN_VERSION | false-map | ignore | prov:hadMember | 3/3 |
| VERSION_OF_COLUMN | different | prov:specializationOf | prov:specializationOf (reverse) | 1/3 |
| RUN_OF | ignore-vs-defer | ignore | defer | 1/3 |
| RUN_OF | false-map | ignore | qualified prov:Association | 1/3 |
| WAS_INFORMED_BY | related | prov:wasInformedBy | prov:wasInformedBy qualified prov:Communication | 2/3 |
| WAS_ASSOCIATED_WITH | different | prov:wasAssociatedWith qualified prov:Association | qualified prov:Association | 2/3 |
| WAS_ATTRIBUTED_TO | different | prov:wasAttributedTo qualified prov:Attribution | prov:qualifiedAttribution qualified prov:Attribution | 1/3 |
| ACTED_ON_BEHALF_OF | related | prov:actedOnBehalfOf | prov:actedOnBehalfOf qualified prov:Delegation | 1/3 |
| ACTED_ON_BEHALF_OF | different | prov:actedOnBehalfOf | qualified prov:Delegation | 1/3 |
| WAS_INVALIDATED_BY | different | prov:wasInvalidatedBy qualified prov:Invalidation | qualified prov:Invalidation | 1/3 |
| WAS_INVALIDATED_BY | related | prov:wasInvalidatedBy qualified prov:Invalidation | prov:wasInvalidatedBy qualified prov:Invalidation | 1/3 |

Pass 1:
- invalid answers: relationships/r:2 ((element): ignore without a reason; p:50: ignore without a reason; p:51: ignore without a reason)
- check: warning target.kind-mismatch relationships/r:1/properties/p:49/predicate; warning target.range relationships/r:14/predicate; warning target.kind-mismatch relationships/r:4/properties/p:60/predicate; warning target.domain relationships/r:6/predicate; warning target.domain relationships/r:7/predicate
- oracle: q32-upstream-runs-and-agents fail, q35-downstream-impact fail, q35-owners fail

Pass 2:
- invalid answers: nodes/n:7 (p:26: ignore without a reason), relationships/r:2 ((element): ignore without a reason; p:50: ignore without a reason; p:51: ignore without a reason)
- check: warning target.domain relationships/r:16/qualified/link; warning target.range relationships/r:16/qualified/link; warning target.kind-mismatch relationships/r:4/properties/p:60/predicate; warning target.domain relationships/r:6/predicate; warning target.domain relationships/r:7/predicate
- oracle: all expressible checks pass

Pass 3:
- invalid answers: relationships/r:2 ((element): ignore without a reason; p:50: ignore without a reason; p:51: ignore without a reason)
- check: warning target.domain relationships/r:1/qualified/link; warning target.range relationships/r:1/qualified/link; warning target.kind-mismatch relationships/r:4/properties/p:60/predicate; warning target.domain relationships/r:6/predicate; warning target.domain relationships/r:7/predicate
- oracle: q32-upstream-runs-and-agents fail, q35-downstream-impact fail, q35-owners fail, q38-column-versions-and-sources fail

## no-descriptions

Stability: 52/83 decisions identical in all 3 passes.

| confidence | decisions | agree |
|---|---|---|
| 0–0.5 | 0 | - |
| 0.5–0.8 | 32 | 50% |
| 0.8–0.95 | 128 | 68% |
| 0.95–1 | 76 | 76% |

| element | outcome | gold | proposed | passes |
|---|---|---|---|---|
| Agent | different | prov:Agent | (none) | 2/3 |
| Dataset | missing | map | none | 2/3 |
| Dataset.namespace | missing | ignore | none | 2/3 |
| Dataset.name | missing | map | none | 2/3 |
| Dataset.system | missing | ignore | none | 2/3 |
| Dataset.kind | missing | ignore | none | 2/3 |
| Dataset.retiredAt | false-map | ignore | prov:invalidatedAtTime | 1/3 |
| Dataset.retiredAt | missing | ignore | none | 2/3 |
| DatasetVersion.version | false-map | ignore | rdfs:label | 3/3 |
| DatasetVersion.publishedAt | ignore-vs-defer | ignore | defer | 3/3 |
| Column | different | (none) | prov:Location | 2/3 |
| Job | different | (none) | prov:Plan | 2/3 |
| JobVersion | different | prov:Plan | (none) | 1/3 |
| JobVersion.codeRef | false-map | ignore | rdfs:label | 1/3 |
| JobVersion.definitionHash | false-map | ignore | prov:value | 1/3 |
| JobVersion.artifactRef | false-map | ignore | rdfs:comment | 1/3 |
| JobVersion.configRef | false-map | ignore | rdfs:comment | 1/3 |
| Run.parameters | false-map | ignore | rdfs:comment | 1/3 |
| Run.parametersRef | false-map | ignore | rdfs:comment | 1/3 |
| USED | related | prov:used qualified prov:Usage | prov:used qualified prov:Usage | 1/3 |
| USED | different | prov:used qualified prov:Usage | qualified prov:Usage | 1/3 |
| USED | different | prov:used qualified prov:Usage | prov:qualifiedUsage qualified prov:Usage | 1/3 |
| WAS_GENERATED_BY.role | related | prov:hadRole (values) | prov:hadRole (literal) | 2/3 |
| DEPENDS_ON | false-map | ignore | prov:wasDerivedFrom qualified prov:Derivation | 1/3 |
| DEPENDS_ON | missing | ignore | none | 1/3 |
| DEPENDS_ON | false-map | ignore | qualified prov:Derivation | 1/3 |
| WAS_DERIVED_FROM.runId | false-map | defer | prov:hadActivity | 3/3 |
| WAS_DERIVED_FROM.source | false-map | ignore | rdfs:comment | 1/3 |
| WAS_DERIVED_FROM.evidenceRef | false-map | ignore | rdfs:comment | 2/3 |
| WAS_DERIVED_FROM.transformationType | false-map | ignore | rdfs:label | 3/3 |
| WAS_DERIVED_FROM.transformationSubtype | false-map | ignore | rdfs:comment | 3/3 |
| WAS_DERIVED_FROM.expression | false-map | ignore | rdfs:comment | 3/3 |
| COLUMN_DERIVED_FROM.runId | false-map | defer | prov:hadActivity | 1/3 |
| COLUMN_DERIVED_FROM.jobVersionId | ignore-vs-defer | defer | ignore | 1/3 |
| COLUMN_DERIVED_FROM.source | false-map | ignore | rdfs:comment | 3/3 |
| COLUMN_DERIVED_FROM.evidenceRef | false-map | ignore | rdfs:comment | 1/3 |
| COLUMN_DERIVED_FROM.transformationType | false-map | ignore | rdfs:label | 2/3 |
| COLUMN_DERIVED_FROM.transformationType | false-map | ignore | rdfs:comment | 1/3 |
| COLUMN_DERIVED_FROM.transformationSubtype | false-map | ignore | rdfs:comment | 3/3 |
| COLUMN_DERIVED_FROM.expression | false-map | ignore | prov:value | 1/3 |
| COLUMN_DERIVED_FROM.expression | false-map | ignore | rdfs:comment | 2/3 |
| HAS_COLUMN | false-map | ignore | prov:hadMember | 2/3 |
| HAS_COLUMN | false-map | ignore | prov:atLocation | 1/3 |
| HAS_COLUMN_VERSION | false-map | ignore | prov:hadMember | 3/3 |
| RUN_OF | ignore-vs-defer | ignore | defer | 1/3 |
| RUN_OF | false-map | ignore | prov:qualifiedAssociation qualified prov:Association | 1/3 |
| RUN_OF | false-map | ignore | qualified prov:Association | 1/3 |
| HAD_PLAN | false-map | defer | qualified prov:Association | 1/3 |
| WAS_INFORMED_BY | related | prov:wasInformedBy | prov:wasInformedBy qualified prov:Communication | 3/3 |
| WAS_ASSOCIATED_WITH | different | prov:wasAssociatedWith qualified prov:Association | prov:qualifiedAssociation qualified prov:Association | 1/3 |
| WAS_ASSOCIATED_WITH | different | prov:wasAssociatedWith qualified prov:Association | qualified prov:Association | 1/3 |
| ACTED_ON_BEHALF_OF | related | prov:actedOnBehalfOf | prov:actedOnBehalfOf qualified prov:Delegation | 2/3 |
| ACTED_ON_BEHALF_OF | different | prov:actedOnBehalfOf | qualified prov:Delegation | 1/3 |

Pass 1:
- check: warning target.domain relationships/r:0/qualified/link; warning target.range relationships/r:0/qualified/link; warning target.kind-mismatch relationships/r:1/properties/p:49/predicate; warning target.kind-mismatch relationships/r:3/properties/p:52/predicate; warning target.domain relationships/r:4/properties/p:66/predicate; warning target.domain relationships/r:6/predicate; warning target.domain relationships/r:7/predicate
- oracle: q33-upstream-asserted-sources fail, q34-asserted-inputs fail, q34-potential-not-asserted fail

Pass 2:
- invalid answers: nodes/n:3 (p:5: ignore without a reason; p:7: ignore without a reason; p:8: ignore without a reason), relationships/r:2 (p:50: defer without a reason; p:51: defer without a reason)
- check: warning target.kind-mismatch relationships/r:1/properties/p:49/predicate; warning target.range relationships/r:10/predicate; warning target.kind-mismatch relationships/r:3/properties/p:52/predicate; warning target.kind-mismatch relationships/r:4/properties/p:60/predicate; warning target.domain relationships/r:6/predicate; warning target.domain relationships/r:7/predicate
- oracle: q32-upstream-runs-and-agents fail, q35-downstream-impact fail, q35-owners fail

Pass 3:
- invalid answers: nodes/n:3 (p:5: ignore without a reason; p:7: ignore without a reason; p:8: ignore without a reason)
- repaired: USED [rel.property-without-qualified]
- check: warning target.range relationships/r:0/predicate; warning target.domain relationships/r:0/qualified/link; warning target.range relationships/r:0/qualified/link; warning target.domain relationships/r:2/properties/p:51/predicate; warning target.kind-mismatch relationships/r:3/properties/p:52/predicate; warning target.domain relationships/r:7/predicate
- oracle: q32-upstream-runs-and-agents fail, q35-downstream-impact fail, q35-owners fail

## gold-nodes

Stability: 61/83 decisions identical in all 3 passes.

| confidence | decisions | agree |
|---|---|---|
| 0–0.5 | 0 | - |
| 0.5–0.8 | 9 | 22% |
| 0.8–0.95 | 55 | 76% |
| 0.95–1 | 39 | 69% |

| element | outcome | gold | proposed | passes |
|---|---|---|---|---|
| WAS_GENERATED_BY | different | prov:wasGeneratedBy qualified prov:Generation | qualified prov:Generation | 1/3 |
| WAS_GENERATED_BY.role | related | prov:hadRole (values) | prov:hadRole (literal) | 3/3 |
| DEPENDS_ON | missing | ignore | none | 2/3 |
| WAS_DERIVED_FROM | missing | map | none | 1/3 |
| WAS_DERIVED_FROM.runId | missing | defer | none | 1/3 |
| WAS_DERIVED_FROM.runId | false-map | defer | prov:hadActivity | 1/3 |
| WAS_DERIVED_FROM.jobVersionId | missing | defer | none | 1/3 |
| WAS_DERIVED_FROM.source | missing | ignore | none | 1/3 |
| WAS_DERIVED_FROM.evidenceRef | missing | ignore | none | 1/3 |
| WAS_DERIVED_FROM.transformationType | missing | ignore | none | 1/3 |
| WAS_DERIVED_FROM.transformationSubtype | missing | ignore | none | 1/3 |
| WAS_DERIVED_FROM.expression | missing | ignore | none | 1/3 |
| WAS_DERIVED_FROM.expression | false-map | ignore | rdfs:comment | 2/3 |
| WAS_DERIVED_FROM.assertedAt | missing | ignore | none | 1/3 |
| COLUMN_DERIVED_FROM | different | prov:wasDerivedFrom qualified prov:Derivation | qualified prov:Derivation | 1/3 |
| COLUMN_DERIVED_FROM.runId | false-map | defer | prov:hadActivity | 1/3 |
| COLUMN_DERIVED_FROM.source | false-map | ignore | rdfs:comment | 1/3 |
| COLUMN_DERIVED_FROM.evidenceRef | false-map | ignore | rdfs:comment | 1/3 |
| COLUMN_DERIVED_FROM.transformationType | false-map | ignore | rdfs:comment | 1/3 |
| COLUMN_DERIVED_FROM.transformationSubtype | false-map | ignore | rdfs:comment | 1/3 |
| COLUMN_DERIVED_FROM.expression | false-map | ignore | rdfs:comment | 3/3 |
| HAS_COLUMN | false-map | ignore | prov:hadMember | 2/3 |
| HAS_COLUMN_VERSION | false-map | ignore | prov:hadMember | 3/3 |
| RUN_OF | false-map | ignore | prov:used | 1/3 |
| RUN_OF | false-map | ignore | prov:wasInfluencedBy | 1/3 |
| RUN_OF | false-map | ignore | prov:used qualified prov:Usage | 1/3 |
| WAS_INFORMED_BY | different | prov:wasInformedBy | qualified prov:Communication | 1/3 |
| WAS_INFORMED_BY | related | prov:wasInformedBy | prov:wasInformedBy qualified prov:Communication | 2/3 |
| WAS_ASSOCIATED_WITH | related | prov:wasAssociatedWith qualified prov:Association | prov:wasAssociatedWith qualified prov:Association | 1/3 |
| WAS_ATTRIBUTED_TO | related | prov:wasAttributedTo qualified prov:Attribution | prov:wasAttributedTo qualified prov:Attribution | 1/3 |
| ACTED_ON_BEHALF_OF | related | prov:actedOnBehalfOf | prov:actedOnBehalfOf qualified prov:Delegation | 3/3 |

Pass 1:
- invalid answers: relationships/r:2 ((element): ignore without a reason; p:50: ignore without a reason; p:51: ignore without a reason), relationships/r:3 (p:52: defer without a reason; p:53: defer without a reason)
- check: warning target.kind-mismatch relationships/r:1/properties/p:49/predicate; warning target.domain relationships/r:13/qualified/link; warning target.range relationships/r:13/qualified/link; warning target.domain relationships/r:6/predicate; warning target.domain relationships/r:7/predicate
- oracle: q32-upstream-runs-and-agents fail, q33-upstream-asserted-sources fail, q34-asserted-inputs fail, q35-downstream-impact fail, q35-owners fail, q37-column-sources fail, q38-column-versions-and-sources fail

Pass 2:
- check: warning target.kind-mismatch relationships/r:1/properties/p:49/predicate; warning target.domain relationships/r:14/qualified/link; warning target.range relationships/r:14/qualified/link; warning target.kind-mismatch relationships/r:3/properties/p:52/predicate; warning target.kind-mismatch relationships/r:4/properties/p:60/predicate; warning target.domain relationships/r:6/predicate; warning target.domain relationships/r:7/predicate
- oracle: q35-owners fail

Pass 3:
- invalid answers: relationships/r:2 ((element): ignore without a reason; p:50: ignore without a reason; p:51: ignore without a reason)
- check: warning target.kind-mismatch relationships/r:1/properties/p:49/predicate; warning target.domain relationships/r:7/predicate
- oracle: all expressible checks pass

