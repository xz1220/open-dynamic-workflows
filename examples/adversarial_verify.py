"""adversarial verify: surface findings, then keep only those that survive refutation.

Stage 1 asks one agent for candidate findings (typed via a schema). Stage 2 runs
each finding past several independent skeptics; a finding is kept only if a
majority fail to refute it. The pipeline streams: a finding can be under
verification while others are still being found.

Run it::

    swarm run examples/adversarial_verify.py --wait \\
        --args '{"target": "Review auth.py for correctness bugs.", "voters": 3}'
"""

from agentswarm import agent, log, parallel, pipeline, schema

META = {
    "name": "adversarial-verify",
    "description": "Surface findings, then keep only those that survive independent refutation.",
    "phases": ["find", "verify"],
}

FINDINGS = schema.obj(
    {
        "findings": schema.array(
            schema.obj({"title": schema.string(), "detail": schema.string()})
        )
    }
)
VERDICT = schema.obj({"refuted": schema.boolean(), "reason": schema.string()})


def workflow(args):
    args = args or {}
    target = args.get("target", "Review this code for correctness bugs.")
    voters = int(args.get("voters", 3))

    log("finding candidate issues")
    found = agent(target, schema=FINDINGS, label="finder", phase="find")
    findings = found["findings"]
    log(f"{len(findings)} candidates; verifying each with {voters} skeptics")

    def verify(finding):
        votes = parallel(
            [
                lambda f=finding: agent(
                    "Try to REFUTE this finding; default to refuted=true if unsure.\n"
                    f"Title: {f['title']}\nDetail: {f['detail']}",
                    schema=VERDICT,
                    phase="verify",
                )
                for _ in range(voters)
            ]
        )
        refutations = sum(1 for v in votes if v and v["refuted"])
        survived = refutations <= voters // 2
        return {"finding": finding, "kept": survived}

    judged = pipeline(findings, verify)
    confirmed = [j["finding"] for j in judged if j and j["kept"]]
    return {"confirmed": confirmed, "considered": len(findings)}
