const clockFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const weekdays = ['日', '一', '二', '三', '四', '五', '六'];

function parts(value: string): { date: string; clock: string } | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? { date: value, clock: '' } : null;
  }
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?$/.test(value)) return null;
  const date = new Date(/[Zz]$|[+-]\d{2}:\d{2}$/.test(value) ? value : `${value.replace(' ', 'T')}+08:00`);
  if (!Number.isFinite(date.getTime())) return null;
  const values = Object.fromEntries(clockFormatter.formatToParts(date).map(part => [part.type, part.value]));
  return { date: `${values.year}-${values.month}-${values.day}`, clock: `${values.hour}:${values.minute}` };
}

/** User-facing calendar dates always use Beijing time, independent of the host's timezone. */
export function formatFriendlyDate(value: string, options: { weekday?: boolean; year?: boolean } = {}): string {
  const parsed = parts(value);
  if (!parsed) return value;
  const [year, month, day] = parsed.date.split('-');
  const weekday = weekdays[new Date(`${parsed.date}T00:00:00Z`).getUTCDay()];
  return `${options.weekday === false ? '' : `周${weekday} `}${options.year ? `${year}年` : ''}${Number(month)}月${Number(day)}日`;
}

export function formatFriendlyInstant(value: string): string {
  const parsed = parts(value);
  return parsed ? `${formatFriendlyDate(parsed.date)}${parsed.clock ? ` ${parsed.clock}` : ''}` : value;
}

export function formatFriendlyRange(start: string, end?: string | null): string {
  const from = parts(start), to = end ? parts(end) : null;
  if (!end) return formatFriendlyInstant(start);
  if (!from || !to) return `${formatFriendlyInstant(start)} 至 ${formatFriendlyInstant(end)}`;
  if (from.date === to.date) return `${formatFriendlyDate(from.date)}${from.clock ? ` ${from.clock}` : ''}${to.clock && to.clock !== from.clock ? `–${to.clock}` : ''}`;
  const year = from.date.slice(0, 4) !== to.date.slice(0, 4);
  return `${formatFriendlyDate(from.date, { year })}${from.clock ? ` ${from.clock}` : ''} 至 ${formatFriendlyDate(to.date, { year })}${to.clock ? ` ${to.clock}` : ''}`;
}
