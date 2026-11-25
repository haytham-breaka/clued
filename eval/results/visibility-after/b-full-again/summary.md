# Can you see what was answered? (summary)

130 recorded runs; screen 120×40 (clued: panel 38 columns); glance haiku, truth sonnet; spent $0.5454 of $0.62.

Truth pairs (moment × message): A {"done":659,"waiting":195,"working":141}, B {"done":694,"waiting":166,"working":135}. Rules and judge name the same answering block for 0/0 messages.

## Every moment

| reader | pairs | answered or not | still open | exact state | answer found | which reply (when it said answered) | can't tell | not answered, looked answered | open, looked done | done, looked open |
|---|---|---|---|---|---|---|---|---|---|---|
| A panel | 995 | 100% | 99% | 99% | 100% | 100% (648) | 0% | 0/141 | 3/336 | 8/659 |
| B glance | 995 | 86% | 77% | 77% | 83% | 98% (575) | 14% | 4/135 | 93/301 | 2/694 |
| B full read | 280 | 100% | 88% | 88% | 98% | 98% (233) | 0% | 0/0 | 31/41 | 3/239 |

## At the end only

| reader | pairs | answered or not | still open | exact state | answer found | which reply (when it said answered) | can't tell | not answered, looked answered | open, looked done | done, looked open |
|---|---|---|---|---|---|---|---|---|---|---|
| A panel | 280 | 100% | 96% | 96% | 100% | 100% (229) | 0% | 0/0 | 3/45 | 7/235 |
| B glance | 280 | 86% | 76% | 76% | 84% | 98% (201) | 14% | 0/0 | 28/41 | 0/239 |
| B full read | 280 | 100% | 88% | 88% | 98% | 98% (233) | 0% | 0/0 | 31/41 | 3/239 |

## Hard set, every moment

| reader | pairs | answered or not | still open | exact state | answer found | which reply (when it said answered) | can't tell | not answered, looked answered | open, looked done | done, looked open |
|---|---|---|---|---|---|---|---|---|---|---|
| A panel | 915 | 100% | 99% | 99% | 100% | 100% (597) | 0% | 0/121 | 3/307 | 3/608 |
| B glance | 915 | 85% | 75% | 75% | 81% | 98% (520) | 15% | 4/115 | 88/276 | 2/639 |
| B full read | 230 | 100% | 87% | 87% | 97% | 98% (188) | 0% | 0/0 | 26/36 | 3/194 |

## Every moment, offers without a question left out

| reader | pairs | answered or not | still open | exact state | answer found | which reply (when it said answered) | can't tell | not answered, looked answered | open, looked done | done, looked open |
|---|---|---|---|---|---|---|---|---|---|---|
| A panel | 992 | 100% | 99% | 99% | 100% | 100% (648) | 0% | 0/141 | 0/333 | 8/659 |
| B glance | 844 | 86% | 86% | 86% | 83% | 98% (575) | 13% | 4/135 | 4/150 | 2/694 |
| B full read | 239 | 100% | 99% | 99% | 98% | 98% (233) | 0% | 0/0 | 0/0 | 3/239 |

## Comparisons (per-run means; mean over scenarios of X − Y; permutation p, labels shuffled within scenario, 5,000 shuffles)

| X vs Y | answered or not | still open | exact state | answer found | not answered, looked answered (per run) | open, looked done (per run) | done, looked open (per run) |
|---|---|---|---|---|---|---|---|
| A panel vs B glance (all) | +4 pt (p <0.001) | +10 pt (p <0.001) | +10 pt (p <0.001) | +5 pt (p <0.001) | -0.06 (p 0.221) | -1.38 (p <0.001) | 0.09 (p 0.155) |
| A panel vs B glance (end) | +7 pt (p <0.001) | +13 pt (p <0.001) | +13 pt (p <0.001) | +9 pt (p <0.001) | 0.00 (p 1.000) | -0.38 (p <0.001) | 0.11 (p 0.003) |
| A panel vs B glance (hard) | +7 pt (p <0.001) | +16 pt (p <0.001) | +16 pt (p <0.001) | +9 pt (p <0.001) | -0.10 (p 0.224) | -2.13 (p <0.001) | 0.03 (p 1.000) |
| A panel vs B glance (no offers) | +4 pt (p <0.001) | +2 pt (p 0.180) | +2 pt (p 0.180) | +5 pt (p <0.001) | -0.06 (p 0.221) | -0.06 (p 0.221) | 0.09 (p 0.155) |

## Per scenario, every moment (answered or not / still open / answer found)

| scenario | A panel | B glance | B full read |
|---|---|---|---|
| busy-burst | 100% / 100% / 100% | 100% / 100% / 100% | 100% / 100% / 100% |
| continuation | 100% / 100% / 100% | 100% / 67% / 100% | 100% / 68% / 100% |
| correction | 100% / 67% / 100% | 100% / 67% / 100% | 100% / 50% / 100% |
| follow-up | 100% / 100% / 100% | 100% / 100% / 100% | 100% / 100% / 100% |
| interleaved | 100% / 100% / 100% | 71% / 62% / 70% | 100% / 83% / 100% |
| late-correction | 100% / 100% / 100% | 99% / 75% / 100% | 100% / 84% / 100% |
| midturn-edits | 100% / 100% / 100% | 97% / 97% / 96% | 100% / 100% / 92% |
| midturn-flood | 99% / 99% / 98% | 97% / 97% / 95% | 100% / 100% / 97% |
| numbered | 100% / 100% / 100% | 100% / 100% / 100% | 90% / 80% / 90% |
| open-question | 100% / 100% / 100% | 89% / 81% / 80% | 100% / 88% / 94% |
| quotes | 100% / 95% / 100% | 89% / 88% / 87% | 100% / 93% / 100% |
| tool-task | 100% / 100% / 100% | 100% / 100% / 100% | 100% / 100% / 100% |
| two-questions | 100% / 100% / 100% | 100% / 100% / 100% | 100% / 100% / 100% |

## Waiting on you, by how Claude asked (pairs seen as open / looked done / all)

- A panel: asked with "?": 192/0/192; offered without one: 0/3/3
- B glance: asked with "?": 15/0/15; offered without one: 37/89/151
- B full read: asked with "?": 0/0/0; offered without one: 10/31/41

Reading: {"A":{"frames":280,"screenWords":183,"fullWordsAtEnd":323,"screenChars":2845,"fullCharsAtEnd":4391},"B":{"frames":280,"screenWords":133,"fullWordsAtEnd":233,"screenChars":964,"fullCharsAtEnd":1692}}

Spend: {"glance (haiku)":{"calls":466,"usd":0.4287},"full (haiku)":{"calls":130,"usd":0.1166}}
