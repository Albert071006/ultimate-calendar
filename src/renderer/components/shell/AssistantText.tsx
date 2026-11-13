import { Fragment, type ReactNode } from 'react';
import { formatFriendlyDate, formatFriendlyInstant } from '../../../shared/display-time';
import './assistant-text.css';

/** Presentation only: keep stored replies and future AI conversation evidence unchanged. */
export function friendlyReplyText(text: string): string {
  return text.replace(/账面余额\s+未知/g, '余额未设置').replace(/\b\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?\b/g, value => {
    const date = value.slice(0, 10), parsed = new Date(`${date}T00:00:00Z`);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return value;
    if (!value.includes('T')) return formatFriendlyDate(value);
    return /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? formatFriendlyInstant(value) : `${formatFriendlyDate(date)} ${value.slice(11, 16)}`;
  }).replace(/\b(\d{4})-(0[1-9]|1[0-2])\b(?!-\d)/g, (_match, year: string, month: string) => `${year}年${Number(month)}月`);
}

function linkTarget(value: string): string | null {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function inline(text: string, depth = 0): ReactNode {
  if (depth > 4) return friendlyReplyText(text);
  // React owns all nodes. Raw HTML and images are never interpreted or fetched.
  const token = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\[([^\]\n]+)\]\(([^\s)]+)\)|https?:\/\/[^\s<>]+|\*([^*\n]+)\*/g;
  const result: ReactNode[] = [];
  let offset = 0;
  for (const match of text.matchAll(token)) {
    const index = match.index;
    if (index > offset) result.push(friendlyReplyText(text.slice(offset, index)));
    let node: ReactNode;
    if (match[1]) node = <code>{match[1]}</code>;
    else if (match[2] || match[3]) node = <strong>{inline(match[2] ?? match[3]!, depth + 1)}</strong>;
    else if (match[4]) {
      const href = linkTarget(match[5]!);
      node = href ? <a href={href} target="_blank" rel="noopener noreferrer">{inline(match[4], depth + 1)}</a> : match[0];
    } else if (match[6]) node = <em>{inline(match[6], depth + 1)}</em>;
    else {
      const href = linkTarget(match[0]);
      node = href ? <a href={href} target="_blank" rel="noopener noreferrer">{match[0]}</a> : match[0];
    }
    result.push(<Fragment key={index}>{node}</Fragment>);
    offset = index + match[0].length;
  }
  if (offset < text.length) result.push(friendlyReplyText(text.slice(offset)));
  return result;
}

const bullet = (line: string) => /^\s*[-+*]\s+(.+)$/.exec(line);
const numbered = (line: string) => /^\s*(\d+)[.)]\s+(.+)$/.exec(line);
const special = (line: string) => /^\s*```|^#{1,6}\s|^\s*>\s?/.test(line) || bullet(line) || numbered(line);

/** Small, non-HTML Markdown renderer shared by desktop and phone replies. */
export function AssistantText({ text }: { text: string }) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n'), blocks: ReactNode[] = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index]!;
    if (!line.trim()) { index++; continue; }
    const key = index;
    if (/^\s*```/.test(line)) {
      const code: string[] = []; index++;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index]!)) code.push(lines[index++]!);
      if (index < lines.length) index++;
      blocks.push(<pre key={key}><code>{code.join('\n')}</code></pre>); continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) { blocks.push(<p key={key} className="assistant-text-heading" role="heading" aria-level={heading[1]!.length}>{inline(heading[2]!)}</p>); index++; continue; }
    if (bullet(line) || numbered(line)) {
      const ordered = !!numbered(line), start = ordered ? Number(numbered(line)![1]) : undefined, items: ReactNode[] = [];
      while (index < lines.length) {
        const item = ordered ? numbered(lines[index]!) : bullet(lines[index]!);
        if (!item) break;
        items.push(<li key={index}>{inline(item[ordered ? 2 : 1]!)}</li>); index++;
      }
      blocks.push(ordered ? <ol key={key} start={start}>{items}</ol> : <ul key={key}>{items}</ul>); continue;
    }
    if (/^\s*>\s?/.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index]!)) quoted.push(lines[index++]!.replace(/^\s*>\s?/, ''));
      blocks.push(<blockquote key={key}>{inline(quoted.join('\n'))}</blockquote>); continue;
    }
    const paragraph = [line]; index++;
    while (index < lines.length && lines[index]!.trim() && !special(lines[index]!)) paragraph.push(lines[index++]!);
    blocks.push(<p key={key}>{inline(paragraph.join('\n'))}</p>);
  }
  return <div className="assistant-text">{blocks}</div>;
}
