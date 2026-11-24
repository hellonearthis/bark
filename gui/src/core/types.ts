export interface AppInfo {
  readonly barkRoot: string;
  readonly defaultOutputDir: string;
  readonly pythonPath: string;
  readonly workerScriptPath: string;
  readonly pythonExists: boolean;
  readonly workerScriptExists: boolean;
}

export interface VoicePreset {
  readonly id: string;
  readonly label: string;
  readonly language: string;
  readonly isV2: boolean;
}

export type WorkerStage =
  | "stopped"
  | "starting"
  | "ready"
  | "loading"
  | "generating"
  | "saving"
  | "error";

export interface WorkerStatus {
  readonly stage: WorkerStage;
  readonly device: string;
  readonly cuda: boolean;
  readonly torchVersion: string;
  readonly lastError: string | null;
}

export interface GenerationConfig {
  readonly text: string;
  readonly presetId: string;
  readonly customPromptPath: string;
  readonly textTemp: number;
  readonly waveformTemp: number;
  readonly outputDir: string;
  readonly outputFilename: string;
  readonly useSmallModels: boolean;
  readonly offloadCpu: boolean;
  readonly savePromptNpz: boolean;
}

export interface GenerateRequestPayload {
  readonly id: string;
  readonly text: string;
  readonly historyPrompt: string | null;
  readonly textTemp: number;
  readonly waveformTemp: number;
  readonly outputDir: string;
  readonly outputFilename: string;
  readonly useSmallModels: boolean;
  readonly offloadCpu: boolean;
  readonly savePromptNpz: boolean;
}

export interface BarkResultEvent {
  readonly id: string | null;
  readonly ok: boolean;
  readonly output_path?: string;
  readonly prompt_path?: string | null;
  readonly duration_seconds?: number;
  readonly sample_rate?: number;
  readonly error?: string;
}

export interface BarkStatusEvent {
  readonly id: string | null;
  readonly stage: WorkerStage;
}

export interface BarkReadyEvent {
  readonly cuda: boolean;
  readonly device: string;
  readonly torch: string;
}

export interface GenerationRecord {
  readonly id: string;
  readonly text: string;
  readonly preset: string;
  readonly textTemp: number;
  readonly waveformTemp: number;
  readonly useSmallModels: boolean;
  readonly offloadCpu: boolean;
  readonly outputPath: string;
  readonly promptPath: string | null;
  readonly durationSeconds: number;
  readonly sampleRate: number;
  readonly createdAt: string;
}

export interface HistoryItem extends GenerationRecord {
  readonly audioUrl: string | null;
}

export type Result<SuccessValue, ErrorValue> =
  | { readonly success: true; readonly value: SuccessValue }
  | { readonly success: false; readonly error: ErrorValue };
