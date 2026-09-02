# OMP (oh-my-pi) trial — quickstart

Goal: exercise OMP's subagent control surface (Agent Hub) under failure, and
record behaviour side-by-side with OMO-slim's `feat/subagent-control`.

Installed: `omp` 18.1.2 at `~/.bun/bin/omp` (bun global; `omp update` to bump).
AFT plugin: `@cortexkit/aft-pi` 0.55.0 (`omp plugin list`).
State dir: `~/.omp/` (sessions/auth in `~/.omp/agent/`, plugins in `~/.omp/plugins/`).

## 0. One-time auth (not done yet)

Inside a session: `/login anthropic` (OAuth) — or export `ANTHROPIC_API_KEY`.
OpenAI: `OPENAI_API_KEY`, or `/login openai-codex` for a ChatGPT/Codex plan.
Google: `GEMINI_API_KEY`, or `/login google-gemini-cli`.
Headless alternative: `omp auth-broker login <provider>`.
Credentials land in `~/.omp/agent/agent.db`. Nothing is inherited from
`~/.claude`, `~/.codex`, or `~/.gemini`.

## 1. Start OMP in a worktree

OMP refuses to start in `~` (auto-switches to a temp dir), so always start
inside a repo checkout. Use a dedicated worktree so torture tests cannot
dirty the main checkout:

```sh
cd ~/Projects/<repo>
git worktree add ../<repo>-omp-trial -b omp-trial
cd ../<repo>-omp-trial
omp                          # or: omp --cwd ../<repo>-omp-trial
```

Useful flags: `--profile omp-trial` (isolated auth/sessions/settings),
`--no-session` (ephemeral), `--approval-mode write`.
Agent-managed worktrees (created by the `task` tool) live in `~/.omp/wt`;
inspect/clear with `omp worktree`.

## 2. Open the Agent Hub

`Alt+A` (also `Ctrl+S`, or double-tap `←` from an empty editor once a
subagent exists). Remap in `~/.omp/agent/keybindings.yml`.

Keys: `j`/`k` or `↑`/`↓` select · `Enter` focus that agent's session ·
`t` flat/tree · `Tab` inspector (narrow terminals) · `r` revive a parked
agent · `x` abort+kill selected agent · `Esc` close inspector, then Hub.
From a focused subagent, `Esc` on an empty editor returns to the parent
without interrupting the subagent.

Fan out first, e.g.:

> Use the task tool to launch 3 subagents in parallel: (a) list every TODO
> in src/, (b) summarise the test layout, (c) count exported symbols. Do not
> start any until all three are ready to launch together.

## 3. The four torture tests

Run each from a fresh fan-out. Hub open (`Alt+A`) so state changes are visible.

1. **Wi-Fi off mid fan-out** — toggle Wi-Fi off ~5 s after the subagents
   start streaming; wait 30 s; turn it back on.
   Watch: per-agent status (`running`/`parked`/`aborted`), the inspector's
   retry state, whether the parent turn survives, whether agents resume or
   need `r` (revive), and what the parent is told.
2. **ESC at the parent** — with subagents running, press `Esc` in the main
   (parent) session.
   Watch: does it abort only the parent turn, cascade to children, or
   nothing? What do the children show in the Hub afterwards; are their
   results still delivered?
3. **`x`-kill one agent** — in the Hub select one running agent, press `x`.
   Watch: is it immediate; does the parent get a clear "killed" result or a
   hang; do siblings continue; can the parent re-launch it.
4. **Type to a running subagent** — `Enter` on a running agent, type a
   steering message ("stop and report what you have so far"), `Enter`.
   Watch: is it injected mid-turn or queued to the next turn; is it visible
   in that agent's session history; does the parent see any of it.

## 4. What to record (per test)

- Exact keystrokes + timing, and a screenshot/`omp --export` of the session
  (`omp --export ~/.omp/agent/sessions/<path>/session.jsonl`).
- Hub status column before/during/after; inspector retry state if shown.
- What the *parent* model was told (tool result text) — verbatim.
- Recovery: automatic / needs `r` / needs re-launch / stuck.
- Wall time to recover; tokens+cost from the Hub header.
- Log tail: `~/.omp/logs/omp.<date>.<pid>.log`.
- Any crash, orphaned process (`omp ps`), or leftover worktree (`omp worktree`).

Compare against the same four scenarios on OMO-slim `feat/subagent-control`
(hub_status / hub_peek / hub_steer / hub_kill): parity, gaps, and which UX
decisions are worth borrowing.

## Cleanup

`git worktree remove ../<repo>-omp-trial`; `omp worktree` to clear
agent-managed worktrees; `omp plugin uninstall @cortexkit/aft-pi` and
`rm -rf ~/.omp` to remove OMP state entirely; `bun remove -g @oh-my-pi/pi-coding-agent`.
