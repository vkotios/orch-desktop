# Session records API — CHO-03 S2a

Implemented in `247f43d`. This trusted internal Node API uses the S1 SQLite store;
it has no host, IPC, UI or provider consumer yet. The caller opens and closes the
store and supplies it to `createSessionRecords({ store, now = Date.now })`.
Construction performs no I/O. Every data operation uses one synchronous store
transaction, including its project-binding checks. Schema and lifecycle remain
defined by [SESSION_STORAGE](SESSION_STORAGE.md).

## Project and chat metadata

| Method | Result |
| --- | --- |
| `createProject({ id, name, pathCanonical })` | New project; duplicate ID or exact path rejects. |
| `getProject({ projectId })` | Project or `null`. |
| `listProjects({ limit = 100, offset = 0, includeArchived = false })` | Creation time descending, ID ascending. Arguments default to `{}`. |
| `setProjectArchived({ projectId, archived })` | Updated project; children are unchanged. |
| `createConversation({ id, projectId, controller, title = '', modelRequested = null, effort = null, role = 'implement', parentConversationId = null })` | New chat; parent must belong to the same project. |
| `getConversation({ projectId, conversationId })` | Chat or `null`, including a wrong-project lookup. |
| `listConversations({ projectId, limit = 50, offset = 0, includeArchived = false, query = '' })` | Update time descending, ID ascending; literal, case-sensitive title substring. |
| `renameConversation({ projectId, conversationId, title })` | Updated chat metadata. |
| `setConversationArchived({ projectId, conversationId, archived })` | Updated chat metadata. |

Records use camelCase names and boolean archive flags. Projects return
`id`, `name`, `pathCanonical`, `createdAtMs`, `archived`. Chats return `id`,
`projectId`, `title`, `controller`, `modelRequested`, `modelReported`,
`servedVerified`, `requestedClaudeSessionUuid`, `effort`, `role`,
`parentConversationId`, `createdAtMs`, `updatedAtMs`, `archived`.

Creation leaves observed native fields and the requested Claude session UUID
`null`. There is no configuration/native-binding update method in S2a.
Rename/archive preserve those fields. Archive is an organizational flag;
explicit reads and draft saves still work. It does not represent project trust.
The future host resolves/canonicalizes paths and checks trust before calling this
API; this module stores the supplied absolute path without filesystem access.

## Draft saves and conflicts

`getDraft({ projectId, conversationId })` returns `null` when no draft exists,
otherwise `{ conversationId, text, version, updatedAtMs }`. Reads create no rows.

`saveDraft({ projectId, conversationId, saveId, expectedVersion, text })` returns
`{ saveId, conversationId, status, version, conflictId }` after commit:

- An absent draft has version 0. Matching the current version saves the exact
  accepted text and increments the version; the first saved version is 1.
- A stale version preserves the current draft and inserts a separate immutable
  conflict containing the attempted text and base version. The receipt has
  `status: 'conflict'` and `conflictId: saveId`; successful saves use
  `status: 'saved'` and `conflictId: null`.
- The save ID identifies one immutable request: project, chat, expected version
  and exact text. An exact retry returns the original stored receipt, even after
  later edits. Reusing the ID for a different request or operation kind rejects.
  A historical receipt does not describe the latest draft; use `getDraft` for it.
- Draft/conflict mutation and its completed `draft_save` operation receipt commit
  together. Local draft operations use owner generation 0 and null host/turn IDs.
  Failed receipt writes roll back the mutation too.

`listDraftConflicts({ projectId, conversationId, limit = 10, offset = 0,
includeResolved = false })` returns metadata only: `conversationId`, `saveId`,
`baseVersion`, `resolution`, `createdAtMs`, ordered by creation time and save ID
ascending. `getDraftConflict({ projectId, conversationId, saveId })` returns one
such record with its `text`, or `null`. Conflict text is excluded from list reads
to bound responses. Explicit version-checked resolution is a later slice;
original conflicting text must remain preserved.

## Validation and errors

IDs are canonical lowercase UUID strings; no trimming or case conversion occurs.
All text rejects embedded NUL and unpaired UTF-16 surrogates before mutation.
This gives consistent behavior on tested Node versions: the older development
Node 24.11.1 truncates NUL on SQLite string reads; bundled 24.22.2 preserves it.
Accepted text retains whitespace, newlines and Unicode without normalization.

Limits count UTF-16 code units: project name 1–256, title 0–512, nonnull model
1–256, nonnull effort 1–64, path 1–32768, draft 0–65536, search query 0–512.
Controller is `codex` or `claude`; role is `implement` or `review`. Pagination
limits are integers 1–100; offsets and expected versions are nonnegative safe
integers. Boolean flags are strictly typed. Version increments never wrap.

Mapped record errors use static messages without input values or SQL:

| Code | Meaning |
| --- | --- |
| `ERR_INVALID_RECORD` | Invalid argument, type, text, bound or clock value. |
| `ERR_NOT_FOUND` | Missing project/chat binding for a mutation or draft/conflict read. |
| `ERR_RECORD_CONFLICT` | Duplicate project/chat ID or project path. |
| `ERR_IDEMPOTENCY_CONFLICT` | Save ID reused with a different request or kind. |
| `ERR_VERSION_LIMIT` | Increment would exceed the safe integer range. |

S1 storage errors, including `ERR_BUSY`, `ERR_STORAGE` and `ERR_CLOSED`, propagate.
Native references and producer fences are provided by the separate
[SESSION_BINDINGS](SESSION_BINDINGS.md) module. Turns, execution operations,
large bodies, clarifications, events, recovery and UI consumers remain later work.
