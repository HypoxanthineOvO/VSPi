// Adapted from MoonshotAI/kimi-code commit 676e4d8 (MIT), cron-expr.ts.
// Cron fields are evaluated with Date's local-time accessors by design.
export interface ParsedCronExpression {
  readonly raw: string;
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly daysOfMonth: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  readonly daysOfWeek: ReadonlySet<number>;
  readonly daysOfMonthWildcard: boolean;
  readonly daysOfWeekWildcard: boolean;
}

const MS_PER_MINUTE = 60_000;
const DIGITS = /^\d+$/;

export function parseCronExpression(expression: string): ParsedCronExpression {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5 || fields.some((field) => field.length === 0)) {
    throw new Error("cron expression must have exactly 5 fields: minute hour day-of-month month day-of-week");
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [string, string, string, string, string];
  const dow = parseField(dayOfWeek, 0, 7, "day-of-week");
  return {
    raw: fields.join(" "),
    minutes: parseField(minute, 0, 59, "minute"),
    hours: parseField(hour, 0, 23, "hour"),
    daysOfMonth: parseField(dayOfMonth, 1, 31, "day-of-month"),
    months: parseField(month, 1, 12, "month"),
    daysOfWeek: new Set([...dow].map((value) => (value === 7 ? 0 : value))),
    daysOfMonthWildcard: dayOfMonth === "*",
    daysOfWeekWildcard: dayOfWeek === "*",
  };
}

function parseField(field: string, min: number, max: number, name: string): Set<number> {
  const values = new Set<number>();
  for (const term of field.split(",")) {
    if (!term) throw new Error(`cron ${name} field contains an empty term`);
    addTerm(values, term, min, max, name);
  }
  return values;
}

function addTerm(values: Set<number>, term: string, min: number, max: number, name: string): void {
  const slash = term.indexOf("/");
  if (slash !== term.lastIndexOf("/")) throw new Error(`cron ${name} has an invalid step in ${JSON.stringify(term)}`);
  const rangePart = slash < 0 ? term : term.slice(0, slash);
  const step = slash < 0 ? 1 : integer(term.slice(slash + 1), name, "step");
  if (step < 1) throw new Error(`cron ${name} step must be positive`);

  let low: number;
  let high: number;
  if (rangePart === "*") {
    low = min;
    high = max;
  } else {
    const dash = rangePart.indexOf("-");
    if (dash < 0) {
      low = integer(rangePart, name, "value");
      high = slash < 0 ? low : max;
    } else {
      if (dash !== rangePart.lastIndexOf("-")) throw new Error(`cron ${name} has an invalid range`);
      low = integer(rangePart.slice(0, dash), name, "range lower bound");
      high = integer(rangePart.slice(dash + 1), name, "range upper bound");
    }
  }
  if (low < min || high > max || low > high) {
    throw new Error(`cron ${name} range ${low}-${high} is outside ${min}..${max}`);
  }
  for (let value = low; value <= high; value += step) values.add(value);
}

function integer(value: string, name: string, role: string): number {
  if (!DIGITS.test(value)) throw new Error(`cron ${name} ${role} must be a non-negative integer`);
  return Number.parseInt(value, 10);
}

export function computeNextCronRun(expression: ParsedCronExpression, fromMs: number): number | null {
  const date = new Date(fromMs);
  date.setSeconds(0, 0);
  date.setMinutes(date.getMinutes() + 1);
  const deadline = fromMs + 5 * 366 * 24 * 60 * MS_PER_MINUTE;
  let iterations = 0;
  while (date.getTime() <= deadline && iterations++ < 10_000_000) {
    if (!expression.months.has(date.getMonth() + 1)) advanceMonth(date);
    else if (!dayMatches(expression, date)) advanceDay(date);
    else if (!expression.hours.has(date.getHours())) advanceHour(date);
    else if (!expression.minutes.has(date.getMinutes())) date.setMinutes(date.getMinutes() + 1, 0, 0);
    else return date.getTime();
  }
  return null;
}

function dayMatches(expression: ParsedCronExpression, date: Date): boolean {
  const dom = expression.daysOfMonth.has(date.getDate());
  const dow = expression.daysOfWeek.has(date.getDay());
  if (expression.daysOfMonthWildcard) return expression.daysOfWeekWildcard || dow;
  if (expression.daysOfWeekWildcard) return dom;
  return dom || dow;
}

function advanceMonth(date: Date): void {
  date.setDate(1);
  date.setHours(0, 0, 0, 0);
  date.setMonth(date.getMonth() + 1);
}

function advanceDay(date: Date): void {
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + 1);
}

function advanceHour(date: Date): void {
  date.setMinutes(0, 0, 0);
  date.setHours(date.getHours() + 1);
}

export function describeCron(expression: ParsedCronExpression): string {
  if (expression.raw === "* * * * *") return "every minute";
  const minute = only(expression.minutes);
  const hour = only(expression.hours);
  if (minute !== undefined && hour !== undefined && expression.daysOfMonthWildcard && expression.daysOfWeekWildcard) {
    return `every day at ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  }
  return expression.raw;
}

function only(values: ReadonlySet<number>): number | undefined {
  return values.size === 1 ? values.values().next().value : undefined;
}
