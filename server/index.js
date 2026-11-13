import "dotenv/config";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import multer from "multer";
import {
  appendTranscript,
  createConsultation,
  getConsultation,
  listConsultations,
  updateConsultation
} from "./db.js";
import { buildClinicalDraft, transcribeAudio } from "./ai.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");
const uploadDir = join(rootDir, "uploads");
mkdirSync(uploadDir, { recursive: true });

const app = express();
const port = Number(process.env.PORT || 3001);

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (_req, file, cb) => {
    const safeName = file.originalname.replace(/[^a-z0-9._-]/gi, "-");
    cb(null, `${Date.now()}-${safeName}`);
  }
});

const upload = multer({ storage });

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error("Origen no permitido"));
    }
  })
);
app.use(express.json({ limit: "4mb" }));

app.get("/api/health", (_req, res) => {
  const provider = process.env.AI_PROVIDER || "openai";
  const azureConfigured = Boolean(
    process.env.AZURE_SPEECH_KEY &&
      process.env.AZURE_SPEECH_REGION &&
      process.env.AZURE_OPENAI_ENDPOINT &&
      process.env.AZURE_OPENAI_KEY &&
      process.env.AZURE_OPENAI_MODEL
  );

  res.json({
    ok: true,
    provider,
    hasOpenAiKey: Boolean(process.env.OPENAI_API_KEY),
    aiConfigured:
      provider === "azure" ? azureConfigured : Boolean(process.env.OPENAI_API_KEY)
  });
});

app.get("/api/consultations", (_req, res) => {
  res.json(listConsultations());
});

app.get("/api/consultations/:id", (req, res) => {
  const consultation = getConsultation(Number(req.params.id));
  if (!consultation) {
    res.status(404).json({ error: "Consulta no encontrada" });
    return;
  }
  res.json(consultation);
});

app.post("/api/consultations/start", (req, res) => {
  const consultation = createConsultation({
    patientName: req.body.patientName,
    patientAge: req.body.patientAge,
    transcript: "",
    clinicalNote: "Transcripcion en curso...",
    structured: {},
    missingQuestions: [],
    audioQuality: req.body.audioQuality,
    status: "recording"
  });

  res.status(201).json(consultation);
});

app.post(
  "/api/consultations/:id/chunks",
  upload.single("audio"),
  async (req, res) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: "Falta el audio" });
        return;
      }

      const { transcript, source } = await transcribeAudio(req.file.path);
      const consultation = appendTranscript(
        Number(req.params.id),
        transcript,
        req.file.path
      );

      if (!consultation) {
        res.status(404).json({ error: "Consulta no encontrada" });
        return;
      }

      res.json({
        consultation,
        chunk: {
          index: Number(req.body.chunkIndex || 0),
          transcript,
          source
        }
      });
    } catch (error) {
      console.error(error);
      res.status(500).json({
        error: "No se pudo transcribir el bloque de audio",
        detail: error.message
      });
    }
  }
);

app.post("/api/consultations/:id/finalize", async (req, res) => {
  try {
    const consultation = getConsultation(Number(req.params.id));
    if (!consultation) {
      res.status(404).json({ error: "Consulta no encontrada" });
      return;
    }

    const transcript = consultation.transcript || "";
    if (!transcript.trim()) {
      res.status(400).json({ error: "La consulta no tiene transcripcion" });
      return;
    }

    const draft = await buildClinicalDraft(transcript);
    const updated = updateConsultation(consultation.id, {
      ...consultation,
      clinicalNote: draft.clinicalNote,
      structured: draft.structured,
      missingQuestions: draft.missingQuestions,
      status: "draft"
    });

    res.json(updated);
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "No se pudo finalizar la ficha",
      detail: error.message
    });
  }
});

app.post("/api/consultations/audio", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: "Falta el audio" });
      return;
    }

    const { transcript } = await transcribeAudio(req.file.path);
    const draft = await buildClinicalDraft(transcript);
    const consultation = createConsultation({
      patientName: req.body.patientName,
      patientAge: req.body.patientAge,
      audioPath: req.file.path,
      transcript,
      clinicalNote: draft.clinicalNote,
      structured: draft.structured,
      missingQuestions: draft.missingQuestions,
      audioQuality: req.body.audioQuality,
      status: "draft"
    });

    res.status(201).json(consultation);
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "No se pudo procesar el audio",
      detail: error.message
    });
  }
});

app.post("/api/consultations/text", async (req, res) => {
  try {
    const transcript = req.body.transcript || "";
    const draft = await buildClinicalDraft(transcript);
    const consultation = createConsultation({
      patientName: req.body.patientName,
      patientAge: req.body.patientAge,
      transcript,
      clinicalNote: draft.clinicalNote,
      structured: draft.structured,
      missingQuestions: draft.missingQuestions,
      audioQuality: "manual",
      status: "draft"
    });

    res.status(201).json(consultation);
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "No se pudo generar la ficha",
      detail: error.message
    });
  }
});

app.put("/api/consultations/:id", (req, res) => {
  const updated = updateConsultation(Number(req.params.id), req.body);
  if (!updated) {
    res.status(404).json({ error: "Consulta no encontrada" });
    return;
  }
  res.json(updated);
});

app.listen(port, "127.0.0.1", () => {
  console.log(`API local lista en http://127.0.0.1:${port}`);
});
