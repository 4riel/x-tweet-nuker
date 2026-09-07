"use strict";
/**
 * A tiny, dependency-free DOM stand-in - just enough to run
 * src/commands/verify.js's `readPage` (which is written to run inside a real browser page)
 * against a scripted "page" instead of launching one.
 *
 * Supports exactly the selector shapes readPage uses: a bare tag name, one or more
 * `[attr="value"]` / `[attr*="value"]` / `[attr^="value"]` clauses, and comma-separated
 * alternatives. No descendant combinators are needed because readPage never uses one.
 */

class FakeElement {
  constructor(tag, attrs = {}, children = [], innerText = "") {
    this.tagName = tag.toUpperCase();
    this.attrs = attrs;
    this.children = children;
    for (const child of children) child.parent = this;
    this._innerText = innerText;
  }

  get innerText() {
    if (this._innerText) return this._innerText;
    return this.children.map((c) => c.innerText).join(" ");
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
  }

  *descendants() {
    for (const child of this.children) {
      yield child;
      yield* child.descendants();
    }
  }

  querySelectorAll(selector) {
    const matchers = parseSelectorList(selector);
    const out = [];
    for (const el of this.descendants()) {
      if (matchers.some((m) => matches(el, m))) out.push(el);
    }
    return out;
  }

  querySelector(selector) {
    const matchers = parseSelectorList(selector);
    for (const el of this.descendants()) {
      if (matchers.some((m) => matches(el, m))) return el;
    }
    return null;
  }
}

function parseSelectorList(selector) {
  return selector.split(",").map((part) => parseSimple(part.trim()));
}

function parseSimple(part) {
  const tagMatch = part.match(/^[a-zA-Z][a-zA-Z0-9]*/);
  const tag = tagMatch ? tagMatch[0].toUpperCase() : null;
  const rest = tag ? part.slice(tag.length) : part;
  const attrs = [];
  const re = /\[([a-zA-Z0-9_-]+)(?:([*^]?)="([^"]*)")?\]/g;
  let m;
  while ((m = re.exec(rest))) {
    attrs.push({ name: m[1], op: m[2] || "", value: m[3] !== undefined ? m[3] : null });
  }
  return { tag, attrs };
}

function matches(el, matcher) {
  if (matcher.tag && el.tagName !== matcher.tag) return false;
  for (const clause of matcher.attrs) {
    const value = el.getAttribute(clause.name);
    if (value === null) return false;
    if (clause.value === null) continue; // bare [attr] presence check
    if (clause.op === "") {
      if (value !== clause.value) return false;
    } else if (clause.op === "*") {
      if (!value.includes(clause.value)) return false;
    } else if (clause.op === "^") {
      if (!value.startsWith(clause.value)) return false;
    }
  }
  return true;
}

/** Build a fake `document` whose only child is `body`, itself containing `children`. */
function makeDocument(children = [], bodyText = "") {
  const body = new FakeElement("body", {}, children, bodyText);
  const root = new FakeElement("html", {}, [body]);
  root.body = body;
  root.querySelector = (sel) => root.querySelector0(sel);
  // Delegate document.querySelector/All to the root element's own implementation.
  root.querySelector = FakeElement.prototype.querySelector.bind(root);
  root.querySelectorAll = FakeElement.prototype.querySelectorAll.bind(root);
  return root;
}

function el(tag, attrs, children, innerText) {
  return new FakeElement(tag, attrs, children, innerText);
}

module.exports = { FakeElement, makeDocument, el };
