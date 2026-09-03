# Sandbox Paths extension for Pi

A security extension for the [pi coding agent](https://github.com/earendil-works/pi-coding-agent). It stops tools from reaching outside the directory where Pi is started, with opt-in escapes for symlinks and individual paths.

## Quick Start

```bash
pi install https://github.com/eleqtrizit/pi-sandbox
```

Restart Pi or run `/reload`. The sandbox locks automatically on startup: tools that try to reach outside the project root are blocked and reported in the footer status line. To confirm it is active, run `/sandbox-blocked` after an attempt, or `/save-sandbox-config` to persist your sandbox setup.

The sandbox intercepts the built-in path-based tools (read, write, edit, bash, grep, find, ls) through the `tool_call` event and blocks operations whose paths resolve outside the project root. For bash, it inspects `cd` targets and path-like tokens in each command segment. The guard is best effort: bash cannot be sandboxed perfectly at this level, but common escape routes (absolute paths, `../` traversal, `cd` outside the root) are blocked.

## Install

```bash
pi install npm:<package-name>
```

For development, restart Pi with the extension loaded, or place it in `~/.pi/agent/extensions/` or project `.pi/extensions/` for auto-discovery and `/reload`.

```bash
pi -e ./extensions/index.ts
```

## How it works

Every path check resolves symlinks before comparing, so symlinked views of the sandbox directory (Dropbox-style `~/Dropbox` paths, macOS `/var/folders`) match the sandbox root correctly. Non-existing paths resolve through the nearest existing ancestor, which keeps paths for files a tool is about to create from being falsely blocked.

### Always-allowed paths

These paths are allowed from any sandbox:

- `~/.pi` and `~/.agents`
- Device and pseudo-filesystem paths: `/dev/null`, `/dev/zero`, `/dev/stdout`, `/dev/stderr`, `/dev/stdin`, `/dev/tty`, `/dev/random`, `/dev/urandom`, `/dev/full`
- Prefix trees: `/dev/fd`, `/proc/self/fd`, `/tmp`, `/var/folders`

### Sandbox config file

The sandbox config file lives at `./.pi/sandbox.json` in the project root, with a fallback to `./.agents/sandbox.json`. It stores lock state, symlink mode, allowlisted symlink targets, and unlocked paths. It is a trust anchor: only the slash commands may write it. Any tool whose input references the file is blocked.

## Commands

| Command | Description |
|---------|-------------|
| `/unlock-sandbox` | Disable all sandbox checks for this session. Sends "The sandbox has been unlocked." to the agent. |
| `/lock-sandbox` | Re-enable all sandbox checks. |
| `/unlock-sandbox-symlinks` | Allow symlinks inside the sandbox to resolve outside it. Other checks stay active. Scans the sandbox for symlinks and allowlists their resolved targets. |
| `/lock-sandbox-symlinks` | Disable symlink mode and re-tighten the sandbox. |
| `/save-sandbox-config` | Persist the current sandbox state to the config file at `./.pi/sandbox.json` (falls back to `./.agents/sandbox.json`). |
| `/unlock-last-path` | Allow the most recently blocked path, or the nth-to-last (e.g. `/unlock-last-path 2`). Sends the unlocked path to the agent. |
| `/sandbox-blocked` | List the 20 most recently blocked paths with their `/unlock-last-path` index. |

The footer status line always shows the current state: lock state, symlink mode, unlocked path count, and blocked attempt count.

## Source layout

The extension entry point (`extensions/index.ts`) delegates to `src/sandbox/`:

| Module | Responsibility |
|--------|----------------|
| `state.ts` | Mutable sandbox state and the blocked-path history ring buffer |
| `fs-utils.ts` | Realpath, tilde expansion, and prefix comparison helpers |
| `symlinks.ts` | Symlink scanning (fd with a manual-walk fallback) and target refresh |
| `paths.ts` | Allow lists, `checkPath`, `checkPathToken`, `checkBashCommand` |
| `config.ts` | Config load, save, apply, and snapshot |
| `display.ts` | Footer status line and startup banner |
| `index.ts` | Event wiring, `tool_call` interception, and slash commands |

## Development

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest
```

Unit tests cover the path checks (including macOS `/var/folders` symlink resolution), the bash command tokenizer, symlink scanning, and config persistence.
