import * as vscode from "vscode";
import { CallableEntry, MapFunctionConfig, VariableStore, VariableSyntax } from "./variableStore";

const store = new VariableStore();
let fileWatchers: vscode.FileSystemWatcher[] = [];

function getConfig() {
  const cfg = vscode.workspace.getConfiguration("variableSuggest");
  return {
    variableFiles: cfg.get<string[]>("variableFiles", []),
    projectVariableFiles: cfg.get<string[]>("projectVariableFiles", []),
    projectMapFunctions: cfg.get<MapFunctionConfig[]>("projectMapFunctions", []),
    exclude: cfg.get<string>("exclude", ""),
    maxSuggestions: cfg.get<number>("maxSuggestions", 25),
  };
}

/**
 * All glob patterns to scan/watch, expressed as ready-to-use GlobPatterns.
 * Both `variableFiles` and `projectVariableFiles` apply to every open
 * workspace folder, so a single User Settings entry works for any project
 * without needing to match its folder name. `projectVariableFiles` entries
 * are still scoped per-folder via RelativePattern (rather than joined into
 * plain strings) so a relative path resolves against each root correctly.
 */
function collectPatterns(): vscode.GlobPattern[] {
  const { variableFiles, projectVariableFiles } = getConfig();
  const patterns: vscode.GlobPattern[] = [...variableFiles];

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    for (const pattern of projectVariableFiles) {
      patterns.push(new vscode.RelativePattern(folder, pattern));
    }
  }

  return patterns;
}

const decoder = new TextDecoder("utf-8");

async function parseFile(uri: vscode.Uri): Promise<void> {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const { projectMapFunctions } = getConfig();
    store.parseDocumentText(uri, decoder.decode(bytes), projectMapFunctions);
  } catch {
    // File may have been deleted between the watcher event and the read.
    store.removeFile(uri);
  }
}

async function rescanAll(): Promise<void> {
  const { exclude } = getConfig();
  for (const pattern of collectPatterns()) {
    const uris = await vscode.workspace.findFiles(pattern, exclude || undefined);
    await Promise.all(uris.map(parseFile));
  }
}

function setupWatchers(context: vscode.ExtensionContext): void {
  fileWatchers.forEach((w) => w.dispose());
  fileWatchers = [];

  for (const pattern of collectPatterns()) {
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    watcher.onDidChange(parseFile);
    watcher.onDidCreate(parseFile);
    watcher.onDidDelete((uri) => store.removeFile(uri));
    fileWatchers.push(watcher);
    context.subscriptions.push(watcher);
  }
}

/** Which variable syntaxes make sense to suggest into a given document language. */
function allowedSyntaxes(languageId: string): VariableSyntax[] {
  switch (languageId) {
    case "scss":
    case "sass":
      return ["scss", "css"];
    case "less":
      return ["less", "css"];
    case "css":
      return ["css"];
    default:
      // vue/svelte SFCs, etc. — best effort, allow everything.
      return ["scss", "less", "css"];
  }
}

const VALUE_TOKEN_RE = /[#a-zA-Z0-9_.%-]+/;

/** True for scss/sass, where `@mixin`/`@function` (and `@include`) exist at all. */
function supportsCallables(languageId: string): boolean {
  return languageId === "scss" || languageId === "sass";
}

function buildCallableItem(
  entry: CallableEntry,
  typedLower: string,
  range: vscode.Range,
  opts: { appendSemicolon: boolean }
): vscode.CompletionItem {
  const signature = `${entry.name}(${entry.params.join(", ")})`;
  const item = new vscode.CompletionItem(
    signature,
    entry.kind === "mixin" ? vscode.CompletionItemKind.Method : vscode.CompletionItemKind.Function
  );

  const snippet = new vscode.SnippetString().appendText(entry.name);
  if (entry.params.length) {
    snippet.appendText("(");
    entry.params.forEach((param, i) => {
      if (i > 0) snippet.appendText(", ");
      snippet.appendPlaceholder(param);
    });
    snippet.appendText(")");
  }
  if (opts.appendSemicolon) snippet.appendText(";");
  item.insertText = snippet;

  item.range = range;
  item.detail = entry.params.length ? `${entry.kind}: ${entry.params.join(", ")}` : entry.kind;
  item.documentation = new vscode.MarkdownString(
    `Defined in \`${vscode.workspace.asRelativePath(entry.file)}\``
  );
  // filterText must start with what the user typed even though the label
  // (which includes the full signature) doesn't literally start with it.
  item.filterText = entry.name;
  const exact = entry.name.toLowerCase() === typedLower;
  item.sortText = `${exact ? "0" : "1"}${String(entry.name.length).padStart(4, "0")}${entry.name}`;
  item.preselect = exact;
  return item;
}

class VariableCompletionProvider implements vscode.CompletionItemProvider {
  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.CompletionList | undefined {
    const wordRange = document.getWordRangeAtPosition(position, VALUE_TOKEN_RE);
    if (!wordRange) return undefined;

    const typed = document.getText(wordRange);
    if (!typed) return undefined;
    const typedLower = typed.toLowerCase();

    const linePrefix = document.lineAt(position).text.slice(0, wordRange.start.character);
    const { maxSuggestions } = getConfig();
    const items: vscode.CompletionItem[] = [];

    // `@include name` — mixin names only, inserted as `name(args...);`
    if (supportsCallables(document.languageId) && /@include\s+$/.test(linePrefix)) {
      const mixins = store
        .callables("mixin")
        .filter((m) => m.name.toLowerCase().startsWith(typedLower));
      for (const mixin of mixins) {
        if (items.length >= maxSuggestions) break;
        items.push(buildCallableItem(mixin, typedLower, wordRange, { appendSemicolon: true }));
      }
      return new vscode.CompletionList(items, false);
    }

    // Otherwise, only suggest inside a declaration value, i.e. somewhere
    // after a `:` on the current line (keeps this out of selectors).
    if (!linePrefix.includes(":")) return undefined;

    const allowed = new Set(allowedSyntaxes(document.languageId));

    const matchingValues = store
      .values()
      .filter((v) => v.toLowerCase().startsWith(typedLower))
      .sort((a, b) => a.length - b.length);

    for (const value of matchingValues) {
      for (const entry of store.get(value)) {
        if (!allowed.has(entry.syntax)) continue;
        if (items.length >= maxSuggestions) break;

        const item = new vscode.CompletionItem(entry.insertText, vscode.CompletionItemKind.Variable);
        item.insertText = entry.insertText;
        item.range = wordRange;
        item.detail = value;
        item.documentation = new vscode.MarkdownString(
          `Defined in \`${vscode.workspace.asRelativePath(entry.file)}\``
        );
        // filterText must start with what the user typed (VS Code filters
        // the list against it) even though the label doesn't look like it.
        item.filterText = value;
        const exact = value.toLowerCase() === typedLower;
        item.sortText = `${exact ? "0" : "1"}${String(value.length).padStart(4, "0")}${value}`;
        item.preselect = exact;
        items.push(item);
      }
    }

    // Function calls used inline in a value, e.g. `get-color('brand')` —
    // matched by name prefix (there's no literal output to reverse-match).
    if (supportsCallables(document.languageId)) {
      const functions = store
        .callables("function")
        .filter((f) => f.name.toLowerCase().startsWith(typedLower));
      for (const fn of functions) {
        if (items.length >= maxSuggestions) break;
        items.push(buildCallableItem(fn, typedLower, wordRange, { appendSemicolon: false }));
      }
    }

    return new vscode.CompletionList(items, false);
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  setupWatchers(context);
  await rescanAll();

  const provider = new VariableCompletionProvider();
  const selector: vscode.DocumentSelector = ["scss", "sass", "less", "css", "vue"];
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(selector, provider)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("variableSuggest.rescan", async () => {
      await rescanAll();
      vscode.window.setStatusBarMessage(
        `Variable Suggest: rescanned, ${store.size} variable(s) loaded`,
        3000
      );
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("variableSuggest")) {
        setupWatchers(context);
        void rescanAll();
      }
    })
  );
}

export function deactivate(): void {
  fileWatchers.forEach((w) => w.dispose());
  fileWatchers = [];
}
