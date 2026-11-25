# Run summary

model sonnet, reps 5, max-turns 12, spent $9.6508 of $24.5

Frozen sources (sha256): model.ts 4845128fc262, inbox.ts 470611e6fc97, guide.ts 7a1209c43adc; APP_GUIDE 3423 chars.

## Set: hard (80 runs)

Mean ± sd per run, over every run of the set (scenarios pooled).

| metric | A threadline | B plain | A − B (stratified by scenario) | permutation p |
|---|---|---|---|---|
| cost $ | 0.0800 ± 0.0236 | 0.0732 ± 0.0193 | 0.0068 | 0.000 |
| input tokens (all) | 228,779 ± 121,843 | 229,905 ± 120,404 | -1,127 | 0.778 |
| output tokens | 1,630 ± 710 | 1,457 ± 493 | 173 | 0.000 |
| cache ratio | 94% ± 2% | 95% ± 2% | -1% | 0.000 |
| API calls | 10.2 ± 5.1 | 10.8 ± 5.5 | -0.7 | 0.000 |
| last context | 23,820 ± 1,356 | 22,484 ± 1,056 | 1,336 | 0.000 |
| turn time s | 18.6 ± 9.5 | 20.8 ± 20.3 | -2.2 | 0.861 |
| wall time s | 33.6 ± 14.9 | 36.2 ± 21.5 | -2.6 | 0.699 |
| messages answered (final, regex) | 98% ± 6% | 99% ± 4% | -1% | 0.322 |
| ... or answered by a reaction only (A) | 100% ± 0% | 99% ± 4% | 1% | 0.437 |
| reaction-only replies per run | 0.15 ± 0.36 | 0.00 ± 0.00 | 0.15 | 0.010 |
| messages attributed (plain-text rubric) | 98% ± 6% | 99% ± 4% | -1% | 0.284 |
| mid-turn messages answered | 100% ± 0% | 97% ± 7% | 3% | 0.454 |
| project checks passed | 100% ± 0% | 99% ± 3% | 1% | 1.000 |
| judge: answered fully | 100% ± 3% | 100% ± 0% | 0% | 1.000 |
| judge: correct | 100% ± 0% | 100% ± 0% | 0% | 1.000 |
| judge: clear which reply answers it | 99% ± 4% | 100% ± 0% | -1% | 0.219 |
| judge: misattributed messages per run | 0.00 ± 0.00 | 0.00 ± 0.00 | 0.00 | 1.000 |
| judge: corrections followed | 100% ± 0% | 100% ± 0% | 0% | 1.000 |

A reply structure over 230 messages: own 205, shared 8, other 2, missing 5, grouped 10; tags on 186/186 final answers; 0 marks naming unknown ids; 6 tag entries with made-up ids (T1-discount).

### Per scenario (mean ± sd)

| scenario | arm | n | cost $ | input | output | turn s | answered | attributed | checks | judge clear | judge misattr. |
|---|---|---|---|---|---|---|---|---|---|---|---|
| continuation | A | 5 | 0.0775 ± 0.0023 | 220,476 ± 880 | 1,661 ± 166 | 17.2 ± 1.3 | 100% ± 0% | 100% ± 0% | 100% ± 0% | 100% ± 0% | 0.0 ± 0.0 |
| continuation | B | 5 | 0.0673 ± 0.0022 | 208,890 ± 771 | 1,317 ± 150 | 15.8 ± 2.5 | 100% ± 0% | 100% ± 0% | 100% ± 0% | 100% ± 0% | 0.0 ± 0.0 |
| interleaved | A | 5 | 0.1339 ± 0.0137 | 499,181 ± 47,642 | 3,211 ± 487 | 39.8 ± 10.3 | 100% ± 0% | 98% ± 4% | 100% ± 0% | 98% ± 4% | 0.0 ± 0.0 |
| interleaved | B | 5 | 0.1155 ± 0.0016 | 500,589 ± 10,566 | 2,413 ± 82 | 34.9 ± 5.8 | 100% ± 0% | 98% ± 4% | 100% ± 0% | 100% ± 0% | 0.0 ± 0.0 |
| late-correction | A | 5 | 0.0834 ± 0.0012 | 265,798 ± 480 | 1,746 ± 69 | 19.4 ± 2.4 | 96% ± 9% | 96% ± 9% | 100% ± 0% | 100% ± 0% | 0.0 ± 0.0 |
| late-correction | B | 5 | 0.0746 ± 0.0011 | 251,882 ± 603 | 1,466 ± 91 | 16.4 ± 0.6 | 100% ± 0% | 100% ± 0% | 100% ± 0% | 100% ± 0% | 0.0 ± 0.0 |
| midturn-edits | A | 5 | 0.0681 ± 0.0056 | 130,622 ± 25,816 | 1,259 ± 123 | 14.4 ± 3.8 | 100% ± 0% | 100% ± 0% | 100% ± 0% | 100% ± 0% | 0.0 ± 0.0 |
| midturn-edits | B | 5 | 0.0664 ± 0.0035 | 142,679 ± 12,347 | 1,337 ± 187 | 15.8 ± 2.1 | 100% ± 0% | 100% ± 0% | 100% ± 0% | 100% ± 0% | 0.0 ± 0.0 |
| midturn-flood | A | 5 | 0.0673 ± 0.0022 | 134,469 ± 16,474 | 1,284 ± 61 | 14.4 ± 1.6 | 100% ± 0% | 100% ± 0% | 100% ± 0% | 100% ± 0% | 0.0 ± 0.0 |
| midturn-flood | B | 5 | 0.0609 ± 0.0081 | 123,531 ± 20,324 | 1,223 ± 240 | 37.9 ± 55.3 | 93% ± 9% | 93% ± 9% | 100% ± 0% | 100% ± 0% | 0.0 ± 0.0 |
| numbered | A | 5 | 0.0497 ± 0.0015 | 93,809 ± 11,487 | 693 ± 40 | 8.1 ± 0.3 | 100% ± 0% | 100% ± 0% | - | 100% ± 0% | 0.0 ± 0.0 |
| numbered | B | 5 | 0.0461 ± 0.0009 | 100,799 ± 681 | 716 ± 48 | 8.2 ± 0.5 | 100% ± 0% | 100% ± 0% | - | 100% ± 0% | 0.0 ± 0.0 |
| open-question | A | 5 | 0.0809 ± 0.0033 | 220,972 ± 15,911 | 1,731 ± 127 | 18.5 ± 1.7 | 100% ± 0% | 100% ± 0% | 100% ± 0% | 100% ± 0% | 0.0 ± 0.0 |
| open-question | B | 5 | 0.0809 ± 0.0033 | 231,555 ± 1,536 | 1,884 ± 180 | 19.5 ± 1.1 | 100% ± 0% | 100% ± 0% | 100% ± 0% | 100% ± 0% | 0.0 ± 0.0 |
| quotes | A | 5 | 0.0793 ± 0.0021 | 264,902 ± 17,766 | 1,459 ± 54 | 17.4 ± 1.0 | 87% ± 7% | 87% ± 7% | 100% ± 0% | 93% ± 9% | 0.0 ± 0.0 |
| quotes | B | 5 | 0.0738 ± 0.0034 | 279,315 ± 19,430 | 1,302 ± 75 | 17.9 ± 1.4 | 100% ± 0% | 100% ± 0% | 96% ± 9% | 100% ± 0% | 0.0 ± 0.0 |

### Arm A overhead

- first-call context: A 20,559 ± 39, B 19,460 ± 19; A − B per scenario 1089, 1089, 1088, 1088, 1090, 1176, 1087, 1090
- notes: 230 sent, 107 chars on average (max 302), ~34 tokens each
- tags: 148 chars per final answer on average, ~48 output tokens
## Set: baseline (50 runs)

Mean ± sd per run, over every run of the set (scenarios pooled).

| metric | A threadline | B plain | A − B (stratified by scenario) | permutation p |
|---|---|---|---|---|
| cost $ | 0.0494 ± 0.0075 | 0.0449 ± 0.0078 | 0.0046 | 0.000 |
| input tokens (all) | 82,131 ± 22,102 | 78,853 ± 20,121 | 3,278 | 0.079 |
| output tokens | 700 ± 331 | 684 ± 334 | 16 | 0.491 |
| cache ratio | 88% ± 4% | 89% ± 3% | -1% | 0.000 |
| API calls | 3.8 ± 1.0 | 3.9 ± 1.0 | -0.0 | 1.000 |
| last context | 22,134 ± 828 | 21,088 ± 915 | 1,046 | 0.000 |
| turn time s | 10.5 ± 4.0 | 10.8 ± 5.0 | -0.2 | 0.754 |
| wall time s | 22.1 ± 4.4 | 22.9 ± 4.2 | -0.8 | 0.414 |
| messages answered (final, regex) | 100% ± 0% | 100% ± 0% | 0% | 1.000 |
| ... or answered by a reaction only (A) | 100% ± 0% | 100% ± 0% | 0% | 1.000 |
| reaction-only replies per run | 0.00 ± 0.00 | 0.00 ± 0.00 | 0.00 | 1.000 |
| messages attributed (plain-text rubric) | 100% ± 0% | 100% ± 0% | 0% | 1.000 |
| mid-turn messages answered | 100% ± 0% | 100% ± 0% | 0% | 1.000 |
| project checks passed | 100% ± 0% | 100% ± 0% | 0% | 1.000 |
| judge: answered fully | 100% ± 0% | 100% ± 0% | 0% | 1.000 |
| judge: correct | 100% ± 0% | 100% ± 0% | 0% | 1.000 |
| judge: clear which reply answers it | 100% ± 0% | 100% ± 0% | 0% | 1.000 |
| judge: misattributed messages per run | 0.00 ± 0.00 | 0.00 ± 0.00 | 0.00 | 1.000 |
| judge: corrections followed | 100% ± 0% | 100% ± 0% | 0% | 1.000 |

A reply structure over 50 messages: own 40, grouped 10; tags on 35/35 final answers; 0 marks naming unknown ids; 3 tag entries with made-up ids (T3).

### Per scenario (mean ± sd)

| scenario | arm | n | cost $ | input | output | turn s | answered | attributed | checks | judge clear | judge misattr. |
|---|---|---|---|---|---|---|---|---|---|---|---|
| busy-burst | A | 5 | 0.0513 ± 0.0023 | 90,938 ± 10,205 | 683 ± 49 | 10.3 ± 2.6 | 100% ± 0% | 100% ± 0% | 100% ± 0% | 100% ± 0% | 0.0 ± 0.0 |
| busy-burst | B | 5 | 0.0497 ± 0.0025 | 91,594 ± 12,109 | 738 ± 93 | 11.9 ± 2.8 | 100% ± 0% | 100% ± 0% | 100% ± 0% | 100% ± 0% | 0.0 ± 0.0 |
| correction | A | 5 | 0.0615 ± 0.0017 | 87,786 ± 307 | 1,298 ± 130 | 17.1 ± 2.1 | 100% ± 0% | 100% ± 0% | 100% ± 0% | 100% ± 0% | 0.0 ± 0.0 |
| correction | B | 5 | 0.0564 ± 0.0008 | 83,155 ± 155 | 1,269 ± 65 | 18.0 ± 5.0 | 100% ± 0% | 100% ± 0% | 100% ± 0% | 100% ± 0% | 0.0 ± 0.0 |
| follow-up | A | 5 | 0.0485 ± 0.0014 | 105,250 ± 281 | 568 ± 90 | 10.4 ± 2.0 | 100% ± 0% | 100% ± 0% | 100% ± 0% | 100% ± 0% | 0.0 ± 0.0 |
| follow-up | B | 5 | 0.0414 ± 0.0021 | 95,434 ± 8,965 | 453 ± 78 | 7.7 ± 1.4 | 100% ± 0% | 100% ± 0% | 100% ± 0% | 100% ± 0% | 0.0 ± 0.0 |
| tool-task | A | 5 | 0.0466 ± 0.0002 | 84,685 ± 33 | 594 ± 12 | 7.4 ± 0.5 | 100% ± 0% | 100% ± 0% | - | 100% ± 0% | 0.0 ± 0.0 |
| tool-task | B | 5 | 0.0421 ± 0.0004 | 80,398 ± 44 | 600 ± 26 | 7.6 ± 0.8 | 100% ± 0% | 100% ± 0% | - | 100% ± 0% | 0.0 ± 0.0 |
| two-questions | A | 5 | 0.0393 ± 0.0012 | 41,998 ± 243 | 358 ± 41 | 7.5 ± 0.9 | 100% ± 0% | 100% ± 0% | - | 100% ± 0% | 0.0 ± 0.0 |
| two-questions | B | 5 | 0.0348 ± 0.0028 | 43,685 ± 9,125 | 361 ± 117 | 8.7 ± 4.2 | 100% ± 0% | 100% ± 0% | - | 100% ± 0% | 0.0 ± 0.0 |

### Arm A overhead

- first-call context: A 20,541 ± 19, B 19,444 ± 9; A − B per scenario 1087, 1091, 1089, 1089, 1128
- notes: 50 sent, 73 chars on average (max 168), ~24 tokens each
- tags: 143 chars per final answer on average, ~46 output tokens
