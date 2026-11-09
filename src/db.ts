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
export const SCHEMA_VERSION = 2;

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id              INTEGER PRIMARY KEY,
  name            TEXT NOT NULL,
  brief           TEXT NOT NULL DEFAULT '',
  agent_key_hash  TEXT NOT NULL UNIQUE,
  owner_key_hash  TEXT NOT NULL UNIQUE,
  code_rotation   INTEGER NOT NULL DEFAULT 0,          -- agent code = hash(owner key, rotation); bump to revoke
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
  status_text    TEXT NOT NULL DEFAULT '',
  inbox_cursor   INTEGER NOT NULL DEFAULT 0,          -- last message id delivered via inbox
  thread_cursor  INTEGER NOT NULL DEFAULT 0,          -- last thread id announced via inbox
  last_seen_at   TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (project_id, name)
);

CREATE TABLE IF NOT EXISTS threads (
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
  if (hasTables && version < SCHEMA_VERSION) {
    throw new Error(
      `Databáze ${path} je ve starém formátu (v${version}) z prototypu. Smaž ji (nebo nastav jinou cestu v RUCH_DB) a spusť hub znovu.`,
    );
  }
  db.exec(SCHEMA);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  return db;
}
