import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");
const dataDir = join(rootDir, "data");

mkdirSync(dataDir, { recursive: true });

export const db = new DatabaseSync(join(dataDir, "consultas.sqlite"));

db.exec(`
  CREATE TABLE IF NOT EXISTS consultations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    patient_name TEXT,
    patient_age TEXT,
    audio_path TEXT,
    transcript TEXT,
    clinical_note TEXT,
    structured_json TEXT,
    missing_questions TEXT,
    audio_quality TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

export function createConsultation(data) {
  const stmt = db.prepare(`
    INSERT INTO consultations (
      patient_name,
      patient_age,
      audio_path,
      transcript,
      clinical_note,
      structured_json,
      missing_questions,
      audio_quality,
      status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    data.patientName ?? "",
    data.patientAge ?? "",
    data.audioPath ?? "",
    data.transcript ?? "",
    data.clinicalNote ?? "",
    JSON.stringify(data.structured ?? {}),
    JSON.stringify(data.missingQuestions ?? []),
    data.audioQuality ?? "",
    data.status ?? "draft"
  );

  return getConsultation(result.lastInsertRowid);
}

export function appendTranscript(id, chunkText, audioPath = "") {
  const consultation = getConsultation(id);
  if (!consultation) return null;

  const transcript = mergeTranscript(consultation.transcript || "", chunkText);
  const audioPaths = [consultation.audioPath, audioPath].filter(Boolean).join("\n");

  db.prepare(`
    UPDATE consultations
    SET transcript = ?,
        audio_path = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(transcript, audioPaths, id);

  return getConsultation(id);
}

export function updateConsultation(id, data) {
  const stmt = db.prepare(`
    UPDATE consultations
    SET patient_name = ?,
        patient_age = ?,
        transcript = ?,
        clinical_note = ?,
        structured_json = ?,
        missing_questions = ?,
        audio_quality = ?,
        status = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);

  stmt.run(
    data.patientName ?? "",
    data.patientAge ?? "",
    data.transcript ?? "",
    data.clinicalNote ?? "",
    JSON.stringify(data.structured ?? {}),
    JSON.stringify(data.missingQuestions ?? []),
    data.audioQuality ?? "",
    data.status ?? "draft",
    id
  );

  return getConsultation(id);
}

function mergeTranscript(current, next) {
  const cleanNext = (next || "").trim();
  if (!cleanNext) return current || "";
  if (!current) return cleanNext;

  const normalizedCurrent = current.trim();
  const tail = normalizedCurrent.slice(-160).toLowerCase();
  const incoming = cleanNext.toLowerCase();

  for (let size = Math.min(tail.length, incoming.length); size >= 20; size -= 1) {
    if (tail.endsWith(incoming.slice(0, size))) {
      return `${normalizedCurrent}${cleanNext.slice(size)}`.trim();
    }
  }

  return `${normalizedCurrent}\n${cleanNext}`;
}

export function getConsultation(id) {
  const row = db.prepare("SELECT * FROM consultations WHERE id = ?").get(id);
  return row ? mapConsultation(row) : null;
}

export function listConsultations() {
  return db
    .prepare("SELECT * FROM consultations ORDER BY created_at DESC LIMIT 50")
    .all()
    .map(mapConsultation);
}

function mapConsultation(row) {
  return {
    id: row.id,
    patientName: row.patient_name,
    patientAge: row.patient_age,
    audioPath: row.audio_path,
    transcript: row.transcript,
    clinicalNote: row.clinical_note,
    structured: safeJson(row.structured_json, {}),
    missingQuestions: safeJson(row.missing_questions, []),
    audioQuality: row.audio_quality,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function safeJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}
