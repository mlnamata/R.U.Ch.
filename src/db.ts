import { DatabaseSync } from "node:sqlite";

/**
 * Database schema of the hub (one SQLite file for all rooms).
 *
 * - Every room is a "project". Access is by key only: an agent code (shared with agents)
 *   and an owner key (the human's link). Only SHA-256 hashes of the keys are stored.
 * - IDs are small integers on purpose: agents reference them in text ("T3", "Q7"), which is
 *   cheap in tokens and hard to mistype or invent.
 * - messages.project_id and thread_members are denormalised so an inbox is one indexed query.
 */
export const SCHEMA_VERSION = 3;

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id              INTEGER PRIMARY KEY,
  name            TEXT NOT NULL,
  brief           TEXT NOT NULL DEFAULT '',
  agent_key_hash  TEXT NOT NULL UNIQUE,
  owner_key_hash  TEXT NOT NULL UNIQUE,
  code_rotation   INTEGER NOT NULL DEFAULT 0,          -- agent code = hash(owner key, rotation); bump to revoke
  -- Per-room counters: agents see small room-local numbers (T3, M41), never global ids.
  seq_thread      INTEGER NOT NULL DEFAULT 0,
  seq_message     INTEGER NOT NULL DEFAULT 0,
  seq_question    INTEGER NOT NULL DEFAULT 0,
  seq_knowledge   INTEGER NOT NULL DEFAULT 0,
  seq_task        INTEGER NOT NULL DEFAULT 0,
  coord_thread_id INTEGER,                              -- the room's coordination thread (check-ins, requests)
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_active_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS projects_active ON projects(last_active_at);

CREATE TABLE IF NOT EXISTS participants (
  id             INTEGER PRIMARY KEY,
  project_id     INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name           TEXT NOT NULL COLLATE NOCASE,
  kind           TEXT NOT NULL CHECK (kind IN ('agent','human')),
  role           TEXT NOT NULL DEFAULT '',
  secret_hash    TEXT,                                -- per-agent secret, so nobody can post under another agent's name
  status_text    TEXT NOT NULL DEFAULT '',
  inbox_cursor   INTEGER NOT NULL DEFAULT 0,          -- last message id delivered via inbox
  thread_cursor  INTEGER NOT NULL DEFAULT 0,          -- last thread id announced via inbox
  last_seen_at   TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (project_id, name)
);

CREATE TABLE IF NOT EXISTS threads (
  n                  INTEGER NOT NULL DEFAULT 0,          -- number within the room
  id             INTEGER PRIMARY KEY,
  project_id     INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_id      INTEGER REFERENCES threads(id) ON DELETE SET NULL,
  title          TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','human_needed','resolved')),
  status_reason  TEXT NOT NULL DEFAULT '',
  summary        TEXT NOT NULL DEFAULT '',
  agent_streak   INTEGER NOT NULL DEFAULT 0,          -- agent messages since the last human message
  message_count  INTEGER NOT NULL DEFAULT 0,
  created_by     INTEGER REFERENCES participants(id) ON DELETE SET NULL,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS threads_project ON threads(project_id, status);

-- Who takes part in a thread, and from which message on (so inbox relevance is chronological).
CREATE TABLE IF NOT EXISTS thread_members (
  thread_id       INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  participant_id  INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  since_id        INTEGER NOT NULL,
  PRIMARY KEY (thread_id, participant_id)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS messages (
  n                  INTEGER NOT NULL DEFAULT 0,          -- number within the room
  id               INTEGER PRIMARY KEY,
  project_id       INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  thread_id        INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  author_id        INTEGER REFERENCES participants(id) ON DELETE SET NULL,  -- NULL = system
  kind             TEXT NOT NULL CHECK (kind IN ('chat','question','answer','decision','handoff','review','status','system')),
  body             TEXT NOT NULL,
  mentions         TEXT NOT NULL DEFAULT '[]',        -- JSON array of participant ids
  reply_to         INTEGER,
  evidence         TEXT NOT NULL DEFAULT '[]',
  evidence_status  TEXT NOT NULL DEFAULT 'none'
                   CHECK (evidence_status IN ('none','verified','unchecked','invalid','missing')),
  confidence       TEXT CHECK (confidence IN ('certain','likely','guess')),
  meta             TEXT NOT NULL DEFAULT '{}',
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_id, id);
CREATE INDEX IF NOT EXISTS messages_project ON messages(project_id, id);

CREATE TABLE IF NOT EXISTS questions (
  n                  INTEGER NOT NULL DEFAULT 0,          -- number within the room
  id                 INTEGER PRIMARY KEY,
  project_id         INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  thread_id          INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  message_id         INTEGER NOT NULL,
  asked_by           INTEGER REFERENCES participants(id) ON DELETE SET NULL,
  target_id          INTEGER REFERENCES participants(id) ON DELETE SET NULL,  -- NULL = anyone
  body               TEXT NOT NULL,
  options            TEXT NOT NULL DEFAULT '[]',
  blocking           INTEGER NOT NULL DEFAULT 0,
  status             TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','cancelled')),
  answer_message_id  INTEGER,
  answered_by        INTEGER REFERENCES participants(id) ON DELETE SET NULL,
  knowledge_id       INTEGER,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  answered_at        TEXT
);
CREATE INDEX IF NOT EXISTS questions_project ON questions(project_id, status);

CREATE TABLE IF NOT EXISTS knowledge (
  n                  INTEGER NOT NULL DEFAULT 0,          -- number within the room
  id                 INTEGER PRIMARY KEY,
  project_id         INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind               TEXT NOT NULL CHECK (kind IN ('answer','decision','fact','note')),
  title              TEXT NOT NULL,
  body               TEXT NOT NULL,
  tags               TEXT NOT NULL DEFAULT '',
  evidence           TEXT NOT NULL DEFAULT '[]',
  trust              TEXT NOT NULL CHECK (trust IN ('human','evidence','agent')),
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disputed','superseded')),
  status_note        TEXT NOT NULL DEFAULT '',
  superseded_by      INTEGER,
  author_id          INTEGER REFERENCES participants(id) ON DELETE SET NULL,
  source_message_id  INTEGER,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS knowledge_project ON knowledge(project_id, updated_at);

CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
  title, body, tags,
  content='knowledge', content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS knowledge_ai AFTER INSERT ON knowledge BEGIN
  INSERT INTO knowledge_fts(rowid, title, body, tags) VALUES (new.id, new.title, new.body, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS knowledge_ad AFTER DELETE ON knowledge BEGIN
  INSERT INTO knowledge_fts(knowledge_fts, rowid, title, body, tags) VALUES ('delete', old.id, old.title, old.body, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS knowledge_au AFTER UPDATE OF title, body, tags ON knowledge BEGIN
  INSERT INTO knowledge_fts(knowledge_fts, rowid, title, body, tags) VALUES ('delete', old.id, old.title, old.body, old.tags);
  INSERT INTO knowledge_fts(rowid, title, body, tags) VALUES (new.id, new.title, new.body, new.tags);
END;

-- Areas: who owns which part of the code (long-lived, unlike claims). Others send requests instead of editing.
CREATE TABLE IF NOT EXISTS areas (
  participant_id  INTEGER PRIMARY KEY REFERENCES participants(id) ON DELETE CASCADE,
  project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  paths           TEXT NOT NULL,                     -- JSON array of normalised paths
  description     TEXT NOT NULL DEFAULT '',
  rules           TEXT NOT NULL DEFAULT '',          -- constraints others must respect
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS areas_project ON areas(project_id);

CREATE TABLE IF NOT EXISTS claims (
  id          INTEGER PRIMARY KEY,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path        TEXT NOT NULL,
  holder_id   INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  reason      TEXT NOT NULL DEFAULT '',
  thread_id   INTEGER,
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS claims_project ON claims(project_id, expires_at);

CREATE TABLE IF NOT EXISTS tasks (
  n                  INTEGER NOT NULL DEFAULT 0,          -- number within the room
  id           INTEGER PRIMARY KEY,
  project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  thread_id    INTEGER,
  title        TEXT NOT NULL,
  details      TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','doing','review','done','blocked')),
  assignee_id  INTEGER REFERENCES participants(id) ON DELETE SET NULL,
  created_by   INTEGER REFERENCES participants(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS tasks_project ON tasks(project_id, status);
`;

const ROOM_NUMBERED = ["threads", "messages", "questions", "knowledge", "tasks"] as const;
const SEQ: Record<(typeof ROOM_NUMBERED)[number], string> = {
  threads: "seq_thread",
  messages: "seq_message",
  questions: "seq_question",
  knowledge: "seq_knowledge",
  tasks: "seq_task",
};

/** v2 → v3: room-local numbers and per-agent secrets. */
function migrateV2(db: DatabaseSync) {
  const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
  db.exec("BEGIN");
  try {
    for (const [, col] of Object.entries(SEQ)) {
      if (!cols("projects").includes(col)) db.exec(`ALTER TABLE projects ADD COLUMN ${col} INTEGER NOT NULL DEFAULT 0`);
    }
    if (!cols("projects").includes("coord_thread_id")) db.exec("ALTER TABLE projects ADD COLUMN coord_thread_id INTEGER");
    if (!cols("participants").includes("secret_hash")) db.exec("ALTER TABLE participants ADD COLUMN secret_hash TEXT");
    for (const t of ROOM_NUMBERED) {
      if (!cols(t).includes("n")) db.exec(`ALTER TABLE ${t} ADD COLUMN n INTEGER NOT NULL DEFAULT 0`);
      db.exec(`UPDATE ${t} SET n = (SELECT COUNT(*) FROM ${t} x WHERE x.project_id = ${t}.project_id AND x.id <= ${t}.id)`);
      db.exec(`UPDATE projects SET ${SEQ[t]} = (SELECT COALESCE(MAX(n), 0) FROM ${t} WHERE project_id = projects.id)`);
    }
    // Stored references that agents see become room-local numbers too.
    db.exec(`UPDATE messages SET reply_to = (SELECT r.n FROM messages r WHERE r.id = messages.reply_to) WHERE reply_to IS NOT NULL`);
    db.exec(`UPDATE knowledge SET source_message_id = (SELECT m.n FROM messages m WHERE m.id = knowledge.source_message_id) WHERE source_message_id IS NOT NULL`);
    db.exec(`UPDATE knowledge SET superseded_by = (SELECT k.n FROM knowledge k WHERE k.id = knowledge.superseded_by) WHERE superseded_by IS NOT NULL`);
    db.exec(`UPDATE questions SET knowledge_id = (SELECT k.n FROM knowledge k WHERE k.id = questions.knowledge_id) WHERE knowledge_id IS NOT NULL`);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  // Small, predictable memory footprint: 2 MB page cache, no mmap, temp data in memory.
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA cache_size = -2000;
    PRAGMA mmap_size = 0;
    PRAGMA temp_store = MEMORY;
  `);
  const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  const hasTables = !!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'projects'").get();
  if (hasTables && version < 2) {
    throw new Error(`Database ${path} is from the v1 prototype (format v${version}). Delete it or point RUCH_DB elsewhere.`);
  }
  if (hasTables && version === 2) migrateV2(db);
  db.exec(SCHEMA);
  for (const t of ROOM_NUMBERED) db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${t}_room_n ON ${t}(project_id, n)`);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  return db;
}
