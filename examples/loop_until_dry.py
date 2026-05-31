"""loop-until-dry: keep discovering until rounds stop finding anything new.

For open-ended discovery where you do not know how many items exist. Each round
fans out several finders; the loop stops once ``patience`` consecutive rounds
surface nothing new. Dedup happens in plain Python — the primitives only
dispatch and wait.

Run it::

    swarm run examples/loop_until_dry.py --wait \\
        --args '{"topic": "edge cases for a date parser", "finders": 3}'
"""

from agentswarm import agent, log, parallel, schema

META = {
    "name": "loop-until-dry",
    "description": "Repeatedly fan out discovery until it stops finding anything new.",
    "phases": ["discover"],
}

ITEMS = schema.obj({"items": schema.array(schema.string())})


def workflow(args):
    args = args or {}
    topic = args.get("topic", "edge cases for a date-parsing function")
    finders = int(args.get("finders", 3))
    patience = int(args.get("patience", 2))

    seen: set[str] = set()
    dry_rounds = 0
    round_no = 0
    while dry_rounds < patience:
        round_no += 1
        log(f"round {round_no}: {len(seen)} known so far")
        batches = parallel(
            [
                lambda: agent(
                    f"List {topic}. Avoid these already-known ones: {sorted(seen)}",
                    schema=ITEMS,
                    phase="discover",
                )
                for _ in range(finders)
            ]
        )
        fresh = {item for batch in batches if batch for item in batch["items"]} - seen
        if fresh:
            dry_rounds = 0
            seen |= fresh
        else:
            dry_rounds += 1

    return {"found": sorted(seen), "rounds": round_no}
