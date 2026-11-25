# Run summary

model sonnet, reps 5, max-turns 12, spent $0.8660 of $1.9

Frozen sources (sha256): model.ts 4845128fc262, inbox.ts 470611e6fc97, guide.ts 7a1209c43adc; APP_GUIDE 3423 chars.

## Set: hard (10 runs)

Mean ± sd per run, over every run of the set (scenarios pooled).

| metric | A threadline | B plain | A − B (stratified by scenario) | permutation p |
|---|---|---|---|---|
| cost $ | 0.0749 ± 0.0020 | 0.0733 ± 0.0070 | 0.0015 | 0.641 |
| input tokens (all) | 162,572 ± 1,265 | 183,377 ± 26,738 | -20,805 | 0.146 |
| output tokens | 1,455 ± 85 | 1,659 ± 271 | -204 | 0.178 |
| cache ratio | 93% ± 0% | 95% ± 1% | -2% | 0.007 |
| API calls | 7.0 ± 0.0 | 8.4 ± 1.1 | -1.4 | 0.050 |
| last context | 24,658 ± 275 | 23,197 ± 424 | 1,460 | 0.007 |
| turn time s | 16.5 ± 0.6 | 18.8 ± 2.3 | -2.3 | 0.065 |
| wall time s | 27.5 ± 0.7 | 29.7 ± 2.6 | -2.3 | 0.086 |
| messages answered (final, regex) | 100% ± 0% | 96% ± 5% | 4% | 0.452 |
| ... or answered by a reaction only (A) | 100% ± 0% | 96% ± 5% | 4% | 0.452 |
| reaction-only replies per run | 0.00 ± 0.00 | 0.00 ± 0.00 | 0.00 | 1.000 |
| messages attributed (plain-text rubric) | 100% ± 0% | 96% ± 5% | 4% | 0.452 |
| mid-turn messages answered | 100% ± 0% | 94% ± 8% | 6% | 0.452 |
| project checks passed | 100% ± 0% | 100% ± 0% | 0% | 1.000 |
| judge: answered fully | 100% ± 0% | 100% ± 0% | 0% | 1.000 |
| judge: correct | 100% ± 0% | 100% ± 0% | 0% | 1.000 |
| judge: clear which reply answers it | 100% ± 0% | 100% ± 0% | 0% | 1.000 |
| judge: misattributed messages per run | 0.00 ± 0.00 | 0.00 ± 0.00 | 0.00 | 1.000 |
| judge: corrections followed | 100% ± 0% | 100% ± 0% | 0% | 1.000 |

A reply structure over 50 messages: own 30, grouped 20; tags on 15/15 final answers; 0 marks naming unknown ids; 0 tag entries with made-up ids ().

### Per scenario (mean ± sd)

| scenario | arm | n | cost $ | input | output | turn s | answered | attributed | checks | judge clear | judge misattr. |
|---|---|---|---|---|---|---|---|---|---|---|---|
| burst | A | 5 | 0.0749 ± 0.0020 | 162,572 ± 1,265 | 1,455 ± 85 | 16.5 ± 0.6 | 100% ± 0% | 100% ± 0% | 100% ± 0% | 100% ± 0% | 0.0 ± 0.0 |
| burst | B | 5 | 0.0733 ± 0.0070 | 183,377 ± 26,738 | 1,659 ± 271 | 18.8 ± 2.3 | 96% ± 5% | 96% ± 5% | 100% ± 0% | 100% ± 0% | 0.0 ± 0.0 |

### Arm A overhead

- first-call context: A 20,521 ± 2, B 19,433 ± 3; A − B per scenario 1087
- notes: 50 sent, 211 chars on average (max 434), ~68 tokens each
- tags: 305 chars per final answer on average, ~98 output tokens
