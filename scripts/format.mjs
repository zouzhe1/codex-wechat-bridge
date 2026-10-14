// Markdown → WeChat-friendly plain text.
// The iLink protocol only carries text_item; the official plugin does the same
// conversion (its `markdown-filter`). Goals: no bare hash/star/fence markers, no
// collapsed "stacked" blobs — structure survives as readable plain text.
// (Line comments on purpose: block comments break on stray star-slash sequences.)

function convertInline(text) {
  return text
    // images: keep the alt text as a placeholder (URLs are noise on phones)
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt) => (alt ? `[图:${alt}]` : ''))
    // links: text (url); autolinks stay
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => (label === url ? label : `${label} (${url})`))
    .replace(/<((?:https?:\/\/|mailto:)[^>\s]+)>/g, '$1')
    // inline code / bold / italic / strikethrough — keep the text, drop the decoration
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '$1')
    .replace(/(?<!_)_([^_\n]+)_(?!_)/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    // markdown escapes: \* → *
    .replace(/\\([\\`*_{}[\]()#+\-.!>])/g, '$1');
}

export function mdToText(markdown) {
  if (typeof markdown !== 'string' || !markdown) return '';
  const out = [];
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  let inCode = false;

  while (i < lines.length) {
    const line = lines[i];

    // fenced code blocks: drop the fences, keep every line verbatim
    const fence = line.match(/^\s*(```+|~~~+)\s*(\S*)\s*$/);
    if (fence) {
      if (!inCode) { inCode = true; out.push(''); }
      else { inCode = false; out.push(''); }
      i += 1;
      continue;
    }
    if (inCode) { out.push(line); i += 1; continue; }

    if (!line.trim()) { out.push(''); i += 1; continue; }

    // headings → 【title】 for h1/h2, plain text below
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      const title = convertInline(heading[2].trim());
      out.push(level <= 2 ? `【${title}】` : title);
      i += 1;
      continue;
    }

    // horizontal rules
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) { out.push('────────'); i += 1; continue; }

    // tables → cells joined with |
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const cells = line.trim().replace(/^\||\|$/g, '').split('|').map(c => convertInline(c.trim()));
      if (!cells.every(c => /^:?-{2,}:?$/.test(c))) out.push(cells.join(' | '));
      i += 1;
      continue;
    }

    // task list items
    const task = line.match(/^(\s*)[-*+]\s+\[( |x|X)\]\s+(.*)$/);
    if (task) { out.push(`${task[1]}${task[2].toLowerCase() === 'x' ? '☑' : '☐'} ${convertInline(task[3])}`); i += 1; continue; }

    // unordered list items → •, one indent level per 2 spaces (or tab)
    const ul = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (ul) {
      const depth = Math.floor(ul[1].replace(/\t/g, '  ').length / 2);
      out.push(`${'  '.repeat(depth)}• ${convertInline(ul[2])}`);
      i += 1;
      continue;
    }

    // ordered lists keep their numbering
    const ol = line.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
    if (ol) {
      const depth = Math.floor(ol[1].replace(/\t/g, '  ').length / 2);
      out.push(`${'  '.repeat(depth)}${ol[2]}. ${convertInline(ol[3])}`);
      i += 1;
      continue;
    }

    // blockquotes
    const bq = line.match(/^\s*>\s?(.*)$/);
    if (bq) { out.push(`│ ${convertInline(bq[1])}`); i += 1; continue; }

    out.push(convertInline(line));
    i += 1;
  }

  // tidy: collapse runs of blank lines, trim trailing spaces
  return out
    .map(l => l.replace(/\s+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
