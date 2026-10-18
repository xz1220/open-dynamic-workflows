# The image the real-engine sandbox check (scripts/ci/sandbox-real.sh) runs
# agents in: node (which an egress allowlist's proxy sidecar runs on too),
# plus stand-in agent CLIs that report what they could do.
FROM node:22-alpine
COPY probe-agent.mjs /usr/local/bin/probe-agent
COPY egress-probe.mjs /usr/local/bin/egress-probe
RUN chmod 755 /usr/local/bin/probe-agent /usr/local/bin/egress-probe
