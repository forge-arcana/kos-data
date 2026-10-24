# kos-data — Keppet Open Sports (public hot tier)

Free, keyless open sports data: evidence rows served straight from this repo
via jsDelivr. Event dossiers (current season + 90-day window), athlete/team
cards, registries, sport packs, schedules, schemas, the license register, and
`llms.txt` — everything an agent needs to answer with citations.

Start at `llms.txt` and `catalog.json`. Coverage gaps are first-class data:
what KOS cannot show is declared per sport in each pack's coverage block, and
refusals cite it. Deep history (all seasons, forward-accumulated state series)
is not in this mirror.

This repo is a build artifact — every file is force-synced by the private
builder's pipeline; nothing here is hand-edited. Consumer docs grow here as
the pilots (F1, tennis, football) come online.
