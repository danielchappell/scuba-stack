# <Project> — roadmap
**Updated** <YYYY-MM-DD HH:MM> · <chief-of-staff | scribe> · mirror <scuba-state/<slug>@<sha>>

## Now active
_One or two lines per currently-moving thread — what's happening right now._
- <emoji> **<thread>** — <one-line status> → [status](teams/<team>/<thread>.status.md)

## Decisions waiting on me
_(Empty when none; never bury a decision.)_
1. **<thread>** — <the call, one line> → [context](teams/<team>/decisions.md)

## Roadmap

```mermaid
flowchart TD
  L([<Project>]):::root

  L --> A[🟢 <initiative>]:::exec
  A --> A1[🟡 <thread>]:::spec
  A --> A2[🟢 <thread>]:::exec

  click A1 "teams/<team>/<thread>.spec.md" "spec → plan → brief"
  click A2 "teams/<team>/<thread>.status.md" "status"

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
