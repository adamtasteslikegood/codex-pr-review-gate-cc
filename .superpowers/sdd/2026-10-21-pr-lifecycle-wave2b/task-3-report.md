# Task 3 report (R91)
Status: DONE. Added LifecycleRecord.ownReplies, replyIdsOf (core.ts), withOwnReplies (round.ts) recorded in afterTriage and afterFix, and fetchFeedback now treats ownReplies as the gate's own. Test added in flow.test.ts (untriagedFeedback already existed; imported it). Suite 507 pass, lint and typecheck clean.
Notes: afterFix records replies via a separate updateRecord right after readDispositions (the brief's fallback), since its main patch is on the run, not the record.

## Fix round 1
1. ownReplies now survives a reset: archiveLifecycle's seed (comment updated) and the fresh-start carry-over in register.tsx (line ~308, a second site the reviewer did not name) both copy it. Test: reset then fresh start keeps ['79'] and untriagedFeedback skips comment:79.
2. afterFix: answer computed once; the ownReplies write moved after the `after === null` guard.
3. withOwnReplies moved above afterTriage's JSDoc.
4. Test: a pre-PR fix step's replyId lands in ownReplies.
Suite 509 pass, 0 fail; lint and typecheck clean.
