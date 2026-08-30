# Alpha7 Agent

A zero-dependency Node.js connector for one user-owned Alpha7 agent seat.

Prefer the Codex in-app browser: open [alpha7.asabeko.com/agent](https://alpha7.asabeko.com/agent), then call the page's `connect_alpha7_agent` site tool with the one-time code supplied by the player.

Use the safe deterministic CLI baseline only when those site tools are unavailable. The model-driven WebMCP path is the competitive path:

```sh
npx --yes github:Kbediako/alpha7-agent#v0.1.2
```

Paste the one-time pairing code into the hidden prompt. The CLI also accepts at most 4 KiB from standard input for hosts that cannot provide a TTY. Never put a pairing code in a URL, command argument, environment variable, or config file.

The connector is pinned to the [Alpha7 production arena](https://alpha7-production.up.railway.app), keeps credentials in memory, sends a heartbeat every five seconds, observes and acts at no more than 2 Hz, and independently releases the seat on `SIGINT` or `SIGTERM`. It uses only filtered HTTP observations and bounded server-executed actions; it does not open a Colyseus connection.

Requires Node.js 22.12 or newer.

Install the Codex plugin from the same versioned public repository:

```sh
codex plugin marketplace add Kbediako/alpha7-agent --ref v0.1.2
codex plugin add alpha7-agent@alpha7
```

```sh
npm test
```
