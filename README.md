# Sandbox Paths extension for Pi

A security extension for the [pi coding agent](https://github.com/earendil-works/pi-coding-agent). It stops tools from reaching outside the directory where Pi is started, with opt-in escapes for symlinks and individual paths.

Bash commands run inside an OS-level sandbox, so the kernel enforces the rules: paths built at runtime (shell variables, globs, nested shells, interpreters, scripts) are confined exactly like literal paths. All programs stay runnable; only file access is filtered.

## Quick Start

```bash
pi install https://github.com/eleqtrizit/pi-sandbox
```

Restart Pi or run `/reload`. The sandbox locks automatically on startup: commands and tools that reach outside the project root fail with an OS permission error and in-process tools are blocked with a clear reason. To confirm it is active, run `/sandbox-blocked` after an attempt, or `/sandbox-save-config` to persist your sandbox setup.

## Install

```bash
pi install npm:<package-name>
```

For development, restart Pi with the extension loaded, or place it in `~/.pi/agent/extensions/` or project `.pi/extensions/` for auto-discovery and `/reload`.

```bash
pi -e ./extensions/index.ts
```

## How it works

### Bash: OS-level confinement

The extension replaces the built-in bash tool and wraps every command:

- **macOS:** `sandbox-exec` with a generated launchd Seatbelt profile. The profile is `(allow default)` plus a deny on file access under the home directory, re-allowing the sandbox directory, symlink targets, unlocked paths, and the pi config roots. Programs and the network stay unrestricted, so CLIs behave normally; only file access outside the allow list fails.
- **Linux:** bubblewrap (`/usr/bin/bwrap`) with the argument vector built by `buildBwrapArgs()` in `src/sandbox/os-sandbox.ts`. The host root stays bind-mounted read-write, a tmpfs covers `$HOME` so the real home is invisible, and the allowed roots are bound back in. PIDs are unshared with a fresh `/proc`, which blocks the `/proc/<pid>/root` route into the real home. Availability is decided by `probeBwrap()`, which runs a real bwrap command once instead of checking that the binary exists — Ubuntu 24.04+ AppArmor can restrict unprivileged user namespaces. When the probe fails, the extension falls back to Landlock through `src/sandbox/landlock.py` (needs `/usr/bin/python3` and a kernel with Landlock, 5.13+). Landlock needs no user namespaces, so AppArmor does not block it; it allows every path outside `$HOME` plus the same allowed roots, and blocked paths report "permission denied". Only when both fail do bash calls block with both reasons; `/sandbox-unlock` disables confinement for the session. A blocked path surfaces as "not found" rather than "permission denied", so test assertions should check for failure, not a specific error.

Because the kernel resolves every path at open time, runtime-built paths cannot bypass the rules. A red-team probe with variable paths, globs, `eval`, `sh -c`, process substitution, Python/Node/Perl one-liners, and arena-written scripts was fully confined.

### In-process tools

The `read`, `write`, `edit`, `grep`, `find`, and `ls` tools run inside pi's own process, outside any command sandbox, so they are checked by a realpath containment test: a path resolves through symlinks and then must fall inside the sandbox directory or an allow list. `~/.gitconfig` and the paths below stay readable.

### Always-allowed paths

These paths are allowed from any sandbox, in both layers:

- `~/.pi` and `~/.agents`
- Device and pseudo-filesystem paths: `/dev/null`, `/dev/zero`, `/dev/stdout`, `/dev/stderr`, `/dev/stdin`, `/dev/tty`, `/dev/random`, `/dev/urandom`, `/dev/full`
- Prefix trees: `/dev/fd`, `/proc/self/fd`, `/tmp`, `/var/folders`
- Read-only toolchain and config paths under `$HOME`, so normal CLIs keep working: `~/.gitconfig`, `~/.config/git`, `~/.ssh`, `~/.volta`, `~/.local/bin`, `~/.local/share/uv`, `~/.cargo/bin`. `~/.ssh` is read-only because ssh remotes need the keys and `known_hosts`. Secrets like `~/.gnupg` and `~/.aws` are deliberately not listed.
- Read-write cache paths under `$HOME` so package managers keep working: `~/.cache`, `~/.npm`.

### Symlinks inside the sandbox

Symlinks that exist when the session starts (for example `./common -> ../common`) are scanned with `fd` (manual-walk fallback) and their realpath targets are allowlisted in both layers, so shared directories reachable through links keep working. Symlinks created during the session are not allowlisted: an earlier implementation re-scanned targets on every command, and a red-team probe demonstrated the bypass (fixed in commit 159e4df). With re-scanning, an agent could allowlist any path it can name by creating a link to it. Run `/sandbox-save-config` to rescan deliberately.

### Sandbox config file

The sandbox config file lives at `./.pi/` + the config basename in the project root, with a fallback to `./.agents/`. It stores lock state, allowlisted symlink targets, and unlocked paths. It is a trust anchor: only the slash commands may write it. Any tool whose input references the file is blocked.

A global config with the same basename lives in `~/.pi/agent/`. It stores only `unlockedPaths`, written by `/sandbox-unlock-last-path-globally`. At session start its paths are merged with the project config, and a project snapshot (`/sandbox-save-config`) never copies them. An unreadable global file is reported and never overwritten.

## Commands

| Command | Description |
|---------|-------------|
| `/sandbox-unlock` | Disable all sandbox checks for this session. Sends "The sandbox has been unlocked." to the agent. |
| `/sandbox-lock` | Re-enable all sandbox checks. |
| `/sandbox-save-config` | Persist the current sandbox state to the config file. |
| `/sandbox-unlock-last-path` | Unlock the directory of the most recently blocked path, or the nth-to-last (e.g. `/sandbox-unlock-last-path 2`). Blocked files unlock their parent directory. Bash denials are read back from the command's error output (lines such as "Operation not permitted" that name a path under `$HOME`). Sends the unlocked directory to the agent. |
| `/sandbox-unlock-last-path-globally` | Like `/sandbox-unlock-last-path`, but saves the directory to the global config in `~/.pi/agent/` at once, reloads it, and applies it to every project. |
| `/sandbox-blocked` | List the 20 most recently blocked paths with their `/sandbox-unlock-last-path` index. |
| `/sandbox-paths` | Browse the last blocked paths from `~/.pi/agent/sandbox-blocked.jsonl` (newest 20 first, arrow keys to page through up to 100) and unblock one locally or globally. Unlocking removes the path from the journal. |

The footer status line always shows the current state: lock state, symlink target count, unlocked path count, blocked attempt count, and the most recently blocked path.

## Source layout

The extension entry point (`extensions/index.ts`) delegates to `src/sandbox/`:

| Module | Responsibility |
|--------|----------------|
| `state.ts` | Mutable sandbox state and the blocked-path history ring buffer |
| `registry.ts` | `registerAllowedPath()` and the `pi-sandbox:allow-path` event channel: let other extensions allow extra directories |
| `fs-utils.ts` | Realpath, tilde expansion, and prefix comparison helpers |
| `symlinks.ts` | Symlink scanning (fd with a manual-walk fallback) for allowlisted targets |
| `os-sandbox.ts` | Seatbelt profile generation, `sandbox-exec` wrapping, bubblewrap argument generation with an AppArmor-aware availability probe |
| `allowlist.ts` | The single list of default allowed paths, shared by both layers and the banner |
| `paths.ts` | Allow lists and `checkPath` for the in-process tools |
| `config.ts` | Project config load, save, apply, and snapshot; global config load, add, and reload |
| `denials.ts` | Extracts denied `$HOME` paths from bash error output |
| `journal.ts` | Append-only JSONL journal of blocked paths at `~/.pi/agent/sandbox-blocked.jsonl`, with dedupe on read and periodic compaction |
| `display.ts` | Footer status line and startup banner |
| `index.ts` | The sandboxed bash tool, `tool_call` interception, and slash commands |

## Allowing extra directories from other extensions

Another extension in the same process can allow additional directories inside the sandbox. Two transports exist: import this package, or emit an event on pi's shared event bus when a dependency is not an option.

### Import the registry

Add this package as a dependency, import the named export from the package entry point, and call it from the extension factory or a `session_start` hook:

```ts
import { registerAllowedPath } from "pi-sandbox";

export default function (pi: ExtensionAPI): void {
	registerAllowedPath("~/shared-dir");
}
```

Load order does not matter, and this works even though pi loads every extension through jiti with `moduleCache: false` (each extension gets its own copy of the module): the registry `Set` is stored on `globalThis` under a `Symbol.for` key, so all copies share one registry.

### Emit an allow-path event

Extensions that cannot add a dependency can emit a `pi-sandbox:allow-path` event on `pi.events` instead. Emit from a `session_start` handler: extension factories run in an unspecified order, so an emit straight from a factory can fire before this extension subscribes.

```ts
export default function (pi: ExtensionAPI): void {
	pi.on("session_start", () => {
		pi.events.emit("pi-sandbox:allow-path", { path: "~/shared-dir" });
	});
}
```

Contract for both transports:

- The path must be absolute or tilde. Relative paths are rejected.
- Both enforcement layers read the registry lazily on every operation (`checkPath` per tool call, the OS profile per bash spawn), so a registered path takes effect from the next call onward.
- Registrations are read-write, cover the whole subtree, and are session-local. They are never written to the sandbox config file; extensions re-register on every load.
- A malformed payload is dropped, and pi-sandbox shows a UI warning with the rejection reason.
- Security: any in-process extension can expand the sandbox by emitting or calling. The event carries the same trust level as the import API; there is no extra gate.
- The agent has no tool access to this API.

## Development

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest
```

Unit tests cover the path checks (including macOS `/var/folders` symlink resolution), profile and bwrap argument generation, and config persistence. On macOS with `sandbox-exec` available, and on Linux when the bubblewrap probe passes, the suite also runs live enforcement tests: a file outside the sandbox stays unreadable through literal paths, variable paths, globs, nested shells, and interpreters (plus the `/proc/1/root` route on Linux), while files inside stay readable and writable and CLIs like `node` still run.

## Notes and limits

- The Seatbelt launcher (`sandbox-exec`) is deprecated by Apple but remains functional and is used by widely deployed tools.
- The OS layer confines file access only. It does not restrict the network or which programs run, matching the extension's file-containment goal.
- Interactive shell commands typed with `!` (user_bash) are not wrapped.
- On Linux, non-allowlisted programs see an empty but writable `$HOME` (the tmpfs), so most CLIs run normally; their home config files are just absent. Blocked paths inside the sandbox report "not found", not "permission denied".
- shortcut: on Linux a session whose working directory is itself a symlink will fail to spawn bash inside the namespace; pi normally starts in a real directory, fix if that changes.
- A session started while bwrap is unavailable (probe failure) keeps bash blocked even after bwrap is installed; reload or restart pi to re-probe.
