import { useEffect, useMemo, useRef, useState } from "react";
import {
  fetchAppInfo,
  fetchGenerationDb,
  fetchVoicePresets,
  loadAudioObjectUrl,
  removeGenerationRecord,
  requestAudioGeneration,
  revealOutputInExplorer,
  saveGenerationRecord,
  startPythonWorker,
  stopPythonWorker,
  subscribeWorkerExit,
  subscribeWorkerLog,
  subscribeWorkerReady,
  subscribeWorkerResult,
  subscribeWorkerStatus,
} from "./api/tauriBridge";
import {
  BARK_EXPRESSION_TAGS,
  buildTimestampFilename,
  extractAvailableLanguages,
  filterVoicePresets,
  formatDuration,
  getLanguageLabel,
  insertTokenAtSelection,
  validateGenerationConfig,
} from "./core/barkHelpers";
import {
  formatPresetOptionLabel,
  getSpeakerContext,
} from "./core/speakerCatalog";
import type {
  AppInfo,
  GenerateRequestPayload,
  GenerationConfig,
  GenerationRecord,
  HistoryItem,
  VoicePreset,
  WorkerStatus,
} from "./core/types";

const INITIAL_WORKER_STATUS: WorkerStatus = {
  stage: "starting",
  device: "Detecting...",
  cuda: false,
  torchVersion: "",
  lastError: null,
};

const INITIAL_CONFIG: GenerationConfig = {
  text: "Hello, my name is Suno. [laughs] I am running locally on Bark Studio!",
  presetId: "v2/en_speaker_6",
  customPromptPath: "",
  textTemp: 0.7,
  waveformTemp: 0.7,
  outputDir: "",
  outputFilename: buildTimestampFilename(),
  useSmallModels: false,
  offloadCpu: false,
  savePromptNpz: false,
};

const STAGE_LABELS: Readonly<Record<WorkerStatus["stage"], string>> = {
  stopped: "Stopped",
  starting: "Starting Python...",
  ready: "Ready",
  loading: "Loading Models...",
  generating: "Generating Audio...",
  saving: "Saving WAV...",
  error: "Error",
} as const;

const SPEAKER_NOTES_STORAGE_KEY = "bark_studio_speaker_notes_v1";

interface InfoTooltipProps {
  readonly text: string;
}

function InfoTooltip({ text }: InfoTooltipProps) {
  return (
    <span className="tooltip-anchor" tabIndex={0} aria-label={text}>
      <span className="tooltip-icon">?</span>
      <span className="tooltip-bubble" role="tooltip">
        {text}
      </span>
    </span>
  );
}

function loadStoredSpeakerNotes(): Readonly<Record<string, string>> {
  try {
    const raw = localStorage.getItem(SPEAKER_NOTES_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Readonly<Record<string, string>>;
    }
    return {};
  } catch {
    return {};
  }
}

export function App() {
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [presets, setPresets] = useState<readonly VoicePreset[]>([]);
  const [speakerNotes, setSpeakerNotes] = useState<
    Readonly<Record<string, string>>
  >(loadStoredSpeakerNotes);
  const [languageFilter, setLanguageFilter] = useState<string>("all");
  const [onlyV2, setOnlyV2] = useState<boolean>(true);
  const [presetQuery, setPresetQuery] = useState<string>("");

  const [config, setConfig] = useState<GenerationConfig>(INITIAL_CONFIG);
  const [workerStatus, setWorkerStatus] = useState<WorkerStatus>(
    INITIAL_WORKER_STATUS
  );
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [history, setHistory] = useState<readonly HistoryItem[]>([]);
  const [selectedHistoryId, setSelectedHistoryId] = useState<string | null>(
    null
  );
  const [logs, setLogs] = useState<readonly string[]>([]);
  const [uiError, setUiError] = useState<string | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const pendingMetaRef = useRef<
    Readonly<Record<string, GenerateRequestPayload>>
  >({});

  useEffect(() => {
    let active = true;

    async function bootstrap() {
      try {
        const [info, loadedPresets, savedRecords] = await Promise.all([
          fetchAppInfo(),
          fetchVoicePresets(),
          fetchGenerationDb(),
        ]);
        if (!active) return;
        setAppInfo(info);
        setPresets(loadedPresets);
        setHistory(
          savedRecords.map((record) => ({
            ...record,
            audioUrl: null,
          }))
        );
        setConfig((prev) => ({
          ...prev,
          outputDir: prev.outputDir || info.defaultOutputDir,
        }));
        await startPythonWorker();
      } catch (err) {
        if (!active) return;
        const message = err instanceof Error ? err.message : String(err);
        setUiError(message);
        setWorkerStatus((prev) => ({
          ...prev,
          stage: "error",
          lastError: message,
        }));
      }
    }

    bootstrap();

    const unlistenPromises = [
      subscribeWorkerReady((payload) => {
        setWorkerStatus({
          stage: "ready",
          device: payload.device,
          cuda: payload.cuda,
          torchVersion: payload.torch,
          lastError: null,
        });
      }),
      subscribeWorkerStatus((payload) => {
        setWorkerStatus((prev) => ({
          ...prev,
          stage: payload.stage,
        }));
      }),
      subscribeWorkerLog((line) => {
        setLogs((prev) => [...prev.slice(-149), line]);
      }),
      subscribeWorkerExit(() => {
        setActiveJobId(null);
        setWorkerStatus((prev) => ({
          ...prev,
          stage: "stopped",
        }));
      }),
      subscribeWorkerResult(async (payload) => {
        setActiveJobId(null);
        if (!payload.ok || !payload.output_path) {
          const errMsg = payload.error ?? "Generation failed.";
          setUiError(errMsg);
          setWorkerStatus((prev) => ({
            ...prev,
            stage: "error",
            lastError: errMsg,
          }));
          return;
        }

        setWorkerStatus((prev) => ({
          ...prev,
          stage: "ready",
          lastError: null,
        }));

        try {
          const jobId = payload.id ?? crypto.randomUUID();
          const meta = pendingMetaRef.current[jobId];
          const record: GenerationRecord = {
            id: jobId,
            text: meta?.text ?? "",
            preset: meta?.historyPrompt ?? "none",
            textTemp: meta?.textTemp ?? 0.7,
            waveformTemp: meta?.waveformTemp ?? 0.7,
            useSmallModels: meta?.useSmallModels ?? false,
            offloadCpu: meta?.offloadCpu ?? false,
            outputPath: payload.output_path,
            promptPath: payload.prompt_path ?? null,
            durationSeconds: payload.duration_seconds ?? 0,
            sampleRate: payload.sample_rate ?? 24000,
            createdAt: new Date().toISOString(),
          };

          const [audioUrl] = await Promise.all([
            loadAudioObjectUrl(payload.output_path),
            saveGenerationRecord(record),
          ]);

          const newItem: HistoryItem = {
            ...record,
            audioUrl,
          };
          setHistory((prev) => [newItem, ...prev]);
          setSelectedHistoryId(newItem.id);
          setConfig((prev) => ({
            ...prev,
            outputFilename: buildTimestampFilename(),
          }));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          setUiError(`Audio generated, but failed to save/load preview: ${msg}`);
        }
      }),
    ];

    return () => {
      active = false;
      Promise.all(unlistenPromises).then((unlisteners) => {
        unlisteners.forEach((unlisten) => unlisten());
      });
    };
  }, []);

  const availableLanguages = useMemo(
    () => extractAvailableLanguages(presets),
    [presets]
  );

  const filteredPresets = useMemo(
    () =>
      filterVoicePresets(
        presets,
        languageFilter,
        onlyV2,
        presetQuery,
        speakerNotes
      ),
    [presets, languageFilter, onlyV2, presetQuery, speakerNotes]
  );

  const selectedPresetObj = useMemo(
    () => presets.find((p) => p.id === config.presetId) ?? null,
    [presets, config.presetId]
  );

  const selectedSpeakerContext = useMemo(
    () => (selectedPresetObj ? getSpeakerContext(selectedPresetObj) : null),
    [selectedPresetObj]
  );

  function handleSpeakerNoteChange(presetId: string, note: string) {
    setSpeakerNotes((prev) => {
      const next = { ...prev, [presetId]: note };
      try {
        localStorage.setItem(SPEAKER_NOTES_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Ignore storage quota errors
      }
      return next;
    });
  }

  const selectedClip = useMemo(
    () => history.find((item) => item.id === selectedHistoryId) ?? history[0] ?? null,
    [history, selectedHistoryId]
  );

  const isBusy =
    activeJobId !== null ||
    workerStatus.stage === "loading" ||
    workerStatus.stage === "generating" ||
    workerStatus.stage === "saving";

  function handleInsertTag(token: string) {
    const el = textareaRef.current;
    const start = el?.selectionStart ?? config.text.length;
    const end = el?.selectionEnd ?? config.text.length;
    const { nextText, nextCursor } = insertTokenAtSelection(
      config.text,
      token,
      start,
      end
    );
    setConfig((prev) => ({ ...prev, text: nextText }));
    requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.focus();
        textareaRef.current.setSelectionRange(nextCursor, nextCursor);
      }
    });
  }

  async function handleGenerate() {
    setUiError(null);
    const jobId = crypto.randomUUID();
    const validation = validateGenerationConfig(config, jobId);
    if (!validation.success) {
      setUiError(validation.error);
      return;
    }

    pendingMetaRef.current = {
      ...pendingMetaRef.current,
      [jobId]: validation.value,
    };

    setActiveJobId(jobId);
    setWorkerStatus((prev) => ({ ...prev, stage: "loading", lastError: null }));

    try {
      await requestAudioGeneration(validation.value);
    } catch (err) {
      setActiveJobId(null);
      const msg = err instanceof Error ? err.message : String(err);
      setUiError(msg);
      setWorkerStatus((prev) => ({
        ...prev,
        stage: "error",
        lastError: msg,
      }));
    }
  }

  async function handleSelectHistoryItem(item: HistoryItem) {
    setSelectedHistoryId(item.id);
    if (item.audioUrl !== null) {
      return;
    }
    try {
      const audioUrl = await loadAudioObjectUrl(item.outputPath);
      setHistory((prev) =>
        prev.map((entry) =>
          entry.id === item.id ? { ...entry, audioUrl } : entry
        )
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setUiError(`Could not load audio file: ${msg}`);
    }
  }

  function handleRestorePrompt(item: HistoryItem) {
    const isBuiltInPreset =
      item.preset === "none" ||
      presets.some((preset) => preset.id === item.preset);

    setConfig((prev) => ({
      ...prev,
      text: item.text,
      presetId: isBuiltInPreset ? item.preset : prev.presetId,
      customPromptPath: isBuiltInPreset ? "" : item.preset,
      textTemp: item.textTemp,
      waveformTemp: item.waveformTemp,
      useSmallModels: item.useSmallModels,
      offloadCpu: item.offloadCpu,
    }));
  }

  async function handleDeleteHistoryItem(id: string) {
    try {
      const remaining = await removeGenerationRecord(id, false);
      setHistory((prev) => {
        const urlMap = new Map(prev.map((entry) => [entry.id, entry.audioUrl]));
        return remaining.map((record) => ({
          ...record,
          audioUrl: urlMap.get(record.id) ?? null,
        }));
      });
      if (selectedHistoryId === id) {
        setSelectedHistoryId(null);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setUiError(`Failed to remove record: ${msg}`);
    }
  }

  async function handleRestartWorker() {
    setUiError(null);
    setActiveJobId(null);
    setWorkerStatus((prev) => ({ ...prev, stage: "starting" }));
    try {
      await stopPythonWorker();
      await startPythonWorker();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setUiError(msg);
      setWorkerStatus((prev) => ({
        ...prev,
        stage: "error",
        lastError: msg,
      }));
    }
  }

  return (
    <div className="app-shell">
      <header className="top-bar">
        <div className="brand-block">
          <span className="brand-badge">BARK</span>
          <div>
            <h1>Bark Studio</h1>
            <p className="subtitle">
              Local Text-to-Audio Console {appInfo ? `• ${appInfo.barkRoot}` : ""}
            </p>
          </div>
        </div>

        <div className="status-cluster">
          <div className={`status-pill stage-${workerStatus.stage}`}>
            <span className="status-dot" />
            <span>{STAGE_LABELS[workerStatus.stage]}</span>
            <span className="status-sep">•</span>
            <span>
              {workerStatus.cuda ? `CUDA (${workerStatus.device})` : workerStatus.device}
            </span>
          </div>
          <button
            type="button"
            className="btn-secondary"
            onClick={handleRestartWorker}
            title="Restart Python worker & free VRAM"
          >
            Unload / Restart
          </button>
        </div>
      </header>

      {uiError && (
        <div className="error-banner" role="alert">
          <span>{uiError}</span>
          <button
            type="button"
            className="btn-dismiss"
            onClick={() => setUiError(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      <main className="workspace-grid">
        <section className="panel panel-controls">
          <div className="section-header">
            <div className="label-with-tip">
              <h2>Prompt</h2>
              <InfoTooltip text="Enter spoken text, lyrics wrapped in ♪ ... ♪, or non-speech tags like [laughs] and [sighs]. Works best for ~13 seconds of speech per clip." />
            </div>
            <span className="muted-meta">{config.text.length} chars</span>
          </div>

          <textarea
            ref={textareaRef}
            className="prompt-input"
            rows={5}
            value={config.text}
            onChange={(e) =>
              setConfig((prev) => ({ ...prev, text: e.target.value }))
            }
            placeholder="Enter speech, lyrics (♪ ... ♪), or non-speech tags like [laughs], [sighs], [music]..."
          />

          <div className="tag-strip">
            {BARK_EXPRESSION_TAGS.map((tag) => (
              <button
                key={tag.label}
                type="button"
                className="tag-chip"
                onClick={() => handleInsertTag(tag.token)}
              >
                {tag.label}
              </button>
            ))}
          </div>

          <div className="divider" />

          <div className="section-header">
            <div className="label-with-tip">
              <h2>Voice Preset</h2>
              <InfoTooltip text="Choose a built-in speaker voice embedding. Bark uses this to match tone, pitch, and accent." />
            </div>
            <label className="inline-check">
              <input
                type="checkbox"
                checked={onlyV2}
                onChange={(e) => setOnlyV2(e.target.checked)}
              />
              <span>v2 presets only</span>
              <InfoTooltip text="Show only newer v2 speaker presets, which generally sound cleaner and more consistent than v1." />
            </label>
          </div>

          <div className="preset-filters">
            <select
              aria-label="Language filter"
              value={languageFilter}
              onChange={(e) => setLanguageFilter(e.target.value)}
            >
              {availableLanguages.map((lang) => (
                <option key={lang} value={lang}>
                  {getLanguageLabel(lang)}
                </option>
              ))}
            </select>

            <input
              type="text"
              placeholder="Search name, gender, style (e.g. female, narrator)..."
              value={presetQuery}
              onChange={(e) => setPresetQuery(e.target.value)}
            />
          </div>

          <select
            className="preset-select"
            aria-label="Voice preset"
            value={config.presetId}
            onChange={(e) =>
              setConfig((prev) => ({ ...prev, presetId: e.target.value }))
            }
          >
            <option value="none">Random / Unconditional (No Preset)</option>
            {filteredPresets.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {formatPresetOptionLabel(preset, speakerNotes[preset.id])}
              </option>
            ))}
          </select>

          {selectedSpeakerContext && (
            <div className="speaker-context-card">
              <div className="speaker-context-head">
                <strong>{selectedSpeakerContext.displayName}</strong>
                <span
                  className={`gender-badge gender-${selectedSpeakerContext.gender.toLowerCase()}`}
                >
                  {selectedSpeakerContext.gender}
                </span>
              </div>
              <p className="muted-meta">{selectedSpeakerContext.summary}</p>
              <input
                type="text"
                className="speaker-note-input"
                placeholder="Add your own voice note (e.g. warm female, deep narrator)..."
                value={speakerNotes[selectedSpeakerContext.presetId] ?? ""}
                onChange={(e) =>
                  handleSpeakerNoteChange(
                    selectedSpeakerContext.presetId,
                    e.target.value
                  )
                }
              />
            </div>
          )}

          <label className="field-label">
            <span className="label-with-tip">
              <span>Custom .npz Prompt Path (optional, overrides preset)</span>
              <InfoTooltip text="Path to a .npz voice prompt saved from an earlier generation. Overrides the dropdown preset above for voice continuity." />
            </span>
            <input
              type="text"
              placeholder="C:\path\to\custom_voice.npz"
              value={config.customPromptPath}
              onChange={(e) =>
                setConfig((prev) => ({
                  ...prev,
                  customPromptPath: e.target.value,
                }))
              }
            />
          </label>

          <div className="divider" />

          <div className="sliders-grid">
            <label className="slider-field">
              <div className="slider-head">
                <span className="label-with-tip">
                  <span>Text Temperature</span>
                  <InfoTooltip text="Controls how creative vs. predictable the speech phrasing and expressions are. Lower (0.0–0.4) = steady and literal; higher (0.7–1.0) = more expressive and varied." />
                </span>
                <span className="mono">{config.textTemp.toFixed(2)}</span>
              </div>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={config.textTemp}
                onChange={(e) =>
                  setConfig((prev) => ({
                    ...prev,
                    textTemp: Number(e.target.value),
                  }))
                }
              />
            </label>

            <label className="slider-field">
              <div className="slider-head">
                <span className="label-with-tip">
                  <span>Waveform Temperature</span>
                  <InfoTooltip text="Controls acoustic variation in pitch, tone, and background texture. Lower values sound cleaner and more consistent; higher values add more vocal color or variation." />
                </span>
                <span className="mono">{config.waveformTemp.toFixed(2)}</span>
              </div>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={config.waveformTemp}
                onChange={(e) =>
                  setConfig((prev) => ({
                    ...prev,
                    waveformTemp: Number(e.target.value),
                  }))
                }
              />
            </label>
          </div>

          <div className="toggles-row">
            <label className="inline-check">
              <input
                type="checkbox"
                checked={config.useSmallModels}
                onChange={(e) =>
                  setConfig((prev) => ({
                    ...prev,
                    useSmallModels: e.target.checked,
                  }))
                }
              />
              <span>Small Models (&lt;8GB VRAM)</span>
              <InfoTooltip text="Uses smaller Bark checkpoints (~8GB VRAM) for faster generation with slightly lower audio quality. Your RTX 5070 Ti (16GB) can run full models." />
            </label>

            <label className="inline-check">
              <input
                type="checkbox"
                checked={config.offloadCpu}
                onChange={(e) =>
                  setConfig((prev) => ({
                    ...prev,
                    offloadCpu: e.target.checked,
                  }))
                }
              />
              <span>Offload to CPU</span>
              <InfoTooltip text="Moves inactive Bark models to system RAM between stages to reduce VRAM usage, at the cost of slower generation." />
            </label>

            <label className="inline-check">
              <input
                type="checkbox"
                checked={config.savePromptNpz}
                onChange={(e) =>
                  setConfig((prev) => ({
                    ...prev,
                    savePromptNpz: e.target.checked,
                  }))
                }
              />
              <span>Save .npz Voice Prompt</span>
              <InfoTooltip text="Saves a .npz voice prompt file next to the .wav so you can reuse this exact generated voice in future clips." />
            </label>
          </div>

          <div className="output-grid">
            <label className="field-label">
              <span>Output Directory</span>
              <input
                type="text"
                value={config.outputDir}
                onChange={(e) =>
                  setConfig((prev) => ({ ...prev, outputDir: e.target.value }))
                }
              />
            </label>

            <label className="field-label">
              <span>Filename (.wav)</span>
              <input
                type="text"
                value={config.outputFilename}
                onChange={(e) =>
                  setConfig((prev) => ({
                    ...prev,
                    outputFilename: e.target.value,
                  }))
                }
              />
            </label>
          </div>

          <button
            type="button"
            className="btn-primary generate-btn"
            disabled={isBusy}
            onClick={handleGenerate}
          >
            {isBusy ? STAGE_LABELS[workerStatus.stage] : "Generate Audio"}
          </button>
        </section>

        <section className="panel panel-output">
          <div className="player-card">
            <div className="section-header">
              <h2>Audio Preview</h2>
              {selectedClip && (
                <span className="mono badge-soft">
                  {formatDuration(selectedClip.durationSeconds)} •{" "}
                  {selectedClip.sampleRate} Hz
                </span>
              )}
            </div>

            {selectedClip && selectedClip.audioUrl ? (
              <div className="player-body">
                <p className="clip-prompt">"{selectedClip.text}"</p>
                <audio
                  key={selectedClip.id}
                  controls
                  autoPlay
                  src={selectedClip.audioUrl}
                  className="audio-element"
                />
                <div className="clip-meta-row">
                  <span className="mono path-text" title={selectedClip.outputPath}>
                    {selectedClip.outputPath}
                  </span>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => revealOutputInExplorer(selectedClip.outputPath)}
                  >
                    Show in Explorer
                  </button>
                </div>
                {selectedClip.promptPath && (
                  <p className="muted-meta mono">
                    Saved voice prompt: {selectedClip.promptPath}
                  </p>
                )}
              </div>
            ) : selectedClip ? (
              <div className="empty-state">
                <p>Click a saved clip below to load and play it.</p>
                <p className="muted-meta mono">{selectedClip.outputPath}</p>
              </div>
            ) : (
              <div className="empty-state">
                <p>No audio generated yet.</p>
                <p className="muted-meta">
                  First run will download Bark model checkpoints (~5 GB) into your
                  HuggingFace/XDG cache.
                </p>
              </div>
            )}
          </div>

          <div className="history-card">
            <div className="section-header">
              <h2>Saved Generations</h2>
              <span className="muted-meta">
                {history.length} clips • outputs/generations.json
              </span>
            </div>
            <div className="history-list">
              {history.length === 0 ? (
                <p className="muted-meta">Generated clips and prompts will be saved here.</p>
              ) : (
                history.map((item) => (
                  <div
                    key={item.id}
                    className={`history-item ${
                      selectedClip?.id === item.id ? "active" : ""
                    }`}
                  >
                    <button
                      type="button"
                      className="history-select-btn"
                      onClick={() => handleSelectHistoryItem(item)}
                    >
                      <div className="history-top">
                        <span className="mono">{item.preset}</span>
                        <span className="muted-meta">
                          {formatDuration(item.durationSeconds)} •{" "}
                          {new Date(item.createdAt).toLocaleString()}
                        </span>
                      </div>
                      <p className="history-text">{item.text}</p>
                    </button>
                    <div className="history-actions">
                      <button
                        type="button"
                        className="btn-link"
                        onClick={() => handleRestorePrompt(item)}
                      >
                        Load Prompt
                      </button>
                      <button
                        type="button"
                        className="btn-link"
                        onClick={() => revealOutputInExplorer(item.outputPath)}
                      >
                        Explorer
                      </button>
                      <button
                        type="button"
                        className="btn-link btn-danger-link"
                        onClick={() => handleDeleteHistoryItem(item.id)}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="log-card">
            <div className="section-header">
              <h2>Worker Console</h2>
              <button
                type="button"
                className="btn-link"
                onClick={() => setLogs([])}
              >
                Clear
              </button>
            </div>
            <pre className="log-box">
              {logs.length > 0
                ? logs.join("\n")
                : "Waiting for Python worker output..."}
            </pre>
          </div>
        </section>
      </main>
    </div>
  );
}

export default App;
