export interface SnapshotOptions {
  /** CSS selector that scopes the snapshot. Default: the whole document. */
  within?: string;
  /** List only interactive elements, without page text. */
  interactiveOnly?: boolean;
  /** Output budget in characters. Default 12000. */
  maxChars?: number;
}

/**
 * Runs inside the page (serialized by `page.evaluate`), so it must stay self-contained:
 * no imports and no references to anything outside its own body.
 */
export function snapshotInPage(options: SnapshotOptions): string {
  const INTERACTIVE = new Set([
    "link",
    "button",
    "textbox",
    "searchbox",
    "combobox",
    "listbox",
    "checkbox",
    "radio",
    "switch",
    "slider",
    "spinbutton",
    "tab",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "option",
    "treeitem",
    "file",
  ]);
  const SKIP = new Set(["script", "style", "noscript", "template", "head", "svg", "canvas"]);
  const BLOCK = new Set([
    "p",
    "div",
    "li",
    "tr",
    "td",
    "th",
    "section",
    "article",
    "header",
    "footer",
    "main",
    "nav",
    "aside",
    "ul",
    "ol",
    "table",
    "form",
    "br",
    "dd",
    "dt",
    "blockquote",
    "pre",
    "label",
  ]);

  const maxChars = options.maxChars ?? 12_000;
  const refs = new Map<string, Element>();
  (window as unknown as { __relayRefs?: Map<string, Element> }).__relayRefs = refs;

  const root = options.within ? document.querySelector(options.within) : document.body;
  if (!root) return `No element matches selector ${JSON.stringify(options.within)}.`;

  const lines: string[] = [`Page: ${document.title}`, `URL: ${location.href}`, ""];
  let size = 0;
  let truncated = false;
  let counter = 0;
  let textBuffer = "";

  const clean = (text: string) => text.replace(/\s+/g, " ").trim();
  const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);
  const push = (line: string) => {
    if (truncated) return;
    if (size + line.length > maxChars) {
      truncated = true;
      return;
    }
    size += line.length + 1;
    lines.push(line);
  };
  const flushText = () => {
    const text = clean(textBuffer);
    textBuffer = "";
    if (text) push(clip(text, 300));
  };

  const visible = (el: Element) => {
    if (typeof el.checkVisibility === "function") {
      return el.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true });
    }
    const style = getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden";
  };

  const roleOf = (el: Element): string | null => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return el.hasAttribute("href") ? "link" : null;
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      const type = (el as HTMLInputElement).type;
      if (type === "hidden") return null;
      if (type === "checkbox" || type === "radio") return type;
      if (type === "button" || type === "submit" || type === "reset" || type === "image") {
        return "button";
      }
      if (type === "range") return "slider";
      if (type === "number") return "spinbutton";
      if (type === "search") return "searchbox";
      if (type === "file") return "file";
      return "textbox";
    }
    const editable = (el as HTMLElement).isContentEditable;
    const parentEditable = (el.parentElement as HTMLElement | null)?.isContentEditable;
    if (editable && !parentEditable) return "textbox";
    return null;
  };

  const nameOf = (el: Element): string => {
    const aria = el.getAttribute("aria-label");
    if (aria && clean(aria)) return clean(aria);
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = clean(
        labelledBy
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent ?? "")
          .join(" "),
      );
      if (text) return text;
    }
    if (
      el instanceof HTMLInputElement ||
      el instanceof HTMLTextAreaElement ||
      el instanceof HTMLSelectElement
    ) {
      const label = clean(el.labels?.[0]?.textContent ?? "");
      if (label) return label;
      if (el instanceof HTMLInputElement && ["button", "submit", "reset"].includes(el.type)) {
        return clean(el.value);
      }
      return clean(el.getAttribute("placeholder") ?? el.getAttribute("name") ?? "");
    }
    const text = clean((el as HTMLElement).innerText ?? el.textContent ?? "");
    if (text) return text;
    const alt = el.querySelector("img[alt]")?.getAttribute("alt");
    return clean(alt ?? el.getAttribute("title") ?? "");
  };

  const describe = (el: Element, role: string): string => {
    const id = `e${++counter}`;
    refs.set(id, el);
    let line = `[${id}] ${role} ${JSON.stringify(clip(nameOf(el), 80))}`;
    if (el instanceof HTMLInputElement) {
      if (el.type === "checkbox" || el.type === "radio") {
        if (el.checked) line += " (checked)";
      } else if (el.type !== "password" && el.value) {
        line += ` value=${JSON.stringify(clip(el.value, 60))}`;
      }
    } else if (el instanceof HTMLTextAreaElement) {
      if (el.value) line += ` value=${JSON.stringify(clip(el.value, 60))}`;
    } else if (el instanceof HTMLSelectElement) {
      const selected = clean(el.selectedOptions[0]?.textContent ?? "");
      if (selected) line += ` value=${JSON.stringify(clip(selected, 60))}`;
    } else if (role === "link") {
      const href = el.getAttribute("href");
      if (href) line += ` -> ${clip(href, 100)}`;
    }
    if (el.getAttribute("aria-checked") === "true") line += " (checked)";
    if (el.getAttribute("aria-selected") === "true") line += " (selected)";
    const expanded = el.getAttribute("aria-expanded");
    if (expanded) line += expanded === "true" ? " (expanded)" : " (collapsed)";
    if ((el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true") {
      line += " (disabled)";
    }
    return line;
  };

  // `quiet` suppresses text while still finding interactive elements nested in an element whose
  // text was already reported (a heading, or another interactive element's name).
  const walk = (node: Node, quiet: boolean) => {
    if (truncated) return;
    if (node.nodeType === Node.TEXT_NODE) {
      if (!quiet && !options.interactiveOnly) textBuffer += ` ${node.textContent ?? ""}`;
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    if (SKIP.has(tag) || el.getAttribute("aria-hidden") === "true" || !visible(el)) return;

    let childQuiet = quiet;
    const role = roleOf(el);
    if (role && INTERACTIVE.has(role)) {
      flushText();
      push(describe(el, role));
      childQuiet = true;
    } else if (/^h[1-6]$/.test(tag)) {
      flushText();
      const heading = clean((el as HTMLElement).innerText ?? "");
      if (heading && !quiet && !options.interactiveOnly) {
        push(`${"#".repeat(Number(tag[1]))} ${clip(heading, 120)}`);
      }
      childQuiet = true;
    } else if (tag === "label" && (el as HTMLLabelElement).control) {
      // The control it labels already reports this text as its name.
      childQuiet = true;
    } else if (tag === "img") {
      const alt = clean(el.getAttribute("alt") ?? "");
      if (alt && !quiet && !options.interactiveOnly) textBuffer += ` [image: ${clip(alt, 80)}]`;
      return;
    } else if (tag === "iframe") {
      flushText();
      push(`[iframe] ${clip(el.getAttribute("src") ?? "", 100)} (contents not included)`);
      return;
    }

    const block = BLOCK.has(tag);
    if (block) flushText();
    let children: Iterable<Node> = el.childNodes;
    if (el instanceof HTMLSlotElement) {
      const assigned = el.assignedNodes({ flatten: true });
      if (assigned.length > 0) children = assigned;
    } else if (el.shadowRoot) {
      children = el.shadowRoot.childNodes;
    }
    for (const child of children) walk(child, childQuiet);
    if (block) flushText();
  };

  walk(root, false);
  flushText();
  if (truncated) {
    lines.push(
      `… snapshot truncated at ${maxChars} characters. Narrow it with tools.page_snapshot({ within: "<css selector>" }) or tools.page_snapshot({ interactiveOnly: true }).`,
    );
  }
  return lines.join("\n");
}

/** Runs inside the page; resolves a ref from the latest snapshot. */
export function resolveRefInPage(id: string): Element | null {
  const refs = (window as unknown as { __relayRefs?: Map<string, Element> }).__relayRefs;
  const element = refs?.get(id);
  return element?.isConnected ? element : null;
}
