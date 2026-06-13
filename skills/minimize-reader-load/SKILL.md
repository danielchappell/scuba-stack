---
name: minimize-reader-load
description: Guidance for writing code and docs that are cheap to read. Use when writing or reviewing any code, naming things, or structuring a module. Code is read far more than written, so reduce what a reader must hold in their head to understand it.
---

# Minimize Reader Load

Every line is written once and read many times, by reviewers, by teammates, by you in six months with no memory of today. Optimize for that reader, because they pay the recurring cost.

## Reduce what must be held in the head

A reader understands a piece by keeping its moving parts in working memory. Fewer parts is easier. Short functions with one job, narrow scope, and few live variables at a time beat a clever block that requires tracking eight things at once.

## Name for intent

A good name removes the need to read the implementation to know what something does. Name by what it means and why it exists, not by how it currently works, so the name survives the next refactor.

## Keep related things close

Put things that change together near each other, and keep the definition near the use. Locality lets a reader understand a change without paging through the whole file. Distance is cognitive cost.

## Prefer explicit over clever

A clever one-liner that takes a minute to decode is more expensive than three plain lines that take five seconds. Save cleverness for where it genuinely earns its keep, and delete dead paths so no one has to wonder whether they matter.
