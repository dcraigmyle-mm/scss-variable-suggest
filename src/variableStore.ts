import * as vscode from "vscode";

export type VariableSyntax = "scss" | "less" | "css";

export interface VariableEntry {
  /** e.g. "$global-spacing-xs", "@spacing-xs", "--spacing-xs" */
  name: string;
  /** the raw token to insert, e.g. "$global-spacing-xs" or "var(--spacing-xs)" */
  insertText: string;
  /** normalized value, e.g. "15px" */
  value: string;
  syntax: VariableSyntax;
  file: vscode.Uri;
}

// At-rule keywords that look like `@name:` but aren't Less variable
// definitions (e.g. `@media`, `@import`). Keeps the Less regex from
// producing false positives.
const LESS_AT_RULE_KEYWORDS = new Set([
  "import",
  "media",
  "mixin",
  "include",
  "function",
  "return",
  "if",
  "else",
  "extend",
  "use",
  "forward",
  "charset",
  "keyframes",
  "supports",
  "page",
  "font-face",
  "namespace",
  "document",
  "warn",
  "error",
  "debug",
  "for",
  "each",
  "while",
  "content",
  "plugin",
  "arguments",
]);

function cleanValue(raw: string): string {
  return raw
    .split("//")[0]
    .replace(/!default/g, "")
    .replace(/!important/g, "")
    .trim()
    .replace(/\s+/g, " ");
}

/** Parses `$name: value;` SCSS/Sass variable declarations. */
function parseScss(text: string, file: vscode.Uri): VariableEntry[] {
  const entries: VariableEntry[] = [];
  const re = /^\s*\$([a-zA-Z0-9_-]+)\s*:\s*([^;]+);/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const value = cleanValue(match[2]);
    if (!value) continue;
    entries.push({
      name: `$${match[1]}`,
      insertText: `$${match[1]}`,
      value,
      syntax: "scss",
      file,
    });
  }
  return entries;
}

/** Parses `@name: value;` Less variable declarations. */
function parseLess(text: string, file: vscode.Uri): VariableEntry[] {
  const entries: VariableEntry[] = [];
  const re = /^\s*@([a-zA-Z0-9_-]+)\s*:\s*([^;]+);/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const name = match[1];
    if (LESS_AT_RULE_KEYWORDS.has(name.toLowerCase())) continue;
    const value = cleanValue(match[2]);
    if (!value) continue;
    entries.push({
      name: `@${name}`,
      insertText: `@${name}`,
      value,
      syntax: "less",
      file,
    });
  }
  return entries;
}

/** Parses `--name: value;` CSS custom properties. */
function parseCssCustomProps(text: string, file: vscode.Uri): VariableEntry[] {
  const entries: VariableEntry[] = [];
  const re = /--([a-zA-Z0-9_-]+)\s*:\s*([^;]+);/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const value = cleanValue(match[2]);
    if (!value) continue;
    entries.push({
      name: `--${match[1]}`,
      insertText: `var(--${match[1]})`,
      value,
      syntax: "css",
      file,
    });
  }
  return entries;
}

export interface MapFunctionConfig {
  /** SCSS map variable name, without the `$` (e.g. "colors"). */
  variable: string;
  /** Function to call, e.g. "get-color". */
  function: string;
  /** Drop the leaf's final path segment from the call when it equals this (matches a default param). */
  omitTrailingIfEquals?: string;
}

interface MapLeaf {
  /** key path down to this leaf, e.g. ["brand", "primary"] */
  path: string[];
  /** the leaf's raw value text, e.g. "#D72020" */
  rawValue: string;
}

/** Strips one layer of matching quotes off a trimmed string, if present. */
function stripQuotes(s: string): string {
  const trimmed = s.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === "'" || first === '"') && first === last) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

/**
 * Splits `key: value` on the first top-level colon (not one nested inside
 * parens/quotes, e.g. inside a further-nested map). Returns null if there
 * is no top-level colon (a malformed or non key/value entry).
 */
function splitFirstTopLevelColon(segment: string): [string, string] | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === ":" && depth === 0) {
      return [segment.slice(0, i), segment.slice(i + 1)];
    }
  }
  return null;
}

/**
 * Recursively flattens the inner content of a (possibly nested) SCSS map
 * literal — e.g. the text between the outer `(` `)` of
 * `$colors: ( brand: ( primary: #D72020 ) )` — into leaf key-path/value pairs.
 */
function flattenMap(raw: string, pathPrefix: string[]): MapLeaf[] {
  const leaves: MapLeaf[] = [];
  for (const rawEntry of splitTopLevelParams(raw)) {
    const split = splitFirstTopLevelColon(rawEntry);
    if (!split) continue; // not a key: value entry (e.g. a plain list item) — skip

    const key = stripQuotes(split[0]);
    const valueText = split[1].trim();
    const path = [...pathPrefix, key];

    if (valueText.startsWith("(")) {
      const closeIndex = findMatchingParen(valueText, 0);
      if (closeIndex !== -1) {
        leaves.push(...flattenMap(valueText.slice(1, closeIndex), path));
        continue;
      }
    }

    const rawValue = cleanValue(valueText);
    if (rawValue) leaves.push({ path, rawValue });
  }
  return leaves;
}

/**
 * A leaf's raw value can be a quoted string standing in for a compound CSS
 * value, e.g. font-stacks store `'"aktiv-grotesk", sans-serif'`. Unwrap the
 * quoting and, for a comma-separated list, take the first segment — that's
 * what a developer would actually type (the primary font name).
 */
function unwrapMapValueForMatch(rawValue: string): string {
  let value = rawValue;
  const isFullyQuoted =
    value.length >= 2 &&
    (value[0] === "'" || value[0] === '"') &&
    value[value.length - 1] === value[0];
  if (isFullyQuoted) value = value.slice(1, -1).trim();

  if (value.includes(",")) value = value.split(",")[0].trim();
  return stripQuotes(value);
}

/**
 * Scans `text` for `$<variable>: ( ... );` for each configured map, flattens
 * it, and produces a reverse-lookup entry per leaf: typing that leaf's raw
 * value suggests calling `<function>(<key path>)`.
 */
function parseMapFunctionEntries(
  text: string,
  file: vscode.Uri,
  configs: MapFunctionConfig[]
): VariableEntry[] {
  const entries: VariableEntry[] = [];

  for (const config of configs) {
    const escapedVar = config.variable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\$${escapedVar}\\s*:\\s*`, "g");
    let match: RegExpExecArray | null;
    while ((match = re.exec(text))) {
      let cursor = re.lastIndex;
      while (cursor < text.length && /\s/.test(text[cursor])) cursor++;
      if (text[cursor] !== "(") continue;

      const closeIndex = findMatchingParen(text, cursor);
      if (closeIndex === -1) continue;

      const leaves = flattenMap(text.slice(cursor + 1, closeIndex), []);
      for (const leaf of leaves) {
        const value = unwrapMapValueForMatch(leaf.rawValue);
        if (!value) continue;

        let args = leaf.path;
        if (
          config.omitTrailingIfEquals !== undefined &&
          args.length > 1 &&
          args[args.length - 1] === config.omitTrailingIfEquals
        ) {
          args = args.slice(0, -1);
        }

        const insertText = `${config.function}(${args.join(", ")})`;
        entries.push({ name: insertText, insertText, value, syntax: "scss", file });
      }
    }
  }

  return entries;
}

export type CallableKind = "mixin" | "function";

export interface CallableEntry {
  /** e.g. "constrained" */
  name: string;
  kind: CallableKind;
  /** raw parameter text, e.g. ["$width: $global-width-maximum"] */
  params: string[];
  file: vscode.Uri;
}

/**
 * Given `text[openParenIndex] === "("`, scans forward tracking paren depth
 * (and skipping over quoted strings, so a `)` inside `'...'` doesn't count)
 * to find the index of the matching `)`. Returns -1 if unbalanced.
 */
function findMatchingParen(text: string, openParenIndex: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = openParenIndex; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") i++; // skip escaped char inside the string
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === "(") {
      depth++;
    } else if (ch === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Splits a parameter list on top-level commas only (not ones nested inside parens/quotes). */
function splitTopLevelParams(raw: string): string[] {
  const params: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = "";
  for (const ch of raw) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
    } else if (ch === "(") {
      depth++;
      current += ch;
    } else if (ch === ")") {
      depth--;
      current += ch;
    } else if (ch === "," && depth === 0) {
      params.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) params.push(current.trim());
  return params;
}

/** Parses `@mixin name(...) {` and `@function name(...) {` definitions. */
function parseCallables(text: string, file: vscode.Uri): CallableEntry[] {
  const entries: CallableEntry[] = [];
  const re = /@(mixin|function)\s+([a-zA-Z0-9_-]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const kind = match[1] as CallableKind;
    const name = match[2];

    let cursor = re.lastIndex;
    while (cursor < text.length && /\s/.test(text[cursor])) cursor++;

    let params: string[] = [];
    if (text[cursor] === "(") {
      const closeIndex = findMatchingParen(text, cursor);
      if (closeIndex !== -1) {
        const raw = text.slice(cursor + 1, closeIndex);
        params = raw.trim() ? splitTopLevelParams(raw) : [];
      }
    }

    entries.push({ name, kind, params, file });
  }
  return entries;
}

export class VariableStore {
  /** value -> matching entries (a value can map to more than one variable) */
  private byValue = new Map<string, VariableEntry[]>();
  /** file uri string -> entries defined in that file, so we can remove stale entries on re-parse */
  private byFile = new Map<string, VariableEntry[]>();
  /** file uri string -> mixins/functions defined in that file */
  private callablesByFile = new Map<string, CallableEntry[]>();

  parseDocumentText(file: vscode.Uri, text: string, mapFunctions: MapFunctionConfig[] = []): void {
    const entries = [
      ...parseScss(text, file),
      ...parseLess(text, file),
      ...parseCssCustomProps(text, file),
      ...parseMapFunctionEntries(text, file, mapFunctions),
    ];
    this.setEntriesForFile(file, entries);
    this.callablesByFile.set(file.toString(), parseCallables(text, file));
  }

  removeFile(file: vscode.Uri): void {
    this.setEntriesForFile(file, []);
    this.callablesByFile.delete(file.toString());
  }

  private setEntriesForFile(file: vscode.Uri, entries: VariableEntry[]): void {
    const key = file.toString();
    const previous = this.byFile.get(key) ?? [];
    for (const entry of previous) {
      const bucket = this.byValue.get(entry.value);
      if (!bucket) continue;
      const filtered = bucket.filter((e) => e !== entry);
      if (filtered.length) {
        this.byValue.set(entry.value, filtered);
      } else {
        this.byValue.delete(entry.value);
      }
    }

    this.byFile.set(key, entries);
    for (const entry of entries) {
      const bucket = this.byValue.get(entry.value) ?? [];
      bucket.push(entry);
      this.byValue.set(entry.value, bucket);
    }
  }

  get size(): number {
    let total = 0;
    for (const bucket of this.byValue.values()) total += bucket.length;
    for (const bucket of this.callablesByFile.values()) total += bucket.length;
    return total;
  }

  /** Every known variable value, longest first (helps prefix matching prefer specific values). */
  values(): string[] {
    return [...this.byValue.keys()];
  }

  get(value: string): VariableEntry[] {
    return this.byValue.get(value) ?? [];
  }

  /** All known mixins and functions, across every scanned file. */
  callables(kind?: CallableKind): CallableEntry[] {
    const all: CallableEntry[] = [];
    for (const bucket of this.callablesByFile.values()) {
      for (const entry of bucket) {
        if (!kind || entry.kind === kind) all.push(entry);
      }
    }
    return all;
  }
}
