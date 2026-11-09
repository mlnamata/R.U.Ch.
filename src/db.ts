import { DatabaseSync } from "node:sqlite";

/**
 * Database schema of the hub.
 *
 * Design notes:
 * - IDs are small integers on purpose: agents reference them in text ("T3", "Q7", "K12"),
 *   and short IDs are cheap in tokens and hard to mistype or invent.
 * - JSON columns (mentions, evidence, options, meta) keep the schema small; they are
 *   always written by the hub itself, never raw by clients.
 * - Knowledge has an FTS5 index (diacritics-insensitive, so Czech text works) so agents
 *   can search earlier answers before asking again. No embeddings / API key needed.
 */
export const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
  id          INTEGER PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  brief       TEXT NOT NULL DEFAULT '',          -- project brief every agent receives
  root_path   TEXT,                              -- local checkout, used to verify file evidence
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS participants (
  id            INTEGER PRIMARY KEY,
  project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name          TEXT NOT NULL COLLATE NOCASE,
  kind          TEXT NOT NULL CHECK (kind IN ('agent','human')),
  role          TEXT NOT NULL DEFAULT '',
  status_text   TEXT NOT NULL DEFAULT '',        -- "what I am doing right now"
  inbox_cursor  INTEGER NOT NULL DEFAULT 0,      -- last message id delivered via inbox
  last_seen_at  TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (project_id, name)
);

CREATE TABLE IF NOT EXISTS threads (
  id             INTEGER PRIMARY KEY,
  project_id     INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_id      INTEGER REFERENCES threads(id) ON DELETE SET NULL,  -- side discussion
  title          TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','human_needed','resolved')),
  status_reason  TEXT NOT NULL DEFAULT '',
  summary        TEXT NOT NULL DEFAULT '',       -- short running summary = cheap context
  agent_streak   INTEGER NOT NULL DEFAULT 0,     -- agent messages since the last human message
  created_by     INTEGER REFERENCES participants(id),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS threads_project ON threads(project_id, status);

CREATE TABLE IF NOT EXISTS messages (
  id               INTEGER PRIMARY KEY,
  thread_id        INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  author_id        INTEGER REFERENCES participants(id),   -- NULL = system message
  kind             TEXT NOT NULL CHECK (kind IN ('chat','question','answer','decision','handoff','review','status','system')),
  body             TEXT NOT NULL,
  mentions         TEXT NOT NULL DEFAULT '[]',            -- JSON array of participant ids
  reply_to         INTEGER REFERENCES messages(id),
  evidence         TEXT NOT NULL DEFAULT '[]',            -- JSON array of Evidence
  evidence_status  TEXT NOT NULL DEFAULT 'none'
                   CHECK (evidence_status IN ('none','verified','unchecked','invalid','missing')),
  confidence       TEXT CHECK (confidence IN ('certain','likely','guess')),
  meta             TEXT NOT NULL DEFAULT '{}',
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_id, id);

CREATE TABLE IF NOT EXISTS questions (
  id                 INTEGER PRIMARY KEY,
  project_id         INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  thread_id          INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  message_id         INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  asked_by           INTEGER NOT NULL REFERENCES participants(id),
  target_id          INTEGER REFERENCES participants(id),   -- NULL = anyone may answer
  body               TEXT NOT NULL,
  options            TEXT NOT NULL DEFAULT '[]',            -- JSON array of strings (A/B choices)
  blocking           INTEGER NOT NULL DEFAULT 0,            -- asker cannot continue without it
  status             TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','cancelled')),
  answer_message_id  INTEGER REFERENCES messages(id),
  answered_by        INTEGER REFERENCES participants(id),
  knowledge_id       INTEGER REFERENCES knowledge(id),
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  answered_at        TEXT
);
CREATE INDEX IF NOT EXISTS questions_open ON questions(project_id, status);

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
  superseded_by      INTEGER REFERENCES knowledge(id),
  author_id          INTEGER REFERENCES participants(id),
  source_message_id  INTEGER REFERENCES messages(id),
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

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
CREATE TRIGGER IF NOT EXISTS knowledge_au AFTER UPDATE ON knowledge BEGIN
  INSERT INTO knowledge_fts(knowledge_fts, rowid, title, body, tags) VALUES ('delete', old.id, old.title, old.body, old.tags);
  INSERT INTO knowledge_fts(rowid, title, body, tags) VALUES (new.id, new.title, new.body, new.tags);
END;

-- File claims: "I am editing these paths right now" – prevents two agents editing the same file.
CREATE TABLE IF NOT EXISTS claims (
  id          INTEGER PRIMARY KEY,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path        TEXT NOT NULL,                     -- file or directory (prefix), normalised
  holder_id   INTEGER NOT NULL REFERENCES participants(id),
  reason      TEXT NOT NULL DEFAULT '',
  thread_id   INTEGER REFERENCES threads(id) ON DELETE SET NULL,
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS claims_project ON claims(project_id, expires_at);

CREATE TABLE IF NOT EXISTS tasks (
  id           INTEGER PRIMARY KEY,
  project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  thread_id    INTEGER REFERENCES threads(id) ON DELETE SET NULL,
  title        TEXT NOT NULL,
  details      TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','doing','review','done','blocked')),
  assignee_id  INTEGER REFERENCES participants(id),
  created_by   INTEGER REFERENCES participants(id),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS tasks_project ON tasks(project_id, status);
`;

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}
