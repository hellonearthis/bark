import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AppInfo,
  BarkReadyEvent,
  BarkResultEvent,
  BarkStatusEvent,
  GenerateRequestPayload,
  GenerationRecord,
  VoicePreset,
} from "../core/types";

export function fetchAppInfo(): Promise<AppInfo> {
  return invoke<AppInfo>("get_app_info");
}

export function fetchVoicePresets(): Promise<VoicePreset[]> {
  return invoke<VoicePreset[]>("list_voice_presets");
}

export function startPythonWorker(): Promise<void> {
  return invoke<void>("init_worker");
}

export function stopPythonWorker(): Promise<void> {
  return invoke<void>("stop_worker");
}

export function requestAudioGeneration(
  request: GenerateRequestPayload
): Promise<void> {
  return invoke<void>("generate_audio", { request });
}

export async function loadAudioObjectUrl(filePath: string): Promise<string> {
  const bytes = await invoke<ArrayBuffer>("read_audio_file", {
    path: filePath,
  });
  const blob = new Blob([bytes], { type: "audio/wav" });
  return URL.createObjectURL(blob);
}

export function revealOutputInExplorer(filePath: string): Promise<void> {
  return invoke<void>("reveal_in_explorer", { path: filePath });
}

export function fetchGenerationDb(): Promise<GenerationRecord[]> {
  return invoke<GenerationRecord[]>("load_generation_db");
}

export function saveGenerationRecord(
  record: GenerationRecord
): Promise<GenerationRecord[]> {
  return invoke<GenerationRecord[]>("append_generation_record", { record });
}

export function removeGenerationRecord(
  id: string,
  deleteFiles: boolean
): Promise<GenerationRecord[]> {
  return invoke<GenerationRecord[]>("delete_generation_record", {
    id,
    deleteFiles,
  });
}

export function subscribeWorkerReady(
  handler: (payload: BarkReadyEvent) => void
): Promise<UnlistenFn> {
  return listen<BarkReadyEvent>("bark-ready", (event) => handler(event.payload));
}

export function subscribeWorkerStatus(
  handler: (payload: BarkStatusEvent) => void
): Promise<UnlistenFn> {
  return listen<BarkStatusEvent>("bark-status", (event) =>
    handler(event.payload)
  );
}

export function subscribeWorkerResult(
  handler: (payload: BarkResultEvent) => void
): Promise<UnlistenFn> {
  return listen<BarkResultEvent>("bark-result", (event) =>
    handler(event.payload)
  );
}

export function subscribeWorkerLog(
  handler: (line: string) => void
): Promise<UnlistenFn> {
  return listen<string>("bark-log", (event) => handler(event.payload));
}

export function subscribeWorkerExit(
  handler: () => void
): Promise<UnlistenFn> {
  return listen("bark-exit", () => handler());
}
