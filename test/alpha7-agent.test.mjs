import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import {
  API_BASE_URL,
  chooseAction,
  consumePairing,
  parseCliArgs,
  parsePairingCode,
  releaseControl,
  runControl,
  validateActionResult,
  validateConnection,
  validateObservation,
  validateStatus,
  validateTacticalIntentResult,
  validateTacticalStatus
} from "../bin/alpha7-agent.mjs";

const arena = {
  bounds: { minX: -500, minZ: -500, maxX: 500, maxZ: 500 },
  walls: []
};
const connection = {
  protocolVersion: 1,
  roomId: "ROOM_123",
  seatId: "seat_123",
  apiBaseUrl: API_BASE_URL,
  brokerCredential: "b".repeat(43),
  idleDeadlineMs: 1_000,
  observationVersion: 1,
  actionVersion: 1,
  arena
};
const tacticalConnection = {
  protocolVersion: 2,
  controlMode: "tactical_reflex_v1",
  roomId: "ROOM_123",
  seatId: "seat_123",
  apiBaseUrl: API_BASE_URL,
  brokerCredential: "b".repeat(43),
  idleDeadlineMs: 1_000,
  observationVersion: 1,
  tacticalIntentVersion: 1,
  reflexVersion: 1,
  executorVersion: 1,
  arena
};
const observation = {
  version: 1,
  observationSeq: 4,
  roomId: connection.roomId,
  roundId: "round_1",
  seatId: connection.seatId,
  mode: "agent_cup",
  track: "custom",
  matchState: "running",
  serverTimeMs: 2_000,
  arenaVersion: "round_1",
  self: {
    id: connection.seatId,
    archetype: "atlas",
    position: { x: 0, z: 0 },
    hullRotation: 0,
    turretRotation: 0,
    velocity: { x: 0, z: 0 },
    health: 100,
    maxHealth: 120,
    armor: 20,
    ammo: 10,
    weapon: "cannon",
    weaponCooldownMs: 0,
    ability: "repair",
    abilityCharge: 90,
    abilityCooldownMs: 0,
    alive: true
  },
  zone: { phase: "running", centerX: 0, centerZ: 0, radius: 400, nextChangeMs: 5_000 },
  pickups: [],
  allies: [],
  opponents: [
    {
      id: "far_target",
      ownerLabel: "untrusted label",
      agentLabel: null,
      archetype: "nova",
      alive: true,
      kills: 0,
      placement: null,
      visible: true,
      position: { x: 300, z: 0 },
      motion: "stationary"
    },
    {
      id: "near_target",
      ownerLabel: "another label",
      agentLabel: "agent label",
      archetype: "quill",
      alive: true,
      kills: 1,
      placement: null,
      visible: true,
      position: { x: 100, z: 0 },
      motion: "moving"
    }
  ]
};

test("CLI accepts only its default action, help, and version", () => {
  assert.equal(parseCliArgs([]), "connect");
  assert.equal(parseCliArgs(["--help"]), "help");
  assert.equal(parseCliArgs(["--version"]), "version");
  assert.throws(() => parseCliArgs(["--url", "https://example.com"]), /Usage/);
});

test("installed bin symlink executes the CLI entrypoint", () => {
  const directory = mkdtempSync(join(tmpdir(), "alpha7-agent-bin-"));
  const binary = join(directory, "alpha7-agent");
  symlinkSync(resolve("bin/alpha7-agent.mjs"), binary);
  try {
    const result = spawnSync(binary, ["--version"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "0.2.1\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("pairing input is exact and errors never disclose it", () => {
  const secret = "g".repeat(43);
  assert.deepEqual(
    parsePairingCode(JSON.stringify({ version: 1, roomId: "ROOM_123", grant: secret })),
    { version: 1, roomId: "ROOM_123", grant: secret }
  );
  assert.deepEqual(
    parsePairingCode(JSON.stringify({ version: 2, roomId: "ROOM_123", grant: secret })),
    { version: 2, roomId: "ROOM_123", grant: secret }
  );
  for (const source of [
    secret,
    JSON.stringify({ version: 1, roomId: "ROOM_123", grant: secret, url: "https://example.com" }),
    JSON.stringify({
      version: 2,
      roomId: "ROOM_123",
      grant: secret,
      controlMode: "tactical_reflex_v1"
    }),
    JSON.stringify({ version: 3, roomId: "ROOM_123", grant: secret })
  ]) {
    assert.throws(() => parsePairingCode(source), (error) => !error.message.includes(secret));
  }
});

test("pairing and connection credentials reject non-string JSON values", () => {
  const secret = "g".repeat(43);
  for (const credential of [[secret], [[secret]], { token: secret }, 123, true, null]) {
    assert.throws(
      () => parsePairingCode(JSON.stringify({ version: 1, roomId: connection.roomId, grant: credential })),
      (error) => /Invalid one-time pairing code/.test(error.message) && !error.message.includes(secret)
    );
    for (const descriptor of [connection, tacticalConnection]) {
      assert.throws(
        () => validateConnection(
          { ...descriptor, brokerCredential: credential }, descriptor.roomId, descriptor.protocolVersion
        ),
        (error) => /invalid connection/.test(error.message) && !error.message.includes(secret)
      );
    }
  }
});

test("consume, observation, status, and action envelopes reject unknown fields", () => {
  assert.equal(validateConnection(connection, connection.roomId), connection);
  assert.equal(validateConnection(tacticalConnection, tacticalConnection.roomId, 2), tacticalConnection);
  assert.equal(validateObservation(observation, connection), observation);
  const status = {
    version: 1,
    roomId: connection.roomId,
    seatId: connection.seatId,
    mode: "agent_cup",
    track: "custom",
    state: "connected",
    matchState: "running",
    observationSeq: 4,
    lastActionSeq: 3,
    leaseExpiresAtMs: null,
    idleDeadlineMs: 10_000
  };
  assert.equal(validateStatus(status, connection), status);
  const result = {
    version: 1,
    type: "agent_action_result",
    actionSeq: 4,
    accepted: true,
    code: "accepted",
    leaseExpiresAtMs: 3_000
  };
  assert.equal(validateActionResult(result, 4), result);
  assert.throws(
    () => validateConnection({ ...connection, extra: connection.brokerCredential }, connection.roomId),
    (error) => /invalid connection/.test(error.message) && !error.message.includes(connection.brokerCredential)
  );
  assert.throws(
    () => validateConnection({ ...tacticalConnection, reflexVersion: 2 }, tacticalConnection.roomId, 2),
    /invalid connection/
  );
  assert.throws(
    () => validateConnection(tacticalConnection, tacticalConnection.roomId),
    /invalid connection/
  );
  assert.throws(
    () => validateObservation({ ...observation, extra: observation.opponents[0].ownerLabel }, connection),
    (error) => /invalid response/.test(error.message) && !error.message.includes(observation.opponents[0].ownerLabel)
  );
  assert.throws(() => validateStatus({ ...status, extra: true }, connection), /invalid response/);
  assert.throws(() => validateActionResult({ ...result, extra: true }, 4), /invalid response/);
});

test("consume releases malformed successful descriptors without disclosing credentials", async () => {
  const originalFetch = globalThis.fetch;
  const secret = "s".repeat(43);
  const { executorVersion: _executorVersion, ...missingField } = {
    ...tacticalConnection,
    brokerCredential: secret
  };
  const malformedDescriptors = [
    missingField,
    { ...tacticalConnection, brokerCredential: secret, extra: secret }
  ];
  try {
    for (const descriptor of malformedDescriptors) {
      const requests = [];
      globalThis.fetch = async (url, init = {}) => {
        requests.push({ url: String(url), init });
        if (new URL(url).pathname.endsWith("/grants/consume")) {
          return Response.json(descriptor, { status: 201 });
        }
        return new Response(null, { status: 204 });
      };
      await assert.rejects(
        consumePairing(
          { version: 2, roomId: tacticalConnection.roomId, grant: "g".repeat(43) },
          new AbortController().signal
        ),
        (error) => /invalid connection/.test(error.message) && !error.message.includes(secret)
      );
      assert.deepEqual(requests.map(({ url, init }) => [new URL(url).pathname, init.method]), [
        [`/agent/rooms/${tacticalConnection.roomId}/grants/consume`, "POST"],
        [`/agent/rooms/${tacticalConnection.roomId}/control`, "DELETE"]
      ]);
      assert.equal(requests[1].init.headers.Authorization, `Bearer ${secret}`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("consume releases a malformed descriptor against the trusted requested room", async () => {
  const originalFetch = globalThis.fetch;
  const secret = "s".repeat(43);
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    if (new URL(url).pathname.endsWith("/grants/consume")) {
      return Response.json({
        ...tacticalConnection,
        roomId: "OTHER_ROOM",
        brokerCredential: secret,
        extra: true
      }, { status: 201 });
    }
    return new Response(null, { status: 204 });
  };
  try {
    await assert.rejects(
      consumePairing(
        { version: 2, roomId: tacticalConnection.roomId, grant: "g".repeat(43) },
        new AbortController().signal
      ),
      (error) => /invalid connection/.test(error.message) && !error.message.includes(secret)
    );
    assert.deepEqual(requests.map(({ url, init }) => [new URL(url).pathname, init.method]), [
      [`/agent/rooms/${tacticalConnection.roomId}/grants/consume`, "POST"],
      [`/agent/rooms/${tacticalConnection.roomId}/control`, "DELETE"]
    ]);
    assert.equal(requests[1].init.headers.Authorization, `Bearer ${secret}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("consume never uses non-string broker credentials for cleanup", async () => {
  const originalFetch = globalThis.fetch;
  const secret = "s".repeat(43);
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    return Response.json({ ...connection, brokerCredential: [secret] }, { status: 201 });
  };
  try {
    await assert.rejects(
      consumePairing(
        { version: 1, roomId: connection.roomId, grant: "g".repeat(43) },
        new AbortController().signal
      ),
      (error) => /invalid connection/.test(error.message) && !error.message.includes(secret)
    );
    assert.deepEqual(requests.map(({ url, init }) => [new URL(url).pathname, init.method]), [
      [`/agent/rooms/${connection.roomId}/grants/consume`, "POST"]
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("consume finishes and releases when cancellation arrives after dispatch", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  let resolveConsume;
  const consumeResponse = new Promise((resolve) => { resolveConsume = resolve; });
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    if (new URL(url).pathname.endsWith("/grants/consume")) return consumeResponse;
    return new Response(null, { status: 204 });
  };
  try {
    const controller = new AbortController();
    const pending = consumePairing(
      { version: 1, roomId: connection.roomId, grant: "g".repeat(43) },
      controller.signal
    );
    await Promise.resolve();
    assert.equal(requests.length, 1);
    assert.notEqual(requests[0].init.signal, controller.signal);
    controller.abort();
    assert.equal(requests[0].init.signal.aborted, false);
    resolveConsume(Response.json(connection, { status: 201 }));

    await assert.rejects(pending, /Interrupted/);
    assert.deepEqual(requests.map(({ url, init }) => [new URL(url).pathname, init.method]), [
      [`/agent/rooms/${connection.roomId}/grants/consume`, "POST"],
      [`/agent/rooms/${connection.roomId}/control`, "DELETE"]
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("tactical intent and status envelopes are exact", () => {
  const result = {
    version: 1,
    type: "agent_tactical_intent_result",
    intentSeq: 1,
    accepted: true,
    code: "accepted",
    intentExpiresAtMs: 45_000
  };
  const status = {
    version: 1,
    type: "agent_tactical_status",
    roomId: tacticalConnection.roomId,
    seatId: tacticalConnection.seatId,
    mode: "agent_cup",
    track: "custom",
    controlMode: "tactical_reflex_v1",
    state: "connected",
    matchState: "waiting",
    observationSeq: 0,
    lastIntentSeq: 1,
    intentExpiresAtMs: 45_000,
    lastReflexAtMs: null,
    active: false,
    stopReason: "waiting",
    idleDeadlineMs: 15_000
  };
  assert.equal(validateTacticalIntentResult(result, 1), result);
  assert.equal(validateTacticalStatus(status, tacticalConnection), status);
  assert.deepEqual(validateTacticalStatus({
    ...status,
    matchState: "running",
    intentExpiresAtMs: 45_000,
    lastReflexAtMs: 2_000,
    active: true,
    stopReason: "moving"
  }, tacticalConnection), {
    ...status,
    matchState: "running",
    intentExpiresAtMs: 45_000,
    lastReflexAtMs: 2_000,
    active: true,
    stopReason: "moving"
  });
  assert.equal(validateTacticalStatus({
    ...status,
    matchState: "running",
    intentExpiresAtMs: 45_000,
    lastReflexAtMs: 2_000,
    active: true,
    stopReason: "hold"
  }, tacticalConnection).stopReason, "hold");
  assert.throws(() => validateTacticalIntentResult({ ...result, extra: true }, 1), /invalid response/);
  assert.throws(() => validateTacticalStatus({ ...status, extra: true }, tacticalConnection), /invalid response/);
  assert.throws(
    () => validateTacticalStatus({ ...status, controlMode: "macro_v1" }, tacticalConnection),
    /invalid response/
  );
  assert.throws(
    () => validateTacticalStatus({ ...status, mode: "classic" }, tacticalConnection),
    /invalid response/
  );
  assert.equal(validateTacticalStatus({
    ...status,
    lastIntentSeq: 0,
    intentExpiresAtMs: null,
    lastReflexAtMs: null,
    stopReason: "no_intent"
  }, tacticalConnection).lastIntentSeq, 0);
  for (const invalid of [
    { ...status, lastIntentSeq: 0 },
    {
      ...status,
      lastIntentSeq: 0,
      active: false,
      stopReason: "no_intent"
    },
    {
      ...status,
      matchState: "running",
      active: true,
      stopReason: "moving",
      intentExpiresAtMs: null,
      lastReflexAtMs: 2_000
    },
    {
      ...status,
      matchState: "running",
      active: true,
      stopReason: "moving",
      intentExpiresAtMs: 45_000
    },
    {
      ...status,
      matchState: "running",
      active: true,
      stopReason: "waiting",
      intentExpiresAtMs: 45_000,
      lastReflexAtMs: 2_000
    },
    {
      ...status,
      state: "paused",
      matchState: "running",
      active: true,
      stopReason: "moving",
      intentExpiresAtMs: 45_000,
      lastReflexAtMs: 2_000
    },
    {
      ...status,
      active: true,
      stopReason: "moving",
      intentExpiresAtMs: 45_000,
      lastReflexAtMs: 2_000
    },
    { ...status, active: false, stopReason: "moving" },
    { ...status, active: false, stopReason: "hold" }
  ]) assert.throws(() => validateTacticalStatus(invalid, tacticalConnection), /invalid response/);
});

test("one-seat policy targets the nearest visible opponent with a bounded lease", () => {
  const action = chooseAction(observation, arena, 5);
  assert.equal(action.targetId, "near_target");
  assert.equal(action.fire, "hold");
  assert.equal(action.useAbility, false);
  assert.equal(action.leaseMs, 750);
  assert.ok(action.leaseMs <= 3_000);
  assert.ok(action.waypoints.length <= 1);
  assert.deepEqual(Object.keys(action).sort(), [
    "actionSeq", "basedOnObservationSeq", "fire", "leaseMs", "targetId", "useAbility", "version", "waypoints"
  ]);
});

test("one-seat policy prioritizes critical pickups and tactical abilities", () => {
  const tactical = {
    ...observation,
    self: {
      ...observation.self,
      health: 50,
      armor: 5,
      ability: "repair",
      abilityCharge: 65
    },
    pickups: [{ id: "health_1", type: "health_repair", x: 70, z: 0, active: true }]
  };
  const action = chooseAction(tactical, arena, 6);
  assert.equal(action.pickupId, "health_1");
  assert.equal(action.targetId, "near_target");
  assert.equal(action.fire, "hold");
  assert.equal(action.useAbility, "once");
  assert.ok(action.waypoints[0].x > 0);
});

test("broker lifecycle consumes, heartbeats, observes, acts, and releases", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  let stopped = false;
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    const path = new URL(url).pathname;
    if (path.endsWith("/grants/consume")) {
      return Response.json(connection, { status: 201 });
    }
    if (path.endsWith("/heartbeat")) {
      return Response.json({
        version: 1,
        roomId: connection.roomId,
        seatId: connection.seatId,
        mode: "agent_cup",
        track: "custom",
        state: "connected",
        matchState: "running",
        observationSeq: 0,
        lastActionSeq: 0,
        leaseExpiresAtMs: null,
        idleDeadlineMs: 10_000
      });
    }
    if (path.endsWith("/observation")) return Response.json({ ...observation, observationSeq: 1 });
    if (path.endsWith("/action")) {
      const action = JSON.parse(init.body);
      stopped = true;
      return Response.json({
        version: 1,
        type: "agent_action_result",
        actionSeq: action.actionSeq,
        accepted: true,
        code: "accepted",
        leaseExpiresAtMs: 20_000
      });
    }
    if (path.endsWith("/control")) return new Response(null, { status: 204 });
    throw new Error("unexpected request");
  };
  try {
    const controller = new AbortController();
    const paired = await consumePairing(
      { version: 1, roomId: connection.roomId, grant: "g".repeat(43) },
      controller.signal
    );
    await runControl(paired, controller.signal, () => stopped);
    await releaseControl(paired);
    assert.deepEqual(requests.map(({ url, init }) => [new URL(url).pathname.split("/").at(-1), init.method]), [
      ["consume", "POST"],
      ["heartbeat", "POST"],
      ["observation", "GET"],
      ["action", "POST"],
      ["control", "DELETE"]
    ]);
    assert.ok(requests.every(({ init }) => init.redirect === "error"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("tactical control verifies the bound opening, reads status, and clears without macro actions", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  let stopped = false;
  let openingSeq = 1;
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(url).pathname.split("/").at(-1);
    requests.push({ path, init });
    if (path === "consume") return Response.json(tacticalConnection, { status: 201 });
    if (path === "heartbeat") {
      return Response.json({
        version: 1,
        roomId: tacticalConnection.roomId,
        seatId: tacticalConnection.seatId,
        mode: "agent_cup",
        track: "custom",
        state: "connected",
        matchState: "waiting",
        observationSeq: 0,
        lastActionSeq: 0,
        leaseExpiresAtMs: null,
        idleDeadlineMs: 15_000
      });
    }
    if (path === "tactical-status") {
      stopped = true;
      return Response.json({
        version: 1,
        type: "agent_tactical_status",
        roomId: tacticalConnection.roomId,
        seatId: tacticalConnection.seatId,
        mode: "agent_cup",
        track: "custom",
        controlMode: "tactical_reflex_v1",
        state: "connected",
        matchState: "waiting",
        observationSeq: 0,
        lastIntentSeq: openingSeq,
        intentExpiresAtMs: 45_000,
        lastReflexAtMs: null,
        active: false,
        stopReason: "waiting",
        idleDeadlineMs: 15_000
      });
    }
    if (path === "tactical-intent" && init.method === "DELETE") {
      return Response.json({
        version: 1,
        type: "agent_tactical_status",
        roomId: tacticalConnection.roomId,
        seatId: tacticalConnection.seatId,
        mode: "agent_cup",
        track: "custom",
        controlMode: "tactical_reflex_v1",
        state: "connected",
        matchState: "waiting",
        observationSeq: 0,
        lastIntentSeq: openingSeq,
        intentExpiresAtMs: null,
        lastReflexAtMs: null,
        active: false,
        stopReason: "cleared",
        idleDeadlineMs: 15_000
      });
    }
    if (path === "control") return new Response(null, { status: 204 });
    throw new Error(`unexpected request: ${path}`);
  };
  try {
    const paired = await consumePairing(
      { version: 2, roomId: tacticalConnection.roomId, grant: "g".repeat(43) },
      new AbortController().signal
    );
    await runControl(paired, new AbortController().signal, () => stopped);
    await releaseControl(paired);
    assert.deepEqual(requests.map(({ path, init }) => [path, init.method]), [
      ["consume", "POST"],
      ["heartbeat", "POST"],
      ["tactical-status", "GET"],
      ["tactical-intent", "DELETE"],
      ["control", "DELETE"]
    ]);
    assert.ok(requests.every(({ init }) => init.redirect === "error"));
    assert.ok(!requests.some(({ path }) => path === "observation" || path === "action"));

    requests.length = 0;
    stopped = false;
    openingSeq = Number.MAX_SAFE_INTEGER;
    await assert.rejects(
      runControl(tacticalConnection, new AbortController().signal, () => stopped),
      /opening was not bound/
    );
    assert.deepEqual(requests.map(({ path, init }) => [path, init.method]), [
      ["heartbeat", "POST"],
      ["tactical-status", "GET"],
      ["tactical-intent", "DELETE"]
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("heartbeat scheduling survives serial near-timeout requests", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const requests = [];
  let virtualNow = 0;
  let idleDeadline = 15_000;
  let heartbeatCount = 0;
  let stopped = false;
  Date.now = () => virtualNow;
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(url).pathname.split("/").at(-1);
    requests.push([path, virtualNow]);
    if (path === "heartbeat") {
      virtualNow += heartbeatCount === 0 ? 0 : 4;
      heartbeatCount += 1;
      if (virtualNow >= idleDeadline) {
        return Response.json({
          version: 1,
          ok: false,
          error: { code: "agent_revoked" }
        }, { status: 401 });
      }
      idleDeadline = virtualNow + 15_000;
      virtualNow += 4_999;
      return Response.json({
        version: 1,
        roomId: connection.roomId,
        seatId: connection.seatId,
        mode: "agent_cup",
        track: "custom",
        state: "connected",
        matchState: "running",
        observationSeq: 0,
        lastActionSeq: 0,
        leaseExpiresAtMs: null,
        idleDeadlineMs: idleDeadline
      });
    }
    if (path === "observation") {
      virtualNow += 4_999;
      return Response.json({
        ...observation,
        observationSeq: 1,
        serverTimeMs: virtualNow
      });
    }
    if (path === "action") {
      virtualNow += 4_999;
      const action = JSON.parse(init.body);
      stopped = heartbeatCount >= 2;
      return Response.json({
        version: 1,
        type: "agent_action_result",
        actionSeq: action.actionSeq,
        accepted: true,
        code: "accepted",
        leaseExpiresAtMs: virtualNow + 750
      });
    }
    throw new Error("unexpected request");
  };
  try {
    await runControl(connection, new AbortController().signal, () => stopped);
    assert.deepEqual(requests, [
      ["heartbeat", 0],
      ["observation", 4_999],
      ["heartbeat", 9_998],
      ["action", 15_001]
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  }
});
