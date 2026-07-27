// @mention support for the group chat. This is purely a display concern: the
// message body stored in Matrix stays plain text (e.g. "hey @Blue"), the "@"
// is an ordinary character, and these helpers only decide where a mention
// autocomplete should open and which spans to highlight when rendering.

/** A parsed run of a message body: either plain text or a participant mention. */
export interface MentionSegment {
  type: "text" | "mention";
  /** For a mention this is the full match including the leading "@". */
  value: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Look backwards from the caret for an in-progress mention. A mention starts at
 * an "@" that sits at the start of the text or right after whitespace, with no
 * whitespace between it and the caret. Returns the "@" index and the partial
 * name typed so far, or null when the caret is not inside a mention.
 */
export function detectMention(
  value: string,
  caret: number,
): { start: number; query: string } | null {
  const upto = value.slice(0, caret);
  const at = upto.lastIndexOf("@");
  if (at === -1) return null;
  if (at > 0 && !/\s/.test(value[at - 1])) return null;
  const query = upto.slice(at + 1);
  if (/\s/.test(query)) return null;
  return { start: at, query };
}

/**
 * Split a message body into text and mention segments. Only "@name" runs whose
 * name is a current participant (and that sit on a word boundary, so emails
 * like "a@Blue.com" are left alone) become mentions.
 */
export function splitMentions(
  body: string,
  names: Iterable<string>,
): MentionSegment[] {
  // Longest first so "@Magenta" wins over any shorter prefix name.
  const list = [...new Set(names)]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  if (list.length === 0) return [{ type: "text", value: body }];

  const alternation = list.map(escapeRegExp).join("|");
  const re = new RegExp(
    `(?<![\\p{L}\\p{N}])@(?:${alternation})(?![\\p{L}\\p{N}])`,
    "gu",
  );
  const segments: MentionSegment[] = [];
  let last = 0;
  for (const match of body.matchAll(re)) {
    const start = match.index;
    if (start > last) segments.push({ type: "text", value: body.slice(last, start) });
    segments.push({ type: "mention", value: match[0] });
    last = start + match[0].length;
  }
  if (last < body.length) segments.push({ type: "text", value: body.slice(last) });
  return segments;
}
