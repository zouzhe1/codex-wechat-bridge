/**
 * Split long text into WeChat-sized chunks at natural boundaries.
 * Order of preference: paragraph → line → sentence end → hard cut.
 * A sentence is never cut mid-way when any boundary is available
 * (the old plugin hard-truncated at 1200 chars — that's the "stacked" bug).
 */

export const DEFAULT_MAX_CHARS = 1800; // protocol cuts around 2000; keep headroom

/** A cut point: CJK/full-width terminators, or a Latin period not glued to a number. */
function endsSentence(s) {
  if (/[。!？？;;]$/.test(s)) return true;
  if (/\.$/.test(s)) return !/\d$/.test(s.slice(-2, -1)); // "3.14" stays whole
  return false;
}

function splitAt(text, max, separator, keepSeparator = false) {
  const parts = [];
  let rest = text;
  while (rest.length > max) {
    const idx = rest.slice(0, max).lastIndexOf(separator);
    const cut = keepSeparator ? idx + separator.length : idx;
    if (cut <= 0) break;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) parts.push(rest); // caller must handle a possibly oversized tail
  return parts;
}

function safeCutPoint(window) {
  // Never tear a surrogate pair: a dangling high surrogate at the cut goes back one.
  if (window.length === 0) return 0;
  const last = window.charCodeAt(window.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? window.length - 1 : window.length;
}

function splitSentence(text, max) {
  const parts = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    // last sentence boundary inside the window; fall back to a surrogate-safe hard cut
    let cut = 0;
    for (let i = 1; i <= window.length; i++) {
      if (endsSentence(window.slice(0, i))) cut = i;
    }
    if (cut <= 0) cut = safeCutPoint(window);
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) parts.push(rest);
  return parts;
}

function chunkOne(block, max) {
  if (block.length <= max) return [block];
  const byLine = splitAt(block, max, '\n', true);
  const pieces = byLine.length === 1 ? splitSentence(block, max) : byLine;
  // greedily re-join tiny pieces; anything still oversized gets a sentence split
  const merged = [];
  const push = piece => {
    const prev = merged[merged.length - 1];
    if (piece.length <= max && prev && prev.length + piece.length <= max) merged[merged.length - 1] = prev + piece;
    else merged.push(piece);
  };
  for (const piece of pieces) {
    if (piece.length <= max) push(piece);
    else for (const sub of splitSentence(piece, max)) push(sub);
  }
  return merged;
}

/** Returns an array of chunks, each ≤ max characters (code-unit safe for BMP text). */
export function chunk(text, max = DEFAULT_MAX_CHARS) {
  if (typeof text !== 'string' || !text) return [];
  if (text.length <= max) return [text];

  const paragraphs = text.split(/\n{2,}/);
  const chunks = [];
  let cur = '';

  for (const para of paragraphs) {
    const block = cur ? `${cur}\n\n${para}` : para;
    if (block.length <= max) { cur = block; continue; }
    if (cur) { chunks.push(cur); cur = ''; }
    if (para.length <= max) { cur = para; continue; }
    // oversized paragraph (e.g. a long code block): split it on its own
    const parts = chunkOne(para, max);
    chunks.push(...parts.slice(0, -1));
    cur = parts[parts.length - 1] || '';
  }
  if (cur) chunks.push(cur);
  return chunks.filter(Boolean);
}
