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
  validateStatus
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
    assert.equal(result.stdout, "0.1.0\n");
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
  for (const source of [
    secret,
    JSON.stringify({ version: 1, roomId: "ROOM_123", grant: secret, url: "https://example.com" }),
    JSON.stringify({ version: 2, roomId: "ROOM_123", grant: secret })
  ]) {
    assert.throws(() => parsePairingCode(source), (error) => !error.message.includes(secret));
  }
});

test("consume, observation, status, and action envelopes reject unknown fields", () => {
  assert.equal(validateConnection(connection, connection.roomId), connection);
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
    () => validateObservation({ ...observation, extra: observation.opponents[0].ownerLabel }, connection),
    (error) => /invalid response/.test(error.message) && !error.message.includes(observation.opponents[0].ownerLabel)
  );
  assert.throws(() => validateStatus({ ...status, extra: true }, connection), /invalid response/);
  assert.throws(() => validateActionResult({ ...result, extra: true }, 4), /invalid response/);
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
