---
name: html-executive-brief
description: Produces the milestone executive brief that the chief of staff presents to the user. Use this whenever a milestone is reached and a brief is needed, or whenever the user or the chief of staff asks for an executive brief, a milestone report, or a product-and-architecture summary. The brief is a self-contained HTML document covering the work from two lenses, product and architecture, sourced from the control plane. Make sure to use this skill whenever rendering a milestone brief, and start from the bundled template rather than designing from scratch.
---

# HTML Executive Brief

You render the document that lands on the user's desk at each milestone. It has one job: let a busy decision-maker grasp what was built and what it needs from them, at a glance and then in depth, from both a product and an architecture perspective.

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

Neither lens is optional and neither dominates. If you only have material for one, the milestone isn't ready for a brief.

## Lead with what needs a decision

The most valuable part of the brief is the "Needs your decision" block. Surface every open question that requires the user's input before the milestone's Review gate can close, each with enough context to decide and a note on what the team recommends. If nothing needs a decision, say so explicitly rather than padding it.

## The gate trail

Mark the milestone's position in the spec -> plan -> build -> QA -> review lifecycle honestly: completed gates as done, the active gate as current, the rest as upcoming, with real dates where the control plane has them. This is the one piece of structure the user reads first to orient, so it must be accurate.

## Fill points in the template

Work through the template's HTML comments. The swap points are: the masthead (eyebrow id/date/team, milestone title, one-line thesis subtitle), the status ribbon, the gate trail states and dates, both lenses, the decisions block, the scope-strip metrics, and the footer provenance line. Keep the type system, palette, and layout exactly as given.

## Output

Write the finished brief to `.scuba/briefs/<milestone>.html` as a single self-contained file (fonts via CDN, no external assets), then hand the path to the chief of staff to present. Do not present it to the user yourself; that's the chief of staff's job. Write the brief with the `Write`/`Edit` tools, never with Bash heredocs (`cat > f << EOF`) — a heredoc silently truncates on a broken shell, landing a partial brief that reports success.

## Anti-patterns

- Designing a new layout instead of cloning the template.
- Filling a lens with material the control plane doesn't support.
- Burying or omitting the decisions the milestone needs from the user.
- A gate trail that doesn't match the real lifecycle state.
- Marketing tone. This is an internal brief; be plain and specific, not promotional.
