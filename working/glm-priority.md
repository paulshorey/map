# Fireworks Priority admission and human ingestion hold

Requested 2026-10-14 after Fireworks acknowledged a shared serverless infrastructure
incident affecting GLM 5.3 Flash and DeepSeek V4.1 Flash. The latest Dyrt execution
had 28 failed Fireworks calls out of 49, with 500/502/504 errors and request timeouts;
these are transport/service failures rather than malformed model output. The earlier
database checkout failure remains a separate, unproven transient connection fault.

The shared chat client now defaults to `service_tier: "priority"`. GLM, the 256-token
thinking allowance, final-answer caps, schemas and output repair behavior stay in place.
`LLM_SERVICE_TIER=default` explicitly selects Standard. Invalid settings fail early;
the client does not silently downgrade a rejected Priority request. All shared chat
consumers use the setting, including normalization and matching.

Priority is an admission policy, not a more capable model. Fireworks describes it as
less likely to be shed during congestion, with the same rate limits as Standard. It
cannot establish that an infrastructure outage is resolved. Official references:
[modes](https://docs.fireworks.ai/serverless/serverless-modes),
[pricing](https://docs.fireworks.ai/serverless/pricing), and the
[reported incident](https://status.fireworks.ai/incidents/01M4YAMVS2260M80QZMQHBPZPY).

Fallback cost estimates include the published 25% Priority premium for the two known
models, use the served tier when reported, and defer to provider-reported cost.
Managed provider-call metadata distinguishes requested tier from nullable reported
tier. Normalization cache identity preserves its historical tier key because admission
does not change semantic output; a tier switch does not discard successful work.

Normalization already sends a `JSON.stringify` packet and requests strict JSON Schema.
Code validates schema and source evidence, preserves authoritative captured scalars,
and constructs the final record. One output repair is followed by explicit quarantine
on exhausted record validation. A stronger model can improve ambiguous interpretation
or matching; formatting alone does not require it. These controls remain useful with
any model and do not repair API transport failures.

## Validation and operating state

Mocked tests cover Priority wire requests, unchanged token bounds, explicit Standard,
invalid settings, tier-aware prices, provider cost precedence, requested/reported tier
telemetry on success and output failure, rejected Priority without downgrade, and exact
historical cache identity. No live provider or ingestion validation is authorized during
the human hold; Priority's actual availability and latency are not yet measured.

Validation passed: 33 mocked LLM/provider-recovery tests, 13 mocked output-repair tests,
TypeScript checking and generated application-contract drift checking. These tests made
no real inference requests or ingestion writes.

The user explicitly stopped ingestion and will restart after Fireworks is reliably
online. All workers and Node supervisors are stopped. The Dyrt hourly heartbeat is
paused; the daily Map coordinator also has an explicit ingestion hold. Owned maintenance
remains closed. Its token and stop evidence are in the primary checkout's ignored
`lib/db-map/.ingest-jobs/21d7f1f9-baa0-4180-b0b7-c12c0eec98c2/human-hold-priority-20261014/`
and native automation memory. Do not reopen admission or restart monitoring automatically.

Original run `4dda8606-9c20-4275-bae6-c14cdea9e38c` retains its frozen 43,272-record
Dyrt cohort and successful artifacts; whole-file verification is incomplete. The latest
job `21d7f1f9-baa0-4180-b0b7-c12c0eec98c2` / execution
`0be2a8cd-842b-4718-a51e-6485eff3e766` is terminal and its event consumed.
Use the [maintenance workflow](../data/poi-ingestion.md#process-control-and-maintenance)
and [human ingestion instructions](../README.md#poi-ingestion) when the human elects
to restart; resume the original run with `--unlimited` to retain checkpoints.
