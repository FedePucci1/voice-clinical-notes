import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Check,
  CircleStop,
  Clipboard,
  FileText,
  Mic,
  Mic2,
  Play,
  RefreshCcw,
  Save,
  SquarePen,
  Upload
} from "lucide-react";
import "./styles.css";

const API_URL = import.meta.env.VITE_API_URL || "http://127.0.0.1:3001/api";
const CHUNK_MS = 45_000;

const fieldLabels = {
  motivoConsulta: "Motivo de consulta",
  enfermedadActual: "Enfermedad actual",
  antecedentesPersonales: "Antecedentes personales",
  antecedentesFamiliares: "Antecedentes familiares",
  medicacionHabitual: "Medicación habitual",
  alergias: "Alergias",
  habitos: "Hábitos",
  signosSintomas: "Signos y síntomas",
  datosInciertos: "Datos inciertos"
};

function App() {
  const [health, setHealth] = useState(null);
  const [consultations, setConsultations] = useState([]);
  const [active, setActive] = useState(null);
  const [patientName, setPatientName] = useState("");
  const [patientAge, setPatientAge] = useState("");
  const [manualTranscript, setManualTranscript] = useState("");
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState("");
  const [audioQuality, setAudioQuality] = useState("sin medir");
  const [chunkStatus, setChunkStatus] = useState("");
  const [level, setLevel] = useState(0);
  const [recordingTime, setRecordingTime] = useState(0);

  const mediaRecorderRef = useRef(null);
  const consultationIdRef = useRef(null);
  const chunkIndexRef = useRef(0);
  const uploadQueueRef = useRef(Promise.resolve());
  const streamRef = useRef(null);
  const timerRef = useRef(null);
  const analyserRef = useRef(null);
  const rafRef = useRef(null);

  useEffect(() => {
    refresh();
    fetch(`${API_URL}/health`)
      .then((res) => res.json())
      .then(setHealth)
      .catch(() => setHealth({ ok: false, hasOpenAiKey: false }));
  }, []);

  const qualityTone = useMemo(() => {
    if (audioQuality.includes("buena")) return "good";
    if (audioQuality.includes("baja") || audioQuality.includes("ruido")) {
      return "bad";
    }
    return "warn";
  }, [audioQuality]);

  async function refresh() {
    const res = await fetch(`${API_URL}/consultations`);
    const data = await res.json();
    setConsultations(data);
  }

  async function startMicMonitor() {
    if (streamRef.current) return streamRef.current;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });
    streamRef.current = stream;

    const context = new AudioContext();
    const analyser = context.createAnalyser();
    const source = context.createMediaStreamSource(stream);
    source.connect(analyser);
    analyser.fftSize = 512;
    analyserRef.current = analyser;

    const data = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      analyser.getByteFrequencyData(data);
      const avg = data.reduce((sum, value) => sum + value, 0) / data.length;
      const normalized = Math.min(100, Math.round(avg * 2.4));
      setLevel(normalized);
      if (normalized > 34) setAudioQuality("buena señal de voz");
      else if (normalized > 14) setAudioQuality("señal baja, acercar notebook");
      else setAudioQuality("muy baja o mucho silencio");
      rafRef.current = requestAnimationFrame(tick);
    };
    tick();
    return stream;
  }

  async function startRecording() {
    setError("");
    setActive(null);
    setRecordingTime(0);
    setChunkStatus("");
    chunkIndexRef.current = 0;
    uploadQueueRef.current = Promise.resolve();
    try {
      const stream = await startMicMonitor();
      const started = await fetch(`${API_URL}/consultations/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          patientName,
          patientAge,
          audioQuality
        })
      });
      const consultation = await started.json();
      if (!started.ok) throw new Error(consultation.detail || consultation.error);

      consultationIdRef.current = consultation.id;
      setActive(consultation);
      await refresh();

      const recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
      mediaRecorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          const index = chunkIndexRef.current;
          chunkIndexRef.current += 1;
          uploadQueueRef.current = uploadQueueRef.current.then(() =>
            uploadChunk(event.data, index)
          );
        }
      };
      recorder.onstop = finalizeStreaming;
      recorder.start(CHUNK_MS);
      timerRef.current = setInterval(() => {
        setRecordingTime((value) => value + 1);
      }, 1000);
      setStatus("recording");
    } catch (err) {
      setError(`No pude acceder al micrófono: ${err.message}`);
    }
  }

  function stopRecording() {
    mediaRecorderRef.current?.stop();
    clearInterval(timerRef.current);
    setStatus("processing");
    setChunkStatus("Cerrando transcripción y generando ficha...");
  }

  async function uploadChunk(blob, index) {
    if (!consultationIdRef.current) return;
    setChunkStatus(`Transcribiendo bloque ${index + 1}...`);
    const formData = new FormData();
    formData.append("audio", blob, `consulta-${index + 1}.webm`);
    formData.append("chunkIndex", String(index));

    const res = await fetch(
      `${API_URL}/consultations/${consultationIdRef.current}/chunks`,
      {
        method: "POST",
        body: formData
      }
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || data.error);

    setActive(data.consultation);
    setChunkStatus(`Bloque ${index + 1} transcripto`);
    await refresh();
  }

  async function finalizeStreaming() {
    try {
      await uploadQueueRef.current;
      const res = await fetch(
        `${API_URL}/consultations/${consultationIdRef.current}/finalize`,
        { method: "POST" }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || data.error);
      setActive(data);
      setStatus("idle");
      setChunkStatus("Ficha generada");
      await refresh();
    } catch (err) {
      setError(err.message);
      setStatus("idle");
      setChunkStatus("");
    }
  }

  async function generateFromText() {
    setError("");
    setStatus("processing");
    try {
      const res = await fetch(`${API_URL}/consultations/text`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          patientName,
          patientAge,
          transcript: manualTranscript
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || data.error);
      setActive(data);
      setStatus("idle");
      await refresh();
    } catch (err) {
      setError(err.message);
      setStatus("idle");
    }
  }

  async function saveActive(nextStatus = active.status) {
    const res = await fetch(`${API_URL}/consultations/${active.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...active, status: nextStatus })
    });
    const data = await res.json();
    setActive(data);
    await refresh();
  }

  function copyDraft() {
    if (!active) return;
    const sections = Object.entries(active.structured)
      .map(([key, value]) => `${fieldLabels[key] || key}: ${value}`)
      .join("\n\n");
    navigator.clipboard.writeText(
      `Resumen:\n${active.clinicalNote}\n\n${sections}\n\nPreguntas faltantes:\n${active.missingQuestions.join("\n")}`
    );
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">MVP local</p>
          <h1>Ficha clínica por voz</h1>
        </div>
        <div className={`api-pill ${health?.aiConfigured ? "ready" : ""}`}>
          {health?.aiConfigured
            ? `IA conectada (${health.provider})`
            : "Modo demo"}
        </div>
      </header>

      <section className="workspace">
        <aside className="sidebar">
          <div className="panel">
            <div className="panel-title">
              <Mic2 size={18} />
              Nueva consulta
            </div>
            <label>
              Paciente
              <input
                value={patientName}
                onChange={(event) => setPatientName(event.target.value)}
                placeholder="Nombre opcional"
              />
            </label>
            <label>
              Edad
              <input
                value={patientAge}
                onChange={(event) => setPatientAge(event.target.value)}
                placeholder="Edad opcional"
              />
            </label>

            <button className="ghost" onClick={startMicMonitor}>
              <Play size={18} />
              Probar micrófono
            </button>
            <div className="meter" aria-label="Nivel de micrófono">
              <span style={{ width: `${level}%` }} />
            </div>
            <p className={`quality ${qualityTone}`}>{audioQuality}</p>

            {status === "recording" ? (
              <button className="danger" onClick={stopRecording}>
                <CircleStop size={18} />
                Finalizar {formatTime(recordingTime)}
              </button>
            ) : (
              <button onClick={startRecording} disabled={status === "processing"}>
                <Mic size={18} />
                Grabar entrevista
              </button>
            )}
          </div>

          <div className="panel">
            <div className="panel-title">
              <Upload size={18} />
              Prueba con texto
            </div>
            <textarea
              value={manualTranscript}
              onChange={(event) => setManualTranscript(event.target.value)}
              placeholder="Pegá una entrevista simulada para generar ficha sin grabar audio."
              rows={7}
            />
            <button
              className="ghost"
              onClick={generateFromText}
              disabled={!manualTranscript.trim() || status === "processing"}
            >
              <FileText size={18} />
              Generar ficha
            </button>
          </div>
        </aside>

        <section className="result">
          {error && <div className="error">{error}</div>}
          {chunkStatus && <div className="processing-inline">{chunkStatus}</div>}
          {status === "processing" && !active && (
            <div className="processing">Procesando consulta...</div>
          )}
          {!active && status !== "processing" && (
            <div className="empty">
              <SquarePen size={34} />
              <h2>Lista para una entrevista de prueba</h2>
              <p>
                Grabá con el micrófono de la notebook o pegá una transcripción
                simulada. La ficha queda guardada localmente.
              </p>
            </div>
          )}
          {active && (
            <ConsultationEditor
              consultation={active}
              onChange={setActive}
              onSave={() => saveActive("draft")}
              onApprove={() => saveActive("approved")}
              onCopy={copyDraft}
            />
          )}
        </section>

        <aside className="history">
          <div className="history-title">
            <span>Historial local</span>
            <button className="icon" onClick={refresh} title="Actualizar">
              <RefreshCcw size={16} />
            </button>
          </div>
          {consultations.map((item) => (
            <button
              className="history-item"
              key={item.id}
              onClick={() => setActive(item)}
            >
              <strong>{item.patientName || `Consulta #${item.id}`}</strong>
              <span>{item.createdAt}</span>
            </button>
          ))}
        </aside>
      </section>
    </main>
  );
}

function ConsultationEditor({ consultation, onChange, onSave, onApprove, onCopy }) {
  function updateStructured(key, value) {
    onChange({
      ...consultation,
      structured: { ...consultation.structured, [key]: value }
    });
  }

  return (
    <div className="editor">
      <div className="editor-head">
        <div>
          <p className="eyebrow">Borrador editable</p>
          <h2>{consultation.patientName || `Consulta #${consultation.id}`}</h2>
        </div>
        <div className="actions">
          <button className="ghost" onClick={onCopy}>
            <Clipboard size={18} />
            Copiar
          </button>
          <button className="ghost" onClick={onSave}>
            <Save size={18} />
            Guardar
          </button>
          <button onClick={onApprove}>
            <Check size={18} />
            Aprobar
          </button>
        </div>
      </div>

      <label>
        Resumen clínico
        <textarea
          value={consultation.clinicalNote}
          onChange={(event) =>
            onChange({ ...consultation, clinicalNote: event.target.value })
          }
          rows={4}
        />
      </label>

      <div className="grid">
        {Object.entries(fieldLabels).map(([key, label]) => (
          <label key={key}>
            {label}
            <textarea
              value={consultation.structured?.[key] || ""}
              onChange={(event) => updateStructured(key, event.target.value)}
              rows={3}
            />
          </label>
        ))}
      </div>

      <label>
        Preguntas faltantes
        <textarea
          value={consultation.missingQuestions.join("\n")}
          onChange={(event) =>
            onChange({
              ...consultation,
              missingQuestions: event.target.value.split("\n").filter(Boolean)
            })
          }
          rows={4}
        />
      </label>

      <details>
        <summary>Transcripción completa</summary>
        <pre>{consultation.transcript}</pre>
      </details>
    </div>
  );
}

function formatTime(value) {
  const minutes = Math.floor(value / 60).toString().padStart(2, "0");
  const seconds = (value % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

createRoot(document.getElementById("root")).render(<App />);
