const test = require("node:test");
const assert = require("node:assert/strict");
const Submission = require("../submission.js");
const Parser = require("../parser.js");

function storage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
  };
}

function payload(hash = "a".repeat(64)) {
  return {
    schema: "arbi-analyzer-run/v3",
    sol_node: "SolNode130",
    level_path: "/Lotus/Levels/Example.level",
    mission_type: "DEFENSE",
    run_offset_seconds: 123.4,
    observed_spawn_events: 7,
    spawn_points: [{ point_key: "/Layer/NpcSpawnPoint1", position: [1, 2, 3], count: 7 }],
    run_metrics: {
      mission_seconds: 600,
      active_seconds: 570,
      drone_kills: 100,
      blessed_drone_kills: 100,
      enemy_spawns: 1000,
      high_enemy_seconds: 5,
      enemy_telemetry_seconds: 500,
      enemy_count_seconds: Array.from({ length: 52 }, (_, count) => count === 0 ? 495 : count === 15 ? 5 : 0),
      drone_dry_seconds: 29,
      drone_cadence_seconds: 500,
      drone_interval_span_seconds: 540,
      drone_interval_count: 99,
      reward_cycles: 2,
      defense_waves: 6,
      rotation_seconds: [285, 285],
      rotation_drones: [50, 49],
      wave_seconds: [40, 40, 40, 40, 40, 40],
      enemy_type_counts: { EliteRifleLancer: 600, ChargerAgent: 400 },
      four_member_majority: true,
    },
    run_hash: hash,
  };
}

test("accepted and duplicate responses are cached, failed submissions are not", async () => {
  const cache = storage();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: true, status: 201, json: async () => ({ status: "accepted" }) };
  };
  const first = await Submission.postPayload(payload(), { fetchImpl, storage: cache });
  const second = await Submission.postPayload(payload(), { fetchImpl, storage: cache });
  assert.equal(first.status, "accepted");
  assert.equal(second.status, "cached");
  assert.equal(calls, 1);

  const failedHash = "b".repeat(64);
  await assert.rejects(() => Submission.postPayload(payload(failedHash), {
    storage: cache,
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({ error: "offline" }) }),
  }));
  assert.equal(Submission.acceptedHashes(cache).includes(failedHash), false);
});

test("repeat analysis submits only a newly appended run", async () => {
  const cache = storage();
  const sent = [];
  const fetchImpl = async (_url, options) => {
    sent.push(JSON.parse(options.body).run_hash);
    return { ok: true, status: 201, json: async () => ({ status: "accepted" }) };
  };
  const runs = [payload("1".repeat(64)), payload("2".repeat(64))];
  const build = async (run) => run;
  await Submission.submitRuns(runs, build, { hostname: "arbi.guide", storage: cache, fetchImpl });
  await Submission.submitRuns([...runs, payload("3".repeat(64))], build, { hostname: "arbi.guide", storage: cache, fetchImpl });
  assert.deepEqual(sent.sort(), ["1".repeat(64), "2".repeat(64), "3".repeat(64)]);
});

test("a forced correction bypasses the browser cache but keeps the same run hash", async () => {
  const cache = storage();
  const sent = [];
  const fetchImpl = async (_url, options) => {
    sent.push(JSON.parse(options.body));
    return { ok: true, status: 201, json: async () => ({ status: "accepted" }) };
  };
  const original = payload();
  await Submission.postPayload(original, { fetchImpl, storage: cache });
  const corrected = structuredClone(original);
  corrected.run_metrics.blessed_drone_kills = 60;
  await Submission.postPayload(corrected, { fetchImpl, storage: cache, force: true });
  assert.equal(sent.length, 2);
  assert.equal(sent[0].run_hash, sent[1].run_hash);
  assert.equal(sent[1].run_metrics.blessed_drone_kills, 60);
});

test("non-production hosts never contact the ingestion endpoint", async () => {
  let called = false;
  const result = await Submission.submitRuns([payload()], async (run) => run, {
    hostname: "127.0.0.1",
    fetchImpl: async () => { called = true; },
  });
  assert.equal(result.disabled, true);
  assert.equal(called, false);
});

test("requires a complete duration-balanced 0-50 plus overflow histogram", () => {
  const valid = payload();
  assert.equal(Submission.isValidPayload(valid), true);

  const short = structuredClone(valid);
  short.run_metrics.enemy_count_seconds.pop();
  assert.equal(Submission.isValidPayload(short), false);

  const unbalanced = structuredClone(valid);
  unbalanced.run_metrics.enemy_count_seconds[0] -= 1;
  assert.equal(Submission.isValidPayload(unbalanced), false);
});

test("accepts finalized-window drone intervals and rejects impossible totals", () => {
  const valid = payload();
  assert.equal(Submission.isValidPayload(valid), true);

  const inactive = structuredClone(valid);
  inactive.run_metrics.active_seconds = inactive.run_metrics.mission_seconds + 1;
  assert.equal(Submission.isValidPayload(inactive), false);

  const boundedIntervals = structuredClone(valid);
  boundedIntervals.run_metrics.drone_interval_count -= 4;
  assert.equal(Submission.isValidPayload(boundedIntervals), true);

  const tooManyIntervals = structuredClone(valid);
  tooManyIntervals.run_metrics.drone_interval_count += 1;
  assert.equal(Submission.isValidPayload(tooManyIntervals), false);

  const tooLongSpan = structuredClone(valid);
  tooLongSpan.run_metrics.drone_interval_span_seconds = tooLongSpan.run_metrics.mission_seconds + 1;
  assert.equal(Submission.isValidPayload(tooLongSpan), false);
});

// parser.js and submission.js ship in one Pages bundle but were pinned to the
// schema string independently, so a contract bump could silently close this
// gate and turn every run into an "ineligible" count. Bind them in a test.
function defenseLog() {
  const offset = 1;
  const lines = [`${offset.toFixed(1)} Game [Info]: EliteAlertMission at SolNode130`];
  lines.push(`${(offset + .1).toFixed(1)} Game [Info]: Level=/Lotus/Levels/GrineerAsteroidRelight/GrnDefenseOne.level`);
  lines.push(`${(offset + 1).toFixed(1)} ThemedSquadOverlay.lua: Mission name: Arbitration: Lares (Mercury) - Defense`);
  lines.push(`${(offset + 2).toFixed(1)} WaveDefend.lua: Starting wave 1 (32 simultaneous)`);
  for (let index = 0; index < 48; index += 1) {
    const time = offset + 3 + index * .8;
    const npc = index < 7 ? "CorpusEliteShieldDroneAgent" : "ChargerAgent";
    lines.push(`${time.toFixed(1)} AI [Info]: OnAgentCreated /Npc/${npc}${index + 1} AI [Info]: MonitoredTicking ${index + 1}`);
    if (index < 12) {
      const point = 293 + index % 2;
      const x = point === 293 ? 47 : 15;
      const z = point === 293 ? 50 : 64.5;
      lines.push(`${(time + .01).toFixed(2)} WaveDefend.lua: Spawned a /Npc/ChargerAgent${index + 1} @ Vector(0,0,0), spawn point: /LayerGrnDefenseOne/NpcSpawnPoint${point} @ Vector(${x},0,${z})`);
    }
  }
  lines.push(`${(offset + 42).toFixed(1)} WaveDefend.lua: Defense wave: 1`);
  lines.push(`${(offset + 43).toFixed(1)} Created /Lotus/Interface/DefenseReward.swf`);
  return lines.join("\n");
}

test("the submission gate accepts what parser.js actually builds", async () => {
  const runs = Parser.parseText(defenseLog());
  assert.ok(runs.length >= 1, "the fixture log should produce a run");
  const built = await Parser.buildContribution(runs[0]);
  assert.ok(built, "the fixture run should be eligible to contribute");
  assert.equal(
    Submission.isValidPayload(built),
    true,
    `submission.js rejected a payload parser.js built (schema ${built.schema})`,
  );
});

test("the gate rejects a payload missing the v3 series", () => {
  for (const field of ["rotation_seconds", "rotation_drones", "wave_seconds", "enemy_type_counts"]) {
    const missing = payload();
    delete missing.run_metrics[field];
    assert.equal(Submission.isValidPayload(missing), false, `${field} should be required`);
  }
});

test("the gate rejects impossible v3 series", () => {
  const longerThanActive = payload();
  longerThanActive.run_metrics.rotation_seconds = [570, 1];
  assert.equal(Submission.isValidPayload(longerThanActive), false);

  const mismatchedLengths = payload();
  mismatchedLengths.run_metrics.rotation_drones = [50];
  assert.equal(Submission.isValidPayload(mismatchedLengths), false);

  const moreDronesThanKills = payload();
  moreDronesThanKills.run_metrics.rotation_drones = [80, 80];
  assert.equal(Submission.isValidPayload(moreDronesThanKills), false);

  const overEnemySpawns = payload();
  overEnemySpawns.run_metrics.enemy_type_counts = { EliteRifleLancer: 1001 };
  assert.equal(Submission.isValidPayload(overEnemySpawns), false);

  const tooManyTypes = payload();
  tooManyTypes.run_metrics.enemy_type_counts = Object.fromEntries(
    Array.from({ length: Submission.MAX_ENEMY_TYPES + 1 }, (_, index) => [`Agent${index}`, 1]),
  );
  assert.equal(Submission.isValidPayload(tooManyTypes), false);

  const zeroCount = payload();
  zeroCount.run_metrics.enemy_type_counts = { EliteRifleLancer: 0 };
  assert.equal(Submission.isValidPayload(zeroCount), false);
});
