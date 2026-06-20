# Stemmesystem udviklet til brug i ungdoms foreninger

## Versioning

The program uses [Semantic Versioning](https://semver.org/)

## Building & Contributing

This sections contains the documentation for how to set up a build and
development environment for contributing to the project.

### Install Deno

To work on the project the
[Deno CLI](https://docs.deno.com/runtime/getting_started/installation/) tool
will need to be installed, this can be done as shown below.

The system has been tested on deno 2.7.9.

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

The project can run inside a Docker container for development where source files
are automagically synchronized with the development container on file changes.

The Docker container can run attached with (requires root):

```shell
docker compose up
```

The Docker container can run detached with (requires root):

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
DATABASE_URL="file:./database/database.db"
```

The following optional environment variables can also be set:

```
FREETSA_URL="https://freetsa.org/tsr"
TSA_TIMEOUT_MS="4000"
TSA_SYSTEM_CA_BUNDLE="/etc/ssl/certs/ca-certificates.crt"
VOTE_BUFFER_BATCH_SIZE="5"
VOTE_BUFFER_FLUSH_MS="30000"
```

When a poll is closed it is timestamped via an RFC 3161 Time Stamping Authority.
The server tries a fallback chain of TSAs in order and records which one signed
(on `Poll.closeTsaName`) so verification can pin the matching root: first
freetsa (its root is bundled under `server_certs/`), then DigiCert as a fallback
(verified against the system CA bundle). `FREETSA_URL` overrides the primary
(freetsa) endpoint. `TSA_TIMEOUT_MS` (default `4000`) is how long each TSA may
take before the next one is tried — note that while freetsa is unreachable,
every close waits this long before DigiCert answers. `TSA_SYSTEM_CA_BUNDLE`
overrides the path to the OS trusted-root bundle used for public-CA TSAs, if it
is not at one of the usual locations.

`VOTE_BUFFER_BATCH_SIZE` controls how many received votes are mixed in RAM
before they are flushed to `PendingVote`, and `VOTE_BUFFER_FLUSH_MS` controls
the maximum time in milliseconds before a partial batch is flushed anyway.

It is also important that the timezone of the server running the application is
set accordingly.

Prisma also needs to be initialized locally. This requires Node/npm so `npx` is
available.

Generate the Prisma client and apply the schema to the configured database:

```shell
deno run -A prisma generate
deno run -A prisma db push
```

`prisma generate` updates the generated Prisma client in generated/Prisma, and
`npx prisma db push` applies `./prisma/schema.prisma` to the database from
DATABASE_URL.

If you are testing the system, and have previously tested it with another
database, it can save som headache if you go into browser console at type
localStorage.clear, since else it will associate if you have had the same pollId
before.

## Testing

To run the test, you simply run:

```shell
deno run test
```

you can add --coverage to get a coverage report at the end. IMPORTANT: you must
terminate the server if its running, since the test does require to startup the
server on the same port.

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

#### Deno

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

#### Prisma

1. Install the
   [Prisma extension](https://marketplace.visualstudio.com/items?itemName=Prisma.prisma)

2. Add the following to the local workspace settings file at:
   `.vscode/setting.json`

```json
"[prisma]": {
  "editor.defaultFormatter": "Prisma.prisma"
},
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
