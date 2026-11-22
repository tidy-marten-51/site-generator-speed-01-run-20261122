// Fast drop-in for makefun-site 1.0.0.
//
// Reimplemented from the behaviour stated in makefun-site's README (front matter,
// template dialect, Markdown subset, slug rule, report) with the vendor code as the
// reference where the two differ. Same answers, byte for byte; the speed comes from
// fused single-pass rendering: Markdown blocks and inline marks are rendered straight
// to output chunks (no token objects, no per-character escaping), slugs are memoised
// within one build, and templates are parsed once per build and walked over an
// output array. Nothing is kept from one run() call to the next.

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const RESERVED = ['posts', 'tags', 'page'];
const SLUG_MAX = 64;

// ---------------------------------------------------------------- text

const ESC_TEST = /[&<>"']/;
/** The escape table, by character, for the inline scanner's own use. */
const ESCAPED = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** `text` with & < > " and ' escaped. Fast path when there is nothing to escape; `&` first so later replacements are not re-escaped. */
function escapeHtml(text) {
  if (!ESC_TEST.test(text)) return text;
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const ASCII_ONLY = /^[\x00-\x7F]*$/;
const COMBINING = /\p{M}/gu;

/** The slug of `text`, exactly as makefun-site computes it; `cache` memoises it for one build. */
function slugify(text, cache) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  const plain = ASCII_ONLY.test(text) ? text : text.normalize('NFKD').replace(COMBINING, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const ch = plain[i];
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  if (out === '') out = 'untitled';
  cache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it): slug, slug-2, slug-3 ... */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

/** Whether code unit `c` is whitespace in JavaScript's \s sense. */
function isWS(c) {
  return (
    c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 ||
    c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff
  );
}

const WS_ASCII = new Uint8Array(128);
for (const c of [9, 10, 11, 12, 13, 32]) WS_ASCII[c] = 1;

/** The words of a body: its runs of characters other than whitespace (no allocation). */
function countWords(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 128 ? WS_ASCII[c] === 1 : isWS(c)) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;
const FM_BLANK = /^[ \t]*$/;
const FM_TRAIL = /[ \t]+$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare (never opening on " or [). */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !FM_TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first reason it is refused.
 * `text` has "\n" line ends. The front matter opens on the line `---` and runs to the next line `---`.
 */
function parseFrontMatter(text) {
  if (text !== '---' && !text.startsWith('---\n')) return { error: 'no front matter' };
  let fmText;
  let bodyStart;
  const idx = text.indexOf('\n---\n', 3);
  if (idx !== -1) {
    fmText = text.slice(4, idx);
    bodyStart = idx + 5;
  } else if (text.endsWith('\n---')) {
    fmText = text.slice(4, text.length - 4);
    bodyStart = text.length;
  } else {
    return { error: 'the front matter is not closed' };
  }
  const data = {};
  const lines = fmText.split('\n');
  for (let k = 0; k < lines.length; k++) {
    const line = lines[k];
    if (FM_BLANK.test(line) || line.charCodeAt(0) === 35) continue;
    const m = FM_LINE.exec(line);
    if (!m) return { error: `line ${k + 2} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(FM_TRAIL, '');
    if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

// ---------------------------------------------------------------- Markdown

const BLANK_RE = /^[ \t]*$/;
const FENCE_OPEN_RE = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE_RE = /^```[ \t]*$/;
const HEADING_RE = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR_RE = /^(?:---|\*\*\*)[ \t]*$/;
const BULLET_RE = /^[-*] (.*)$/;
const ORDERED_RE = /^(\d{1,9})\. (.*)$/;
const CONTINUED_RE = /^ {2,}\S/;
const WS_RE = /\s/;

/** A line with spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  const m = HEADING_RE.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. Dispatched on the first character: only '#', '`', '-', '*' and space/tab can open one. */
function endsParagraph(line) {
  if (line === '') return true;
  const c = line.charCodeAt(0);
  if (c === 35) return headingOf(line) !== null;
  if (c === 96) return FENCE_OPEN_RE.test(line);
  if (c === 45 || c === 42) return HR_RE.test(line);
  if (c === 32 || c === 9) return BLANK_RE.test(line);
  return false;
}

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/**
 * `s` rendered inline; `link(target)` is a link's href. One native scan jumps from one
 * inline mark to the next; the scan also matches the characters the escape table names,
 * so the plain text between matches is escaped already and is written as it stands.
 */
function inline(s, link) {
  let out = '';
  const re = /[\\`*\[]|[&<>"']/g;
  let start = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    const i = m.index;
    const c = m[0];
    if (c === '\\') {
      if (i + 1 < s.length && ESCAPABLE.has(s[i + 1])) {
        if (start < i) out += s.slice(start, i);
        out += ESCAPED[s[i + 1]] ?? s[i + 1];
        re.lastIndex = i + 2;
        start = i + 2;
      }
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        if (start < i) out += s.slice(start, i);
        out += '<code>';
        out += escapeHtml(s.slice(i + 1, j));
        out += '</code>';
        re.lastIndex = j + 1;
        start = j + 1;
      }
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          if (start < i) out += s.slice(start, i);
          out += '<strong>';
          out += inline(s.slice(i + 2, j), link);
          out += '</strong>';
          re.lastIndex = j + 2;
          start = j + 2;
        } else {
          re.lastIndex = i + 2;
        }
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        if (start < i) out += s.slice(start, i);
        out += '<em>';
        out += inline(s.slice(i + 1, j), link);
        out += '</em>';
        re.lastIndex = j + 1;
        start = j + 1;
      }
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', i + 1);
      const close = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = close === -1 ? '' : s.slice(k + 2, close);
      if (target !== '' && !WS_RE.test(target)) {
        if (start < i) out += s.slice(start, i);
        out += '<a href="';
        out += escapeHtml(link(target));
        out += '">';
        out += inline(s.slice(i + 1, k), link);
        out += '</a>';
        re.lastIndex = close + 1;
        start = close + 1;
      }
      continue;
    }
    // A character the escape table names: write its escape.
    if (start < i) out += s.slice(start, i);
    out += ESCAPED[c];
    start = i + 1;
  }
  if (start < s.length) out += s.slice(start);
  return out;
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the last), its table of
 * contents (every level 2 and 3 heading: level, id and its inline HTML) and its excerpt (the
 * first paragraph's inline HTML, or ""). Blocks are rendered straight to strings; no tokens.
 */
function renderMarkdown(src, link, slugCache) {
  const lines = src.split('\n');
  let html = '';
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (line === '') {
      i++;
      continue;
    }
    const c0 = line.charCodeAt(0);
    if (c0 === 32 || c0 === 9) {
      if (BLANK_RE.test(line)) {
        i++;
        continue;
      }
      // An indented line opens no block: it is a paragraph line.
    } else if (c0 === 96) {
      const fence = FENCE_OPEN_RE.exec(line);
      if (fence !== null) {
        i++;
        html += fence[1] === '' ? '<pre><code>' : `<pre><code class="language-${escapeHtml(fence[1])}">`;
        while (i < n && !FENCE_CLOSE_RE.test(lines[i])) {
          html += escapeHtml(lines[i]);
          html += '\n';
          i++;
        }
        i++;
        html += '</code></pre>\n';
        continue;
      }
    } else if (c0 === 35) {
      const heading = headingOf(line);
      if (heading !== null) {
        const id = uniqueSlug(slugify(heading.text, slugCache), ids);
        const h = inline(heading.text, link);
        html += `<h${heading.depth} id="${id}">${h}</h${heading.depth}>\n`;
        if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html: h });
        i++;
        continue;
      }
    } else if (c0 === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i];
        body.push(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
        i++;
      }
      const kept = [];
      for (const l of body) {
        const t = trimLine(l);
        if (t !== '') kept.push(t);
      }
      html += kept.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inline(kept.join('\n'), link)}</p>\n</blockquote>\n`;
      continue;
    } else if (c0 === 45 || c0 === 42 || (c0 >= 48 && c0 <= 57)) {
      let lm = null;
      let lOrd = false;
      if (c0 === 45 || c0 === 42) {
        if (HR_RE.test(line)) {
          html += '<hr>\n';
          i++;
          continue;
        }
        lm = BULLET_RE.exec(line);
      } else {
        lm = ORDERED_RE.exec(line);
        lOrd = lm !== null;
      }
      if (lm !== null) {
        const isOrdered = lOrd;
        const marker = isOrdered ? ORDERED_RE : BULLET_RE;
        const start = isOrdered ? Number(lm[1]) : 1;
        const items = [];
        while (i < n) {
          const m = marker.exec(lines[i]);
          if (m !== null) {
            items.push([trimLine(isOrdered ? m[2] : m[1])]);
            i++;
          } else if (CONTINUED_RE.test(lines[i])) {
            items[items.length - 1].push(trimLine(lines[i]));
            i++;
          } else break;
        }
        const tag = isOrdered ? 'ol' : 'ul';
        html += isOrdered && start !== 1 ? `<ol start="${start}">\n` : `<${tag}>\n`;
        for (const item of items) {
          html += '<li>';
          html += inline(item.join('\n'), link);
          html += '</li>\n';
        }
        html += `</${tag}>\n`;
        continue;
      }
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) {
      body.push(trimLine(lines[i]));
      i++;
    }
    const h = inline(body.join('\n'), link);
    if (excerpt === null) excerpt = h;
    html += `<p>${h}</p>\n`;
  }
  return { html, toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const TPL_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const TPL_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const TPL_IF = /^if (not )?(\S+)$/;
const TPL_INCLUDE = /^include "([a-z0-9-]+)"$/;
const TPL_STANDALONE = /^[ \t]*$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!TPL_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/**
 * `src`'s tokens: text, {{ }}, {{{ }}} and {% %}; a {% %} tag alone on its line takes
 * the whole line with it, its "\n" included. Node kinds: 0 text, 1 var, 2 raw, 3 if,
 * 4 for, 5 include, 9 root.
 */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = TPL_STANDALONE.test(src.slice(lineStart, open)) && TPL_STANDALONE.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { k: 9, a: [] };
  const stack = [root];
  let body = root.a;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ k: 0, x: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ k: tok.t === 'var' ? 1 : 2, p: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = TPL_FOR.exec(tag)) !== null) {
        const node = { k: 4, v: m[1], p: pathOf(name, m[2]), a: [] };
        body.push(node);
        stack.push(node);
        body = node.a;
      } else if ((m = TPL_IF.exec(tag)) !== null) {
        const node = { k: 3, n: m[1] !== undefined, p: pathOf(name, m[2]), a: [], b: null };
        body.push(node);
        stack.push(node);
        body = node.a;
      } else if (tag === 'else') {
        if (top.k !== 3 || top.b !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.b = [];
        body = top.b;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.k !== (tag === 'endfor' ? 4 : 3)) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.k === 9 ? parent.a : parent.k === 4 ? parent.a : parent.b ?? parent.a;
      } else if ((m = TPL_INCLUDE.exec(tag)) !== null) body.push({ k: 5, x: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].k === 4 ? 'for' : 'if'} is not closed`);
  return root.a;
}

/**
 * The value at `path` in the scope chain. A scope is its vars object whose prototype is
 * the enclosing scope's vars (all null-prototype), so `in` walks the chain exactly as
 * the reference's hasOwn walk does; later names are own properties of the value so far.
 */
function lookup(S, path) {
  const p0 = path[0];
  if (!(p0 in S)) return undefined;
  let v = S[p0];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `nodes` rendered in scope `S` at include depth `D`; `T` maps template names to their
 * parsed nodes. Returns the rendered text. The for scope (and its loop record) is built
 * once per loop and reused across items: rendering is synchronous, so no body can observe
 * the reuse. This is the fallback for a template that does not compile; the compiled
 * form below is what normally runs.
 */
function renderNodes(nodes, S, D, T) {
  let out = '';
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    switch (n.k) {
      case 0:
        out += n.x;
        break;
      case 1:
        out += escapeHtml(textOf(lookup(S, n.p)));
        break;
      case 2:
        out += textOf(lookup(S, n.p));
        break;
      case 3: {
        const branch = truthy(lookup(S, n.p)) !== n.n ? n.a : n.b;
        if (branch !== null) out += renderNodes(branch, S, D, T);
        break;
      }
      case 4: {
        const xs = lookup(S, n.p);
        if (!Array.isArray(xs)) break;
        const sc = Object.create(S);
        const lp = { index: 0, first: false, last: false, length: xs.length };
        for (let k = 0; k < xs.length; k++) {
          sc[n.v] = xs[k];
          sc.loop = lp;
          lp.index = k + 1;
          lp.first = k === 0;
          lp.last = k === xs.length - 1;
          out += renderNodes(n.a, sc, D, T);
        }
        break;
      }
      case 5: {
        if (D < INCLUDE_DEPTH) {
          const t = T.get(n.x);
          if (t !== undefined) out += renderNodes(t, S, D + 1, T);
        }
        break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- template compilation

/** Lookup helper for compiled templates: first name from the scope chain, then own properties. */
function lkn(S, p) {
  if (!(p[0] in S)) return undefined;
  let v = S[p[0]];
  for (let k = 1; k < p.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, p[k])) return undefined;
    v = v[p[k]];
  }
  return v;
}

/**
 * Fused variable helpers for compiled templates: one call does the lookup and the
 * value's rendering, instead of a lookup call, a textOf call and an escape call.
 * `ve` is {{ }} (escaped), `vr` is {{{ }}} (raw), `tc` is an if condition's truthiness,
 * `fa` is a for loop's array (or undefined). Each is exactly escapeHtml(textOf(v)),
 * textOf(v), truthy(v) or the array check of the looked-up value.
 */
function ve1(S, a) {
  if (!(a in S)) return '';
  return veValue(S[a]);
}
function ve2(S, a, b) {
  if (!(a in S)) return '';
  const v = S[a];
  if (v === null || typeof v !== 'object' || !Object.hasOwn(v, b)) return '';
  return veValue(v[b]);
}
function ve3(S, a, b, c) {
  if (!(a in S)) return '';
  let v = S[a];
  if (v === null || typeof v !== 'object' || !Object.hasOwn(v, b)) return '';
  v = v[b];
  if (v === null || typeof v !== 'object' || !Object.hasOwn(v, c)) return '';
  return veValue(v[c]);
}
function veValue(w) {
  if (typeof w === 'string') return escapeHtml(w);
  if (typeof w === 'number') return String(w);
  if (typeof w === 'boolean') return w ? 'true' : 'false';
  if (Array.isArray(w)) return escapeHtml(w.map(textOf).join(', '));
  return '';
}
function vr1(S, a) {
  return a in S ? textOf(S[a]) : '';
}
function vr2(S, a, b) {
  if (!(a in S)) return '';
  const v = S[a];
  if (v === null || typeof v !== 'object' || !Object.hasOwn(v, b)) return '';
  return textOf(v[b]);
}
function vr3(S, a, b, c) {
  if (!(a in S)) return '';
  let v = S[a];
  if (v === null || typeof v !== 'object' || !Object.hasOwn(v, b)) return '';
  v = v[b];
  if (v === null || typeof v !== 'object' || !Object.hasOwn(v, c)) return '';
  return textOf(v[c]);
}
function tc1(S, a) {
  return a in S ? truthy(S[a]) : false;
}
function tc2(S, a, b) {
  if (!(a in S)) return false;
  const v = S[a];
  if (v === null || typeof v !== 'object' || !Object.hasOwn(v, b)) return false;
  return truthy(v[b]);
}
function tc3(S, a, b, c) {
  if (!(a in S)) return false;
  let v = S[a];
  if (v === null || typeof v !== 'object' || !Object.hasOwn(v, b)) return false;
  v = v[b];
  if (v === null || typeof v !== 'object' || !Object.hasOwn(v, c)) return false;
  return truthy(v[c]);
}
function fa1(S, a) {
  if (!(a in S)) return undefined;
  const w = S[a];
  return Array.isArray(w) ? w : undefined;
}
function fa2(S, a, b) {
  if (!(a in S)) return undefined;
  const v = S[a];
  if (v === null || typeof v !== 'object' || !Object.hasOwn(v, b)) return undefined;
  const w = v[b];
  return Array.isArray(w) ? w : undefined;
}
function fa3(S, a, b, c) {
  if (!(a in S)) return undefined;
  let v = S[a];
  if (v === null || typeof v !== 'object' || !Object.hasOwn(v, b)) return undefined;
  v = v[b];
  if (v === null || typeof v !== 'object' || !Object.hasOwn(v, c)) return undefined;
  const w = v[c];
  return Array.isArray(w) ? w : undefined;
}

/** Fused helpers for paths of more than three names (the generator's templates never have them). */
function ven(S, p) {
  return escapeHtml(textOf(lkn(S, p)));
}
function vrn(S, p) {
  return textOf(lkn(S, p));
}
function tcn(S, p) {
  return truthy(lkn(S, p));
}
function fan(S, p) {
  const v = lkn(S, p);
  return Array.isArray(v) ? v : undefined;
}

/** The generated code for a variable use of `kind` ('ve', 'vr', 'tc' or 'fa') at `path` in scope `S`. */
function genVar(kind, path, S) {
  if (path.length <= 3) {
    const args = path.map((p) => JSON.stringify(p)).join(',');
    return `H.${kind}${path.length}(${S},${args})`;
  }
  return `H.${kind}n(${S},${JSON.stringify(path)})`;
}

/** The generated code rendering `nodes` in scope `S`, appending to `_o`; `u` numbers the temporaries. */
function genNodes(nodes, S, u) {
  let code = '';
  for (const n of nodes) {
    switch (n.k) {
      case 0:
        code += `_o+=${JSON.stringify(n.x)};`;
        break;
      case 1:
        code += `_o+=${genVar('ve', n.p, S)};`;
        break;
      case 2:
        code += `_o+=${genVar('vr', n.p, S)};`;
        break;
      case 3: {
        const cond = n.n ? `!${genVar('tc', n.p, S)}` : genVar('tc', n.p, S);
        code += `if(${cond}){${genNodes(n.a, S, u)}}`;
        if (n.b !== null) code += `else{${genNodes(n.b, S, u)}}`;
        break;
      }
      case 4: {
        const id = ++u.n;
        code += `{const _a${id}=${genVar('fa', n.p, S)};if(_a${id}!==undefined){const _s${id}=Object.create(${S});const _l${id}={index:0,first:false,last:false,length:_a${id}.length};for(let _k${id}=0;_k${id}<_a${id}.length;_k${id}++){_s${id}[${JSON.stringify(n.v)}]=_a${id}[_k${id}];_s${id}.loop=_l${id};_l${id}.index=_k${id}+1;_l${id}.first=_k${id}===0;_l${id}.last=_k${id}===_a${id}.length-1;${genNodes(n.a, `_s${id}`, u)}}}}`;
        break;
      }
      case 5: {
        const id = ++u.n;
        code += `if(D<8){const _f${id}=H.T.get(${JSON.stringify(n.x)});if(_f${id}!==undefined)_o+=_f${id}(${S},D+1,H);}`;
        break;
      }
    }
  }
  return code;
}

/** A template's parsed nodes compiled to a render function (S scope, D depth, H helpers), returning its text. */
function compileTemplate(nodes) {
  return new Function('S', 'D', 'H', `let _o='';${genNodes(nodes, 'S', { n: 0 })}return _o;`);
}

// ---------------------------------------------------------------- the build

const CR_RE = /\r\n?/g;
const LINK_SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** `rel` (a link's path, "/"-separated) from the directory `dirParts` of a source, or null when it climbs out of the root. */
function resolvePath(dirParts, rel) {
  const parts = dirParts.slice();
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** A page's link record as templates read it. */
const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

/** A post's card, as lists show it. */
function cardOf(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: s.readingMinutes,
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

/** A page as its layout reads it. `s.card` is the card built once for the lists; the page spreads it, so the tags list and the long date are not built twice. Its toc is the renderer's own list: the entries already are { level, id, html }. */
function pageOf(s) {
  return {
    ...s.card,
    slug: s.slug,
    content: s.html,
    toc: s.toc,
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  };
}

/** One site's output tree: path -> text. */
function build(input) {
  const slugCache = new Map();
  const report = [];
  const templates = new Map();
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. The sources, in code-unit order of their paths, line ends made "\n".
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  let sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(CR_RE, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  sources = kept;

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  const taken = new Map();
  const takenIn = (dir) => {
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    return set;
  };
  const bySource = new Map();
  for (const s of sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, slugCache), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  const staticPaths = new Set();
  for (const f of statics) staticPaths.add(f.path);
  const broken = new Set();
  for (const s of sources) {
    const dir = dirOf(s.path);
    const dirParts = dir === '' ? [] : dir.split('/');
    const link = (target) => {
      if (LINK_SCHEME_RE.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dirParts, rel);
      if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
      if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, link, slugCache);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.readingMinutes = Math.max(1, Math.ceil(countWords(s.body) / 200));
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name, slugCache);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name, slugCache);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name, slugCache);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  for (const s of sources) s.card = cardOf(s);
  const cards = new Map();
  for (const p of posts) cards.set(p, p.card);
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const output = {};
  // Templates are compiled to render functions once per build; one that does not
  // compile falls back to the tree walker, so the answer never depends on codegen.
  const compiled = new Map();
  for (const [name, nodes] of templates) {
    try {
      compiled.set(name, compileTemplate(nodes));
    } catch {
      // fall back to renderNodes for this template
    }
  }
  const H = { ve1, ve2, ve3, ven, vr1, vr2, vr3, vrn, tc1, tc2, tc3, tcn, fa1, fa2, fa3, fan, T: compiled };
  /** Render template `name` in scope `S` (which holds site, tags and recent). */
  const render = (name, S) => {
    const fn = compiled.get(name);
    if (fn !== undefined) return fn(S, 0, H);
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    return renderNodes(nodes, S, 0, templates);
  };
  for (const s of sources) output[`${s.outDir}/index.html`] = render(s.layout, { __proto__: null, site, tags: allTags, recent, page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      __proto__: null,
      site,
      tags: allTags,
      recent,
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { __proto__: null, site, tags: allTags, recent, tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', { __proto__: null, site, tags: allTags, recent });
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = sources.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  return build(input);
}
