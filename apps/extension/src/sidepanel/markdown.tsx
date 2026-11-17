import DOMPurify from "dompurify";
import { marked } from "marked";
import { memo } from "react";

// Model output is untrusted: sanitize the rendered HTML and keep links from taking over the panel.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
  // Loading an image sends its URL to its server, so a page that got the model to write one
  // could put what the model knows in that URL. A remote image becomes a link the user may
  // follow; the extension's content security policy refuses the request as well.
  if (node.tagName === "IMG") {
    const src = node.getAttribute("src") ?? "";
    if (src.startsWith("data:image/")) return;
    const label = node.getAttribute("alt") || src;
    // The link is added after its own sanitizing would have run, so only a web address gets one.
    if (!/^https?:\/\//i.test(src)) return node.replaceWith(label);
    const link = document.createElement("a");
    link.href = src;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = label;
    node.replaceWith(link);
  }
});

/** Nothing in a message loads from the network: no media, and no styles that could fetch. */
const SANITIZE = {
  FORBID_TAGS: ["audio", "video", "source", "picture", "track", "style"],
  FORBID_ATTR: ["style", "srcset", "poster", "background"],
};

// Finished messages never change, so their rendered form is cached per source string.
const cache = new Map<string, string>();
const CACHE_LIMIT = 500;

function toHtml(text: string, cacheable: boolean): string {
  const cached = cache.get(text);
  if (cached !== undefined) return cached;
  const rendered = DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true }), SANITIZE);
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
