# Stemmesystem udviklet til brug i Ungdommens Naturfaglige Forening

## Building

The project uses Deno tasks to configure the various build options

| `deno task {option}` | Description                                                                   |
| :------------------- | :---------------------------------------------------------------------------- |
| dev                  | Uses Vite as a dev server to provide hot-reloading while developing.          |
| build                | Uses Vite to bundle the web app to `./dist`.                                  |
| preview              | Uses Vite to build the project and serve it from `./dist` using a dev server. |
| prod                 | Runs the production server and serves the content in `./dist`.                |
| lint                 | Uses ESLint to lint the project.                                              |

## Editior Configuration

To work on the project the
[Deno CLI](https://docs.deno.com/runtime/getting_started/installation/) tool
will need to be installed, this can be done as shown below.

**Linux/MacOS**

```shell
curl -fsSL https://deno.land/install.sh | sh
```

**Windows**:

```powershell
irm https://deno.land/install.ps1 | iex
```

Offical environment setup documentation can be found at
[Deno - Set up your environment](https://docs.deno.com/runtime/getting_started/setup_your_environment/).

### VS Code Specfic

1. Install the
   [Deno LSP extension](https://marketplace.visualstudio.com/items?itemName=denoland.vscode-deno)
   for VS code.

2. Add the following to `.vscode/settings.json`

```json
{
  "deno.enable": true,
  "deno.lint": true,
  "editor.formatOnSave": true,
  "editor.defaultFormatter": "denoland.vscode-deno",

  // Disable built-in JavaScript and TypeScript validation since Deno provides its own.
  "js/ts.validate.enabled": false
}
```

### Helix Editor

The following config can be used to configure the Deno LSP for Helix.

```toml
[[language]]
name = "typescript"
roots = ["deno.json", "deno.jsonc", "package.json"]
file-types = ["ts", "tsx"]
auto-format = true
language-servers = ["deno-lsp"]

[[language]]
name = "javascript"
roots = ["deno.json", "deno.jsonc", "package.json"]
file-types = ["js", "jsx"]
auto-format = true
language-servers = ["deno-lsp"]

[language-server.deno-lsp]
command = "deno"
args = ["lsp"]
config.deno.enable = true
```
