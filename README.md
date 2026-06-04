# always-yes-codex

`always-yes-codex` is a small pseudo-terminal wrapper for Codex CLI. It starts
the real `codex` command and types `yes` for low-risk yes/no prompts, including
ordinary yes/no questions and prompts that accept a proposed implementation
direction.

It is not an auto-approval tool. The default blocklist skips prompts that
mention approval, permission, sandbox escalation, command execution,
install/download, network access, deletion, overwrite, reset, admin rights, and
similar terms.

## Why

Codex sometimes pauses for ordinary workflow questions like "do you want me to
continue with this direction?" This wrapper is for those low-risk prompts. It is
deliberately conservative around permission and command-execution prompts.

## Install

```powershell
npm install
npm link
```

Or run it without linking:

```powershell
npx always-yes-codex
```

## Use

```powershell
always-yes-codex
always-yes-codex --verbose
always-yes-codex --once
always-yes-codex -- model gpt-5-codex
```

Everything after the wrapper options is passed to `codex`.

Use this command instead of `codex` when you want the auto-answer behavior.
For a first real run, prefer:

```powershell
always-yes-codex --verbose
```

The verbose mode prints a short stderr line only when the wrapper actually
answers or deliberately skips a changed prompt.

## Options

```text
--answer <text>       Text to send when a safe prompt is detected. Default: yes
--command <command>   Command to wrap. Default: codex
--delay-ms <ms>       Delay before answering. Default: 250
--cooldown-ms <ms>    Minimum time between answers. Default: 4000
--once                Answer at most once per session
--verbose             Print auto-answer decisions to stderr
--self-test           Run prompt-classification checks
--echo-test           Echo stdin through a wrapped command for input tests
--help                Show help
```

## Uninstall

```powershell
npm unlink -g always-yes-codex
```

## Notes

- This is heuristic automation, not a security boundary.
- Keep using Codex's normal approval controls for commands and permissions.
- Use `--verbose` for the first few sessions to see when the wrapper answers.
