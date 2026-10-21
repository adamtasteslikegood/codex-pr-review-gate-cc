# Task 3 report (R91)
Status: DONE. Added LifecycleRecord.ownReplies, replyIdsOf (core.ts), withOwnReplies (round.ts) recorded in afterTriage and afterFix, and fetchFeedback now treats ownReplies as the gate's own. Test added in flow.test.ts (untriagedFeedback already existed; imported it). Suite 507 pass, lint and typecheck clean.
Notes: afterFix records replies via a separate updateRecord right after readDispositions (the brief's fallback), since its main patch is on the run, not the record.
