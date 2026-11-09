import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { Evidence, EvidenceStatus } from "./types.js";

export interface EvidenceCheck {
  evidence: Evidence;
  result: "verified" | "unchecked" | "invalid";
  note?: string;
}

export interface EvidenceLookup {
  projectRoot: string | null;
  messageExists(id: number): boolean;
  knowledgeStatus(id: number): "active" | "disputed" | "superseded" | null;
}

const MAX_FILE_BYTES = 2_000_000;

/** Collapse whitespace so a quote still matches after re-indentation or line wrapping. */
function squash(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Resolve a path inside the project root. Returns null when the path escapes the root,
 * so evidence can never be used to probe files outside the project.
 */
export function resolveInRoot(root: string, path: string): string | null {
  const full = resolve(root, path);
  const rel = relative(root, full);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return full;
}

function parseLines(spec: string): [number, number] | null {
  const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(spec.trim());
  if (!m) return null;
  const from = Number(m[1]);
  const to = m[2] ? Number(m[2]) : from;
  if (from < 1 || to < from) return null;
  return [from, to];
}

function checkFile(ev: Extract<Evidence, { type: "file" }>, root: string | null): EvidenceCheck {
  if (!root) {
    return { evidence: ev, result: "unchecked", note: "hub nezná kořen projektu (RUCH_PROJECT_ROOT)" };
  }
  const full = resolveInRoot(root, ev.path);
  if (!full) return { evidence: ev, result: "invalid", note: `cesta ${ev.path} je mimo projekt` };
  if (!existsSync(full)) return { evidence: ev, result: "invalid", note: `soubor ${ev.path} neexistuje` };
  const st = statSync(full);
  if (st.isDirectory()) {
    if (ev.lines || ev.quote) {
      return { evidence: ev, result: "invalid", note: `${ev.path} je složka, nelze citovat řádky` };
    }
    return { evidence: ev, result: "verified" };
  }
  if (st.size > MAX_FILE_BYTES) {
    return { evidence: ev, result: "unchecked", note: `${ev.path} je příliš velký na ověření` };
  }
  const text = readFileSync(full, "utf8");
  const lines = text.split(/\r?\n/);
  let scope = text;
  if (ev.lines) {
    const range = parseLines(ev.lines);
    if (!range) return { evidence: ev, result: "invalid", note: `neplatný rozsah řádků "${ev.lines}" (použij např. "10-25")` };
    if (range[1] > lines.length) {
      return {
        evidence: ev,
        result: "invalid",
        note: `${ev.path} má jen ${lines.length} řádků, rozsah ${ev.lines} neexistuje`,
      };
    }
    scope = lines.slice(range[0] - 1, range[1]).join("\n");
  }
  if (ev.quote) {
    if (!squash(scope).includes(squash(ev.quote))) {
      return {
        evidence: ev,
        result: "invalid",
        note: `citace se v ${ev.path}${ev.lines ? `:${ev.lines}` : ""} nenachází – načti soubor znovu a cituj doslova`,
      };
    }
  }
  return { evidence: ev, result: "verified" };
}

export function checkEvidence(list: Evidence[], lookup: EvidenceLookup): EvidenceCheck[] {
  return list.map((ev): EvidenceCheck => {
    switch (ev.type) {
      case "file":
        return checkFile(ev, lookup.projectRoot);
      case "message":
        return lookup.messageExists(ev.id)
          ? { evidence: ev, result: "verified" }
          : { evidence: ev, result: "invalid", note: `zpráva M${ev.id} neexistuje` };
      case "knowledge": {
        const st = lookup.knowledgeStatus(ev.id);
        if (st === null) return { evidence: ev, result: "invalid", note: `znalost K${ev.id} neexistuje` };
        if (st === "superseded") return { evidence: ev, result: "invalid", note: `znalost K${ev.id} je nahrazená novější` };
        if (st === "disputed") return { evidence: ev, result: "unchecked", note: `znalost K${ev.id} je zpochybněná` };
        return { evidence: ev, result: "verified" };
      }
      case "command":
      case "url":
        return { evidence: ev, result: "unchecked" };
    }
  });
}

/** Kinds of messages that state facts or conclusions and therefore should carry evidence. */
export const FACTUAL_KINDS = new Set(["answer", "decision", "review", "handoff"]);

export function overallStatus(kind: string, checks: EvidenceCheck[]): EvidenceStatus {
  if (checks.length === 0) return FACTUAL_KINDS.has(kind) ? "missing" : "none";
  if (checks.some((c) => c.result === "invalid")) return "invalid";
  if (checks.every((c) => c.result === "verified")) return "verified";
  return "unchecked";
}
