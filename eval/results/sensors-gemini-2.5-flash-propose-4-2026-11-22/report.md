# propose on Plant telemetry to SOSA: gemini-2.5-flash, prompt propose/4

**Commit 0ce718eeedb0**

2026-11-22T15:08:12.010Z.

| fingerprint | file | SHA-256 |
|---|---|---|
| lpg | aura-export.json | `f1cce5c8bf892693ad3aafca13f4b06c019c07f4f44254a54aa9ce43beaad661` |
| gold | sensors-sosa.gold.yaml | `2487b8f56d15344322b8de728d4864fa0637e7a5276a84fb647a416e456efbd4` |
| alternatives | alternatives.yaml | `e78f6826af4ebfbf53882a574fdf509422cdb1f9d856c51fa1052fe8decd0d3a` |
| oracle | oracle.yaml | `5cca42b9c1bcb6ccf31dc364e79a1f9816ee96542cf26b680c32fd4259ea2dfd` |
| seed | seed.cypher | `9daf98095a6d096ae615a9cd0a256cfeef67b927d44432499a29c6bc558a177a` |
| target | targets/sosa.ttl | `c70b0d1c843c0047e4c98e0a89392e46a05752ff6365bda7f7f55303905a0392` |
| src | src/ (33 files) | `f749d5e8682521d69960efe9e66631022d86164a06a9f88fb608b88c251150aa` |

Commit `0ce718eeedb077881cf3998fa0ef3c3c6d69dc4d` on eval/campaign-1, clean. Prompt propose/4, model gemini-2.5-flash.

| condition | pass | agree | agree, alternative or acceptable | alternative | related | different | false map | false ignore | ignore/defer | missing | check E/W | repaired | completed | dropped | oracle pass | tokens in/out | s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| full | 1 | 28/34 (82%) | 82% | 0 | 0 | 1 | 2 | 1 | 2 | 0 | 0/1 | 2 | 0 | 0 | 9/11 | 69550/24302 | 119 |
| full | 2 | 27/34 (79%) | 79% | 0 | 0 | 1 | 4 | 2 | 0 | 0 | 0/1 | 0 | 0 | 0 | 8/11 | 63110/17246 | 87 |
| full | 3 | 23/34 (68%) | 76% | 0 | 0 | 2 | 3 | 3 | 0 | 0 | 0/4 | 3 | 0 | 0 | 7/11 | 72680/22408 | 113 |
| no-descriptions | 1 | 26/34 (76%) | 85% | 1 | 0 | 1 | 0 | 2 | 2 | 0 | 0/0 | 2 | 0 | 0 | 8/11 | 68370/20587 | 106 |
| no-descriptions | 2 | 30/34 (88%) | 91% | 0 | 0 | 1 | 0 | 2 | 0 | 0 | 0/0 | 1 | 0 | 0 | 8/11 | 65379/16406 | 91 |
| no-descriptions | 3 | 29/34 (85%) | 91% | 1 | 0 | 1 | 0 | 2 | 0 | 0 | 0/0 | 1 | 0 | 0 | 8/11 | 65379/16504 | 86 |
| open-terms | 1 | 28/34 (82%) | 82% | 0 | 0 | 1 | 4 | 1 | 0 | 0 | 0/2 | 0 | 0 | 0 | 10/11 | 63158/18311 | 96 |
| open-terms | 2 | 25/34 (74%) | 74% | 0 | 0 | 1 | 4 | 2 | 2 | 0 | 0/1 | 0 | 0 | 0 | 9/11 | 63110/18266 | 98 |
| open-terms | 3 | 24/34 (71%) | 71% | 0 | 0 | 1 | 4 | 2 | 3 | 0 | 0/1 | 0 | 0 | 0 | 9/11 | 63110/17909 | 95 |

### Safety net

Wrong decisions (neither gold nor alternative), and what caught them; Accept safe after an oracle run on the proposals: how many elements it would accept, how many of them hold a wrong decision.

| condition | pass | wrong | caught by check only | by oracle only | by both | by neither | Accept safe: elements (entries) | of which wrong | precision |
|---|---|---|---|---|---|---|---|---|---|
| full | 1 | 6 | 0 | 1 | 0 | 5 | 4 (4) | 0 | 100% |
| full | 2 | 7 | 1 | 2 | 0 | 4 | 3 (3) | 0 | 100% |
| full | 3 | 8 | 1 | 5 | 0 | 2 | 3 (3) | 0 | 100% |
| no-descriptions | 1 | 5 | 0 | 2 | 0 | 3 | 5 (5) | 0 | 100% |
| no-descriptions | 2 | 3 | 0 | 2 | 0 | 1 | 4 (4) | 0 | 100% |
| no-descriptions | 3 | 3 | 0 | 2 | 0 | 1 | 4 (4) | 0 | 100% |
| open-terms | 1 | 6 | 1 | 1 | 0 | 4 | 5 (5) | 0 | 100% |
| open-terms | 2 | 9 | 1 | 2 | 0 | 6 | 4 (4) | 0 | 100% |
| open-terms | 3 | 10 | 1 | 2 | 0 | 7 | 4 (4) | 0 | 100% |

### Traps

| condition | pass | trap | expected | proposed | outcome | check |
|---|---|---|---|---|---|---|
| full | 1 | ROLLUP_OF | left out or deferred; any SOSA link from a rollup to its ticks fails s10 | ignore | agree | - |
| full | 1 | Metric.unit | left out; an invented term gets target.unknown-term; sosa:hasSimpleResult fails s4 | ignore | agree | - |
| full | 1 | Tick.measuredAt | sosa:resultTime; sosa:phenomenonTime gets target.kind-mismatch and fails s5, s6 | map | agree | - |
| full | 1 | Threshold | left out; as an observation with a result it fails s4 | ignore | agree | - |
| full | 1 | ABOUT (Rollup) | sosa:observedProperty, covered by s11 only | map | agree | - |
| full | 2 | ROLLUP_OF | left out or deferred; any SOSA link from a rollup to its ticks fails s10 | ignore | agree | - |
| full | 2 | Metric.unit | left out; an invented term gets target.unknown-term; sosa:hasSimpleResult fails s4 | ignore | agree | - |
| full | 2 | Tick.measuredAt | sosa:resultTime; sosa:phenomenonTime gets target.kind-mismatch and fails s5, s6 | map | agree | - |
| full | 2 | Threshold | left out; as an observation with a result it fails s4 | ignore | agree | - |
| full | 2 | ABOUT (Rollup) | sosa:observedProperty, covered by s11 only | map | agree | - |
| full | 3 | ROLLUP_OF | left out or deferred; any SOSA link from a rollup to its ticks fails s10 | map sosa:isResultOf | false-map | - |
| full | 3 | Metric.unit | left out; an invented term gets target.unknown-term; sosa:hasSimpleResult fails s4 | ignore | agree | - |
| full | 3 | Tick.measuredAt | sosa:resultTime; sosa:phenomenonTime gets target.kind-mismatch and fails s5, s6 | map | agree | - |
| full | 3 | Threshold | left out; as an observation with a result it fails s4 | ignore | agree | - |
| full | 3 | ABOUT (Rollup) | sosa:observedProperty, covered by s11 only | defer | false-ignore | - |
| no-descriptions | 1 | ROLLUP_OF | left out or deferred; any SOSA link from a rollup to its ticks fails s10 | defer | alternative | - |
| no-descriptions | 1 | Metric.unit | left out; an invented term gets target.unknown-term; sosa:hasSimpleResult fails s4 | ignore | agree | - |
| no-descriptions | 1 | Tick.measuredAt | sosa:resultTime; sosa:phenomenonTime gets target.kind-mismatch and fails s5, s6 | map | agree | - |
| no-descriptions | 1 | Threshold | left out; as an observation with a result it fails s4 | defer | ignore-vs-defer | - |
| no-descriptions | 1 | ABOUT (Rollup) | sosa:observedProperty, covered by s11 only | map | agree | - |
| no-descriptions | 2 | ROLLUP_OF | left out or deferred; any SOSA link from a rollup to its ticks fails s10 | ignore | agree | - |
| no-descriptions | 2 | Metric.unit | left out; an invented term gets target.unknown-term; sosa:hasSimpleResult fails s4 | ignore | agree | - |
| no-descriptions | 2 | Tick.measuredAt | sosa:resultTime; sosa:phenomenonTime gets target.kind-mismatch and fails s5, s6 | map | agree | - |
| no-descriptions | 2 | Threshold | left out; as an observation with a result it fails s4 | ignore | agree | - |
| no-descriptions | 2 | ABOUT (Rollup) | sosa:observedProperty, covered by s11 only | map | agree | - |
| no-descriptions | 3 | ROLLUP_OF | left out or deferred; any SOSA link from a rollup to its ticks fails s10 | defer | alternative | - |
| no-descriptions | 3 | Metric.unit | left out; an invented term gets target.unknown-term; sosa:hasSimpleResult fails s4 | ignore | agree | - |
| no-descriptions | 3 | Tick.measuredAt | sosa:resultTime; sosa:phenomenonTime gets target.kind-mismatch and fails s5, s6 | map | agree | - |
| no-descriptions | 3 | Threshold | left out; as an observation with a result it fails s4 | ignore | agree | - |
| no-descriptions | 3 | ABOUT (Rollup) | sosa:observedProperty, covered by s11 only | map | agree | - |
| open-terms | 1 | ROLLUP_OF | left out or deferred; any SOSA link from a rollup to its ticks fails s10 | ignore | agree | - |
| open-terms | 1 | Metric.unit | left out; an invented term gets target.unknown-term; sosa:hasSimpleResult fails s4 | ignore | agree | - |
| open-terms | 1 | Tick.measuredAt | sosa:resultTime; sosa:phenomenonTime gets target.kind-mismatch and fails s5, s6 | map | agree | - |
| open-terms | 1 | Threshold | left out; as an observation with a result it fails s4 | ignore | agree | - |
| open-terms | 1 | ABOUT (Rollup) | sosa:observedProperty, covered by s11 only | map | agree | - |
| open-terms | 2 | ROLLUP_OF | left out or deferred; any SOSA link from a rollup to its ticks fails s10 | ignore | agree | - |
| open-terms | 2 | Metric.unit | left out; an invented term gets target.unknown-term; sosa:hasSimpleResult fails s4 | ignore | agree | - |
| open-terms | 2 | Tick.measuredAt | sosa:resultTime; sosa:phenomenonTime gets target.kind-mismatch and fails s5, s6 | map | agree | - |
| open-terms | 2 | Threshold | left out; as an observation with a result it fails s4 | defer | ignore-vs-defer | - |
| open-terms | 2 | ABOUT (Rollup) | sosa:observedProperty, covered by s11 only | map | agree | - |
| open-terms | 3 | ROLLUP_OF | left out or deferred; any SOSA link from a rollup to its ticks fails s10 | ignore | agree | - |
| open-terms | 3 | Metric.unit | left out; an invented term gets target.unknown-term; sosa:hasSimpleResult fails s4 | ignore | agree | - |
| open-terms | 3 | Tick.measuredAt | sosa:resultTime; sosa:phenomenonTime gets target.kind-mismatch and fails s5, s6 | map | agree | - |
| open-terms | 3 | Threshold | left out; as an observation with a result it fails s4 | defer | ignore-vs-defer | - |
| open-terms | 3 | ABOUT (Rollup) | sosa:observedProperty, covered by s11 only | map | agree | - |

Outcomes per decision: agree (same decision, same terms), alternative (a decision the set lists as as good as the gold), acceptable (rdfs:label or rdfs:comment on a property the gold leaves out), related (sub/super term), different (other terms), false map (gold leaves it out, the proposal maps it), false ignore (gold maps it, the proposal leaves it out), ignore/defer (both leave it out, differently), missing (no answer). gold-nodes counts relationships only.

## full

Stability: 21/34 decisions identical in all 3 passes.

| confidence | decisions | agree |
|---|---|---|
| 0–0.5 | 0 | - |
| 0.5–0.8 | 6 | 50% |
| 0.8–0.95 | 54 | 65% |
| 0.95–1 | 42 | 95% |

| element | outcome | gold | proposed | passes |
|---|---|---|---|---|
| Rig | different | sosa:Platform, sosa:FeatureOfInterest | sosa:Platform | 3/3 |
| Gauge.model | acceptable | ignore | rdfs:label | 1/3 |
| Gauge.serial | acceptable | ignore | rdfs:label | 1/3 |
| Rollup | different | sosa:Observation | sosa:Result | 1/3 |
| Rollup.windowStart | false-map | defer | sosa:phenomenonTime | 1/3 |
| Rollup.windowEnd | false-ignore | sosa:resultTime | defer | 3/3 |
| Method.version | acceptable | ignore | rdfs:comment | 1/3 |
| WorkOrder | false-map | ignore | sosa:Procedure | 1/3 |
| WorkOrder | false-map | ignore | sosa:Actuation | 1/3 |
| Crew | false-map | ignore | sosa:Sensor | 1/3 |
| Crew | false-map | ignore | sosa:Actuator | 2/3 |
| ON | false-ignore | sosa:hasFeatureOfInterest | defer | 1/3 |
| ROLLUP_OF | false-map | ignore | sosa:isResultOf | 1/3 |
| ABOUT | false-ignore | sosa:observedProperty | defer | 1/3 |
| COMPUTED_WITH | false-ignore | sosa:usedProcedure | defer | 1/3 |
| FOR_RIG | ignore-vs-defer | ignore | defer | 1/3 |
| FOR_RIG | false-map | ignore | sosa:hasFeatureOfInterest | 1/3 |
| SERVICED_BY | ignore-vs-defer | ignore | defer | 1/3 |
| SERVICED_BY | false-map | ignore | sosa:madeByActuator | 1/3 |

Pass 1:
- invalid answers: nodes/n:4 ((element): a node kind mapped without a class (it implies no kind that gives one): give its classes), nodes/n:8 ((element): a node kind mapped without a class (it implies no kind that gives one): give its classes)
- repaired: Rollup [answer.invalid], Crew [answer.invalid]
- check: warning target.range-includes relationships/r:3/predicate
- wrong and caught by nothing: Rig (different: sosa:Platform), WorkOrder (false-map: sosa:Procedure), Crew (false-map: sosa:Sensor), FOR_RIG (ignore-vs-defer: defer), SERVICED_BY (ignore-vs-defer: defer)
- wrong and caught: Rollup.windowEnd by s11-rollup-result-times
- oracle: s5-tick-values fail, s11-rollup-result-times fail

Pass 2:
- check: warning target.range-includes relationships/r:9/predicate
- wrong and caught by nothing: Rig (different: sosa:Platform), WorkOrder (false-map: sosa:Actuation), Crew (false-map: sosa:Actuator), SERVICED_BY (false-map: sosa:madeByActuator)
- wrong and caught: Rollup.windowEnd by s11-rollup-result-times; ON by s7-observed-on-rig; FOR_RIG by target.range-includes
- oracle: s5-tick-values fail, s7-observed-on-rig fail, s11-rollup-result-times fail

Pass 3:
- invalid answers: nodes/n:8 ((element): a node kind mapped without a class (it implies no kind that gives one): give its classes)
- repaired: Crew [answer.invalid], SERVICED_BY [rel.endpoint-no-subject] map->ignore, FOR_RIG [rel.endpoint-no-subject] map->ignore
- check: warning target.domain-includes nodes/n:4/properties/p:14/predicate; warning target.kind-mismatch nodes/n:4/properties/p:15/predicate; warning target.domain-includes nodes/n:4/properties/p:15/predicate; warning target.range-includes relationships/r:3/predicate
- wrong and caught by nothing: Rig (different: sosa:Platform), Crew (false-map: sosa:Actuator)
- wrong and caught: Rollup by s10-rollup-inputs-not-related; Rollup.windowStart by target.kind-mismatch, target.domain-includes; Rollup.windowEnd by s11-rollup-result-times; ROLLUP_OF by s10-rollup-inputs-not-related; ABOUT by s11-rollup-result-times; COMPUTED_WITH by s9-rollup-procedure
- oracle: s5-tick-values fail, s9-rollup-procedure fail, s10-rollup-inputs-not-related fail, s11-rollup-result-times fail

## no-descriptions

Stability: 29/34 decisions identical in all 3 passes.

| confidence | decisions | agree |
|---|---|---|
| 0–0.5 | 0 | - |
| 0.5–0.8 | 6 | 33% |
| 0.8–0.95 | 61 | 79% |
| 0.95–1 | 35 | 100% |

| element | outcome | gold | proposed | passes |
|---|---|---|---|---|
| Rig | different | sosa:Platform, sosa:FeatureOfInterest | sosa:Platform | 3/3 |
| Gauge.model | acceptable | ignore | rdfs:label | 3/3 |
| Rollup.windowEnd | false-ignore | sosa:resultTime | defer | 3/3 |
| Method.version | acceptable | ignore | rdfs:label | 1/3 |
| Threshold | ignore-vs-defer | ignore | defer | 1/3 |
| ON | false-ignore | sosa:hasFeatureOfInterest | defer | 2/3 |
| ON | false-ignore | sosa:hasFeatureOfInterest | ignore | 1/3 |
| ROLLUP_OF | alternative | ignore | defer | 2/3 |
| TRIPPED | ignore-vs-defer | ignore | defer | 1/3 |

Pass 1:
- invalid answers: nodes/n:0 ((element): a node kind mapped without a class (it implies no kind that gives one): give its classes), nodes/n:5 ((element): a node kind mapped without a class (it implies no kind that gives one): give its classes)
- repaired: Rig [answer.invalid], Method [answer.invalid]
- wrong and caught by nothing: Rig (different: sosa:Platform), Threshold (ignore-vs-defer: defer), TRIPPED (ignore-vs-defer: defer)
- wrong and caught: Rollup.windowEnd by s11-rollup-result-times; ON by s7-observed-on-rig
- oracle: s5-tick-values fail, s7-observed-on-rig fail, s11-rollup-result-times fail

Pass 2:
- invalid answers: nodes/n:3 ((element): a node kind mapped without a class (it implies no kind that gives one): give its classes)
- repaired: Tick [answer.invalid]
- wrong and caught by nothing: Rig (different: sosa:Platform)
- wrong and caught: Rollup.windowEnd by s11-rollup-result-times; ON by s7-observed-on-rig
- oracle: s5-tick-values fail, s7-observed-on-rig fail, s11-rollup-result-times fail

Pass 3:
- invalid answers: nodes/n:3 ((element): a node kind mapped without a class (it implies no kind that gives one): give its classes)
- repaired: Tick [answer.invalid]
- wrong and caught by nothing: Rig (different: sosa:Platform)
- wrong and caught: Rollup.windowEnd by s11-rollup-result-times; ON by s7-observed-on-rig
- oracle: s5-tick-values fail, s7-observed-on-rig fail, s11-rollup-result-times fail

## open-terms

Stability: 30/34 decisions identical in all 3 passes.

| confidence | decisions | agree |
|---|---|---|
| 0–0.5 | 0 | - |
| 0.5–0.8 | 4 | 75% |
| 0.8–0.95 | 47 | 57% |
| 0.95–1 | 51 | 92% |

| element | outcome | gold | proposed | passes |
|---|---|---|---|---|
| Rig | different | sosa:Platform, sosa:FeatureOfInterest | sosa:Platform | 3/3 |
| Rollup.windowEnd | false-ignore | sosa:resultTime | defer | 3/3 |
| Threshold | ignore-vs-defer | ignore | defer | 2/3 |
| WorkOrder | false-map | ignore | sosa:Actuation | 3/3 |
| Crew | false-map | ignore | sosa:Actuator | 3/3 |
| ON | false-ignore | sosa:hasFeatureOfInterest | ignore | 2/3 |
| TRIPPED | ignore-vs-defer | ignore | defer | 2/3 |
| FOR_RIG | false-map | ignore | sosa:hasFeatureOfInterest | 3/3 |
| SERVICED_BY | false-map | ignore | sosa:madeByActuator | 3/3 |
| REPLACED | ignore-vs-defer | ignore | defer | 1/3 |

Pass 1:
- check: warning target.range-includes relationships/r:3/predicate; warning target.range-includes relationships/r:9/predicate
- wrong and caught by nothing: Rig (different: sosa:Platform), WorkOrder (false-map: sosa:Actuation), Crew (false-map: sosa:Actuator), SERVICED_BY (false-map: sosa:madeByActuator)
- wrong and caught: Rollup.windowEnd by s11-rollup-result-times; FOR_RIG by target.range-includes
- oracle: s11-rollup-result-times fail

Pass 2:
- check: warning target.range-includes relationships/r:9/predicate
- wrong and caught by nothing: Rig (different: sosa:Platform), Threshold (ignore-vs-defer: defer), WorkOrder (false-map: sosa:Actuation), Crew (false-map: sosa:Actuator), TRIPPED (ignore-vs-defer: defer), SERVICED_BY (false-map: sosa:madeByActuator)
- wrong and caught: Rollup.windowEnd by s11-rollup-result-times; ON by s7-observed-on-rig; FOR_RIG by target.range-includes
- oracle: s7-observed-on-rig fail, s11-rollup-result-times fail

Pass 3:
- check: warning target.range-includes relationships/r:9/predicate
- wrong and caught by nothing: Rig (different: sosa:Platform), Threshold (ignore-vs-defer: defer), WorkOrder (false-map: sosa:Actuation), Crew (false-map: sosa:Actuator), TRIPPED (ignore-vs-defer: defer), SERVICED_BY (false-map: sosa:madeByActuator), REPLACED (ignore-vs-defer: defer)
- wrong and caught: Rollup.windowEnd by s11-rollup-result-times; ON by s7-observed-on-rig; FOR_RIG by target.range-includes
- oracle: s7-observed-on-rig fail, s11-rollup-result-times fail

