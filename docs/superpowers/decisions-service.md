# Decisions taken on the author's behalf — the service layer

Companion to `decisions-foundation.md`, covering the branch that added the repository layer, the API key,
the 46 MCP tools, the 23 internal HTTP routes and the backups.
Plan: `docs/superpowers/plans/2026-11-03-service.md`.
Spec: §§6–12 and §17 of `docs/superpowers/specs/2026-11-03-job-application-tracker-design.md`.

## Why this file exists

Each entry is a decision I took rather than asked about, because asking would have stopped the work and the
cost of being wrong was small and reversible. Each states what I decided, the reasoning, and **what it costs
if it is wrong** — that last clause is the useful part, because it is what lets you overturn any of them
cheaply. They appear in the order I made them.

Three groups are worth knowing before you read.

**Corrections to my own plan.** The plan was wrong in several places, and each was caught by a reviewer rather
than by me: a false claim that the MCP HTTP transport checks the API key; a request-merge order that let a
request body override the path id, so `PATCH /positions/5` could edit position 9; a function named
`writeKeyToEnvFile` that neither writes nor touches a file; a test call with the wrong signature; a test case
asking for something the sort order makes impossible; and one sentence — "the latest score per criteria set" —
that dropped a spec requirement before any implementer saw it.

**Five chassis facts the plan got wrong.** `ServiceConfig.auth` takes only an introspection URL; `ctx.requireAuth`
is a passthrough that allows every request when `auth` is unset; the MCP HTTP transport has no auth hook at all;
`createService` and `createDependency` live in `@open-tomato/service-express`, not `@open-tomato/service`; and the
rate limit defaults to 100 requests a minute. Every one was accurate in the package's published types and wrong
in its prose, which is where I read them from.

**One reversal of a preference the plan recorded as yours.** The plan said keyless local operation was your
explicit choice, justified as "loopback without a key". `createService` binds **every** interface — confirmed
three ways — so that premise is false and the offer was never the one you accepted. A missing or empty
`API_KEY` now refuses to start. If you want keyless local operation back, it needs either a host option
upstream or starting the Express app ourselves instead of through the chassis; say so and it is small.

## The 95 decisions

1. **Preflight.** `statusFor` also maps `CriteriaSetConflictError` to 409 — Task 5's `createCriteriaVersion` raises it through `insertCriteriaSet`, so without the branch `POST /api/criteria-sets` answers 500 for a duplicate the user can fix. The spec's §17 taxonomy intent is one status per surface-visible distinction, and a duplicate version is a conflict by the class's own name — if wrong, the cost is one `instanceof` branch and one assertion to remove.

2. **Preflight.** Task 16 owns the `requireApiKey` mount; Task 15's `mountRoutes` must not mount it. T15 lists it as consumed, but T16 step 3 is where the plan mounts it, conditionally on `API_KEY` being set. Mounting it in both would run the key check twice — if wrong, the cost is moving one line between two files.

3. **Preflight.** `.superpowers/` goes into `.gitignore` before Task 1. The skill's scripts write briefs, reports and review packages there and assume the path is ignored; this repo's `.gitignore` does not cover it, so an implementer's `git add` could commit review artefacts — if wrong, the cost is one line to revert.

4. **Task 1.** each implementer keeps the `Co-Authored-By` line its own harness gave it, so a haiku-written commit says Haiku 5.5 rather than Opus 5. The trailer names the model that wrote the code, which is the accurate record — if wrong, the cost is a trailer rewrite across the branch's commits.

5. **Task 2.** the brief's illustrative call `lintMigrations([file])` is wrong — the real signature takes a directory. The implementer lints the directory and filters to /^0009_.*\.sql$/, matching the existing pattern in tests/data/registries.test.ts, and that stands. The plan's test sketch was never run against the real signature when it was written; the codebase is the authority — if wrong, the cost is one test rewritten.

6. **Task 3.** the "archive input" schema named in the plan's File Structure stays out of common.ts. Its shape is `{ name, id }`, which is registry-specific rather than common, so it belongs beside the registry tools in Task 12 — if wrong, the cost is moving one small schema between two files.

7. **Task 3.** the guard and the insert stay separate statements. The guard exists for other repositories storing a reference to a vocabulary row; registries are the referents, so there is nothing to make atomic here, and a caller needing both in one unit passes a transaction, which is what the chosen Db shape is for — if wrong, the cost is wrapping one function body in a transaction.

8. **Task 3.** assertNotArchived's one SELECT per referencing column per row is left unoptimised. It is bounded by BULK_MAX on a single-user local database. Task 4 adds positions in bulk, each referencing seniority and workFormat, so a 500-row call could reach ~1000 SELECTs in one transaction; if that measures slow there, batch the guard then. Pre-optimising for a load that may never arrive is the YAGNI the constraints forbid — if wrong, the cost is one query rewritten as an IN-list.

9. **Task 3.** findRegistryRow(db, name, id) is added, returning the row whatever its archival state and raising NotFoundError when it is absent. The reviewer raised it as out of scope and I ruled it in: today the correct read of a stored reference to an archived row is an opt-in flag whose failure mode is a blank label rather than an error, and three later tasks must render exactly that — a position's latest stage event, the current stage with its flags, and route counts with their labels. So it is not speculative, and this is the last moment it costs one function instead of fourteen call sites — if wrong, the cost is one unused export.

10. **Task 3.** finding 2 ships without a test of its own. The re-reviewer looked for a fixture-free test and found none — no real registry has a second unique column, so no behavioural test can tell `find` over all columns from "first column only", and the only fixture-free alternative pins the schema rather than the handler. The structural fix stands on its own — if wrong, the cost is a synthetic fixture table added later.

11. **Task 4.** positionKey's default `<company_norm>/<role_norm>[/<disambiguator>]` stands, optional input. It is derivable from data the row already has, stable across re-imports, readable in a URL and uniquely constrainable — if wrong, the cost is a key format change plus a backfill.

12. **Task 4.** no single-item addPosition in the repository. The single/bulk pair belongs at the tool layer, where Task 12 defines each collection operation twice over this one function. Carried to Task 11: a single shared helper unwraps an index-0 BulkItemError to its cause, rather than every single-form tool repeating it — if wrong, the cost is one helper moved.

13. **Task 4.** searchPositions keeps `exclude` as the setAside default (a general search should not surface set-aside roles; the board asks for include) and returns no total (a short page ends the list at this scale, and counts belong to the Stats surface another plan owns). clientHidden is now filtered server-side with the same include/exclude shape and the same default, because returning it unfiltered while filtering setAside is an inconsistency a caller must learn rather than deduce, and both fields do the same job. lastImportedAt is written by nothing in this plan beyond the column default; the importers that will write it belong to the market-stats plan — if wrong, the cost is one filter removed.

14. **Task 4.** the tie-break test is rebuilt as a bound query, because a test whose failure depends on Postgres choosing a heap order may stop proving its clause silently. Ten rows with identical sort keys and ascending ids, request three, assert the three highest. With the clause the answer is forced; without it a sequential scan returns the lowest three, so the failure is structural — if wrong, the cost is one test rewritten.

15. **Task 4.** the 879-line tests/repositories/positions.test.ts stands. The project's size ceiling exempts test files whose size is justified by their role, and a cohesive file for the most-called functions qualifies. Recorded so the final review does not re-raise it — if wrong, the cost is a split along subject lines.

16. **Task 4.** updatePosition re-checks only references that differ from the stored value. It re-checked every reference present in the patch, so a client PATCHing a full object with an unchanged but since-archived seniorityId was refused, and the web app will PATCH full objects. Archival blocks a new reference, not the continued existence of one already stored — if wrong, the cost is one comparison removed and a stricter guard restored.

17. **Task 5.** createCriteriaVersion takes MAX(version) + 1 over the rows sharing the name, not source.version + 1. I checked the table first: criteria_set has no lineage column, only a (name, version) unique constraint, so the version number is a sequence and there is nothing for source.version + 1 to preserve. As built, copying v1 while v2 existed raised a 409 the user could not act on, and branching from v1's wording was impossible — if wrong, the cost is one aggregate reverted to an increment.

18. **Task 5.** the BackupSettings shape { enabled, keep, intervalDays } with defaults true / 1 / 14 stands. §12.2 asks for "a retention policy that replaces rather than accumulates: keep the last N, default to a fortnightly replace", so 14 is the fortnight and keep: 1 is the replace. Faithful to the spec — worth telling Marcos that keep is a settable value and 1 means a corrupt dump leaves nothing behind.

19. **Task 5.** RequirementRow.anchors stays typed `unknown`, narrowed by an exported RequirementAnchorsSchema at each consumer. The jsonb is hand-editable, so this is the unknown-for-untrusted-input rule rather than a compromise — if wrong, the cost is a type assertion at a handful of call sites.

20. **Task 5.** the two helper extractions stand — pickDefined into src/data/repositories/pick-defined.ts and booleanOrText into src/schemas/common.ts. Both were made when a second consumer appeared, which is when an abstraction is earned rather than speculative, and the positions tests still pass.

21. **Task 5.** the enabled fallback direction stays as it is — an unreadable `enabled` yields true, so backups run. For a backup, running when the setting cannot be read is the data-safe failure, and the log names the field. The earlier claim that a typo cannot switch backups back on holds only for a valid false beside other bad fields, so the fix is a test stating the real behaviour plus a doc line saying why on is safe — if wrong, the cost is one default flipped and one test rewritten.

22. **Task 5.** readBackupSettings must return a copy, not BACKUP_DEFAULTS itself. The object is neither frozen nor readonly, so a caller mutating the result corrupts the module's defaults for every later call, which the project's immutability rule forbids outright — no cost to being wrong; a copy is correct either way.

23. **Task 6.** the foreign-key fault is typed in the repository. The brief told the implementer to let the database guarantee set membership rather than checking it twice, which was right, but I did not account for the error quality: Drizzle's message carries the failed SQL, so a raw fault reaching the surface breaks the no-leak constraint. isForeignKeyViolation(error, constraint) joins isUniqueViolation in driver-faults.ts matching SQLSTATE 23503, and the set-mismatch constraints map to ConflictError with the driver fault on cause only. The foreign key stays the guarantee — if wrong, the cost is one predicate removed.

24. **Task 6.** scorePosition and requestRescore refuse an archived criteria set with ArchivedError, while getScoreHistory and getBestScores keep returning scores made against a set archived afterwards. Archival means readable but no longer offered for new use, which this codebase already enforces for every registry reference, and a new score against an archived set is exactly a new write naming an archived row. assertNotArchived covers only the registry tables, so the check reads the set row already loaded — if wrong, the cost is one guard removed.

25. **Task 6.** getScoreHistory stays a flat newest-first list with criteriaSetId on each row. Grouping is presentation, and a repository taking a mode argument to shape its return is doing the surface's job.

26. **Task 6.** PendingRescoreRow's criteriaSetId joined in from rescore_request stands. The view omits it and the consumer needs it.

27. **Task 6.** the entity string is 'criteria set' with a space in both places — my brief said 'criteria_set', which was a table name copied into prose that lands in a user-facing message through the error templates. The existing setDefaultCriteriaSet string was right and the new one changes to match it.

28. **Task 6.** ConflictError gains an optional message in its options rather than a private subclass overriding it. The implementer's reasoning was right — "criteria set X already exists" would be false for a membership fault — but a private subclass that overrides its parent's message is a pattern the next person copies without knowing why. It is also the second time the template has not fitted a real case, after Task 3's "phase key one of: p1, p2, p3 already exists". The widening is additive, so no existing call site changes, and it gives Task 3's deferred message minor a proper fix at the final review — if wrong, the cost is one optional field nobody passes.

29. **Task 6.** a detour coverage requires its requirement's rating row, and a caller with no direct assessment sends coverage: null. The normalisation is right, since a detour coverage is a qualifier on a rating. It needs the schema doc comment to say so, plus the test for the branch it creates — a rating with coverage: null carrying a detour above zero, where effectiveCoverage returns the discounted contribution rather than null, so "not rated" becomes "rated by a detour" and the overall moves. That is distinct from the null-detour-coverage case already covered, and nothing tested it.

30. **Task 6.** the detour foreign key keeps no ON DELETE, deliberately. Restrict is correct because a stored score's inputs must not vanish underneath it, or history silently changes meaning, and it matches the existing position_rating -> requirement restriction for the same reason. The consequence is carried, not solved here: a later surface for editing a criteria set's detours must archive rather than delete, and `detour` has no archivedAt column, so that surface's plan owns adding one. Nothing in this plan deletes a detour. The schema comment now says the key is restrictive on purpose, so the next person meets the decision instead of the error — if wrong, the cost is one migration adding a cascade.

31. **Task 7.** currentStage and isApplied raise NotFoundError('position', id) for a position that does not exist. The brief said null for no event or a null stage and said nothing about a missing position, which was my omission — but isApplied returning false for a position that does not exist is an affirmative statement about nothing, and currentStage returning null conflates "no such position" with "no stage yet". The move rule already locks the position, so it passes that knowledge down rather than paying for a second read; the standalone calls take one extra round trip on a path that is not hot — if wrong, the cost is two guards removed.

32. **Task 7.** a non-repeatable stage stays appendable twice. is_repeatable is a reading hint, not a write constraint — the table's own comment says there is deliberately no unique key on position and stage because counting those rows is how "this process had four steps" is answered, so the flag tells a consumer how to count rounds rather than telling the writer what to refuse. The history is append-only, so refusing a second real occurrence would lose something that happened. Documented on appendStageEvent as advisory, with a pointer to where the counting happens — if wrong, the cost is one guard added and the stats counting revised.

33. **Task 7.** no check-violation predicate, as instructed, and the handling is right. Validating the reason exists before the write means a bypassed null reason surfaces as NotFoundError with no SQL, and a separate test shows the database's CHECK still refuses a mismatched pair — the guarantee proven live rather than duplicated in application code.

34. **Task 7.** listSetAside pages through searchPositions rather than capping, reusing the archival-safe label reads and the filter instead of growing a second query that can drift from it. And a position set aside and later rejected stays in its set-aside group, because the grouping exists so the user can see why they passed on things and refine a gate or a weight from it — their judgement happened regardless of what the other side did afterwards. Both documented on the function.

35. **Task 7.** moveIfRecommended's asymmetry stands and is documented instead of changed. With recommendApply: false the null is an answer about the input — there is nothing to do whatever the position's state — rather than a claim about the position, so it need not verify the row exists and should not pay a read to do so.

36. **Task 7.** listSetAside de-duplicates by position id, but does not get a repeatable-read transaction. Offset paging over searchPositions is not a snapshot and seenAt can change between pages, so skipping a row under concurrent writes is acceptable for a personal tracker while showing the same role twice in one group is not — if wrong, the cost is wrapping the read in a transaction.

37. **Task 8.** updateText takes no lock while createCriteriaVersion does, deliberately. The two have the same shape — read max(version), insert at +1, unique constraint behind — and opposite concurrency behaviour, so the difference needs writing down. A criteria version is an independent copy, so queueing callers and giving each its own number is right. A text asset is one document being edited, so a loser who silently received version 3 built on someone else's version 2 would have their edit layered onto wording they never saw; a ConflictError telling them to re-read is the honest answer — if wrong, the cost is adding a lock.

38. **Task 8.** routeCounts counts distinct positions per route, so a position reached through two routes appears in both rows and the column does not sum to the number of positions. That is correct for "how many positions did each route bring me" and surprising to anyone who adds the numbers up, so it is documented, along with the null row for touches with no route and the exclusion of origins with no position.

39. **Task 8.** widening NotFoundError with an optional ErrorOptions matches ConflictError and keeps a foreign-key fault on cause. Accepted, one new test.

40. **Task 8.** NotFoundError for a missing position from listOrigins, getFirstTouch and wasReposted is the consistency Task 7 established. Accepted.

41. **Task 8.** attachOrigin refuses an origin already on a different position with ConflictError while a repeat attach to the same position is harmless — the right idempotency. Accepted.

42. **Task 8.** listTexts without pagination is proportionate for a personal tracker's cover letters, and judging the type filter on the newest version is the sensible reading. Accepted.

43. **Task 8.** the schema renames (NewOriginSchema -> strict OriginInputSchema, NewSearchRunSchema -> SearchRunInputSchema) stand since nothing used the old names. The implementer is to confirm in its report that the schema the pure firstTouch function parses with was not touched, since C2 deliberately leaves the foundation's z.object schemas alone.

44. **Task 9.** the implementer's empty-string catch is a genuine find and its placement is what makes it sound. SHA-256 digests of two empty strings are equal, so a plain digest compare returns true for ('', ''), which is the fail-open hole in another form. The guard reads only the configured key, after the compare, so it adds no early return on the presented value and leaks nothing about it through timing. It must stay there, with the reason written down — a later reader "tidying" it into a leading `if (!presented) return false` would undo the constant-time property without touching the comparison.

45. **Task 9.** not claiming to have measured constant-time is the right answer. The reasoning holds — a missing or malformed header skips the compare and answers sooner, revealing the shape of the header the caller themselves sent, not anything about the key.

46. **Task 9.** @types/express added as a dev dependency stands, with a runtime-import-free middleware typed against it. The implementer is to confirm the resolved major is the Express 5 line, since the v4 and v5 type packages compile either way while describing a different RequestHandler.

47. **Task 9.** WWW-Authenticate: Bearer added to the 401. RFC 7235 makes it a MUST, the implementer cited that same RFC for case-insensitive scheme matching, it reveals nothing, and the Bearer scheme triggers no browser credential dialog.

48. **Task 10.** add a "replaced" notice. Re-running silently invalidated the old key, so every client configured with it would start getting 401s whose body deliberately explains nothing. One line naming what the user must do turns a confusing failure into an expected one — printed through the injected write and asserted on the replace path only.

49. **Task 10.** preserve a trailing comment on a replaced API_KEY= line. The function's own promise is to leave every other line untouched, so eating part of the one line it does touch is against its spirit, and a user who annotated that line loses the note. Tractable because the key format makes it unambiguous — base64url with a jat_ prefix contains no #, so the first ` #` after the value begins a comment.

50. **Task 10.** the replace warning must survive the clear, which is the implementer's own concern and it is right. As built, the notice sat beside the key and was wiped with it after the wait — so the one piece of information the user must act on LATER vanished exactly when they finished copying the key. The key must be cleared; the warning must not. The test asserts the order (key, wait, clear, warning after the clear), since a warning written before the clear and asserted only for presence would pass while still being wiped.

51. **Task 10.** the Important finding is implemented, not documented away. The real wait is a setTimeout promise that never rejects, so the finally only protects an injected wait; SIGINT or SIGTERM terminates without running finally, leaving the key on screen AND in the terminal's scrollback. For a script whose flag is --burn-after-reading, that is the headline promise failing on the most likely interruption there is. process.once handlers around the display window clear and exit, are removed when the window closes, and are tested through an injected signal registrar rather than real signals.

52. **Task 10.** match ^ *(export +)?API_KEY= for detection and replacement. As built, `  API_KEY=x` and `export API_KEY=x` are missed, so the new line is appended while the old one stays and the parser decides which wins — the user is shown a new key while the service may still read the old one. A silently wrong active key is worse than an error.

53. **Task 10.** do not split on # when the value begins with a quote. A generated key is never quoted, so this only protects a hand-edited line, which is exactly the line worth not destroying.

54. **Task 10.** make the .env write atomic via temp file and rename, preserving mode. writeFile truncates first, so a partial failure can leave an empty file — and that file also holds DATABASE_URL, so losing it breaks the user's whole local setup for the sake of setting a key.

55. **Task 10.** make io a required parameter of main, with only the import.meta.main entry supplying realIo. The default means a future test that forgets a fake writes the author's real .env; it costs nothing now and removes the accident permanently.

56. **Task 10.** three test additions — a failing readFile in a main test (it shares the try with the write and only the write path is covered), realIo's own ENOENT-to-null mapping and rethrow against a temp directory, and deriving the expected key shape from generateApiKey().length instead of hard-coding {43}.

57. **Task 11.** a BulkItemError's envelope includes the cause's message when the cause is a known class, and nothing when it is not. "bulk item 3 failed" with no reason is almost useless to an agent pasting twenty positions. The rule is safe because a known class's message is built from fields the caller supplied — "route 9 does not exist" — never from driver text, which is exactly why earlier tasks put driver faults on `cause`. An unknown cause contributes no text, so the leak property is unchanged — if wrong, the cost is dropping one concatenation.

58. **Task 11.** the {error:{name,message}} shape and the InternalError constant stand as the implementer's choices. Carried to Task 15: the two surfaces have different envelopes by design, but the message TEXT must come from one exported function, or the same failure reads differently depending on which door the caller used. result.ts exports it; the HTTP adapter calls it rather than re-deriving the rules.

59. **Task 11.** ZodError stays unnamed and flat in the MCP envelope, and the reasoning is the valuable part — the SDK validates input before run, so a ZodError reaching errorResult came from inside the server and is genuinely internal. Carried to Task 15 as a warning: this does NOT transfer. There the adapter parses with the schema itself, so a ZodError is caller input and must become a 400 naming the field. A later task copying the MCP decision across would turn every bad request into an opaque 500.

60. **Task 11.** whole-set tool-name uniqueness belongs to Task 14, which assembles all 46 definitions. The per-call duplicate test covering the SDK's own "already registered" throw is the right scope here.

61. **Task 11.** ToolDefinition gains an optional `annotations` slot now, unpopulated. The SDK's read-only and destructive hints are what an MCP client uses to decide whether a call needs explicit approval, which matters for a surface that archives registry rows and overwrites scores — and retrofitting the slot after 46 tools exist means touching all 46, the same "last cheap moment" argument that added findRegistryRow. Which tools are read-only or destructive is the author's call, so the values stay unset and the classification is a follow-up for Marcos rather than 46 guesses — if wrong, the cost is one unused optional field.

62. **Task 12.** one shared tool-layer helper, with isItemFault exported from the repository layer — not three new repository functions. The deciding argument is score_position_bulk and it comes from the plan's own design note: the composition of scorePosition with moveIfRecommended sits in the tool deliberately, because a score and a stage change are two facts and only the tool knows this score was a re-score the user asked for. A scorePositions repository function therefore could not call the mover, so that bulk form must loop over the composed pair in the tool layer whatever I decided about the other two — and pushing the other two into the repositories would leave two different bulk mechanisms in one codebase, which is worse than either choice made consistently. The helper lives in its own module under src/mcp/ so Task 13's groups can use it, takes Db plus items plus a per-item function, opens ONE transaction, and raises BulkItemError(index, cause) when isItemFault holds while rethrowing anything else — the same rule as addPositions, from the same predicate rather than a second copy of the judgement. A tool opening a transaction and passing tx to repository functions does not break "repositories are the only code that touches a table": it manages a transaction, it does not touch a table, and score_position already does this with approval — if wrong, the cost is three repository functions written later and the helper deleted.

63. **Task 12.** registry_add_bulk taking { registry, items } rather than a bare bulkOf(item) stands. bulkOf cannot carry the registry name, and building on it keeps the cap and strictness shared — the brief's intent met rather than deviated from. Recorded so the final review does not read it as drift.

64. **Task 12.** criteria_set_default returning the set through findCriteriaSet stands, since setDefaultCriteriaSet is void and a caller wants to see what it now has.

65. **Task 12.** registry_add needs no unwrapSingleItem, because addRegistryRows raises ConflictError directly rather than wrapping per item. A real asymmetry between the two bulk writers — a failed bulk registry add names the candidate keys ("one of: p1, p2, p3") instead of an index — which is handled rather than unhandled, and is going in the report so a reader comparing them knows it was noticed.

66. **Task 12.** describeError stays one level deep for now, and the recursive version is deferred rather than ordered. The nested case is unreachable today — all three inOneTransaction callers are single-item — so this is prophylactic, and the module belongs to a completed task. A recursive version over the KNOWN classes would be safe by construction (an unknown link contributes nothing and stops the chain) and should carry a small depth bound, but it is only worth doing if something actually composes a bulk-over-bulk. Carried into Task 13's brief: if it composes a bulk tool over a bulk repository function, it must say so, because the envelope then needs the recursive cause to be useful — two indexes and no reason is nearly useless to a caller — if wrong, the cost is one recursive branch in describeError plus a depth bound.

67. **Task 13.** the table stands and the "every collection operation has both forms" rule does not reach text_update, origin_attach or search_run_record. This was already decided in the plan — Task 14's test uses an explicit allowlist of the eight names that must have a _bulk sibling precisely because those three have none, and a name-pattern heuristic was rejected for that reason. Recording one search run is not a collection operation, attaching one origin to one position is inherently singular, and text_update writes one new version of one labelled text.

68. **Task 13.** TextUpdateBulkSchema is deleted if genuinely unreferenced. An exported schema with no tool behind it is the speculative generality the project's rules forbid, and the next reader would reasonably assume a tool is missing. ScorePositionBulkSchema was allowed to arrive a task early only because a tool then consumed it — if wrong, the cost is re-adding a schema when a bulk text update is actually wanted.

69. **Task 13.** set_aside_list returning everything unpaginated stands, following Task 7's ruling that listSetAside pages through searchPositions without a cap so it reuses the archival-safe label reads rather than growing a second query that can drift. The reason goes in the tool's description so an agent knows the result is complete rather than truncated.

70. **Task 14.** add the tool-count log inside setup, through the context's logger. At boot you learn 46 tools registered, and if a module ever fails to import you see a wrong number rather than a silently smaller surface.

71. **Task 14.** unset or blank means stdio, the literal `http` means HTTP, and anything else exits with a message naming what it got. A misspelled transport must stop the process rather than silently pick the exposed one — the same reasoning that made requireApiKey refuse every request rather than allow all of them when its key is missing. Extracted as a pure resolveTransport(env) in src/mcp/transport.ts so it can be tested, since server.ts cannot be imported, with the exit and writer injected as the setApiKey script does.

72. **Task 15.** the three routes that restate a tool's two-call composition must share it instead. Task 12 met the same situation with score_position and score_position_bulk and solved it by exporting one scoreAndMove that both call, so the two cannot disagree rather than being tested for agreement. Duplication guarded by a parity test is still duplication, and the test only fires if someone runs it — if wrong, the cost is three small exports reverted.

73. **Task 15.** the pathOnly solution for PATCH /criteria-sets/:id/requirements/:requirementId stands. The tool's schema has no field for the set, and the alternatives were dropping :id from the route or adding the set to the schema — the second would break the identity the design rests on. Scoping the requirement to the path's set and answering 404 otherwise also closes a real hole, since PATCH /criteria-sets/1/requirements/99 must not edit a requirement of set 2. The implementer must confirm the 404 check runs BEFORE the update: if the write happens first, the hole is open and a well-formed request would still pass the test.

74. **Task 15.** a ZodError thrown from inside `run` is a flat 500 while one from parsing the request is a 400 naming the field. Internal data failing validation is internal, which is the same reasoning the MCP side uses; both halves go in the report because the next reader will see statusFor mapping ZodError to 400 and wonder why one path gives 500.

75. **Task 15.** the disposition route's declared and parsed schemas must be tied by construction. It is the one hand-written RouteSpec, so its schemas:[...] and what dispositionHandler parses with are related only by both referencing the same imports — a future edit could change one and leave the other with the identity test still passing. One assertion that the handler refuses a field the declared schema allows is the cheap close.

76. **Task 16.** a missing or empty API_KEY refuses to start, checked before anything opens, and requireApiKey is mounted unconditionally on /api. There is no keyless mode. The plan recorded keyless operation as Marcos's explicit choice and justified it with "loopback without a key" — but what this package actually offers is keyless on EVERY interface, which is a different offer and not the one he accepted. When a stated preference rests on a fact that does not hold, the preference goes back to him rather than being honoured in a form he never agreed to. SURFACED TO HIM DIRECTLY with the evidence so he can overrule — if wrong, the cost is a conditional mount restored, or a loopback listen outside the chassis.

77. **Task 16.** no ALLOW_KEYLESS flag and no self-rolled loopback listen added on my own initiative. Either would be inventing a feature to paper over a decision that is his. If he wants keyless local operation the options are a host option upstream or starting the app ourselves instead of through the chassis, and either is a follow-up.

78. **Task 16.** a weak API_KEY gets a WARNING, not a refusal. requiredApiKey accepts any non-empty string, so API_KEY=a starts a service bound to every interface, and the comment relies on the key being long and random. setApiKey produces such keys but a hand-edited .env is unconstrained. A length floor would be me inventing policy on the author's behalf; a warning is informational and reversible — and the question of a floor goes to Marcos.

79. **Task 17.** wire startBackupSchedule into startService, which means editing a completed task's file — allowed, with the reason recorded. §12.2 asks for pg_dump ON A SCHEDULE, and a schedule nothing starts is not one; the feature would be half-delivered, running only when someone remembers the command. Critically, the service must NOT await a due dump before serving: a cold start two weeks after the last backup would block the web app behind a full dump. The schedule starts after the server is up, the first due check runs on its own, and the whole thing is skipped under NODE_ENV=test so no test spawns a dump — if wrong, the cost is one call removed.

80. **Task 17.** sweep stale *.partial files at schedule start, and keep them out of the retention count. A process killed mid-dump leaves one behind and nothing removes it, so they accumulate in the very directory the feature exists to manage — and a partial counted as a backup would make retention believe it has a dump it does not have, which is the worse of the two failures.

81. **Task 17.** no pg_dump version detection in code — the binary already says "aborting because of server version mismatch", which is clearer than anything we would write. But the README gets the concrete one-liner using the container's own pg_dump 16, because "find a newer pg_dump" is not much help and this project ships the database in Docker. The answer belongs in the same paragraph as the error.

82. **Task 17.** the SIGTERM orphan is accepted. The chassis shuts down without calling our stop wrapper, so a dump in flight at that moment is orphaned and leaves a partial, which the next start sweeps after an hour. The failure is bounded — one stale file of one dump's size, auto-swept, and planRetention ignores partials so retention is never confused by it — and the fix would mean registering our own SIGTERM handler against the chassis's, which risks fighting its signal handling for a bounded disk cost. Recorded with the mechanism rather than fixed — if wrong, the cost is one handler added.

83. **Task 17.** redact stderr BEFORE truncating. Cutting to 4000 characters and then redacting leaves a partial credential when a URL straddles the cut — the redactor no longer matches because the full string is gone. It is the one path in the feature where a password fragment can still reach an error message.

84. **Task 17.** escalate to SIGKILL after a grace period. One SIGTERM then awaiting exited means a child that ignores it hangs the schedule's chain, every later check AND stop(), so the service cannot shut down cleanly.

85. **Task 17.** the server tests get a scratch database. startService reads backup settings from the real getDb(), so if the author's app_config stores enabled: false, two tests hang on logs that never arrive. A test that fails because of someone's local data costs an afternoon to diagnose.

86. **Task 17.** add the git check-ignore test. The brief did not ask, and it is the one assertion guarding the project's central constraint — that a dump, the user's whole job-hunting history in one file, cannot be committed. The strong form, since no test reads .gitignore as text.

87. **Task 17.** add *.dump.partial to .gitignore (*.dump does not match it), and warn in the README that pg_dump-docker.sh drops PGHOST and PGPORT so a mismatched DATABASE_URL silently dumps the container's database instead — a backup of the wrong data, worse than a failed backup because nobody notices.

88. **Task 17.** install the timer even when the start-time settings read throws, and re-read settings each hourly tick. Simpler than the current special case and it recovers by itself; today a transient database hiccup at boot means no backups for the life of the process.

89. **Task 17.** the field-level default in readBackupSettings stays — an unreadable `enabled` yields true. The re-reviewer argued it should flip, since for a project premised on keeping personal data out of files, dumping after the user turned backups off is the less safe side. I weighed both: an unwanted dump is a gitignored, 0600 file on the user's own disk, while a silently missing backup is unrecoverable loss discovered at the worst moment. The default holds, and the reasoning goes in the comment so the choice reads as considered — if wrong, the cost is one default flipped.

90. **Task 17.** the comment at schedule.ts:207-208 conflates two behaviours and must describe each where it happens. An unreadable `enabled` FIELD yields true inside readBackupSettings; a start-time read that THROWS ENTIRELY now produces no dump until a later read succeeds. The comment claimed the second behaves like the first.

91. **§8 rule.** archived sets take part, and the implementer's reasoning is right. The spec defines non-superseded by name and version only; archival in this codebase means "not offered for new use" rather than "hidden from reading" (which is why findRegistryRow exists); and a recommendation under an archived set can only be withdrawn by a newer version of the same name, which is the spec's own mechanism. A test pins the choice and the report says how to flip it — if wrong, the cost is one predicate.

92. **§8 rule.** the displayed score must not contradict why the row is there. A row listed because set B recommends it was showing the default set's latest score, which may say "not recommended" or be null — a row in a recommended filter displaying a score that denies it. The user cannot tell a bug from a subtlety and loses trust in the number either way. With no set named, show the recommending non-superseded set's latest, chosen deterministically.

93. **§8 rule.** getPosition's latestPerSet drops superseded versions too, or the modal shows v1 and v2 as two lenses while getBestScores shows one — the detail view and the list disagreeing about how many perspectives exist, with §9.2's "+n" chip reading one of them. Two reads of the same fact must not give different answers.

94. **§8 rule.** scoreAndMove STAYS on the just-written score's flag rather than the across-sets answer. The move is a consequence of this scoring action, so "I scored it under A, which said no, and it moved anyway" would be more surprising than the inconsistency. But the inconsistency is real — a position can sit in the recommended filter without being shortlisted — so it goes in moveIfRecommended's doc comment and score_position's description.

95. **§8 rule.** concern 4 is documented, not softened. Publishing v2 of a criteria name drops every v1-only position out of the recommended filter until re-scored. That is the spec read literally and it is the honest answer — the new criteria have not been applied, so "unknown" beats a stale yes. But a user who publishes a version and watches their board empty needs to know it is expected and that rescore_request is the fix, so it goes in criteria_version_create's description, where someone is standing when they cause it, and in the README.
