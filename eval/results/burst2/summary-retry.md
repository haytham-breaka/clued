# Run summary

model sonnet, reps 5, max-turns 12, spent $0.5138 of $1

Frozen sources (sha256): model.ts ef996bd5f04b, inbox.ts 674cc563a809, guide.ts 9aa3dcfa0c77; APP_GUIDE 3692 chars.

## Set: hard (5 runs)

Mean ± sd per run, over every run of the set (scenarios pooled).

| metric | A threadline | B plain | A − B (stratified by scenario) | permutation p |
|---|---|---|---|---|
| cost $ | 0.0897 ± 0.0057 | - | - | - |
| input tokens (all) | 213,463 ± 18,669 | - | - | - |
| output tokens | 2,093 ± 256 | - | - | - |
| cache ratio | 94% ± 0% | - | - | - |
| API calls | 9.0 ± 0.7 | - | - | - |
| last context | 25,508 ± 367 | - | - | - |
| turn time s | 19.1 ± 1.8 | - | - | - |
| wall time s | 28.7 ± 1.9 | - | - | - |
| messages answered (final, regex) | 96% ± 9% | - | - | - |
| ... or answered by a reaction only (A) | 96% ± 9% | - | - | - |
| reaction-only replies per run | 0.00 ± 0.00 | - | - | - |
| messages attributed (plain-text rubric) | 96% ± 9% | - | - | - |
| mid-turn messages answered | 94% ± 13% | - | - | - |
| project checks passed | 100% ± 0% | - | - | - |
| judge: answered fully | 98% ± 4% | - | - | - |
| judge: correct | 98% ± 4% | - | - | - |
| judge: clear which reply answers it | 96% ± 5% | - | - | - |
| judge: misattributed messages per run | 0.00 ± 0.00 | - | - | - |
| judge: corrections followed | 100% ± 0% | - | - | - |

A reply structure over 50 messages: own 39, grouped 10, missing 1; tags on 19/19 final answers; 0 marks naming unknown ids; 1 tag entries with made-up ids (D1).

### Per scenario (mean ± sd)

| scenario | arm | n | cost $ | input | output | turn s | answered | attributed | checks | judge clear | judge misattr. |
|---|---|---|---|---|---|---|---|---|---|---|---|
| burst | A | 5 | 0.0897 ± 0.0057 | 213,463 ± 18,669 | 2,093 ± 256 | 19.1 ± 1.8 | 96% ± 9% | 96% ± 9% | 100% ± 0% | 96% ± 5% | 0.0 ± 0.0 |

### Arm A overhead

- first-call context: A 20,614 ± 2, B -; A − B per scenario 
- notes: 50 sent, 208 chars on average (max 429), ~67 tokens each
- tags: 0 chars per final answer on average, ~0 output tokens
