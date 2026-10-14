import test from 'node:test';
import assert from 'node:assert/strict';
import { mdToText } from '../scripts/format.mjs';
import { chunk, DEFAULT_MAX_CHARS } from '../scripts/chunker.mjs';

test('headings: h1/h2 become 【title】, deeper headings stay plain', () => {
  assert.equal(mdToText('# 主标题\n\n正文'), '【主标题】\n\n正文');
  assert.equal(mdToText('## 二级'), '【二级】');
  assert.equal(mdToText('###### 六级'), '六级');
});

test('lists: bullets become •, nesting keeps indent, ordered lists keep numbers', () => {
  const md = '- 甲\n- 乙\n  - 乙1\n1. 第一\n2) 第二';
  const out = mdToText(md);
  assert.ok(out.includes('• 甲'));
  assert.ok(out.includes('  • 乙1'), out);
  assert.ok(out.includes('1. 第一'));
  assert.ok(out.includes('2. 第二'));
});

test('code blocks: fences dropped, content preserved verbatim', () => {
  const md = '前文\n\n```js\nconst a = 1;\nconsole.log(a);\n```\n\n后文';
  const out = mdToText(md);
  assert.ok(!out.includes('```'), 'fences must be gone');
  assert.ok(out.includes('const a = 1;'));
  assert.ok(out.includes('console.log(a);'));
  assert.ok(out.includes('前文') && out.includes('后文'));
});

test('links and images degrade gracefully', () => {
  const out = mdToText('见 [文档](https://example.com/doc) 与 ![截图](https://cdn/x.png)');
  assert.ok(out.includes('文档 (https://example.com/doc)'), out);
  assert.ok(out.includes('[图:截图]'), out);
  assert.ok(!out.includes(']('), 'no raw markdown link syntax may remain');
});

test('tables, quotes, tasks, rules and inline decoration', () => {
  const out = mdToText([
    '| A | B |',
    '| --- | ---: |',
    '| 1 | 2 |',
    '',
    '> 引用一句',
    '',
    '- [x] 完成',
    '- [ ] 未完成',
    '',
    '---',
    '',
    '这是 **加粗** 和 *斜体* 和 `代码` 和 ~~删除~~。',
  ].join('\n'));
  assert.ok(out.includes('A | B'), out);
  assert.ok(!out.includes('| ---'), 'separator row must be dropped');
  assert.ok(out.includes('│ 引用一句'));
  assert.ok(out.includes('☑ 完成') && out.includes('☐ 未完成'));
  assert.ok(out.includes('────────'));
  assert.ok(out.includes('这是 加粗 和 斜体 和 代码 和 删除。'), out);
});

test('no markdown residue: #, **, ``` never survive conversion', () => {
  const out = mdToText('# 标\n\n- 项\n\n```sh\nls\n```\n\n**粗** `码` [链](u)');
  assert.ok(!/#|\*\*|```/.test(out), out);
});

test('blank-line runs collapse to a single separator', () => {
  assert.equal(mdToText('a\n\n\n\n\nb'), 'a\n\nb');
  assert.equal(mdToText(''), '');
  assert.equal(mdToText(null), '');
});

test('chunk: short text stays whole; empty input yields nothing', () => {
  assert.deepEqual(chunk('你好'), ['你好']);
  assert.deepEqual(chunk(''), []);
  assert.deepEqual(chunk(null), []);
});

test('chunk: long text splits at paragraph boundaries, every chunk within limit', () => {
  const paragraphs = Array.from({ length: 30 }, (_, i) => `第 ${i} 段内容。`.repeat(10));
  const text = paragraphs.join('\n\n');
  const chunks = chunk(text, 500);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.length <= 500, `chunk too long: ${c.length}`);
  // paragraph-boundary splits round-trip losslessly
  assert.equal(chunks.join('\n\n'), text);
});

test('chunk: an oversized single paragraph splits on line breaks', () => {
  const lines = Array.from({ length: 100 }, (_, i) => `line-${i}-${'x'.repeat(40)}`);
  const text = lines.join('\n');
  const chunks = chunk(text, 300);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.length <= 300);
  assert.equal(chunks.join(''), text, 'line splitting must not lose characters');
});

test('chunk: falls back to sentence boundaries, never mid-sentence when avoidable', () => {
  const sentence = '这是一个足够长的句子'.repeat(30) + '。';
  const text = sentence.repeat(10); // one giant paragraph, one line, no \n
  const chunks = chunk(text, 400);
  for (const c of chunks) assert.ok(c.length <= 400);
  // every chunk but the last ends at a sentence terminator
  for (const c of chunks.slice(0, -1)) assert.ok(/[。;;]$/.test(c), `mid-sentence cut: …${c.slice(-6)}`);
  assert.equal(chunks.join(''), text, 'sentence splitting must not lose characters');
});

test('chunk: surrogate pairs are never torn', () => {
  const emoji = '😀🎯🚀';
  const text = `${emoji.repeat(500)}尾`;
  const chunks = chunk(text, 100);
  for (const c of chunks) {
    assert.ok(!/[\uD800-\uDBFF]$/.test(c.slice(-1)) || c.length % 2 === 0, 'lone high surrogate at chunk end');
  }
  assert.equal(chunks.join(''), text);
});

test('DEFAULT_MAX_CHARS stays under the protocol ceiling', () => {
  assert.ok(DEFAULT_MAX_CHARS <= 2000);
});
