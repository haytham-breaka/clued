// APP_GUIDE exactly as app/main.ts builds it (const APP_GUIDE; see main-app-guide.txt). model.ts and inbox.ts here are
// snapshots of hooks/model.ts and app/inbox.ts taken by eval/freeze.sh (SOURCES.txt says when); every run imports
// these, so edits to app/ or hooks/ during a run cannot change what a run sends.
import { FLAT_GUIDE } from './model.ts'
import { REPLY_GUIDE } from './inbox.ts'

export const APP_GUIDE = [
  FLAT_GUIDE,
  REPLY_GUIDE,
  'The user reads your replies in the threadline app as chat bubbles; your tool calls are folded into one line, so',
  'keep narration between tool calls short and put what matters in the final reply.',
  'To react to the user\'s latest message, add "react" to your tag. The user likes reactions: use one whenever it fits.',
  '"✅" a small request you finished with nothing more to say: the reaction is the whole reply, no "Done" text;',
  '"👍" noted: an FYI, a decision, or a go-ahead you act on; "👀" seen, on it: a message sent while you were busy;',
  '"🎉" good news. A reaction may also come with a reply when the reply adds something. None on praise alone.',
].join(' ')
