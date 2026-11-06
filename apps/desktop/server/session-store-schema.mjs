// Orch v1 schema module for session store.
// Exports constants for application ID, schema version, and the exact DDL.

export const SESSION_STORE_APPLICATION_ID = 'cho.sessions.v1';
export const SESSION_STORE_SCHEMA_VERSION = 2;

export const SESSION_STORE_SCHEMA_SQL = `CREATE TABLE meta(application_id TEXT PRIMARY KEY, instance_uuid TEXT NOT NULL,
  schema_version INTEGER NOT NULL, created_at_ms INTEGER NOT NULL);
CREATE TABLE projects(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, path_canonical TEXT NOT NULL UNIQUE,
  created_at_ms INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)));
CREATE TABLE conversations(
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '', controller TEXT NOT NULL CHECK(controller IN ('codex','claude')),
  model_requested TEXT, model_reported TEXT NULL, served_verified TEXT NULL,
  requested_claude_session_uuid TEXT NULL,
  effort TEXT, role TEXT, parent_conversation_id TEXT NULL,
  created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
  UNIQUE(id, project_id), UNIQUE(id, project_id, controller),
  FOREIGN KEY(parent_conversation_id, project_id) REFERENCES conversations(id, project_id));
CREATE INDEX conv_project_updated ON conversations(project_id, updated_at_ms);
CREATE TABLE native_refs(
  conversation_id TEXT NOT NULL, project_id TEXT NOT NULL,
  controller TEXT NOT NULL CHECK(controller IN ('codex','claude')),
  native_thread_id TEXT NULL, native_session_uuid TEXT NULL,
  created_at_ms INTEGER NOT NULL, PRIMARY KEY (conversation_id, controller),
  FOREIGN KEY (conversation_id, project_id, controller) REFERENCES conversations(id, project_id, controller) ON DELETE CASCADE,
  CHECK((controller='codex' AND native_thread_id IS NOT NULL AND native_session_uuid IS NULL)
     OR (controller='claude' AND native_session_uuid IS NOT NULL AND native_thread_id IS NULL)));
CREATE UNIQUE INDEX native_thread_once ON native_refs(native_thread_id) WHERE native_thread_id IS NOT NULL;
CREATE UNIQUE INDEX native_session_once ON native_refs(native_session_uuid) WHERE native_session_uuid IS NOT NULL;
CREATE TABLE turns(
  id TEXT NOT NULL, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL, prompt_text TEXT NOT NULL, prompt_ref TEXT NULL,
  model_requested TEXT, effort TEXT, role TEXT, claude_input_uuid TEXT NULL,
  intent_state TEXT NOT NULL CHECK(intent_state IN
    ('queued','written','observed','completed','failed','interrupted','unknown')),
  native_turn_id TEXT NULL, outcome TEXT NULL CHECK(outcome IN ('completed','failed','interrupted','unknown')),
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, id), UNIQUE(conversation_id, seq));
CREATE UNIQUE INDEX turn_claude_input_once ON turns(claude_input_uuid) WHERE claude_input_uuid IS NOT NULL;
CREATE TABLE events(
  id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL, event_key TEXT NOT NULL, kind TEXT NOT NULL,
  payload_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL,
  UNIQUE(conversation_id, seq), UNIQUE(conversation_id, event_key));
CREATE INDEX events_cursor ON events(conversation_id, seq);
CREATE TABLE snapshots(conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  last_seq INTEGER NOT NULL, projection_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL);
CREATE TABLE large_bodies(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  byte_len INTEGER NOT NULL, sha256_hex TEXT NOT NULL, body_text TEXT NOT NULL, created_at_ms INTEGER NOT NULL);
CREATE TABLE operations(
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, turn_id TEXT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('approval','clarification_answer','stop','handoff','draft_save')),
  owner_generation INTEGER NOT NULL, host_generation TEXT NULL, native_request_id_text TEXT NULL,
  native_request_id_type TEXT NULL CHECK(native_request_id_type IN ('number','string')),
  decision TEXT NULL, state TEXT NOT NULL, history_json TEXT NOT NULL DEFAULT '[]',
  payload_hash TEXT NULL, result_json TEXT NULL,
  created_at_ms INTEGER NOT NULL, settled_at_ms INTEGER NULL,
  CHECK(kind IN ('draft_save','handoff') OR turn_id IS NOT NULL),
  CHECK(kind <> 'draft_save' OR (payload_hash IS NOT NULL AND result_json IS NOT NULL)),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (conversation_id, turn_id) REFERENCES turns(conversation_id, id) ON DELETE CASCADE);
CREATE TABLE clarifications(id TEXT PRIMARY KEY, turn_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
  native_question_id TEXT NOT NULL, question_json TEXT NOT NULL, status TEXT NOT NULL
  CHECK(status IN ('pending','answered','invalid','unactionable')),
  answer_json TEXT NULL, answered_at_ms INTEGER NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (conversation_id, turn_id) REFERENCES turns(conversation_id, id) ON DELETE CASCADE);
CREATE TABLE drafts(conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  text TEXT NOT NULL, version INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL);
CREATE TABLE draft_conflicts(
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  client_save_id TEXT NOT NULL, base_version INTEGER NOT NULL, text TEXT NOT NULL,
  resolution TEXT NOT NULL DEFAULT 'open' CHECK(resolution IN ('open','kept','dropped')),
  created_at_ms INTEGER NOT NULL, PRIMARY KEY (conversation_id, client_save_id));
CREATE TABLE imports(source TEXT NOT NULL, source_key TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  import_batch_id TEXT NOT NULL, created_at_ms INTEGER NOT NULL, PRIMARY KEY (source, source_key));
CREATE TABLE producer_fences(conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  owner_token TEXT NOT NULL, generation INTEGER NOT NULL, state TEXT NOT NULL
  CHECK(state IN ('held','released','dead')) DEFAULT 'held', updated_ms INTEGER NOT NULL);
CREATE TABLE schema_migrations(
  version INTEGER PRIMARY KEY,
  migration_id TEXT NOT NULL UNIQUE,
  applied_at_ms INTEGER NOT NULL);
`;
