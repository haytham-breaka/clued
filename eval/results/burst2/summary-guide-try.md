# Run summary

model sonnet, reps 5, max-turns 12, spent $0.5605 of $1

Frozen sources (sha256): model.ts ef996bd5f04b, inbox.ts 61525c1ba4b7, guide.ts 9aa3dcfa0c77; APP_GUIDE 3853 chars.

## Set: hard (5 runs)

Mean ± sd per run, over every run of the set (scenarios pooled).

| metric | A threadline | B plain | A − B (stratified by scenario) | permutation p |
|---|---|---|---|---|
| cost $ | 0.0948 ± 0.0064 | - | - | - |
| input tokens (all) | 210,116 ± 23,074 | - | - | - |
| output tokens | 2,462 ± 211 | - | - | - |
| cache ratio | 94% ± 0% | - | - | - |
| API calls | 8.8 ± 0.8 | - | - | - |
| last context | 25,981 ± 620 | - | - | - |
| turn time s | 21.1 ± 1.7 | - | - | - |
| wall time s | 30.6 ± 1.7 | - | - | - |
| messages answered (final, regex) | 58% ± 11% | - | - | - |
| ... or answered by a reaction only (A) | 58% ± 11% | - | - | - |
| reaction-only replies per run | 0.00 ± 0.00 | - | - | - |
| messages attributed (plain-text rubric) | 52% ± 16% | - | - | - |
| mid-turn messages answered | 40% ± 16% | - | - | - |
| project checks passed | 100% ± 0% | - | - | - |
| judge: answered fully | 56% ± 13% | - | - | - |
| judge: correct | 60% ± 10% | - | - | - |
| judge: clear which reply answers it | 56% ± 13% | - | - | - |
| judge: misattributed messages per run | 0.00 ± 0.00 | - | - | - |
| judge: corrections followed | 40% ± 55% | - | - | - |

A reply structure over 50 messages: own 24, missing 15, other 7, grouped 4; tags on 15/15 final answers; 0 marks naming unknown ids; 0 tag entries with made-up ids ().

### Per scenario (mean ± sd)

| scenario | arm | n | cost $ | input | output | turn s | answered | attributed | checks | judge clear | judge misattr. |
|---|---|---|---|---|---|---|---|---|---|---|---|
| burst | A | 5 | 0.0948 ± 0.0064 | 210,116 ± 23,074 | 2,462 ± 211 | 21.1 ± 1.7 | 58% ± 11% | 52% ± 16% | 100% ± 0% | 56% ± 13% | 0.0 ± 0.0 |

### Arm A overhead

- first-call context: A 20,663 ± 3, B -; A − B per scenario 
- notes: 50 sent, 226 chars on average (max 463), ~73 tokens each
- tags: 0 chars per final answer on average, ~0 output tokens
