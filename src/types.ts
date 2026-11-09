export type ParticipantKind = "agent" | "human";
export type ThreadStatus = "open" | "human_needed" | "resolved";
export type MessageKind =
  | "chat"
  | "question"
  | "answer"
  | "decision"
  | "handoff"
  | "review"
  | "status"
  | "system";
export type Confidence = "certain" | "likely" | "guess";
export type EvidenceStatus = "none" | "verified" | "unchecked" | "invalid" | "missing";
export type TaskStatus = "todo" | "doing" | "review" | "done" | "blocked";
export type KnowledgeKind = "answer" | "decision" | "fact" | "note";
export type Trust = "human" | "evidence" | "agent";

/** A pointer that backs up a claim. The hub checks what it can (files, ids, quotes). */
export type Evidence =
  /** checked = the agent's local CLI already verified path, lines and quote on disk. */
  | { type: "file"; path: string; lines?: string; quote?: string; checked?: boolean }
  | { type: "message"; id: number }
  | { type: "knowledge"; id: number }
  | { type: "command"; command: string; output?: string }
  | { type: "url"; url: string };

export interface Project {
  id: number;
  name: string;
  brief: string;
  code_rotation: number;
  created_at: string;
  last_active_at: string;
}

export interface Participant {
  id: number;
  project_id: number;
  name: string;
  kind: ParticipantKind;
  role: string;
  status_text: string;
  inbox_cursor: number;
  thread_cursor: number;
  last_seen_at: string | null;
  created_at: string;
}

export interface Thread {
  id: number;
  project_id: number;
  parent_id: number | null;
  title: string;
  status: ThreadStatus;
  status_reason: string;
  summary: string;
  agent_streak: number;
  message_count: number;
  created_by: number | null;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: number;
  thread_id: number;
  author_id: number | null;
  author: string; // resolved name, "system" for system messages
  author_kind: ParticipantKind | "system";
  kind: MessageKind;
  body: string;
  mentions: string[]; // resolved names
  reply_to: number | null;
  evidence: Evidence[];
  evidence_status: EvidenceStatus;
  confidence: Confidence | null;
  meta: Record<string, unknown>;
  created_at: string;
}

export interface Question {
  id: number;
  project_id: number;
  thread_id: number;
  message_id: number;
  asked_by: string;
  target: string | null; // participant name or null = anyone
  body: string;
  options: string[];
  blocking: boolean;
  status: "open" | "answered" | "cancelled";
  answer: string | null;
  answered_by: string | null;
  answer_message_id: number | null;
  knowledge_id: number | null;
  created_at: string;
  answered_at: string | null;
}

export interface Knowledge {
  id: number;
  project_id: number;
  kind: KnowledgeKind;
  title: string;
  body: string;
  tags: string;
  evidence: Evidence[];
  trust: Trust;
  status: "active" | "disputed" | "superseded";
  status_note: string;
  superseded_by: number | null;
  author: string | null;
  source_message_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface Claim {
  id: number;
  project_id: number;
  path: string;
  holder: string;
  holder_id: number;
  reason: string;
  thread_id: number | null;
  expires_at: string;
  created_at: string;
}

export interface Task {
  id: number;
  project_id: number;
  thread_id: number | null;
  title: string;
  details: string;
  status: TaskStatus;
  assignee: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface HubEvent {
  projectId: number;
  type:
    | "message"
    | "thread"
    | "question"
    | "knowledge"
    | "claim"
    | "task"
    | "participant";
  data: unknown;
}
