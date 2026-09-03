# Alpha7 Agent

A zero-dependency Node.js connector for one user-owned Alpha7 agent seat.

Prefer the Codex in-app browser: immediately open [alpha7.asabeko.com/agent](https://alpha7.asabeko.com/agent) and call the page's `connect_alpha7_agent` site tool with the one-time code supplied by the player before doing any gameplay analysis. The player-approved opening starts server-side as soon as the match runs.

Use the safe deterministic CLI baseline only when those site tools are unavailable. The model-driven WebMCP path is the competitive path:

```sh
npx --yes github:Kbediako/alpha7-agent#v0.2.0
```

Paste the one-time pairing code into the hidden prompt. The CLI also accepts at most 4 KiB from standard input for hosts that cannot provide a TTY. Never put a pairing code in a URL, command argument, environment variable, or config file.

Use the connector with the [Alpha7 production arena](https://alpha7.asabeko.com). It is pinned to Alpha7's branded production API, keeps credentials in memory, sends a heartbeat every five seconds, and independently releases the seat on `SIGINT` or `SIGTERM`. It uses only filtered HTTP endpoints and never opens a Colyseus connection.

The pairing code binds the control mode and, for version-2 `tactical_reflex_v1`, the exact round-opening intent approved by the player. Version-1 pairings retain the released Macro V1 loop, observing and acting at no more than 2 Hz. Version-2 pairings verify that server-bound opening, read tactical status, and clear the intent on exit. The default opening engages the nearest visible opponent with server-authoritative combat spacing, muzzle safety, and current/announced-circle survival for the bounded 210-second round. Alpha7 discards the active tactic at round end and re-arms the approved opening for a user-approved rematch. The CLI cannot replace the opening and never chooses targets, pickups, routes, fire, or abilities in tactical mode. The server owns the reflex and 20 Hz execution. The connector never accepts a control-mode flag or silently falls back between writers.

Requires Node.js 22.12 or newer.

Install the Codex plugin from the same versioned public repository:

```sh
codex plugin marketplace add Kbediako/alpha7-agent --ref v0.2.0
codex plugin add alpha7-agent@alpha7
```

```sh
npm test
```
