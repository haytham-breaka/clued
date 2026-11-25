# Run summary

model sonnet, reps 5, max-turns 12, spent $0.9207 of $1.2

Frozen sources (sha256): model.ts ef996bd5f04b, inbox.ts 9220708c58b5, guide.ts 9aa3dcfa0c77; APP_GUIDE 3692 chars.

## Set: hard (10 runs)

Mean ± sd per run, over every run of the set (scenarios pooled).

| metric | A threadline | B plain | A − B (stratified by scenario) | permutation p |
|---|---|---|---|---|
| cost $ | 0.0857 ± 0.0043 | 0.0709 ± 0.0011 | 0.0147 | 0.007 |
| input tokens (all) | 185,440 ± 11,620 | 170,079 ± 9,293 | 15,361 | 0.036 |
| output tokens | 2,002 ± 218 | 1,595 ± 141 | 407 | 0.016 |
| cache ratio | 93% ± 0% | 94% ± 0% | -1% | 0.035 |
| API calls | 7.8 ± 0.4 | 7.8 ± 0.4 | 0.0 | 1.000 |
| last context | 25,442 ± 354 | 23,091 ± 142 | 2,351 | 0.007 |
| turn time s | 20.8 ± 1.8 | 18.4 ± 0.7 | 2.4 | 0.029 |
| wall time s | 31.6 ± 1.8 | 29.3 ± 0.7 | 2.3 | 0.029 |
| messages answered (final, regex) | 60% ± 22% | 100% ± 0% | -40% | 0.045 |
| ... or answered by a reaction only (A) | 60% ± 22% | 100% ± 0% | -40% | 0.045 |
| reaction-only replies per run | 0.00 ± 0.00 | 0.00 ± 0.00 | 0.00 | 1.000 |
| messages attributed (plain-text rubric) | 52% ± 27% | 100% ± 0% | -48% | 0.045 |
| mid-turn messages answered | 43% ± 32% | 100% ± 0% | -57% | 0.045 |
| project checks passed | 100% ± 0% | 100% ± 0% | 0% | 1.000 |
| judge: answered fully | 50% ± 28% | 100% ± 0% | -50% | 0.045 |
| judge: correct | 52% ± 27% | 100% ± 0% | -48% | 0.045 |
| judge: clear which reply answers it | 50% ± 28% | 100% ± 0% | -50% | 0.045 |
| judge: misattributed messages per run | 0.00 ± 0.00 | 0.00 ± 0.00 | 0.00 | 1.000 |
| judge: corrections followed | 20% ± 45% | 100% ± 0% | -80% | 0.045 |

A reply structure over 50 messages: own 21, missing 20, other 5, grouped 4; tags on 15/15 final answers; 0 marks naming unknown ids; 0 tag entries with made-up ids ().

### Per scenario (mean ± sd)

| scenario | arm | n | cost $ | input | output | turn s | answered | attributed | checks | judge clear | judge misattr. |
|---|---|---|---|---|---|---|---|---|---|---|---|
| burst | A | 5 | 0.0857 ± 0.0043 | 185,440 ± 11,620 | 2,002 ± 218 | 20.8 ± 1.8 | 60% ± 22% | 52% ± 27% | 100% ± 0% | 50% ± 28% | 0.0 ± 0.0 |
| burst | B | 5 | 0.0709 ± 0.0011 | 170,079 ± 9,293 | 1,595 ± 141 | 18.4 ± 0.7 | 100% ± 0% | 100% ± 0% | 100% ± 0% | 100% ± 0% | 0.0 ± 0.0 |

### Arm A overhead

- first-call context: A 20,614 ± 2, B 19,434 ± 2; A − B per scenario 1180
- notes: 50 sent, 211 chars on average (max 458), ~68 tokens each
- tags: 0 chars per final answer on average, ~0 output tokens
