import { offsetMinutes } from "@sonata/core";
import { deleteSetting, readSetting, readSettings, writeSetting } from "./db";
import { DEFAULT_MODELS, MODEL_ROLES, isModelId, type ModelRole } from "./models";

// Typed reads and writes over the settings table. Server-only: everything here
// touches platform.db. The API key never leaves this module in the clear — the
// route returns `SettingsView`, which carries a mask and nothing else.

const KEY = {
  model: (role: ModelRole) => `model.${role}`,
  apiKey: "openrouter.apiKey",
  startISO: "clock.startISO",
  simMinutesPerTick: "clock.simMinutesPerTick",
  ticks: "clock.ticks",
} as const;

export interface PlatformSettings {
  models: Record<ModelRole, string>;
  /** Start of the simulated day, with an explicit UTC offset. */
  startISO: string;
  simMinutesPerTick: number;
  ticks: number;
}

/** 9am to 5pm in 15-minute ticks — one workday, the only length the MVP runs. */
export const DEFAULT_CLOCK = {
  startISO: "2026-08-04T09:00:00-04:00",
  simMinutesPerTick: 15,
  ticks: 32,
} as const;

function num(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function getSettings(): PlatformSettings {
  const stored = readSettings();
  const models = {} as Record<ModelRole, string>;
  for (const role of MODEL_ROLES) models[role] = stored[KEY.model(role)] ?? DEFAULT_MODELS[role];
  return {
    models,
    startISO: stored[KEY.startISO] ?? DEFAULT_CLOCK.startISO,
    simMinutesPerTick: num(stored[KEY.simMinutesPerTick], DEFAULT_CLOCK.simMinutesPerTick),
    ticks: num(stored[KEY.ticks], DEFAULT_CLOCK.ticks),
  };
}

/**
 * The OpenRouter key, stored key first and `OPENROUTER_API_KEY` second. The env
 * fallback is what lets the twins' existing .env keep working with no re-entry.
 */
export function getApiKey(): string | null {
  return readSetting(KEY.apiKey) ?? process.env.OPENROUTER_API_KEY ?? null;
}

export type ApiKeySource = "stored" | "env" | "none";

export interface ApiKeyView {
  source: ApiKeySource;
  /** "sk-or-…4f2a" — enough to recognise a key, not enough to use one. */
  masked: string | null;
}

function mask(key: string): string {
  return key.length <= 10 ? "•".repeat(key.length) : `${key.slice(0, 6)}…${key.slice(-4)}`;
}

export function getApiKeyView(): ApiKeyView {
  const stored = readSetting(KEY.apiKey);
  if (stored) return { source: "stored", masked: mask(stored) };
  const env = process.env.OPENROUTER_API_KEY;
  if (env) return { source: "env", masked: mask(env) };
  return { source: "none", masked: null };
}

/** What the settings page renders. Never carries the key itself. */
export interface SettingsView extends PlatformSettings {
  apiKey: ApiKeyView;
}

export function getSettingsView(): SettingsView {
  return { ...getSettings(), apiKey: getApiKeyView() };
}

export interface SettingsPatch {
  models?: Partial<Record<ModelRole, string>>;
  startISO?: string;
  simMinutesPerTick?: number;
  ticks?: number;
  /** Empty string clears the stored key and falls back to the environment. */
  apiKey?: string;
}

/**
 * Applies a patch, rejecting anything that would make a run undefined later —
 * an unparseable model slug, or a start time with no UTC offset (which would be
 * read in the host's zone and make two machines disagree about the day).
 */
export function updateSettings(patch: SettingsPatch): SettingsView {
  if (patch.models) {
    for (const [role, id] of Object.entries(patch.models)) {
      if (!MODEL_ROLES.includes(role as ModelRole)) throw new Error(`unknown model role: ${role}`);
      if (typeof id !== "string" || !isModelId(id)) {
        throw new Error(`"${String(id)}" is not an OpenRouter model id (vendor/model)`);
      }
      writeSetting(KEY.model(role as ModelRole), id);
    }
  }

  if (patch.startISO !== undefined) {
    if (Number.isNaN(Date.parse(patch.startISO))) {
      throw new Error(`"${patch.startISO}" is not a date`);
    }
    offsetMinutes(patch.startISO); // throws when the offset is missing
    writeSetting(KEY.startISO, patch.startISO);
  }

  if (patch.simMinutesPerTick !== undefined) {
    const n = Math.round(patch.simMinutesPerTick);
    if (!(n >= 1 && n <= 120)) throw new Error("minutes per tick must be between 1 and 120");
    writeSetting(KEY.simMinutesPerTick, String(n));
  }

  if (patch.ticks !== undefined) {
    const n = Math.round(patch.ticks);
    if (!(n >= 1 && n <= 200)) throw new Error("a day must be between 1 and 200 ticks");
    writeSetting(KEY.ticks, String(n));
  }

  if (patch.apiKey !== undefined) {
    const trimmed = patch.apiKey.trim();
    if (trimmed) writeSetting(KEY.apiKey, trimmed);
    else deleteSetting(KEY.apiKey);
  }

  return getSettingsView();
}
