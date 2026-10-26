import DOMPurify from "dompurify";
import { marked } from "marked";
import { memo } from "react";

// Model output is untrusted: sanitize the rendered HTML and keep links from taking over the panel.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

// Finished messages never change, so their rendered form is cached per source string.
const cache = new Map<string, string>();
const CACHE_LIMIT = 500;

function toHtml(text: string, cacheable: boolean): string {
  const cached = cache.get(text);
  if (cached !== undefined) return cached;
  const rendered = DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true }));
  // Text that is still streaming changes on every delta and would only churn the cache.
  if (!cacheable) return rendered;
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(text, rendered);
  return rendered;
}

/** Markdown from the model, sanitized. Pass `streaming` while the text is still growing. */
export const Markdown = memo(function Markdown({
  text,
  streaming = false,
}: {
  text: string;
  streaming?: boolean;
}) {
  return <div className="prose" dangerouslySetInnerHTML={{ __html: toHtml(text, !streaming) }} />;
});
