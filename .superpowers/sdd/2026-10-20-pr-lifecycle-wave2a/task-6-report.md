# Task 6 report
Implemented readRequired (github.ts); readChecks, requiredChecksOf, gatherStanding (round.ts); world.ts fakes for rules/protection endpoints; tests in github.test.ts and flow.test.ts.
TDD: RED = `claude plugin test pr-lifecycle` -> 180 pass / 2 fail (missing exports) before implementing. GREEN = 443 pass / 0 fail; npm run lint and typecheck clean.
Files: pr-lifecycle/hooks/github.ts, hooks/round.ts, tests/world.ts, tests/github.test.ts, tests/flow.test.ts.
Adaptations:
- rec.slug exists (types/index.d.ts:146); used as is.
- Test `$` has no process (host refuses it); added `w.engine` in world.ts, a stand-in whose process.run runs the same fake (handler body extracted into `fake`, process.run handler delegates). flow test calls requiredChecksOf(w.engine, ...).
- Brief's flow test bug: classicAnswer was still 'garbage' from the last case at the "later" check; reset to 'none' before it.
- Cache: cleared `required` in setup(c) (round.ts); keys are slug:base.
- Imported readRequired in a multi-line import (line length); added Standing/CheckState/standingOf imports.
- Unrelated pre-existing uncommitted changes in .superpowers/, docs plans/specs left unstaged.
