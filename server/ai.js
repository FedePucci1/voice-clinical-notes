import { createReadStream, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import ffmpegPath from "ffmpeg-static";
import ffmpeg from "fluent-ffmpeg";
import OpenAI from "openai";

const provider = process.env.AI_PROVIDER || "openai";
const openai = buildOpenAiClient();

if (ffmpegPath) {
  ffmpeg.setFfmpegPath(ffmpegPath);
}

export async function transcribeAudio(filePath) {
  if (provider === "azure") {
    return transcribeWithAzureSpeech(filePath);
  }

  if (!openai) {
    return {
      transcript:
        "Modo demo sin OPENAI_API_KEY. Pega una transcripcion real o configura la API key para procesar audio.",
      source: "demo"
    };
  }

  const response = await withAiRetry(() =>
    openai.audio.transcriptions.create({
      file: createReadStream(filePath),
      model: process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe",
      language: "es",
      response_format: "json"
    })
  );

  return {
    transcript: response.text || "",
    source: "openai"
  };
}

export async function buildClinicalDraft(transcript) {
  if (!openai) {
    return demoDraft(transcript);
  }

  const response = await withAiRetry(() =>
    openai.chat.completions.create({
      model: getSummaryModel(),
      ...getModelOptions(),
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "Sos un asistente de documentacion clinica en Argentina. No diagnostiques ni inventes datos. Si algo no fue mencionado o es incierto, marca 'No mencionado' o 'Requiere confirmacion'. Devolve JSON valido."
        },
        {
          role: "user",
          content: `
Transforma esta transcripcion de una consulta medica en un borrador editable para el medico.

JSON requerido:
{
  "clinicalNote": "resumen breve en espanol",
  "structured": {
    "motivoConsulta": "",
    "enfermedadActual": "",
    "antecedentesPersonales": "",
    "antecedentesFamiliares": "",
    "medicacionHabitual": "",
    "alergias": "",
    "habitos": "",
    "signosSintomas": "",
    "datosInciertos": ""
  },
  "missingQuestions": ["preguntas importantes que faltan"]
}

Transcripcion:
${transcript}
`
        }
      ]
    })
  );

  const text = response.choices[0]?.message?.content || "{}";
  return normalizeDraft(JSON.parse(text));
}

function buildOpenAiClient() {
  if (provider === "azure") {
    if (!process.env.AZURE_OPENAI_ENDPOINT || !process.env.AZURE_OPENAI_KEY) {
      return null;
    }
    return new OpenAI({
      baseURL: process.env.AZURE_OPENAI_ENDPOINT,
      apiKey: process.env.AZURE_OPENAI_KEY
    });
  }

  return process.env.OPENAI_API_KEY
    ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    : null;
}

function getSummaryModel() {
  if (provider === "azure") {
    return process.env.AZURE_OPENAI_MODEL || "gpt-4o-mini";
  }
  return process.env.OPENAI_SUMMARY_MODEL || "gpt-4.1-mini";
}

function getModelOptions() {
  if (provider === "azure") {
    return {};
  }
  return { temperature: 0.2 };
}

async function transcribeWithAzureSpeech(filePath) {
  const key = process.env.AZURE_SPEECH_KEY;
  const region = process.env.AZURE_SPEECH_REGION;
  const language = process.env.AZURE_SPEECH_LANGUAGE || "es-AR";

  if (!key || !region) {
    throw new Error(
      "Faltan AZURE_SPEECH_KEY o AZURE_SPEECH_REGION para usar Azure Speech."
    );
  }

  const wavPath = await convertToAzureWav(filePath);
  const endpoint = new URL(
    `https://${region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1`
  );
  endpoint.searchParams.set("language", language);
  endpoint.searchParams.set("format", "detailed");

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": key,
      "Content-Type": "audio/wav; codecs=audio/pcm; samplerate=16000",
      Accept: "application/json"
    },
    body: readFileSync(wavPath)
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Azure Speech rechazo el audio: ${response.status} ${text}`);
  }

  const result = JSON.parse(text);
  const transcript =
    result.DisplayText ||
    result.NBest?.[0]?.Display ||
    result.NBest?.[0]?.Lexical ||
    "";

  if (!transcript) {
    throw new Error(
      `Azure Speech no detecto voz clara. Estado: ${result.RecognitionStatus || "desconocido"}`
    );
  }

  return {
    transcript,
    source: "azure-speech"
  };
}

function convertToAzureWav(filePath) {
  const tempDir = mkdtempSync(join(tmpdir(), "med-ficha-audio-"));
  const wavPath = join(tempDir, `${basename(filePath)}.wav`);

  return new Promise((resolve, reject) => {
    ffmpeg(filePath)
      .audioChannels(1)
      .audioFrequency(16000)
      .audioCodec("pcm_s16le")
      .format("wav")
      .on("end", () => resolve(wavPath))
      .on("error", reject)
      .save(wavPath);
  });
}

async function withAiRetry(operation, attempts = 3) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isRetryableAiError(error) || attempt === attempts) {
        throw toUserFacingAiError(error);
      }
      await sleep(800 * attempt);
    }
  }

  throw toUserFacingAiError(lastError);
}

function isRetryableAiError(error) {
  const code = error?.code || error?.cause?.code;
  return (
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "ECONNREFUSED" ||
    error?.status === 408 ||
    error?.status === 409 ||
    error?.status === 500 ||
    error?.status === 502 ||
    error?.status === 503 ||
    error?.status === 504
  );
}

function toUserFacingAiError(error) {
  if (error?.status === 401) {
    return new Error("La API key del proveedor de IA no es valida o fue revocada.");
  }
  if (error?.status === 429) {
    return new Error(
      "El proveedor de IA rechazo la solicitud por cuota o billing. Revisa creditos, rate limits o metodo de pago."
    );
  }
  if (error?.cause?.code === "ECONNRESET" || error?.code === "ECONNRESET") {
    return new Error(
      "La conexion con el proveedor de IA se corto mientras se procesaba. Proba de nuevo con una grabacion mas corta o revisa la conexion."
    );
  }
  return error;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function demoDraft(transcript) {
  return {
    clinicalNote:
      "Borrador demo. Configura una key de IA para generar una ficha clinica real a partir del audio.",
    structured: {
      motivoConsulta: "Requiere transcripcion real",
      enfermedadActual: transcript,
      antecedentesPersonales: "No mencionado",
      antecedentesFamiliares: "No mencionado",
      medicacionHabitual: "No mencionado",
      alergias: "No mencionado",
      habitos: "No mencionado",
      signosSintomas: "No mencionado",
      datosInciertos: "Modo demo activo"
    },
    missingQuestions: [
      "Confirmar motivo de consulta",
      "Confirmar medicacion habitual",
      "Confirmar alergias"
    ]
  };
}

function normalizeDraft(value) {
  const structured = value.structured || {};
  return {
    clinicalNote: value.clinicalNote || "",
    structured: {
      motivoConsulta: structured.motivoConsulta || "No mencionado",
      enfermedadActual: structured.enfermedadActual || "No mencionado",
      antecedentesPersonales:
        structured.antecedentesPersonales || "No mencionado",
      antecedentesFamiliares:
        structured.antecedentesFamiliares || "No mencionado",
      medicacionHabitual: structured.medicacionHabitual || "No mencionado",
      alergias: structured.alergias || "No mencionado",
      habitos: structured.habitos || "No mencionado",
      signosSintomas: structured.signosSintomas || "No mencionado",
      datosInciertos: structured.datosInciertos || "No mencionado"
    },
    missingQuestions: Array.isArray(value.missingQuestions)
      ? value.missingQuestions
      : []
  };
}
