/**
 * Backend API origin for this build.
 *
 * Configured at build time through VITE_API_BASE_URL (see .env.example);
 * falls back to the local dev server when unset. Trailing slashes are
 * stripped so endpoint paths can be appended directly.
 */
const rawBase: string = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8000'

export const API_BASE: string = rawBase.replace(/\/+$/, '')
