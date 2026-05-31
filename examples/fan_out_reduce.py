"""fan-out -> reduce -> synthesize: the most basic dynamic-workflow shape.

Generate several independent drafts in parallel, drop any that failed, then ask
one more agent to synthesize a single answer from them.

Run it::

    swarm run examples/fan_out_reduce.py --wait \\
        --args '{"question": "Design a rate limiter for a public API.", "fanout": 4}'
"""

from agentswarm import agent, log, parallel

META = {
    "name": "fan-out-reduce",
    "description": "Generate several independent drafts, then synthesize one answer.",
    "phases": ["draft", "synthesize"],
}


def workflow(args):
    args = args or {}
    question = args.get("question", "Design a rate limiter for a public API.")
    fanout = int(args.get("fanout", 3))

    log(f"fanning out {fanout} independent drafts")
    drafts = parallel(
        [
            lambda i=i: agent(
                f"Draft answer #{i + 1} to this question: {question}",
                label=f"draft-{i + 1}",
                phase="draft",
            )
            for i in range(fanout)
        ]
    )
    drafts = [d for d in drafts if d]  # drop any agent that failed

    log(f"synthesizing from {len(drafts)} drafts")
    combined = "\n\n---\n\n".join(drafts)
    return agent(
        "Synthesize the single best answer from these independent drafts.\n"
        f"Question: {question}\n\nDrafts:\n{combined}",
        label="synthesis",
        phase="synthesize",
    )
