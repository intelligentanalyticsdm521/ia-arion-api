/**
 * A written article becomes a blog post on the client's website.
 * ---------------------------------------------------------------------------
 * D-82 (2026-09-09). SPARK's Newsletter Studio has always had a "Publish to
 * site" button. It went LUMEN → arion-api `/arion/plugin/publish-newsletter`
 * → the IA plugin's `/publish-newsletter`, and the plugin has never registered
 * such a route in any version. So the button has never once worked; ARION
 * pack 2 deleted the middle of that chain, which turned a 502 into a 404 and
 * left the button still broken.
 *
 * It is a real feature — the Portal offers it, and the page tells the client
 * exactly what it will do — so it gets a real path. This module composes the
 * post out of the plugin routes that DO exist, which is the same path the
 * Portal's own "New post" uses (D-ARION-C):
 *
 *   1. POST /pages            {type:'post'}   → a draft post
 *   2. POST /pages/<id>/sections {status:'publish'} → the body, then live
 *   3. POST /pages/<id>/settings                    → summary + category
 *
 * ONE MECHANISM. There is no second way to write to WordPress here: no SSH,
 * no WordPress core REST, no plugin route of its own. Everything goes through
 * `pageClient`, which carries the site token.
 *
 * WHAT LANDS ON THE PAGE. The issue body is HTML written in SPARK's editor.
 * It is put into ONE Elementor section holding ONE text-editor widget, with
 * the `ia:` handle on the container so the next person can see where the
 * section came from. The HTML is sanitised on the way through: an email body
 * and a web page are not the same trust boundary, and a `<script>` that rode
 * along would run on every visitor's browser.
 *
 * THE POST IS A COPY, AND IS NOT STAMPED FOR EDITING HERE. The issue's home
 * is SPARK; the article on the website is a copy of it. Stamping the widget
 * with editor bindings would make the same article editable in two places,
 * which is two answers to "what does it say?" — and the write-back would
 * re-encode the markup, flattening the headings and lists the issue was
 * written with. So the section editor correctly reports this section as one
 * it does not own, and changing the article means changing the issue.
 *
 * NOTHING HERE REPORTS A SUCCESS IT DID NOT GET. A body that would not save
 * leaves the draft in place, named, and answers `ok:false` — the caller shows
 * a failure. Only the finishing touch (summary, category) is allowed to fail
 * softly, because by then the post IS live with its body, which is what the
 * button promised.
 */

import {
  createPage as defaultCreatePage,
  writePageSections as defaultWriteSections,
  writePageSettings as defaultWriteSettings,
} from './pageClient.js';
import { buildSectionTitle } from './elementorAdapter.js';

/** Tags a newsletter is actually written in. Everything else is dropped. */
const ALLOWED_TAGS = new Set([
  'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'span', 'div',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'blockquote', 'a', 'img', 'figure', 'figcaption', 'hr',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
]);

/** Attributes that may cross. `on*` is not among them, by construction. */
const ALLOWED_ATTRS = new Set(['href', 'src', 'alt', 'title', 'target', 'rel', 'width', 'height']);

/** Elements whose CONTENT must go too, not just their tags. */
const DROP_WITH_CONTENT = /<(script|style|iframe|object|embed|form|noscript)\b[\s\S]*?<\/\1\s*>/gi;
const DROP_SELF_CLOSING = /<(script|style|iframe|object|embed|form|noscript|link|meta)\b[^>]*\/?>/gi;

function safeUrl(raw) {
  const v = String(raw || '').trim();
  if (!v) return null;
  // Presence check, not an absence check: only these schemes are let through
  // (memory: reference_absence_based_guards_fail_open).
  if (/^https?:\/\//i.test(v)) return v;
  if (/^\//.test(v) && !/^\/\//.test(v)) return v;   // site-relative
  if (/^mailto:/i.test(v) || /^tel:/i.test(v)) return v;
  return null;
}

/**
 * Keep the writing, drop everything that could act.
 *
 * A small, explicit allowlist rather than a parser: the input is HTML our own
 * editor produced, and the job is to make sure a pasted-in `<script>` or an
 * `onclick=` never reaches a visitor's browser.
 */
function sanitizeBodyHtml(html) {
  let out = String(html == null ? '' : html);
  out = out.replace(DROP_WITH_CONTENT, '');
  out = out.replace(DROP_SELF_CLOSING, '');
  out = out.replace(/<!--[\s\S]*?-->/g, '');

  out = out.replace(/<\/?([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g, (whole, rawTag, rawAttrs) => {
    const tag = rawTag.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) return '';
    if (whole.startsWith('</')) return `</${tag}>`;

    const attrs = [];
    const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
    let m;
    while ((m = re.exec(rawAttrs)) !== null) {
      const name = m[1].toLowerCase();
      if (!ALLOWED_ATTRS.has(name)) continue;
      let value = m[2] ?? m[3] ?? m[4] ?? '';
      if (name === 'href' || name === 'src') {
        const url = safeUrl(value);
        if (!url) continue;
        value = url;
      }
      attrs.push(`${name}="${String(value).replace(/"/g, '&quot;')}"`);
    }
    const selfClosing = tag === 'br' || tag === 'img' || tag === 'hr';
    return `<${tag}${attrs.length ? ' ' + attrs.join(' ') : ''}${selfClosing ? ' /' : ''}>`;
  });

  return out;
}

/** Is there anything left once the markup is taken away? */
function hasVisibleText(html) {
  return String(html || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .trim().length > 0;
}

function shortId() {
  return Math.random().toString(36).slice(2, 9);
}

/**
 * Markdown → the small subset of HTML an article is written in.
 *
 * The content agent stores `body_markdown_final`. Handing that to a
 * text-editor widget unconverted puts literal `## ` and `**` on the client's
 * website, so it is converted here rather than at the call site — one
 * conversion, next to the sanitiser that runs after it.
 *
 * Deliberately small: headings, paragraphs, bullet and numbered lists, bold,
 * italic, inline code and links. Anything it does not recognise stays as the
 * text it was, which is the safe direction to be wrong in.
 */
export function markdownToHtml(markdown) {
  const src = String(markdown == null ? '' : markdown).replace(/\r\n?/g, '\n');
  if (!src.trim()) return '';

  const esc = (s) => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Inline runs, applied to already-escaped text so markup we did not intend
  // cannot be smuggled in through the source.
  const inline = (text) => esc(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (whole, label, href) => {
      const url = safeUrl(href.replace(/&amp;/g, '&'));
      return url ? `<a href="${url.replace(/"/g, '&quot;')}">${label}</a>` : label;
    });

  const out = [];
  let list = null;   // 'ul' | 'ol' | null
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };

  for (const rawLine of src.split('\n')) {
    const line = rawLine.trim();
    if (!line) { closeList(); continue; }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      closeList();
      const level = Math.min(6, Math.max(2, heading[1].length)); // never an h1: the post title is the h1
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    const bullet = /^[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
      out.push(`<li>${inline(bullet[1])}</li>`);
      continue;
    }
    const numbered = /^\d+[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
      out.push(`<li>${inline(numbered[1])}</li>`);
      continue;
    }
    if (/^([-*_])\1{2,}$/.test(line)) { closeList(); out.push('<hr />'); continue; }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) { closeList(); out.push(`<blockquote>${inline(quote[1])}</blockquote>`); continue; }

    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return out.join('\n');
}

/**
 * The issue body as ONE section the section editor can open afterwards.
 *
 * @param {string} contentHtml
 * @returns {Array<{ handle: string|null, node: object }>} the plugin's shape
 * @throws {Error} when there is nothing to publish
 */
export function htmlToPostSections(contentHtml) {
  const clean = sanitizeBodyHtml(contentHtml);
  if (!hasVisibleText(clean)) {
    throw new Error('There is nothing to publish — write the issue first.');
  }
  const title = buildSectionTitle({ kind: 'about', block: { archetype: 'article', blueprint_id: 'newsletter' }, blockId: shortId() });
  return [{
    handle: title,
    node: {
      id: shortId(),
      elType: 'container',
      settings: { _title: title },
      elements: [{
        id: shortId(),
        elType: 'widget',
        widgetType: 'text-editor',
        settings: { editor: clean },
      }],
    },
  }];
}

/**
 * Put a written article on the site as a live blog post.
 *
 * @param {object}  args
 * @param {object}  args.site           an `arion.site` row (carries the token)
 * @param {string}  args.title
 * @param {string}  args.contentHtml    the article body
 * @param {string} [args.excerpt]       the summary shown on the blog index
 * @param {string[]} [args.categories]  e.g. ['Newsletter']
 * @param {object} [args.client]        inject the transport for testing
 * @returns {Promise<{ ok:boolean, postId?:number|null, postUrl?:string|null,
 *                     step?:string, message?:string, warning?:string }>}
 */
export async function composePostFromHtml({
  site, title, contentHtml, excerpt = null, categories = [], client = {},
  // 2026-09-25 (register spark-newsletter-republish-creates-a-second-post):
  // a newsletter issue published twice used to become two posts. When the
  // caller already holds the post's id, the body and settings are written to
  // THAT post and no new one is made.
  existingPostId = null,
}) {
  const createPage        = client.createPage        || defaultCreatePage;
  const writePageSections = client.writePageSections || defaultWriteSections;
  const writePageSettings = client.writePageSettings || defaultWriteSettings;

  if (!site) {
    return { ok: false, step: 'site', message: 'No website is connected to this account yet.' };
  }
  const heading = String(title || '').trim();
  if (!heading) {
    return { ok: false, step: 'title', message: 'Give the article a title first.' };
  }

  let sections;
  try {
    sections = htmlToPostSections(contentHtml);
  } catch (err) {
    return { ok: false, step: 'body', message: err.message };
  }

  /* 1. The draft post. Born a draft, exactly like the Portal's New post —
   *    unless the caller is republishing, in which case the post already
   *    exists and this step is skipped. */
  let created = null;
  let postId = Number(existingPostId) || null;
  if (!postId) {
    created = await createPage(site, { title: heading, type: 'post', sections: [] });
    if (!created?.ok) {
      return {
        ok: false, step: 'create',
        message: created?.message || created?.error || 'Your website would not create the post.',
      };
    }
    postId = Number(created.data?.page_id) || null;
    if (!postId) {
      // A 200 with no id is a failure. Saying "published" here is the exact
      // shape this codebase keeps re-learning not to write.
      return {
        ok: false, step: 'create',
        message: 'Your website said it made the post but did not say where. Nothing has been published.',
      };
    }
  }

  /* 2. The body, and live in the same call — the plugin reads it back. */
  const body = await writePageSections(site, postId, { sections, status: 'publish', title: heading });
  if (!body?.ok) {
    return {
      ok: false, step: 'body', postId,
      message: body?.message || body?.error
        || 'Your website made the post but would not save what it says. It is saved as a draft.',
    };
  }

  const postUrl = body.data?.permalink || created?.data?.permalink || null;

  /* 3. The finishing touch. The post is already live with its body, so a
   *    refusal here is a warning on a real success, not a failure. */
  let warning = null;
  const settings = {};
  if (excerpt != null && String(excerpt).trim()) settings.excerpt = String(excerpt).trim();
  const cats = (Array.isArray(categories) ? categories : [])
    .map((c) => String(c || '').trim()).filter(Boolean);
  if (cats.length) settings.categories = cats;

  if (Object.keys(settings).length) {
    const meta = await writePageSettings(site, postId, settings);
    if (!meta?.ok) {
      warning = `The post is live, but its summary and category would not save${meta?.message ? ` (${meta.message})` : ''}.`;
    }
  }

  return { ok: true, postId, postUrl, warning, updated: !!existingPostId };
}

export const __test__ = { sanitizeBodyHtml, hasVisibleText, safeUrl, markdownToHtml, ALLOWED_TAGS, ALLOWED_ATTRS };
