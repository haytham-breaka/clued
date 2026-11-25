# Run summary

model sonnet, max-turns 10, total cost $0.5250 (budget $3)

| scenario | arm | cost $ | wall s | API calls | input (fresh / cache read / cache write) | output | cache ratio | ctx first → last | answered (final) | A attribution | checks | tags |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| correction | A | 0.0622 | 19.8 | 4 | 8 / 77248 / 10019 | 1424 | 88.5% | 20376 → 23421 | 2/2 (any text 2) | m1:grouped m2:grouped | 3/3 | 1/1 |
| correction | B | 0.0570 | 17.6 | 4 | 8 / 73965 / 9094 | 1305 | 89.0% | 19451 → 22487 | 2/2 (any text 2) | - | 3/3 | - |
| busy-burst | A | 0.0499 | 14.6 | 4 | 8 / 76431 / 8767 | 702 | 89.7% | 20369 → 22169 | 3/3 (any text 3) | m1:own m2:own m3:own | 2/2 | 1/1 |
| busy-burst | B | 0.0450 | 13.7 | 4 | 8 / 74071 / 7906 | 587 | 90.3% | 19446 → 21299 | 3/3 (any text 3) | - | 2/2 | - |
| two-questions | A | 0.0383 | 10.7 | 2 | 4 / 33810 / 7853 | 334 | 81.1% | 20412 → 21255 | 1/1 (any text 1) | m1:own | 0/0 | 1/1 |
| two-questions | B | 0.0337 | 10.2 | 2 | 4 / 32839 / 6869 | 285 | 82.7% | 19450 → 20262 | 1/1 (any text 1) | - | 0/0 | - |
| follow-up | A | 0.0502 | 16.9 | 5 | 10 / 96343 / 8267 | 730 | 92.1% | 20359 → 21669 | 2/2 (any text 2) | m1:own m2:own | 1/1 | 2/2 |
| follow-up | B | 0.0430 | 15.4 | 5 | 10 / 92540 / 7086 | 523 | 92.9% | 19434 → 20479 | 2/2 (any text 2) | - | 1/1 | - |
| tool-task | A | 0.0457 | 15.0 | 4 | 8 / 75990 / 8062 | 575 | 90.4% | 20381 → 21464 | 2/2 (any text 2) | m1:own m2:own | 0/0 | 2/2 |
| tool-task | B | 0.0424 | 15.4 | 4 | 8 / 73268 / 7220 | 603 | 91.0% | 19458 → 20613 | 2/2 (any text 2) | - | 0/0 | - |

## Per arm

| arm | runs | cost $ | wall s | API calls | all input tokens | output | cache ratio | answered final | answered any | mid-turn answered | checks | judge answered=2 | judge clear=2 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A | 5 | 0.2462 | 77 | 19 | 402828 | 3765 | 89% | 100% (10/10) | 100% | 3/3 | 6/6 | 10/10 | 10/10 |
| B | 5 | 0.2211 | 72 | 19 | 384896 | 3303 | 90% | 100% (10/10) | 100% | 3/3 | 6/6 | 10/10 | 10/10 |

## Arm A overhead

- correction: first-call context A 20376 vs B 19451: +925 tokens for APP_GUIDE (2870 chars) + first note (38 chars)
- busy-burst: first-call context A 20369 vs B 19446: +923 tokens for APP_GUIDE (2870 chars) + first note (38 chars)
- two-questions: first-call context A 20412 vs B 19450: +962 tokens for APP_GUIDE (2870 chars) + first note (116 chars)
- follow-up: first-call context A 20359 vs B 19434: +925 tokens for APP_GUIDE (2870 chars) + first note (38 chars)
- tool-task: first-call context A 20381 vs B 19458: +923 tokens for APP_GUIDE (2870 chars) + first note (38 chars)
- median first-call delta 925 tokens, about 3.14 chars a token
- notes: 10 sent, 730 chars in all (~232 tokens), each re-read on every later call
- tags: 972 chars of <threadline> tags in final answers (~309 output tokens); 4 <<reply>> marks

## Context per main-thread API call

- correction A: 20376 21314 22164 23421
- correction B: 19451 20020 21109 22487
- busy-burst A: 20369 20939 21729 22169
- busy-burst B: 19446 20278 20962 21299
- two-questions A: 20412 21255
- two-questions B: 19450 20262
- follow-up A: 20359 20603 20760 21229 21669
- follow-up B: 19434 19670 19796 20257 20479
- tool-task A: 20381 20945 21270 21464
- tool-task B: 19458 20025 20400 20613
