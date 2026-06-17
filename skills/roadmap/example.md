# Helio launch — roadmap
**Updated** 2026-06-13 14:20 · `chief-of-staff` · mirror `scuba-state/dan-acme-com@e1f2a3b`

## Now active
- 🟢 **Deploy ordering** — deploy-order fix verifying on staging; `ship-gate` next. → [status](teams/golive/deploy.status.md)
- 🔎 **Inc-3 fixes** — PR [#31](https://github.com/acme/helio/pull/31) up, internal swarm CLEAN, awaiting external reviewer.
- 🟡 **CMS content model** — architect drafting the spec. → [spec (draft)](teams/cms/spec.md)
- ⛔ **Concierge rate-limit** — blocked on the network-exposure fix merging.

## Decisions waiting on me
1. **Booking resume queue** — Redis vs SQS? → [context](teams/booking/decisions.md)
2. **CMS author permissions** — reuse platform RBAC, or a separate model? → [context](teams/cms/decisions.md)

## Roadmap

```mermaid
flowchart TD
  L([Helio launch]):::root

  L --> GO[🟢 Go-live hardening]:::exec
  L --> IN[🔎 Inc-3 burndown]:::review
  L --> CM[🔵 CMS]:::plan
  L --> BK[⛔ Booking resume]:::blocked

  GO --> GS[✅ Network exposure fix]:::done
  GO --> GF[🟢 Deploy ordering]:::exec
  GO --> GC[⛔ Concierge rate-limit]:::blocked
  IN --> IB[🔎 Inc-3 fixes ×5]:::review
  CM --> CS[🟡 Content model]:::spec
  BK --> BR[⛔ Resume queue]:::blocked

  click GS "teams/golive/secure.brief.html" "Done — executive brief"
  click GF "teams/golive/deploy.spec.md" "Spec → plan → ship-gate"
  click GC "teams/golive/concierge.spec.md" "Spec"
  click IB "teams/inc3/burndown.plan.md" "Plan · PR #31"
  click CS "teams/cms/spec.md" "Spec (draft)"
  click BR "teams/booking/decisions.md" "Needs your decision"

  classDef root fill:#F1EFE8,stroke:#5F5E5A,color:#2C2C2A
  classDef spec fill:#FAEEDA,stroke:#854F0B,color:#412402
  classDef plan fill:#E6F1FB,stroke:#185FA5,color:#042C53
  classDef exec fill:#EAF3DE,stroke:#3B6D11,color:#173404
  classDef review fill:#EEEDFE,stroke:#534AB7,color:#26215C
  classDef blocked fill:#FCEBEB,stroke:#A32D2D,color:#501313
  classDef done fill:#E1F5EE,stroke:#0F6E56,color:#04342C
  classDef parked fill:#F1EFE8,stroke:#888780,color:#2C2C2A
```

_Node labels carry the stage emoji (🟡 spec · 🔵 plan · 🟢 execution · 🔎 review · ⛔ blocked · ✅ done · 💤 parked); colour comes from the matching `classDef` — don't invent new ones. Click a node to open its artifact; artifacts chain **spec → plan → executive brief**. Per-thread recovery detail (branch · worktree · last SHA · next · blocker) lives in each thread's `status.md`._
