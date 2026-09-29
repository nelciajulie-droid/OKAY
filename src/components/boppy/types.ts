/**
 * Shared DTO types for the Boppy Studio frontend.
 * These mirror the JSON shapes returned by the local API routes
 * (see src/app/api/**) — all dates are ISO strings.
 */

export type TrackStatus = "PENDING" | "SUCCESS" | "FAILED" | "ERROR" | "TIMEOUT";

/** Generation parameters as embedded in every TrackDTO (GET /api/tracks). */
export interface GenerationInfoDTO {
  prompt: string;
  styleTags: string | null;
  title: string | null;
  lyrics: string | null;
  duration: number;
  bpm: number;
  keyscale: string | null;
  timesignature: string | null;
  createdAt: string;
}

/** A single track as returned by GET /api/tracks. */
export interface TrackDTO {
  id: string;
  generationId: string;
  status: TrackStatus;
  /** 0-100 while the generation job is pending. */
  progress: number | null;
  title: string | null;
  duration: number | null;
  songPath: string | null;
  lyrics: string | null;
  prompt: string | null;
  version: string | null;
  lastCheckedAt: string;
  createdAt: string;
  updatedAt: string;
  generation: GenerationInfoDTO;
}

/** Response of GET /api/tracks. */
export interface TracksResponse {
  tracks: TrackDTO[];
}

/** Relay-only settings as returned by GET /api/settings (the secret never leaves the server). */
export interface SettingsDTO {
  relayUrl: string | null;
  hasRelaySecret: boolean;
  /** Custom boppy-compatible API endpoint (empty/null = https://boppy.me). */
  apiBaseUrl: string | null;
  /** FireProx AWS API Gateway endpoint (empty/null = direct to boppy.me). */
  fireproxUrl: string | null;
}

/** Full generation row returned by POST /api/generate (201). */
export interface GenerationDTO extends GenerationInfoDTO {
  id: string;
  jobId: string | null;
  model: string;
  format: string;
  tracks: TrackDTO[];
}

/** Response of POST /api/generate. deduped = an identical generation was reused (no new job). */
export interface GenerateResponse {
  generation: GenerationDTO;
  deduped?: boolean;
}

/** Payload accepted by POST /api/generate. */
export interface GeneratePayload {
  prompt: string;
  lyrics?: string;
  title?: string;
  styleTags?: string;
  duration: number;
  bpm: number;
  keyscale?: string;
  timesignature?: string;
  promptId?: string;
}

/** Payload accepted by POST /api/lyrics. */
export interface LyricsPayload {
  prompt: string;
  language?: string;
  boost?: boolean;
}

/** Response of POST /api/lyrics. */
export interface LyricsResponse {
  title: string | null;
  lyrics: string | null;
  caption: string | null;
  promptId: string | null;
}

/** Error body returned by the API routes (4xx/5xx). */
export interface ApiErrorBody {
  error: string;
  code?: string;
  retryAfter?: number;
  kind?: "burst" | "daily";
}

/** Client mutation error carrying structured rate-limit fields when present. */
export class ApiMutationError extends Error {
  retryAfter?: number;
  kind?: "burst" | "daily";
}

/** Statuses the backend reports when a track finished successfully. */
export const SUCCESS_STATUSES = new Set<string>(["SUCCESS"]);

/** Statuses the backend reports for terminal failures. */
export const FAILURE_STATUSES = new Set<string>(["FAILED", "ERROR", "TIMEOUT"]);

export function isTrackSuccess(track: Pick<TrackDTO, "status">): boolean {
  return SUCCESS_STATUSES.has(track.status);
}

export function isTrackFailed(track: Pick<TrackDTO, "status">): boolean {
  return FAILURE_STATUSES.has(track.status);
}

/** In-progress / pending. */
export function isTrackPending(track: Pick<TrackDTO, "status">): boolean {
  return track.status === "PENDING";
}
