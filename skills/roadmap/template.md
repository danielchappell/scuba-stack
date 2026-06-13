# <Project> — Roadmap · state of the world
_Resume anchor. The chief of staff reads this FIRST every session and keeps it current
on every monitor tick. If the conversation is lost, this plus the linked files under
`.scuba/` are how a fresh chief of staff recovers every in-flight thread._
updated: <YYYY-MM-DD HH:MM> · by: <chief-of-staff | scribe>

Legend: 🟡 spec · 🔵 plan · ⛔ blocked · 🟢 execution · 🔎 review · ✅ done · 💤 parked

## ⛳ Decisions waiting on you
_(Keep this at the top. Empty when there are none; never bury a decision in the tree.)_
1. <thread> — <the call, in one line> → <.scuba/teams/<team>/decisions.md>

## <Initiative / chunk> · <stage> · manager: <name> · goal: <one line>
_(`##` = a chief→manager chunk; the children are its worker threads. Indent further for sub-threads.)_
├─ <stage> <thread-id> — <one-line goal> · owner: <worker/agent>
│     branch <branch> · wt <../worktree-path> · last <sha> "<commit subject>"
│     spec <.scuba/teams/<team>/spec.md> · plan <…> · status <…> · brief <… | —> · PR <#n (x/y resolved) | —>
│     next: <next step>
└─ <stage> <thread-id> — <one-line goal> · owner: <worker/agent>
      branch <branch> · wt <../worktree-path> · last <sha>
      ⛔ blocked-by: <what it's waiting on>

## <Initiative / chunk> · <stage> · manager: <name> · goal: <one line>
└─ <stage> <thread-id> — <one-line goal> · owner: <worker/agent> · <artifact links>

## 💤 Parked / later
- <thread> — <why parked, one line>

## 🩺 Last monitor tick (<HH:MM>)
<thread> <sha> <live | idle Nm> · <thread> <sha> <…>
