import type { VoicePreset } from "./types";

export type SpeakerGender = "Male" | "Female" | "Neutral" | "Unspecified";

export interface SpeakerContext {
  readonly presetId: string;
  readonly displayName: string;
  readonly gender: SpeakerGender;
  readonly summary: string;
  readonly tags: readonly string[];
}

interface KnownSpeakerMeta {
  readonly gender: SpeakerGender;
  readonly summary: string;
  readonly tags: readonly string[];
}

const KNOWN_SPEAKER_METADATA: Readonly<Record<string, KnownSpeakerMeta>> = {
  announcer: {
    gender: "Male",
    summary: "Classic broadcast / radio announcer cadence",
    tags: ["announcer", "broadcast", "narration", "male"],
  },
  en_speaker_0: {
    gender: "Male",
    summary: "Neutral American male voice (common default)",
    tags: ["male", "american", "neutral"],
  },
  en_speaker_1: {
    gender: "Male",
    summary: "Clear, smooth male voice",
    tags: ["male", "smooth", "clear"],
  },
  en_speaker_2: {
    gender: "Male",
    summary: "Male conversational / dialogue voice",
    tags: ["male", "dialogue", "conversational"],
  },
  en_speaker_3: {
    gender: "Male",
    summary: "Male speaker (prosody shifts with prompt)",
    tags: ["male", "expressive"],
  },
  en_speaker_6: {
    gender: "Male",
    summary: "Stable neutral American male narration",
    tags: ["male", "american", "narration", "stable"],
  },
  en_speaker_7: {
    gender: "Neutral",
    summary: "Natural conversational English tone",
    tags: ["neutral", "conversational", "natural"],
  },
  en_speaker_9: {
    gender: "Female",
    summary: "Distinct female English voice",
    tags: ["female", "clear"],
  },
} as const;

const LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  en: "English",
  de: "German",
  es: "Spanish",
  fr: "French",
  hi: "Hindi",
  it: "Italian",
  ja: "Japanese",
  ko: "Korean",
  pl: "Polish",
  pt: "Portuguese",
  ru: "Russian",
  tr: "Turkish",
  zh: "Chinese",
  other: "Specialty",
} as const;

function formatSpeakerTitle(preset: VoicePreset): string {
  const versionTag = preset.isV2 ? "v2" : "v1";
  const match = /^([a-z]{2})_speaker_(\d+)$/.exec(preset.label);
  if (match) {
    const langName = LANGUAGE_NAMES[match[1]] ?? match[1].toUpperCase();
    return `${langName} Speaker ${match[2]} (${versionTag})`;
  }
  const capitalized =
    preset.label.charAt(0).toUpperCase() + preset.label.slice(1);
  return `${capitalized} (${versionTag})`;
}

export function getSpeakerContext(preset: VoicePreset): SpeakerContext {
  const known = KNOWN_SPEAKER_METADATA[preset.label];
  const displayName = formatSpeakerTitle(preset);

  if (known) {
    return {
      presetId: preset.id,
      displayName,
      gender: known.gender,
      summary: known.summary,
      tags: known.tags,
    };
  }

  const langName = LANGUAGE_NAMES[preset.language] ?? "Multilingual";
  return {
    presetId: preset.id,
    displayName,
    gender: "Unspecified",
    summary: `${langName} generative voice embedding (traits vary slightly by prompt)`,
    tags: [langName.toLowerCase(), preset.isV2 ? "v2" : "v1"],
  };
}

export function formatPresetOptionLabel(
  preset: VoicePreset,
  customNote?: string
): string {
  const ctx = getSpeakerContext(preset);
  const note = customNote?.trim();
  if (note) {
    return `${preset.id} — ${ctx.gender !== "Unspecified" ? `${ctx.gender} · ` : ""}${note}`;
  }
  if (ctx.gender !== "Unspecified") {
    return `${preset.id} — ${ctx.gender} · ${ctx.summary}`;
  }
  return `${preset.id} — ${ctx.displayName}`;
}
