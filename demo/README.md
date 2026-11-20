# Demo: keep the graph database, publish RDF from it

A narrated demo, live or as a video, in two acts on one Neo4j database:

1. **A member directory, as FOAF** — the simple case, end to end: an AI writes the
   specification with a person, proposes the mapping, the person accepts it; the
   directory is published as a SPARQL endpoint that follows the database (change
   data capture); a transaction adds a member and the endpoint follows; a
   transaction breaking a uniqueness constraint is rolled back and nothing reaches
   the RDF; connected as a partner, whose Neo4j role cannot read birthdays, the
   same API returns no birthdays.
2. **Data lineage, as W3C PROV-O** — a real model: the review queue, a structural
   error the checker sees, a meaning error only the oracle sees (Cypher and SPARQL
   answering the same questions), an impact API reasoning over PROV, an incident
   committed as a transaction and seen by the very next call.

The story is the graph database as the system of record — transactions,
constraints, roles, change data capture — and RDF as a view of it. The script,
with the talking points and the scenes, is [demo-script.md](demo-script.md).

## What it needs

- A Neo4j **Enterprise** instance (Aura Business Critical or Virtual Dedicated
  Cloud, or self-managed 5.13+) with **change data capture in FULL mode** (Aura:
  instance → ⋯ → Change Data Capture → FULL). Roles need Enterprise; following
  the database needs CDC.
- `.env` at the root of the repository: `NEO4J_URI`, `NEO4J_USERNAME`,
  `NEO4J_PASSWORD` (an admin: the demo creates a role and a user), and
  `GEMINI_API_KEY` for recording the AI answers and for the voice-over.
- Java 21 and the n20s-server jar (`N20S_JAR`, default
  `../n20s-plugin/n20s-server/target/n20s-server-1.1.0-SNAPSHOT.jar`), a build
  with column-valued IRIs and query terms.
- For the video: Python 3 with `playwright`, `google-genai`, `pyyaml`
  (`python3 -m playwright install chromium`) and ffmpeg.

## The database side

`node demo/aura.mjs reset` puts the instance in its starting state, and every
command of the demo calls it:

- loads the directory (`data/people.cypher`: 8 members, 2 groups, with uniqueness
  and existence constraints) under its own labels, next to the lineage graph
  (`examples/lineage/seed.cypher`, loaded once), which it does not touch;
- creates the role `rdf_partner` (reads members and groups, `DENY READ {birthday,
  email}` on members) and the user `partner`, whose password it generates once and
  keeps in `.env` as `DEMO_PARTNER_PASSWORD`;
- undoes the demo transactions.

`node demo/aura.mjs tx <name>` commits one of the transactions of the demo
(`leo-joins`, `duplicate-ana`, `customers-incident`), as another application
would, and prints what the database answered. `teardown` removes the directory,
the role and the user.

## Live

```bash
demo/demo.sh start      # database reset, fresh copy of demo/project, n20s-server, studio
open http://127.0.0.1:4500/project
demo/demo.sh stop
```

The studio replays the AI answers recorded in `recordings/ai.json`, so a live demo
cannot be surprised by the model; the Connections tab says so. `demo/demo.sh live`
starts with the live model instead and records its answers again (after a prompt
or a script change, a replay stops with "the recording has no answer"). Host names
are masked on screen (`--mask-hosts`).

To commit the transactions by hand during a live demo, from a second terminal:

```bash
node demo/aura.mjs tx leo-joins
node demo/aura.mjs tx duplicate-ana
node demo/aura.mjs tx customers-incident
```

## Video

The video tooling (`demo/video/`: the recorder from the `demo-video` skill and its
hooks) is not in the repository. With it in place, from `demo/`, with the studio
started (`demo/demo.sh start`):

```bash
python3 video/tools/record.py --script demo-script.md --cursor --no-audio   # silent rehearsal: every selector, free
python3 video/tools/assemble.py --no-audio && python3 video/tools/frames.py # dist/frames/contact_sheet.png
(set -a; . ../.env; set +a; python3 video/tools/tts.py --script demo-script.md)  # voice-over, cached per sentence
demo/demo.sh start                                                          # back to the starting state
python3 video/tools/record.py --script demo-script.md --cursor               # holds each scene for its narration
python3 video/tools/assemble.py && python3 video/tools/frames.py            # dist/demo.mp4, dist/demo.srt
```

The recording changes the database (the transactions), so start from
`demo/demo.sh start` before each take. Re-run after a UI change: a broken selector
stops the take naming its scene. `video/hooks.py` holds what a list of clicks
cannot say: the act cards and the transactions, really committed and shown as the
database answered.

The tools come from the `demo-video` skill (`.claude/skills/demo-video`). Each
scene has an English narration (`narration`, the voice-over) and a French one
(`narration_fr`, not voiced yet: swap the field to make the French cut).

## Files

| File | |
|---|---|
| `demo-script.md` | Talking points and scenes (actions, shot, narration, narration_fr). |
| `demo.sh` | start, live, stop. |
| `aura.mjs` | The database side: reset, status, tx, teardown. |
| `data/people.cypher` | The member directory. |
| `project/` | The demo project: two LPG ontologies (Aura exports), FOAF and PROV-O, two mappings, their recipes. Copied to `.work/` on each start. |
| `project/targets/foaf.ttl` | The FOAF terms of the demo, in Turtle, from the FOAF specification (published as RDF/XML only). |
| `project/lineage/lineage-prov.mapping.yaml` | Act 2's starting point: the reviewed lineage mapping, with eight relationship types proposed again by the AI. Built by `prepare-lineage.mjs` (recorded in `recordings/lineage-propose.json`, `--replay` rebuilds it). |
| `recordings/ai.json` | The AI answers the demo replays. |
| `video/`, `dist/` | Video tooling and output, kept out of the repository. |
