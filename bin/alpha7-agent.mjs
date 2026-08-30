#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const API_BASE_URL = "https://api.alpha7.asabeko.com";
const VERSION = "0.1.3";
const MAX_STDIN_BYTES = 4 * 1024;
const REQUEST_TIMEOUT_MS = 5_000;
const DECISION_INTERVAL_MS = 600;
const HEARTBEAT_INTERVAL_MS = 5_000;
const LEASE_MS = 750;
const ACTIVE_MATCH_STATES = new Set(["running", "danger", "final_zone"]);
const MATCH_STATES = new Set(["waiting", "countdown", ...ACTIVE_MATCH_STATES, "finished"]);
const MODES = new Set(["wingman", "open_ffa", "agent_cup"]);
const SEAT_STATES = new Set([
  "none", "pending", "connected", "paused", "reconnecting", "revoked", "disconnected"
]);
const ARCHETYPES = new Set(["nova", "atlas", "quill", "rook"]);
const WEAPONS = new Set(["cannon", "light_cannon", "machine_gun", "explosive"]);
const ABILITIES = new Set(["smoke", "repair", "shield_pulse", "speed_burst", "barrage"]);
const PICKUPS = new Set([
  "health_repair", "shield_armor", "ammo_rapid_fire", "speed_boost", "ability_charge",
  "smoke", "barrage_explosive"
]);
const MOTIONS = new Set(["stationary", "moving", "unknown"]);
const ERROR_CODES = new Set([
  "agent_feature_disabled", "mode_disallows_agent", "owner_limit", "human_ws_limit",
  "agent_control_limit", "combatant_limit", "pending_exists", "grant_expired",
  "grant_consumed", "principal_mismatch", "agent_revoked", "agent_paused",
  "owner_unavailable", "stale_action", "stale_observation", "rate_limited",
  "target_not_visible", "lease_invalid", "room_not_waiting", "match_not_active"
]);
const TEMPORARY_CODES = new Set([
  "match_not_active", "agent_paused", "owner_unavailable", "rate_limited",
  "stale_action", "stale_observation", "target_not_visible", "lease_invalid"
]);

class CliError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

const fail = (message) => { throw new CliError(message); };
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const exact = (value, keys) =>
  isRecord(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const text = (value, maximum, minimum = 1) =>
  typeof value === "string" && value.length >= minimum && value.length <= maximum && value.trim() === value;
const id = (value) => text(value, 64) && /^[A-Za-z0-9_-]+$/.test(value);
const roomId = (value) => text(value, 64, 4) && /^[A-Za-z0-9_-]+$/.test(value);
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const integer = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum;
const nullableInteger = (value, minimum = 0) => value === null || integer(value, minimum);
const oneOf = (value, values) => typeof value === "string" && values.has(value);

const validPosition = (value) => exact(value, ["x", "z"]) && finite(value.x) && finite(value.z);
const validBounds = (value) =>
  exact(value, ["minX", "minZ", "maxX", "maxZ"]) &&
  [value.minX, value.minZ, value.maxX, value.maxZ].every(finite) &&
  value.minX < value.maxX && value.minZ < value.maxZ;
const validWall = (value) =>
  exact(value, ["id", "x", "z", "width", "depth"]) && id(value.id) &&
  [value.x, value.z, value.width, value.depth].every(finite) && value.width > 0 && value.depth > 0;
const validArena = (value) =>
  exact(value, ["bounds", "walls"]) && validBounds(value.bounds) && Array.isArray(value.walls) &&
  value.walls.length <= 2_048 && value.walls.every(validWall);

export const parsePairingCode = (source) => {
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    fail("Invalid one-time pairing code.");
  }
  if (
    !exact(value, ["version", "roomId", "grant"]) || value.version !== 1 ||
    !roomId(value.roomId) || !/^[A-Za-z0-9_-]{43}$/.test(value.grant)
  ) fail("Invalid one-time pairing code.");
  return value;
};

export const validateConnection = (value, expectedRoomId) => {
  if (
    !exact(value, [
      "protocolVersion", "roomId", "seatId", "apiBaseUrl", "brokerCredential",
      "idleDeadlineMs", "observationVersion", "actionVersion", "arena"
    ]) || value.protocolVersion !== 1 || value.observationVersion !== 1 || value.actionVersion !== 1 ||
    value.roomId !== expectedRoomId || !roomId(value.roomId) || !id(value.seatId) ||
    value.apiBaseUrl !== API_BASE_URL || !/^[A-Za-z0-9_-]{43}$/.test(value.brokerCredential) ||
    !integer(value.idleDeadlineMs, 1) || !validArena(value.arena)
  ) fail("Pairing returned an invalid connection response.");
  return value;
};

const validSelf = (value, expectedSeatId) =>
  exact(value, [
    "id", "archetype", "position", "hullRotation", "turretRotation", "velocity", "health",
    "maxHealth", "armor", "ammo", "weapon", "weaponCooldownMs", "ability", "abilityCharge",
    "abilityCooldownMs", "alive"
  ]) && value.id === expectedSeatId && id(value.id) && oneOf(value.archetype, ARCHETYPES) &&
  validPosition(value.position) && finite(value.hullRotation) && finite(value.turretRotation) &&
  validPosition(value.velocity) && [value.health, value.maxHealth, value.armor, value.ammo,
    value.weaponCooldownMs, value.abilityCharge, value.abilityCooldownMs].every(finite) &&
  oneOf(value.weapon, WEAPONS) && oneOf(value.ability, ABILITIES) && typeof value.alive === "boolean";
const validZone = (value) =>
  exact(value, ["phase", "centerX", "centerZ", "radius", "nextChangeMs"]) &&
  oneOf(value.phase, MATCH_STATES) && [value.centerX, value.centerZ, value.radius, value.nextChangeMs].every(finite) &&
  value.radius >= 0 && value.nextChangeMs >= 0;
const validPickup = (value) =>
  exact(value, ["id", "type", "x", "z", "active"]) && id(value.id) && oneOf(value.type, PICKUPS) &&
  finite(value.x) && finite(value.z) && typeof value.active === "boolean";
const validAlly = (value) =>
  exact(value, ["id", "archetype", "alive", "position", "motion"]) && id(value.id) &&
  oneOf(value.archetype, ARCHETYPES) && typeof value.alive === "boolean" &&
  (value.position === null || validPosition(value.position)) && oneOf(value.motion, MOTIONS);
const validOpponent = (value) =>
  exact(value, [
    "id", "ownerLabel", "agentLabel", "archetype", "alive", "kills", "placement",
    "visible", "position", "motion"
  ]) && id(value.id) && text(value.ownerLabel, 64) &&
  (value.agentLabel === null || text(value.agentLabel, 32)) && oneOf(value.archetype, ARCHETYPES) &&
  typeof value.alive === "boolean" && integer(value.kills) && nullableInteger(value.placement, 1) &&
  typeof value.visible === "boolean" && (value.position === null || validPosition(value.position)) &&
  oneOf(value.motion, MOTIONS) && (value.visible || value.position === null);

export const validateObservation = (value, connection) => {
  const baseKeys = [
    "version", "observationSeq", "roomId", "roundId", "seatId", "mode", "track", "matchState",
    "serverTimeMs", "arenaVersion", "self", "zone", "pickups", "allies", "opponents"
  ];
  const keys = Object.hasOwn(isRecord(value) ? value : {}, "arenaUpdate") ? [...baseKeys, "arenaUpdate"] : baseKeys;
  if (
    !exact(value, keys) || value.version !== 1 || !integer(value.observationSeq, 1) ||
    value.roomId !== connection.roomId || !text(value.roundId, 128) || value.seatId !== connection.seatId ||
    !oneOf(value.mode, MODES) || value.track !== "custom" ||
    !oneOf(value.matchState, new Set(["countdown", "running", "danger", "final_zone", "finished"])) ||
    !integer(value.serverTimeMs, 1) || !text(value.arenaVersion, 128) ||
    !validSelf(value.self, connection.seatId) || !validZone(value.zone) ||
    !Array.isArray(value.pickups) || value.pickups.length > 64 || !value.pickups.every(validPickup) ||
    !Array.isArray(value.allies) || value.allies.length > 16 || !value.allies.every(validAlly) ||
    !Array.isArray(value.opponents) || value.opponents.length > 16 || !value.opponents.every(validOpponent) ||
    (Object.hasOwn(value, "arenaUpdate") && !validArena(value.arenaUpdate))
  ) fail("Observation returned an invalid response.");
  return value;
};

export const validateStatus = (value, connection) => {
  if (
    !exact(value, [
      "version", "roomId", "seatId", "mode", "track", "state", "matchState", "observationSeq",
      "lastActionSeq", "leaseExpiresAtMs", "idleDeadlineMs"
    ]) || value.version !== 1 || value.roomId !== connection.roomId || value.seatId !== connection.seatId ||
    !oneOf(value.mode, MODES) || value.track !== "custom" || !oneOf(value.state, SEAT_STATES) ||
    !oneOf(value.matchState, MATCH_STATES) || !integer(value.observationSeq) || !integer(value.lastActionSeq) ||
    !nullableInteger(value.leaseExpiresAtMs, 1) || !integer(value.idleDeadlineMs, 1)
  ) fail("Status returned an invalid response.");
  return value;
};

export const validateActionResult = (value, expectedActionSeq) => {
  const validCode = value?.code === "accepted" || oneOf(value?.code, ERROR_CODES);
  if (
    !exact(value, ["version", "type", "actionSeq", "accepted", "code", "leaseExpiresAtMs"]) ||
    value.version !== 1 || value.type !== "agent_action_result" ||
    !(value.actionSeq === null || value.actionSeq === expectedActionSeq) ||
    typeof value.accepted !== "boolean" || !validCode ||
    (value.accepted
      ? value.actionSeq !== expectedActionSeq || value.code !== "accepted" || !integer(value.leaseExpiresAtMs, 1)
      : value.code === "accepted" || value.leaseExpiresAtMs !== null)
  ) fail("Action returned an invalid response.");
  return value;
};

const validateErrorEnvelope = (value) => {
  if (
    !exact(value, ["version", "ok", "error"]) || value.version !== 1 || value.ok !== false ||
    !exact(value.error, ["code"]) || !oneOf(value.error.code, ERROR_CODES)
  ) fail("Alpha7 returned an invalid error response.");
  return value.error.code;
};

const clearSegment = (arena, from, to) => {
  const distance = Math.hypot(to.x - from.x, to.z - from.z);
  const steps = Math.max(1, Math.ceil(distance / 18));
  for (let step = 1; step <= steps; step += 1) {
    const progress = step / steps;
    const x = from.x + (to.x - from.x) * progress;
    const z = from.z + (to.z - from.z) * progress;
    if (
      x < arena.bounds.minX + 42 || x > arena.bounds.maxX - 42 ||
      z < arena.bounds.minZ + 42 || z > arena.bounds.maxZ - 42 ||
      arena.walls.some((wall) =>
        x >= wall.x - 42 && x <= wall.x + wall.width + 42 &&
        z >= wall.z - 42 && z <= wall.z + wall.depth + 42)
    ) return false;
  }
  return true;
};

const chooseWaypoint = (observation, arena, destination) => {
  const self = observation.self.position;
  if (!destination) return undefined;
  const angle = Math.atan2(destination.z - self.z, destination.x - self.x);
  for (const offset of [0, Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2, Math.PI]) {
    const candidate = {
      x: self.x + Math.cos(angle + offset) * 140,
      z: self.z + Math.sin(angle + offset) * 140
    };
    if (clearSegment(arena, self, candidate)) return candidate;
  }
};

const distanceFromSelf = (observation, position) =>
  Math.hypot(
    position.x - observation.self.position.x,
    position.z - observation.self.position.z
  );

const choosePickup = (observation, outsideZone) => observation.pickups
  .filter((pickup) => pickup.active)
  .map((pickup) => {
    const healthRatio = observation.self.health / Math.max(1, observation.self.maxHealth);
    const priority = pickup.type === "health_repair" && healthRatio < 0.65
      ? 0
      : pickup.type === "shield_armor" && observation.self.armor < 12
        ? 1
        : pickup.type === "ammo_rapid_fire" && observation.self.ammo <= 3
          ? 2
          : pickup.type === "ability_charge" && observation.self.abilityCharge < 25
            ? 3
            : pickup.type === "speed_boost" && outsideZone
              ? 4
              : Infinity;
    return { pickup, score: priority * 10_000 + distanceFromSelf(observation, pickup) };
  })
  .filter(({ score }) => Number.isFinite(score))
  .sort((left, right) => left.score - right.score)[0]?.pickup;

const shouldUseAbility = (observation, targetDistance, outsideZone, chasingPickup) => {
  const costs = { smoke: 50, repair: 65, shield_pulse: 70, speed_burst: 45, barrage: 100 };
  if (observation.self.abilityCharge < costs[observation.self.ability]) return false;
  switch (observation.self.ability) {
    case "repair":
      return observation.self.health / Math.max(1, observation.self.maxHealth) < 0.65 ||
        observation.self.armor < 10;
    case "smoke":
    case "shield_pulse":
      return targetDistance <= 500;
    case "speed_burst":
      return outsideZone || chasingPickup;
    case "barrage":
      return targetDistance <= 700;
  }
};

export const chooseAction = (observation, arena, actionSeq) => {
  const target = observation.opponents
    .filter((opponent) => opponent.visible && opponent.alive && opponent.position)
    .sort((left, right) =>
      Math.hypot(left.position.x - observation.self.position.x, left.position.z - observation.self.position.z) -
      Math.hypot(right.position.x - observation.self.position.x, right.position.z - observation.self.position.z))[0];
  const targetDistance = target ? distanceFromSelf(observation, target.position) : Infinity;
  const outsideZone = Math.hypot(
    observation.self.position.x - observation.zone.centerX,
    observation.self.position.z - observation.zone.centerZ
  ) > Math.max(0, observation.zone.radius - 90);
  const pickup = choosePickup(observation, outsideZone);
  const destination = outsideZone
    ? { x: observation.zone.centerX, z: observation.zone.centerZ }
    : pickup ?? target?.position;
  const waypoint = chooseWaypoint(observation, arena, destination);
  const canFire = Boolean(target && targetDistance <= 750);
  return {
    version: 1,
    actionSeq,
    basedOnObservationSeq: observation.observationSeq,
    leaseMs: LEASE_MS,
    waypoints: waypoint ? [waypoint] : [],
    ...(target ? { targetId: target.id } : {}),
    ...(pickup ? { pickupId: pickup.id } : {}),
    fire: canFire ? "hold" : "none",
    useAbility: shouldUseAbility(observation, targetDistance, outsideZone, Boolean(pickup))
      ? "once"
      : false
  };
};

export const parseCliArgs = (args) => {
  if (args.length === 0) return "connect";
  if (args.length === 1 && args[0] === "--help") return "help";
  if (args.length === 1 && args[0] === "--version") return "version";
  fail("Usage: alpha7-agent [--help | --version]");
};

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason);
  const onAbort = () => {
    clearTimeout(timer);
    reject(signal.reason);
  };
  const timer = setTimeout(() => {
    signal?.removeEventListener("abort", onAbort);
    resolve();
  }, ms);
  signal?.addEventListener("abort", onAbort, { once: true });
});

const readBoundedJson = async (response) => {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > 1024 * 1024) fail("Alpha7 returned an oversized response.");
  if (!response.body) fail("Alpha7 returned an invalid response.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let source = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > 1024 * 1024) {
      await reader.cancel();
      fail("Alpha7 returned an oversized response.");
    }
    source += decoder.decode(value, { stream: true });
  }
  source += decoder.decode();
  try {
    return JSON.parse(source);
  } catch {
    fail("Alpha7 returned an invalid JSON response.");
  }
};

const credentialRequest = async (path, credential, init = {}, signal) => {
  let response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      redirect: "error",
      headers: { ...init.headers, Authorization: `Bearer ${credential}` },
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
        : AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch {
    throw new CliError("Alpha7 request failed.");
  }
  if (response.status === 204) return { response };
  return { response, payload: await readBoundedJson(response) };
};

const requestEnvelope = async (path, credential, validator, init, signal) => {
  const { response, payload } = await credentialRequest(path, credential, init, signal);
  if (!response.ok) return { code: validateErrorEnvelope(payload), status: response.status };
  return { value: validator(payload) };
};

const readPairingCode = async () => {
  if (!process.stdin.isTTY) {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      if (bytes > MAX_STDIN_BYTES) fail("Pairing code input exceeds 4 KiB.");
      chunks.push(chunk);
    }
    const source = Buffer.concat(chunks).toString("utf8").trim();
    if (!source) fail("A one-time pairing code is required on stdin.");
    return source;
  }

  process.stderr.write("Paste the one-time Alpha7 pairing code: ");
  process.stdin.setEncoding("utf8");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let source = "";
    let finished = false;
    const finish = (error) => {
      if (finished) return;
      finished = true;
      process.stdin.off("data", onData);
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stderr.write("\n");
      if (error) reject(error);
      else resolve(source.trim());
    };
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === "\u0003") return finish(new CliError("Interrupted.", 130));
        if (character === "\r" || character === "\n") {
          if (!source.trim()) return;
          return finish();
        }
        if (character === "\u007f" || character === "\b") source = source.slice(0, -1);
        else source += character;
        if (Buffer.byteLength(source) > MAX_STDIN_BYTES) {
          return finish(new CliError("Pairing code input exceeds 4 KiB."));
        }
      }
    };
    const onSignal = () => finish(new CliError("Interrupted.", 130));
    process.stdin.on("data", onData);
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  });
};

const controlPath = (connection, suffix) =>
  `/agent/rooms/${encodeURIComponent(connection.roomId)}/${suffix}`;

export const consumePairing = async (pairing, signal) => {
  const result = await requestEnvelope(
    `/agent/rooms/${encodeURIComponent(pairing.roomId)}/grants/consume`,
    pairing.grant,
    (value) => validateConnection(value, pairing.roomId),
    { method: "POST" },
    signal
  );
  if (!result.value) throw new CliError(`Pairing failed (${result.status}).`);
  return result.value;
};

const requestStatus = (connection, suffix, method, signal) => requestEnvelope(
  controlPath(connection, suffix), connection.brokerCredential,
  (value) => validateStatus(value, connection), { method }, signal
);

export const runControl = async (connection, signal, stopped) => {
  let arena = connection.arena;
  let actionSeq = 0;
  let nextHeartbeatAt = 0;
  let nextObservationAt = 0;
  let nextActionAt = 0;

  const acceptStatus = (result) => {
    if (!result.value) throw new CliError(`Alpha7 status request failed (${result.status}).`);
    actionSeq = Math.max(actionSeq, result.value.lastActionSeq);
    if (result.value.state === "revoked" || result.value.state === "disconnected") {
      throw new CliError("Alpha7 agent control ended.");
    }
    return result.value;
  };
  const heartbeat = async () => {
    const heartbeatStartedAt = Date.now();
    const status = acceptStatus(await requestStatus(connection, "heartbeat", "POST", signal));
    nextHeartbeatAt = heartbeatStartedAt + HEARTBEAT_INTERVAL_MS;
    return status;
  };
  const keepAlive = async () => Date.now() >= nextHeartbeatAt ? heartbeat() : undefined;
  const waitForActiveMatch = async () => {
    while (!stopped()) {
      const heartbeatDue = Date.now() >= nextHeartbeatAt;
      const status = heartbeatDue
        ? await heartbeat()
        : acceptStatus(await requestStatus(connection, "status", "GET", signal));
      if (status.state === "connected" && ACTIVE_MATCH_STATES.has(status.matchState)) return;
      await sleep(DECISION_INTERVAL_MS, signal);
    }
  };

  while (!stopped()) {
    await waitForActiveMatch();
    while (!stopped()) {
      await sleep(Math.max(0, nextObservationAt - Date.now()), signal);
      const heartbeatStatus = await keepAlive();
      if (heartbeatStatus && (
        heartbeatStatus.state !== "connected" || !ACTIVE_MATCH_STATES.has(heartbeatStatus.matchState)
      )) break;

      const observationStartedAt = Date.now();
      const observed = await requestEnvelope(
        controlPath(connection, "observation"), connection.brokerCredential,
        (value) => validateObservation(value, connection), { method: "GET" }, signal
      );
      nextObservationAt = observationStartedAt + DECISION_INTERVAL_MS;
      if (!observed.value) {
        if (TEMPORARY_CODES.has(observed.code)) break;
        throw new CliError(`Alpha7 observation request failed (${observed.status}).`);
      }
      const observation = observed.value;
      if (observation.arenaUpdate) arena = observation.arenaUpdate;
      if (!ACTIVE_MATCH_STATES.has(observation.matchState)) break;
      if (!observation.self.alive) continue;

      await sleep(Math.max(0, nextActionAt - Date.now()), signal);
      const actionHeartbeatStatus = await keepAlive();
      if (actionHeartbeatStatus && (
        actionHeartbeatStatus.state !== "connected" || !ACTIVE_MATCH_STATES.has(actionHeartbeatStatus.matchState)
      )) break;
      const action = chooseAction(observation, arena, actionSeq + 1);
      const actionStartedAt = Date.now();
      const acted = await requestEnvelope(
        controlPath(connection, "action"), connection.brokerCredential,
        (value) => validateActionResult(value, action.actionSeq),
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(action) },
        signal
      );
      nextActionAt = actionStartedAt + DECISION_INTERVAL_MS;
      if (!acted.value) {
        if (TEMPORARY_CODES.has(acted.code)) break;
        throw new CliError(`Alpha7 action request failed (${acted.status}).`);
      }
      if (acted.value.accepted) actionSeq = action.actionSeq;
      else if (!TEMPORARY_CODES.has(acted.value.code)) throw new CliError("Alpha7 action was rejected.");
    }
  }
};

export const releaseControl = async (connection) => {
  const { response, payload } = await credentialRequest(
    controlPath(connection, "control"), connection.brokerCredential,
    { method: "DELETE", keepalive: true }
  );
  if (response.status === 204) return;
  if (!response.ok) validateErrorEnvelope(payload);
  throw new CliError(`Alpha7 release failed (${response.status}).`);
};

const connect = async () => {
  const pairing = parsePairingCode(await readPairingCode());
  const controller = new AbortController();
  let stopping = false;
  let connection;
  let failure;
  const stop = () => {
    stopping = true;
    controller.abort();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    connection = await consumePairing(pairing, controller.signal);
    process.stderr.write("Alpha7 agent connected. Press Ctrl-C to release it.\n");
    await runControl(connection, controller.signal, () => stopping);
  } catch (error) {
    if (!stopping) failure = error;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    if (connection) {
      try {
        await releaseControl(connection);
      } catch (error) {
        failure ??= error;
      }
    }
  }
  if (failure) throw failure;
};

export const main = async (args = process.argv.slice(2)) => {
  const action = parseCliArgs(args);
  if (action === "help") {
    process.stdout.write(
      "Usage: alpha7-agent [--help | --version]\n\n" +
      "With no flag, securely prompt for one Alpha7 pairing code and control one agent until stopped.\n"
    );
  } else if (action === "version") process.stdout.write(`${VERSION}\n`);
  else await connect();
};

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof CliError ? error.message : "Alpha7 agent failed."}\n`);
    process.exitCode = error instanceof CliError ? error.exitCode : 1;
  });
}
