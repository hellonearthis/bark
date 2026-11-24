import { getSpeakerContext } from "./speakerCatalog";
import type {
  GenerateRequestPayload,
  GenerationConfig,
  Result,
  VoicePreset,
} from "./types";

export const BARK_EXPRESSION_TAGS = [
  { label: "[laughter]", token: "[laughter]" },
  { label: "[laughs]", token: "[laughs]" },
  { label: "[sighs]", token: "[sighs]" },
  { label: "[gasps]", token: "[gasps]" },
  { label: "[clears throat]", token: "[clears throat]" },
  { label: "[music]", token: "[music]" },
  { label: "♪ lyrics ♪", token: "♪  ♪" },
  { label: "[MAN]", token: "[MAN]" },
  { label: "[WOMAN]", token: "[WOMAN]" },
  { label: "— pause", token: "—" },
  { label: "... hesitation", token: "..." },
] as const;

export const LANGUAGE_LABELS: Readonly<Record<string, string>> = {
  all: "All Languages",
  en: "English (en)",
  de: "German (de)",
  es: "Spanish (es)",
  fr: "French (fr)",
  hi: "Hindi (hi)",
  it: "Italian (it)",
  ja: "Japanese (ja)",
  ko: "Korean (ko)",
  pl: "Polish (pl)",
  pt: "Portuguese (pt)",
  ru: "Russian (ru)",
  tr: "Turkish (tr)",
  zh: "Chinese (zh)",
  other: "Other",
} as const;

export function getLanguageLabel(code: string): string {
  return LANGUAGE_LABELS[code] ?? code.toUpperCase();
}

export function extractAvailableLanguages(
  presets: readonly VoicePreset[]
): readonly string[] {
  const unique = Array.from(new Set(presets.map((preset) => preset.language)));
  return ["all", ...unique.toSorted((a, b) => a.localeCompare(b))];
}

export function filterVoicePresets(
  presets: readonly VoicePreset[],
  languageFilter: string,
  onlyV2: boolean,
  query: string,
  customNotes: Readonly<Record<string, string>> = {}
): readonly VoicePreset[] {
  const normalizedQuery = query.trim().toLowerCase();
  return presets.filter((preset) => {
    if (onlyV2 && !preset.isV2) {
      return false;
    }
    if (languageFilter !== "all" && preset.language !== languageFilter) {
      return false;
    }
    if (normalizedQuery.length > 0) {
      const ctx = getSpeakerContext(preset);
      const note = customNotes[preset.id] ?? "";
      const searchable = [
        preset.id,
        ctx.displayName,
        ctx.gender,
        ctx.summary,
        ...ctx.tags,
        note,
      ]
        .join(" ")
        .toLowerCase();
      if (!searchable.includes(normalizedQuery)) {
        return false;
      }
    }
    return true;
  });
}

export function insertTokenAtSelection(
  source: string,
  token: string,
  selectionStart: number,
  selectionEnd: number
): { readonly nextText: string; readonly nextCursor: number } {
  const before = source.slice(0, selectionStart);
  const after = source.slice(selectionEnd);
  const needsLeadingSpace = before.length > 0 && !/\s$/.test(before);
  const needsTrailingSpace = after.length > 0 && !/^\s/.test(after);
  const inserted = `${needsLeadingSpace ? " " : ""}${token}${needsTrailingSpace ? " " : ""}`;
  return {
    nextText: `${before}${inserted}${after}`,
    nextCursor: before.length + inserted.length,
  };
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "0.0s";
  }
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const mins = Math.floor(seconds / 60);
  const rem = Math.floor(seconds % 60);
  return `${mins}:${String(rem).padStart(2, "0")}`;
}

export function buildTimestampFilename(prefix = "bark"): string {
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    "_",
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("");
  return `${prefix}_${stamp}.wav`;
}

export function validateGenerationConfig(
  config: GenerationConfig,
  jobId: string
): Result<GenerateRequestPayload, string> {
  const trimmedText = config.text.trim();
  if (trimmedText.length === 0) {
    return {
      success: false,
      error: "Please enter a text prompt before generating.",
    };
  }

  const trimmedDir = config.outputDir.trim();
  if (trimmedDir.length === 0) {
    return {
      success: false,
      error: "Output directory cannot be empty.",
    };
  }

  const rawFilename = config.outputFilename.trim() || buildTimestampFilename();
  const normalizedFilename = rawFilename.toLowerCase().endsWith(".wav")
    ? rawFilename
    : `${rawFilename}.wav`;

  const customPath = config.customPromptPath.trim();
  const historyPrompt =
    customPath.length > 0
      ? customPath
      : config.presetId === "none"
        ? null
        : config.presetId;

  return {
    success: true,
    value: {
      id: jobId,
      text: trimmedText,
      historyPrompt,
      textTemp: config.textTemp,
      waveformTemp: config.waveformTemp,
      outputDir: trimmedDir,
      outputFilename: normalizedFilename,
      useSmallModels: config.useSmallModels,
      offloadCpu: config.offloadCpu,
      savePromptNpz: config.savePromptNpz,
    },
  };
}
