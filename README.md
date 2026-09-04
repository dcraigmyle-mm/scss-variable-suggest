# Variable Suggest (SCSS/Less/CSS)

Reads your project's variable/token file(s), then as you type a raw value
(e.g. `15px`) into an SCSS, Less or CSS declaration, suggests the matching
variable (`$global-spacing-xs`, `@spacing-xs`, `var(--spacing-xs)`) in the
normal VS Code IntelliSense list — accept it with **Tab** or **Enter** like
any other completion.

```scss
// _variables.scss
$global-spacing-xs: 15px;
```

```scss
// some-component.scss
.thing {
  margin: 15|   // <- type 15px here, "$global-spacing-xs" shows up in the
                  //    suggestion list; Tab/Enter replaces "15px" with it
}
```

Works even on a partial match — typing `15` will already list any variable
whose value starts with `15`, showing its full value alongside the name so
you can tell which one to pick when several exist.

Mixins and functions (SCSS/Sass only) work the same way, but by **name**
rather than by value — there's no raw literal to reverse-match against a
`@mixin`, so instead it autocompletes the call with the parameter signature
filled in as tab-stops:

```scss
// _mixins.scss
@mixin constrained($width: $global-width-maximum) { ... }
```

```scss
.thing {
  @include cons|   // <- Tab/Enter inserts:
                    //    @include constrained($width: $global-width-maximum);
                    //    with the param pre-selected so you can just type over it
}
```

Functions work the same way inline in a value (e.g. typing `get-col` inside
`color: get-col|` suggests `get-color($palette, $tone: 'base')`).

## Install

This isn't published to the Marketplace, so it installs from a local
`.vsix` build. From this folder:

```bash
npm install
npm run compile
npx vsce package
code --install-extension scss-variable-suggest-0.2.0.vsix
```

Then reload VS Code: **Cmd+Shift+P → "Developer: Reload Window"**.

That covers variables, mixins and functions — no project setup needed for
those, they're matched by filename convention. The **map + function
reverse-lookup** (`font-scale(...)`, `get-color(...)`, etc.) is the one
exception: it requires `variableSuggest.projectMapFunctions` in your User
Settings before it does anything, since the extension can't infer a map's
shape or which function reads it on its own. It's a single global setting —
not scoped to any particular project's folder name — so once it's added it
applies to every project you open; see
[Configuring](#configuring--no-project-files-required) below.

**To verify it worked:** open any `.scss` file that uses `_variables.scss`
values, type a value that exists there (e.g. `15px`), and a matching
`$variable-name` suggestion should appear — accept with Tab or Enter.

**To pick up a later update to this extension** (new source changes, bumped
version, etc.), re-run the same steps — `vsce package` overwrites the
`.vsix`, and `--install-extension ... --force` replaces the installed copy:

```bash
npm run compile
npx vsce package
code --install-extension scss-variable-suggest-0.2.0.vsix --force
```

then reload the window again.

## Supported syntax

- SCSS/Sass: `$name: value;`
- Less: `@name: value;`
- CSS custom properties: `--name: value;` (inserted as `var(--name)`, usable
  from SCSS/Less/CSS files alike)
- SCSS/Sass `@mixin name(...) { }` — suggested after typing `@include `
- SCSS/Sass `@function name(...) { }` — suggested by name inside a value
- SCSS/Sass map + accessor function reverse-lookup — see below

### Map + function reverse-lookup

Some design tokens aren't stored as flat `$name: value;` variables — they're
entries in a (possibly nested) SCSS map, accessed through a function, e.g.:

```scss
// _variables.scss
$colors: (
  brand: (primary: #D72020),
  text: (base: #000)
);
$font-scales: (
  body: (7: 20px)
);
```

```scss
// _functions.scss
@function get-color($palette, $tone: 'base') { ... }
@function font-scale($stack, $index) { ... }
```

Typing `font-size: 20|` suggests `font-scale(body, 7)` (and any other entry
that also equals `20px`, e.g. `font-scale(display, 3)`); typing
`color: #D72|` suggests `get-color(brand, primary)`. This isn't automatic
like the rest, though — the extension can't know your map's shape or which
function reads it, so **it requires config** (see
[Configuring](#configuring--no-project-files-required) below,
`variableSuggest.projectMapFunctions`).

## Configuring — no project files required

Nothing needs to be added to any project repo. There are two layers, both
configurable from your own **User Settings**
(`Cmd+Shift+P` → *Preferences: Open User Settings (JSON)*), never a
project's `.vscode/settings.json`:

**1. Convention-based (zero config).** The default `variableFiles` glob list
already matches common filenames (`_variables.scss`, `variables.less`,
`tokens.css`, etc.) in *any* open project. If a project follows one of these
names, suggestions just work — nothing to set at all.

**2. Exact path per project (still zero footprint).** For a project with a
non-standard filename or location, add an entry to
`variableSuggest.projectVariableFiles` in your User Settings. It's a plain
list of glob patterns, applied to every open workspace folder — no folder
name to match, so once it's set it works for any project whose variable
file lives at that path:

```json
{
  "variableSuggest.projectVariableFiles": [
    "baseplate/source/stylesheets/_variables.scss",
    "src/styles/tokens.scss"
  ]
}
```

This lives entirely on your machine, applies automatically to every open
project, and never touches the project's own files or git history.

**3. Map + function reverse-lookup (opt-in).** Add entries to
`variableSuggest.projectMapFunctions` — also a plain list, applied to every
open project regardless of its folder name:

```json
{
  "variableSuggest.projectMapFunctions": [
    { "variable": "colors", "function": "get-color", "omitTrailingIfEquals": "base" },
    { "variable": "font-scales", "function": "font-scale" },
    { "variable": "font-weight", "function": "font-weight" },
    { "variable": "z-scale", "function": "z-scale" },
    { "variable": "font-stacks", "function": "font-stack" }
  ]
}
```

Each entry says: flatten `$<variable>` (wherever it's defined among the
already-scanned files) and, when a typed value matches one of its leaves,
suggest `<function>(<key path>)`. `omitTrailingIfEquals` drops the last key
when it's the function's default (so `get-color(text)` instead of
`get-color(text, base)`).

Other settings:

| Setting | Default | Description |
| --- | --- | --- |
| `variableSuggest.variableFiles` | common `_variables.scss` / `.less` / tokens filenames | Glob patterns matched against every open project — good for conventional filenames |
| `variableSuggest.projectVariableFiles` | `[]` | `["glob", ...]` — exact paths, applied to every open project, set from User Settings only |
| `variableSuggest.projectMapFunctions` | `[]` | `[{ variable, function, omitTrailingIfEquals? }, ...]` — map reverse-lookup config, applied to every open project, set from User Settings only |
| `variableSuggest.exclude` | `**/{node_modules,vendor,dist,build,_generated}/**` | Glob excluded from the scan |
| `variableSuggest.maxSuggestions` | `25` | Cap on suggestions shown per keystroke |

Run **Variable Suggest: Rescan Variable Files** from the Command Palette
after editing a variable file's *location* (edits to its *contents* are
picked up automatically via a file watcher).

## Developing

For iterating on the source without repackaging each time: `npm run watch`
(recompiles on save), then press **F5** in VS Code with this folder open to
launch an Extension Development Host with the extension loaded live.

## Known limitations (v1)

- Matches single-token values only (e.g. `15px`, `#fff`, `1.5rem`) — not
  compound values like `0 15px 10px`.
- Suggestions only trigger when the cursor is after a `:` on the current
  line (i.e. inside a declaration's value), not in selectors.
- Does not recognise what the style is for, so will show all options, 
  (e.g. can't tell it's a font-size, or margin, so will show both)
