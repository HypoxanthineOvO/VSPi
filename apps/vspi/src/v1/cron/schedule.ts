const DURATION_PART = /(\d+)([mhd])/giu;
export const MAX_CRON_DELAY_MS = 366 * 24 * 60 * 60_000;

export function parseCronDuration(value: string): number {
  const normalized = value.trim();
  let consumed = "";
  let total = 0;
  for (const match of normalized.matchAll(DURATION_PART)) {
    consumed += match[0];
    const amount = Number(match[1]);
    const unit = match[2]?.toLocaleLowerCase();
    total += amount * (unit === "d" ? 86_400_000 : unit === "h" ? 3_600_000 : 60_000);
  }
  if (consumed.toLocaleLowerCase() !== normalized.toLocaleLowerCase() || total < 60_000 || total > MAX_CRON_DELAY_MS) {
    throw new Error("duration must use m/h/d units and be between 1m and 366d, for example 30m or 2h30m");
  }
  return total;
}

export function parseCronRunAt(value: string, now = Date.now()): number {
  const runAt = Date.parse(value);
  if (!Number.isFinite(runAt)) throw new Error("run_at must be an ISO date-time, for example 2026-08-28T09:00+08:00");
  if (runAt <= now) throw new Error("run_at must be in the future");
  if (runAt - now > MAX_CRON_DELAY_MS) throw new Error("run_at must be within 366 days");
  return runAt;
}

export function formatCronLocalTime(value: number): string {
  const date = new Date(value);
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  const offset = `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${offset}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
