---
name: html-executive-brief
description: Produces the per-epic brief that the chief of staff presents to the user at an epic's two bookends — a v1 architecture brief at design-done and a v2 executive brief at merge, both states in one updated file. Use this whenever an epic reaches a bookend and a brief is needed, or whenever the user or the chief of staff asks for an architecture brief, an executive brief, an epic report, or a product-and-architecture summary. The brief is a self-contained HTML document covering the work from two lenses, product and architecture, sourced from the control plane. Make sure to use this skill whenever rendering either bookend brief, and start from the bundled template rather than designing from scratch.
---

# HTML Executive Brief

You render the document that lands on the user's desk at an epic's bookends. It has one job: let a busy decision-maker grasp what an epic is building (or has built) and what it needs from them, at a glance and then in depth, from both a product and an architecture perspective.

## One file per epic, two bookend states

A brief is **per-epic**, not per-milestone, and the epic is the "milestone" — the chunk bigger than a single PR. The same file is written at **two bookends** and updated in place, never duplicated:

- **v1 — architecture brief, at design-done (before build).** "How this epic gets built." Lead the architecture lens with the design decision and the slice plan; the product lens carries the intended outcome. The gate trail shows spec and plan done, build upcoming; the decisions block carries the open design calls.
- **v2 — executive brief, at merge.** The *same file* updated to "the finished chunk." Both lenses now describe what shipped; the gate trail runs through review and merge; the decisions block reduces to any residual.

The two states share one document and one design system. The shift between them is *when* it renders and *what* the fill points say, not a new layout and not a second file.

Always start from `template.html` in this skill folder. Clone its structure and design system; swap in real content from the control plane. Do not redesign it per brief, and do not invent a new layout. Consistency is the point: the user learns to read these fast because they always look the same.

## Source everything from the control plane

A brief is a compilation, not original work. Pull from:

- `roadmap.md` and the relevant `teams/<team>/status.md` for status and scope.
- `teams/<team>/spec.md` and `plan.md` for what was intended.
- `teams/<team>/decisions.md` for the calls already made and the ones still open.

If a fact isn't on the control plane, don't fabricate it. Mark it as unknown or leave it out. The brief's credibility is that everything in it is traceable to the control plane.

## The two lenses are mandatory

Every brief carries both, side by side:

- **Product lens** - what the work does for users and why it matters. Lead with the user-facing outcome in plain language, then key capabilities, then what's deliberately out of scope. Write from the user's side of the screen, not the system's.
- **Architecture lens** - how it's built. Lead with the core design decision in one sentence, then the key structural choices, then the standing technical risk. Precise but readable; this is for a technical decision-maker, not a spec.

Neither lens is optional and neither dominates. If you only have material for one, the epic isn't ready for a brief. At v1 each lens describes the design and the intended outcome; at v2 each describes what shipped.

## Lead with what needs a decision

The most valuable part of the brief is the "Needs your decision" block. At **v1** it carries the open design calls — the questions still on the table before build commits. At **v2** it reduces to any residual decisions left after merge. Each entry needs enough context to decide and a note on what the team recommends. If nothing needs a decision, say so explicitly rather than padding it.

## The gate trail

Mark the epic's position in the spec -> plan -> build -> review -> merge lifecycle honestly: completed gates as done, the active gate as current, the rest as upcoming, with real dates where the control plane has them. At **v1** the trail shows spec and plan done and build upcoming; at **v2** the same trail runs through review and merge. This is the one piece of structure the user reads first to orient, so it must be accurate to the bookend you're rendering.

## Fill points in the template

Work through the template's HTML comments. The swap points are: the masthead (eyebrow id/date/team, epic title, one-line thesis subtitle), the status ribbon, the gate trail states and dates, both lenses, the decisions block, the scope-strip metrics, and the footer provenance line. Keep the type system, palette, and layout exactly as given.

Which state populates which point:

- **v1 (architecture brief).** The masthead **eyebrow reads "architecture brief"**; the title is the epic with its brief state. The status ribbon shows build-upcoming. The gate trail stops at plan-done. The **decisions block carries the open design calls**. The scope-strip metrics are the slice plan (slices, decisions, open risks). Both lenses describe the design and intended outcome.
- **v2 (executive brief).** Update the *same file*: the eyebrow reads **"executive brief"**; the ribbon and gate trail run through merge; the decisions block is reduced to any residual; the scope-strip metrics reflect what shipped. Both lenses describe the finished chunk.

## Output

Write the finished brief to `.scuba/briefs/<epic>.html` as a single self-contained file (fonts via CDN, no external assets) — one file per epic, **updated in place** at v2 rather than started over. Never check it in. Then hand the path to the chief of staff to present. Write it with the target platform's file-edit tools, never with Bash heredocs (`cat > f << EOF`) — a heredoc silently truncates on a broken shell, landing a partial brief that reports success. Do not present it to the user yourself; that's the chief of staff's job.

## Anti-patterns

- Designing a new layout instead of cloning the template.
- Starting a fresh file at v2 instead of updating the epic's existing brief in place.
- Filling a lens with material the control plane doesn't support.
- Burying or omitting the decisions the epic needs from the user.
- A gate trail that doesn't match the real lifecycle state, or a v1 brief filled as if it were a v2 (e.g. a merge ribbon at design-done).
- Marketing tone. This is an internal brief; be plain and specific, not promotional.
