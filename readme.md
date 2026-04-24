# Stemmesystem udviklet til brug i Ungdommens Naturfaglige Forening

## Versioning

The program uses [Semantic Versioning](https://semver.org/)

## Building & Contributing

This sections contains the documentation for how to set up a build and
development environment for contributing to the project.

### Install Deno

To work on the project the
[Deno CLI](https://docs.deno.com/runtime/getting_started/installation/) tool
will need to be installed, this can be done as shown below.

**Linux/macOS:**

```shell
curl -fsSL https://deno.land/install.sh | sh
```

**Windows:**

```powershell
irm https://deno.land/install.ps1 | iex
```

Official environment setup documentation can be found at
[Deno - Set up your environment](https://docs.deno.com/runtime/getting_started/setup_your_environment/).

### Development Using Docker

The project can run inside a Docker container for development where source files are automagically synchronized with the development container on file changes.

The Docker container can be run with (requires root):
```shell
docker compose watch
```

To connect to the container to view logs use (requires root):
```shell
docker attach CONTAINER
```

### Initialize the Project with Deno - Local Development

To download necessary build and dev dependencies run:

```shell
deno install
```

The program require certain environment variables set for the program in a file
named `.env`, an example is shown below:

```
JWT_SERVER_SECRET="secret-that-only-server-knows-and-no-one-else!"
ADMIN_USER_PASSWORD="test"
```

### Deno Tasks

The project uses Deno tasks to configure the various build options

| `deno task {option}` | Description                                                                   |
| :------------------- | :---------------------------------------------------------------------------- |
| dev                  | Uses Vite as a dev server to provide hot-reloading while developing.          |
| build                | Uses Vite to bundle the web app to `./dist`.                                  |
| preview              | Uses Vite to build the project and serve it from `./dist` using a dev server. |
| prod                 | Runs the production server and serves the content in `./dist`.                |
| lint                 | Uses ESLint to lint the project.                                              |

## Editor Configuration

Most editors require Deno CLI to be installed as mentioned above in section
[Building & Contributing](#building--contributing)

### VS Code

1. Install the
   [Deno LSP extension](https://marketplace.visualstudio.com/items?itemName=denoland.vscode-deno)
   for VS Code.

2. Add the following to the local workspace settings file at:
   `.vscode/settings.json`

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
