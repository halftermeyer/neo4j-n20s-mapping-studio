# Demo: keep the graph database, publish RDF from it

**The story in one sentence.** Your graph database stays the system of record —
transactions, constraints, roles, change data capture — and RDF becomes a view of
it, in standard vocabularies, always consistent with what was committed. The best
of both worlds, with no second copy to keep in sync.

**Audience.** People who know RDF or Neo4j, not necessarily both: data architects,
knowledge-graph teams, partners who were told "export to a triple store".

**What to show, and what not to.** The studio, the database, the vocabularies,
the people deciding. The machinery that turns rows into triples stays in the
background: it is never named, and nobody needs to know it is there.

**Setup.** `demo/demo.sh start` (see demo/README.md): an Aura Enterprise instance
with change data capture in FULL mode holds both domains; the studio opens on
http://127.0.0.1:4500 with the AI answers replayed, so every run is the same.

The scene blocks below drive the recorder (demo/video/tools/record.py). The talking
points around them are for a live presenter; keep both in step.

```scene-config
title: "Keep the graph database. Publish RDF from it."
subtitle: "From a Neo4j graph to FOAF and PROV-O, with AI help and a person deciding"
base_url: "http://127.0.0.1:4500"
viewport: { width: 1920, height: 1080 }
pad_s: 1.0
voice: "Charon"
tts_model: "gemini-2.5-flash-preview-tts"
tts_style: "Speak calmly and clearly, like an architect explaining a design to colleagues. Natural pace, no hype."
```

## Opening — one database, two domains

Talking points: one Neo4j database on Aura holds a member directory and the data
lineage of an analytics platform. Partners want both as RDF. The usual answer is a
copy in a triple store, a sync job, and a second place to secure. We keep the
database instead.

```scene
id: s01-intro
hook: setup
actions:
  - goto: "/project"
  - wait_for: "testid:project-cols"
shot: "testid:project-cols"
narration: >
  One Neo4j database, on Aura. It holds two things: the member directory of a
  professional community, and the data lineage of an analytics platform.
  Partners want both as RDF, in standard vocabularies. The usual answer is to copy
  everything into a triple store. Let's keep the database instead.
narration_fr: >
  Une seule base Neo4j, sur Aura. Elle contient deux choses : l'annuaire d'une
  communauté professionnelle, et le lignage des données d'une plateforme
  analytique. Les partenaires veulent les deux en RDF, dans des vocabulaires
  standard. La réponse habituelle : tout copier dans un triple store. Gardons
  plutôt la base.
```

```scene
id: s02-project
actions:
  - hover: "testid:source-people"
  - wait_ms: 600
  - hover: "testid:mapping-people-foaf"
  - wait_ms: 600
  - hover: "testid:target-foaf"
shot: "testid:project-cols"
narration: >
  The project has three columns. On the left, the graph models, as Aura exports
  them. On the right, the target vocabularies: FOAF for people, PROV-O for lineage.
  In the middle, the mappings between them. The FOAF mapping is still empty.
narration_fr: >
  Le projet tient en trois colonnes. À gauche, les modèles de graphe, tels
  qu'Aura les exporte. À droite, les vocabulaires cibles : FOAF pour les
  personnes, PROV-O pour le lignage. Au milieu, les mappings entre les deux. Celui
  vers FOAF est encore vide.
```

## Act 1 — the member directory, as FOAF

Talking points: the simplest possible case, end to end, in a few minutes. The
person never writes a mapping by hand: they say what the RDF is for, accept or
reject what the AI proposes, and the database does the rest.

```scene
id: s03-act1
hook: act1_card
actions:
  - wait_for: "testid:act-card"
shot: "testid:act-card"
narration: >
  Act one, the simple case: publish the member directory as FOAF.
narration_fr: >
  Premier acte, le cas simple : publier l'annuaire des membres en FOAF.
```

```scene
id: s04-design-ask
before:
  - dismiss: "testid:act-card"
actions:
  - click: "testid:tab-design"
  - wait_for: "testid:design-input"
  - type: { target: "testid:design-input", value: "We want to share our member directory with partner organisations, in FOAF. Emails are private: they must never leave the database.", delay_ms: 18 }
  - click: "testid:design-send"
  - fast_begin: true
  - wait_any: { targets: ["testid:design-msg-2"], timeout_ms: 240000 }
  - fast_end: true
shot: "testid:design-msg-2"
narration: >
  We don't start by writing a mapping. We tell an AI assistant, in plain words,
  what the RDF is for, and what must never be published.
narration_fr: >
  On ne commence pas par écrire un mapping. On dit à un assistant IA, avec nos
  mots, à quoi servira le RDF, et ce qui ne doit jamais être publié.
```

```scene
id: s05-design-accept
actions:
  - click: "testid:design-accept-pending"
  - wait_ms: 1200
shot: "testid:design-spec"
narration: >
  It turns that into a specification: the purpose, the target vocabulary, what is
  in scope, and one exclusion, the email address. Nothing counts until a person
  accepts it. We accept.
narration_fr: >
  Il en fait une spécification : l'objectif, le vocabulaire cible, ce qui est dans
  le périmètre, et une exclusion, l'adresse e-mail. Rien ne compte tant qu'une
  personne ne l'a pas accepté. On accepte.
```

```scene
id: s06-design-propose
actions:
  - select: { target: "testid:design-passes", value: "3" }
  - click: "testid:design-propose"
  - fast_begin: true
  - wait_any: { targets: ["testid:design-proposed"], timeout_ms: 600000 }
  - fast_end: true
shot: "testid:design-proposed"
narration: >
  Now the AI proposes the mapping itself, three times over, so we can see where it
  hesitates. The email is not even sent to it: the specification already left it
  out.
narration_fr: >
  Maintenant l'IA propose le mapping lui-même, trois fois de suite, pour voir où
  elle hésite. L'e-mail ne lui est même pas envoyé : la spécification l'a déjà
  écarté.
```

```scene
id: s07-mapping
actions:
  - click: "testid:tab-mapping"
  - wait_for: "testid:accept-safe"
shot: "css:#graph"
narration: >
  This is the member graph as Neo4j stores it: members, groups, who knows whom.
  Blue means proposed and safe: the same answer every time, with high confidence.
  Orange means a person should look.
narration_fr: >
  Voici le graphe des membres tel que Neo4j le stocke : membres, groupes, qui
  connaît qui. Bleu : proposé et sûr, la même réponse à chaque fois, avec une
  confiance élevée. Orange : une personne doit regarder.
```

```scene
id: s08-member-of
actions:
  - click: "testid:queue-filter-all"
  - click: "testid:queue-relationships-r-1"
  - wait_for: "testid:panel-relationships-r-1"
shot: "css:#panel"
narration: >
  Member of goes from a member to a group. FOAF says it the other way round: a
  group has a member. The AI noticed, and reversed the direction. The small
  drawing shows the triples it will produce.
narration_fr: >
  « Member of » va d'un membre vers un groupe. FOAF le dit dans l'autre sens : un
  groupe a un membre. L'IA l'a remarqué, et a inversé le sens. Le petit schéma
  montre les triplets qui seront produits.
```

```scene
id: s09-accept
actions:
  - hook: accept_safe
  - hook: accept_remaining
  - click: "testid:queue-filter-done"
shot: "css:#top"
narration: >
  We accept the safe proposals in one click, and review the others one by one.
  Every decision lands in a plain YAML file next to the model, with who proposed
  it and who accepted it.
narration_fr: >
  On accepte les propositions sûres en un clic, et on revoit les autres une par
  une. Chaque décision atterrit dans un simple fichier YAML à côté du modèle, avec
  qui l'a proposée et qui l'a acceptée.
```

```scene
id: s10-recipes
actions:
  - click: "testid:tab-recipes"
  - click: "testid:recipe-directory"
  - wait_for: "testid:recipe-run"
shot: "css:#recipes-view .fmain"
narration: >
  Two recipes are ready. This one publishes the directory: Cypher reads members
  and groups, the mapping turns them into FOAF, a SHACL shape checks the result,
  and only a valid graph is published.
narration_fr: >
  Deux recettes sont prêtes. Celle-ci publie l'annuaire : Cypher lit les membres
  et les groupes, le mapping les traduit en FOAF, une forme SHACL vérifie le
  résultat, et seul un graphe valide est publié.
```

```scene
id: s11-publish
actions:
  - click: "testid:recipe-run"
  - wait_for: "testid:run-ok-directory"
  - click: "testid:endpoint-directory"
  - wait_for: "testid:follow-box"
shot: "css:#recipes-view .fpanel"
narration: >
  One click, about a second. Partners now have a standard SPARQL endpoint. It is a
  projection of the database, rebuilt from it, not a copy that someone has to
  maintain.
narration_fr: >
  Un clic, environ une seconde. Les partenaires ont maintenant un endpoint SPARQL
  standard. C'est une projection de la base, reconstruite à partir d'elle, pas une
  copie que quelqu'un doit maintenir.
```

```scene
id: s12-sparql
actions:
  - fill: { target: "testid:sparql-input", value: "PREFIX foaf: <http://xmlns.com/foaf/0.1/>\nSELECT ?person ?knows WHERE {\n  ?p foaf:name ?person ; foaf:knows ?k .\n  ?k foaf:name ?knows .\n} ORDER BY ?person" }
  - click: "testid:sparql-ask"
  - wait_for: "testid:sparql-result-1"
shot: "testid:sparql-result-1"
narration: >
  A partner asks in SPARQL: who knows whom? Plain FOAF, nothing specific to
  Neo4j.
narration_fr: >
  Un partenaire interroge en SPARQL : qui connaît qui ? Du FOAF standard, rien de
  spécifique à Neo4j.
```

Talking points: this is where the graph database earns its place. Change data
capture is a property of the database; the endpoint subscribes to it.

```scene
id: s13-follow
actions:
  - click: "testid:follow-on"
  - wait_for: "testid:follow-state-idle"
shot: "testid:follow-box"
narration: >
  Change data capture is on in this Aura instance, so the endpoint can follow the
  database. When a committed transaction touches members or groups, the graph is
  rebuilt, checked again, and swapped in.
narration_fr: >
  La capture des changements est activée sur cette instance Aura : l'endpoint peut
  donc suivre la base. Quand une transaction validée touche les membres ou les
  groupes, le graphe est reconstruit, revérifié, puis basculé.
```

```scene
id: s14-tx-leo
hook: tx_leo_joins
actions:
  - wait_any: { targets: ["testid:follow-sync-1"], timeout_ms: 90000 }
shot: "testid:follow-box"
narration: >
  The member portal commits a transaction: Leo joins, knows Ana, and joins the
  Graph Guild. Seconds later, the published graph has been rebuilt from the
  committed state. No export, no sync job.
narration_fr: >
  Le portail des membres valide une transaction : Leo arrive, connaît Ana, et
  rejoint la Graph Guild. Quelques secondes plus tard, le graphe publié a été
  reconstruit à partir de l'état validé. Ni export, ni tâche de synchronisation.
```

```scene
id: s15-sparql-leo
before:
  - dismiss: "testid:tx-card-close"
actions:
  - fill: { target: "testid:sparql-input", value: "PREFIX foaf: <http://xmlns.com/foaf/0.1/>\nSELECT ?person WHERE {\n  ?p foaf:name ?person ; foaf:knows ?ana .\n  ?ana foaf:name \"Ana Silva\" .\n}" }
  - click: "testid:sparql-ask"
  - wait_for: "testid:sparql-result-2"
shot: "testid:sparql-result-2"
narration: >
  Who knows Ana? Fatima, and now Leo.
narration_fr: >
  Qui connaît Ana ? Fatima, et maintenant Leo.
```

```scene
id: s16-tx-duplicate
hook: tx_duplicate_ana
actions:
  - wait_for: "testid:tx-card-rolled-back"
shot: "testid:tx-card-rolled-back"
pad_s: 1.5
narration: >
  Another application tries to register Ana a second time, with the same email,
  and to change Ben's nickname in the same transaction. The database refuses: a
  uniqueness constraint. All or nothing. Ben's nickname is unchanged, and nothing
  reaches the RDF. That is what ACID buys you.
narration_fr: >
  Une autre application tente d'inscrire Ana une deuxième fois, avec le même
  e-mail, et de changer le surnom de Ben dans la même transaction. La base refuse :
  contrainte d'unicité. Tout ou rien. Le surnom de Ben n'a pas bougé, et rien
  n'arrive dans le RDF. C'est ce que l'ACID vous apporte.
```

```scene
id: s17-api-friends
before:
  - dismiss: "testid:tx-card-close"
actions:
  - click: "testid:api-friends"
  - click: "testid:api-call"
  - wait_for: "testid:api-result-1"
shot: "testid:api-result-1"
narration: >
  The second recipe is an API, answered on demand: who does Ana know? Cypher reads
  only Ana and her contacts; nothing else is projected. Birthdays are there: we
  are connected as a data steward.
narration_fr: >
  La deuxième recette est une API, calculée à la demande : qui Ana connaît-elle ?
  Cypher ne lit qu'Ana et ses contacts ; rien d'autre n'est projeté. Les dates
  d'anniversaire sont là : nous sommes connectés en tant qu'administrateur des
  données.
```

Talking points: security is not re-implemented on the RDF side. It is the
database's own role-based access control, applied to every client.

```scene
id: s18-partner
actions:
  - click: "testid:tab-connections"
  - fill: { target: "testid:neo4j-user", value: "partner" }
  - hook: fill_partner_password
  - click: "testid:neo4j-connect"
  - wait_for: "testid:neo4j-ok-partner"
shot: "testid:conn-neo4j"
narration: >
  Now we connect as a partner would. In Neo4j, the partner role cannot read emails
  or birthdays. That rule lives in the database, for every client: drivers,
  tools, and this one.
narration_fr: >
  Connectons-nous maintenant comme le ferait un partenaire. Dans Neo4j, le rôle
  partenaire ne peut lire ni les e-mails ni les dates d'anniversaire. Cette règle
  vit dans la base, pour tous les clients : drivers, outils, et celui-ci.
```

```scene
id: s19-api-partner
actions:
  - click: "testid:tab-recipes"
  - click: "testid:api-friends"
  - click: "testid:api-call"
  - wait_for: "testid:api-result-2"
shot: "testid:api-result-2"
narration: >
  Same mapping, same API, same question. The birthdays are gone. The RDF cannot
  leak what the database does not let you read, and there is no second security
  model to keep in sync.
narration_fr: >
  Même mapping, même API, même question. Les dates d'anniversaire ont disparu. Le
  RDF ne peut pas divulguer ce que la base ne vous laisse pas lire, et il n'y a pas
  de second modèle de sécurité à synchroniser.
```

```scene
id: s20-steward
actions:
  - click: "testid:tab-connections"
  - fill: { target: "testid:neo4j-user", value: "neo4j" }
  - fill: { target: "testid:neo4j-password", value: "" }
  - click: "testid:neo4j-connect"
  - wait_for: "testid:neo4j-ok-neo4j"
shot: "testid:conn-neo4j"
narration: >
  Back to the steward account.
narration_fr: >
  Retour au compte administrateur.
```

## Act 2 — data lineage, as W3C PROV-O

Talking points: a real model, with subtle semantics. This is where "the AI
proposes, a person decides, and the oracle checks the meaning" matters.

```scene
id: s21-act2
hook: act2_card
actions:
  - wait_for: "testid:act-card"
shot: "testid:act-card"
narration: >
  Act two, a real case: the data lineage of an analytics platform, published in
  W3C PROV-O. Datasets, versions, runs and owners, in the same database.
narration_fr: >
  Deuxième acte, un cas réel : le lignage des données d'une plateforme
  analytique, publié en PROV-O du W3C. Jeux de données, versions, exécutions et
  responsables, dans la même base.
```

```scene
id: s22-lineage-open
before:
  - dismiss: "testid:act-card"
actions:
  - click: "testid:tab-project"
  - click: "testid:open-lineage-prov"
  - wait_for: "testid:accept-safe"
shot: "css:#graph"
narration: >
  The lineage mapping was mostly reviewed last week. The AI proposed eight
  relationship types again; they are waiting for review.
narration_fr: >
  Le mapping du lignage a été revu en grande partie la semaine dernière. L'IA a
  reproposé huit types de relations ; ils attendent une revue.
```

```scene
id: s23-lineage-safe
actions:
  - hook: accept_safe
  - click: "testid:queue-filter-review"
shot: "css:#queue"
narration: >
  We accept what is safe. The rest needs a person; let's look at two of them.
narration_fr: >
  On accepte ce qui est sûr. Le reste demande une personne ; regardons-en deux.
```

```scene
id: s24-has-column-version
actions:
  - click: "testid:queue-relationships-r-7"
  - wait_for: "testid:panel-relationships-r-7"
shot: "css:#panel"
narration: >
  This one has a warning. The AI mapped has column version to prov had member.
  But in PROV-O, had member applies to collections, and a dataset version is not
  one. The structure is wrong, and the checker can see it.
narration_fr: >
  Celle-ci porte un avertissement. L'IA a mappé « has column version » vers « prov
  had member ». Mais en PROV-O, « had member » s'applique aux collections, et une
  version de jeu de données n'en est pas une. La structure est fausse, et le
  vérificateur le voit.
```

```scene
id: s25-reject-ask
actions:
  - click: "testid:reject"
  - type: { target: "testid:reject-comment", value: "A dataset version is not a prov:Collection. Leave it out, like HAS_COLUMN.", delay_ms: 18 }
  - click: "testid:reject-ask"
  - fast_begin: true
  - wait_any: { targets: ["text:Proposed again"], timeout_ms: 240000 }
  - fast_end: true
shot: "css:#panel"
narration: >
  We reject it, say why, and ask again. The AI reads our reason, and now leaves
  it out, like has column.
narration_fr: >
  On la rejette, on dit pourquoi, et on redemande. L'IA lit notre raison, et
  l'écarte désormais, comme « has column ».
```

```scene
id: s26-accept-new
actions:
  - click: "testid:accept"
  - wait_for: "text:Accepted"
  - click: "testid:queue-relationships-r-2"
  - wait_for: "testid:panel-relationships-r-2"
shot: "css:#panel"
narration: >
  Accepted. Depends on is subtler. The AI leaves it out: it is a potential
  dependency, computed for fast traversal, not an asserted derivation. A reviewer
  might be tempted to map it to was derived from.
narration_fr: >
  Accepté. « Depends on » est plus subtil. L'IA l'écarte : c'est une dépendance
  potentielle, calculée pour accélérer les parcours, pas une dérivation affirmée.
  Un relecteur pourrait être tenté de la mapper vers « was derived from ».
```

```scene
id: s27-tempted
actions:
  - click: "testid:edit"
  - select: { target: "testid:decision", value: "map" }
  - fill: { target: "testid:rel-predicate", value: "prov:wasDerivedFrom" }
  - click: "testid:save-accepted"
  - wait_for: "text:Saved"
shot: "css:#top"
narration: >
  Let's do it. The checker is happy: an entity derived from an entity fits the
  domain and the range. Structure cannot see meaning.
narration_fr: >
  Faisons-le. Le vérificateur est satisfait : une entité dérivée d'une entité
  respecte le domaine et l'image. La structure ne voit pas le sens.
```

```scene
id: s28-oracle-fail
actions:
  - click: "testid:oracle-toggle"
  - click: "testid:oracle-run"
  - fast_begin: true
  - wait_any: { targets: ["testid:oracle-results-fail", "testid:oracle-results-pass"], timeout_ms: 240000 }
  - fast_end: true
shot: "css:#oracle"
narration: >
  The oracle can. It asks the same business questions twice: in Cypher on the
  graph, and in SPARQL on the RDF. Now the RDF claims derivations the graph never
  asserted, and the oracle shows which ones.
narration_fr: >
  L'oracle, lui, le voit. Il pose les mêmes questions métier deux fois : en Cypher
  sur le graphe, et en SPARQL sur le RDF. Le RDF affirme maintenant des dérivations
  que le graphe n'a jamais affirmées, et l'oracle montre lesquelles.
```

```scene
id: s29-fix
actions:
  - click: "testid:edit"
  - select: { target: "testid:decision", value: "ignore" }
  - fill: { target: "testid:rel-reason", value: "Potential dependency, not an asserted derivation." }
  - click: "testid:save-accepted"
  - wait_for: "text:Saved"
  - click: "testid:oracle-run"
  - fast_begin: true
  - wait_any: { targets: ["testid:oracle-results-pass"], timeout_ms: 240000 }
  - fast_end: true
shot: "css:#oracle"
narration: >
  We put it back as the AI had it. Every question now gets the same answer on
  both sides.
narration_fr: >
  On revient à la décision de l'IA. Chaque question obtient maintenant la même
  réponse des deux côtés.
```

```scene
id: s30-impact
actions:
  - click: "testid:tab-recipes"
  - click: "testid:api-owners-to-notify"
  - fill: { target: "testid:api-param-name", value: "raw.customers" }
  - click: "testid:api-call"
  - fast_begin: true
  - wait_for: "testid:api-result-1"
  - fast_end: true
shot: "testid:api-result-1"
narration: >
  Now an impact question, served as an API: which owners must we notify when a
  source fed a run that read a bad input? Cypher scopes the lineage downstream of
  raw customers, and a rule reasons over PROV. Today: nobody.
narration_fr: >
  Maintenant une question d'impact, servie comme une API : quels responsables
  prévenir quand une source a alimenté une exécution qui a lu une entrée
  défectueuse ? Cypher délimite le lignage en aval de « raw customers », et une
  règle raisonne sur PROV. Aujourd'hui : personne.
```

```scene
id: s31-publish-lineage
actions:
  - click: "testid:recipe-lineage-kg"
  - click: "testid:recipe-run"
  - fast_begin: true
  - wait_any: { targets: ["testid:run-ok-lineage-kg"], timeout_ms: 180000 }
  - fast_end: true
  - click: "testid:endpoint-lineage"
  - click: "testid:follow-on"
  - wait_for: "testid:follow-state-idle"
shot: "testid:follow-box"
narration: >
  We also publish the whole lineage as a SPARQL endpoint, with the RDFS closure
  computed, behind a SHACL check, and let it follow the database.
narration_fr: >
  On publie aussi tout le lignage comme endpoint SPARQL, avec la clôture RDFS
  calculée, derrière un contrôle SHACL, et on le laisse suivre la base.
```

```scene
id: s32-incident
hook: tx_customers_incident
actions:
  - wait_for: "testid:tx-card-committed"
shot: "testid:tx-card-committed"
narration: >
  Then an incident. The data quality monitor commits a transaction: the raw
  customers load of November fifth was corrupt.
narration_fr: >
  Puis un incident. Le contrôle qualité des données valide une transaction : le
  chargement « raw customers » du cinq novembre était corrompu.
```

```scene
id: s33-impact-after
before:
  - dismiss: "testid:tx-card-close"
actions:
  - click: "testid:api-owners-to-notify"
  - fill: { target: "testid:api-param-name", value: "raw.customers" }
  - click: "testid:api-call"
  - fast_begin: true
  - wait_for: "testid:api-result-2"
  - fast_end: true
shot: "testid:api-result-2"
narration: >
  Same call: Alice, owner of staging customers, must be notified. The API read
  the committed state. Meanwhile, the lineage SPARQL endpoint, which follows the
  database, is being rebuilt in the background.
narration_fr: >
  Même appel : Alice, responsable de « staging customers », doit être prévenue.
  L'API a lu l'état validé. Pendant ce temps, l'endpoint SPARQL du lignage, qui
  suit la base, se reconstruit en arrière-plan.
```

```scene
id: s34-endpoint-synced
actions:
  - click: "testid:endpoint-lineage"
  - wait_any: { targets: ["testid:follow-sync-1"], timeout_ms: 120000 }
shot: "testid:follow-box"
narration: >
  And there it is: rebuilt, checked, swapped.
narration_fr: >
  Et le voilà : reconstruit, vérifié, basculé.
```

## Act 3 — your triple store and the graph database, one answer

Talking points: clients already have a triple store, with their ontologies and
catalogs, maintained by their own teams. We do not replace it and we never write
to it: a recipe reads it with plain SPARQL. One answer, three sources, each used
for what it does best: Neo4j for what just changed (scoped by Cypher on each
call), our published lineage endpoint for what is stable (precomputed, following
the database), the client's store for their knowledge. The reasoner works on all
three. A static file would be a copy; their endpoint is their live store.

```scene
id: s35-act3
hook: act3_card
actions:
  - wait_for: "testid:act-card"
shot: "testid:act-card"
narration: >
  Act three. The client already has a triple store, with its own ontology and
  data catalog. We keep it too.
narration_fr: >
  Troisième acte. Le client a déjà un triple store, avec sa propre ontologie et
  son catalogue de données. On le garde aussi.
```

```scene
id: s36-mixed-recipe
before:
  - dismiss: "testid:act-card"
actions:
  - click: "testid:recipe-personal-data-alert"
  - wait_for: "testid:recipe-run"
shot: "css:#recipes-view .fmain"
narration: >
  This recipe reads three sources, each for what it does best. What the incident
  tainted comes from Neo4j, scoped by Cypher on each call. Who owns those datasets
  comes from our published lineage endpoint, precomputed. What each dataset holds,
  and who protects personal data, comes from the client's own triple store,
  through standard SPARQL. We only read it.
narration_fr: >
  Cette recette lit trois sources, chacune pour ce qu'elle fait de mieux. Ce que
  l'incident a contaminé vient de Neo4j, délimité par Cypher à chaque appel. Qui
  est responsable de ces jeux de données vient de notre endpoint de lignage
  publié, précalculé. Ce que contient chaque jeu, et qui protège les données
  personnelles, vient du triple store du client, en SPARQL standard. On ne fait
  que le lire.
```

```scene
id: s37-alert
actions:
  - click: "testid:api-personal-data-alert"
  - fill: { target: "testid:api-param-name", value: "raw.customers" }
  - click: "testid:api-call"
  - fast_begin: true
  - wait_for: "testid:api-result-3"
  - fast_end: true
shot: "testid:api-result-3"
narration: >
  After the incident, the compliance question: is personal data at risk, and who
  must be told? Staging customers: Alice owns it, according to our lineage
  endpoint, and Jane Doe is its data protection officer, according to the
  client's catalog. Nobody tagged it as personal. The client's ontology says that a
  dataset holding an email address is a personal dataset, and the OWL reasoner
  works it out, over all three sources.
narration_fr: >
  Après l'incident, la question de conformité : des données personnelles sont-elles
  exposées, et qui prévenir ? « Staging customers » : Alice en est responsable,
  d'après notre endpoint de lignage, et Jane Doe est sa déléguée à la protection des
  données, d'après le catalogue du client. Personne ne l'a marqué comme personnel.
  L'ontologie du client dit qu'un jeu contenant une adresse e-mail est un jeu de
  données personnelles, et le raisonneur OWL le déduit, sur les trois sources.
```

```scene
id: s38-not-personal
actions:
  - fill: { target: "testid:api-param-name", value: "raw.orders" }
  - click: "testid:api-call"
  - fast_begin: true
  - wait_for: "testid:api-result-4"
  - fast_end: true
shot: "testid:api-result-4"
narration: >
  The orders pipeline is tainted too: the revenue mart. But the client's catalog
  says it holds amounts only. Not personal data: no alert.
narration_fr: >
  La chaîne des commandes est contaminée elle aussi : le mart de revenus. Mais le
  catalogue du client dit qu'il ne contient que des montants. Pas de données
  personnelles : pas d'alerte.
```

Talking points: the client's store is live and theirs. When their catalog team
changes it, with their own tools, the next answer follows, without touching
Neo4j or the project. A file copied into the project would not have seen it.

```scene
id: s39-client-tx
hook: tx_client_revenue_emails
actions:
  - wait_for: "testid:tx-card-committed"
shot: "testid:tx-card-committed"
narration: >
  Now a change on the client's side, in their own triple store: their catalog
  team finds email addresses in the revenue mart. Nothing changes in Neo4j, and
  nothing in the project.
narration_fr: >
  Maintenant un changement côté client, dans son propre triple store : son équipe
  catalogue trouve des adresses e-mail dans le mart de revenus. Rien ne change dans
  Neo4j, ni dans le projet.
```

```scene
id: s40-alert-again
before:
  - dismiss: "testid:tx-card-close"
actions:
  - click: "testid:api-call"
  - fast_begin: true
  - wait_for: "testid:api-result-5"
  - fast_end: true
shot: "testid:api-result-5"
narration: >
  Same question, asked again: the revenue mart is now personal data, owned by
  Alice, and Omar Haddad, the finance domain's data protection officer, must be
  told. The answer follows each source as it is now.
narration_fr: >
  Même question, posée à nouveau : le mart de revenus contient désormais des
  données personnelles, Alice en est responsable, et Omar Haddad, délégué à la
  protection des données du domaine finance, doit être prévenu. La réponse suit
  chaque source telle qu'elle est maintenant.
```

## Closing

```scene
id: s41-closing
hook: closing_card
actions:
  - wait_for: "testid:act-card"
shot: "testid:act-card"
pad_s: 2.5
narration: >
  So. Neo4j stays the system of record: transactions, constraints, roles, change
  data capture. RDF is a view of it, in standard vocabularies, with reasoning when
  you need it, always consistent with what was committed, and it works with the
  triple store you already have. The best of both worlds, and no second copy to
  keep in sync.
narration_fr: >
  En résumé. Neo4j reste la source de vérité : transactions, contraintes, rôles,
  capture des changements. Le RDF en est une vue, dans des vocabulaires standard,
  avec du raisonnement quand il le faut, toujours cohérent avec ce qui a été
  validé, et compatible avec le triple store que vous avez déjà. Le meilleur des
  deux mondes, sans seconde copie à synchroniser.
```
