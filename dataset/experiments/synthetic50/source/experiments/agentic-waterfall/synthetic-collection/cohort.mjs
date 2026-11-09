import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { checkpointsFor, constraintRoundsFor, phaseAt, referenceFit, referenceItem, ROUNDS, sha } from './collection.mjs';

const ambiguity = 'behavior_ambiguity', interactive = 'interactive_revision';
const stages = ['general', ambiguity, interactive];
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const validHard = hard => hard && typeof hard === 'object' && !Array.isArray(hard) &&
  Object.keys(hard).every(key => ['modality', 'max_duration_seconds'].includes(key)) &&
  (hard.modality === undefined || ['video', 'text'].includes(hard.modality)) &&
  (hard.max_duration_seconds === undefined || hard.modality === 'video' && Number.isInteger(hard.max_duration_seconds) && hard.max_duration_seconds > 0);

function plannedCheckpoints(persona, length, pinned) {
  const { id, pair, phases, subset } = persona;
  const bandCount = Math.min(length, 5);
  const bands = Array.from({ length: bandCount }, (_, i) => [Math.floor(length * i / bandCount) + 1, Math.floor(length * (i + 1) / bandCount)]);
  const anchors = [];
  if (pair) {
    anchors.push(phases[1].start - 1);
    bands.push([phases[1].start, phases[2].start - 1], [phases[2].start, length]);
  } else if (subset === interactive) {
    anchors.push(...phases.slice(1).flatMap(({ start }) => [start - 1, start]));
    bands.push([phases.at(-1).start + 1, length]);
  }
  const covers = (selected, [start, end]) => selected.some(round => round >= start && round <= end);
  if (pinned !== undefined) {
    assert(Array.isArray(pinned) && pinned.every((round, i) => Number.isInteger(round) && round >= 1 && round <= length &&
      (!i || round > pinned[i - 1])), id + ': invalid checkpoint order or bounds');
    assert(anchors.every(round => pinned.includes(round)), id + ': missing required checkpoint');
    assert(bands.every(band => covers(pinned, band)), id + ': checkpoints do not cover the planned trajectory');
    return pinned;
  }
  const selected = [...anchors];
  for (const [start, end] of bands) {
    if (covers(selected, [start, end])) continue;
    const seed = sha(JSON.stringify([pair || id, length, start, end])).slice(0, 8);
    selected.push(start + Number.parseInt(seed, 16) % (end - start + 1));
  }
  return selected.sort((a, b) => a - b);
}

export function loadCohort(path) {
  const manifest = readFileSync(path);
  const plan = JSON.parse(manifest);
  const variable = plan.schema_version === 'awf-synthetic-cohort/1.1';
  assert(variable || plan.schema_version === 'awf-synthetic-cohort/1.0', 'unsupported cohort version');
  const archive = resolve(dirname(resolve(path)), plan.reference_archive);
  const bytes = readFileSync(archive);
  assert.equal(sha(bytes), plan.reference_archive_sha256, 'reference archive hash changed');
  const catalog = new Map(gunzipSync(bytes).toString('utf8').split('\n').filter(Boolean).map(JSON.parse)
    .filter(row => row.canonical_url?.startsWith('https://') && nonempty(row.title) && typeof row.summary === 'string' &&
      ['text', 'video'].includes(row.metadata?.modality))
    .map(row => [row.content_version_id, referenceItem(row)]));
  assert(Array.isArray(plan.participants) && plan.participants.length >= 3, 'cohort needs participants');
  const people = new Map(), decks = new Map(), checkpoints = new Map(), pairs = new Map(), backgrounds = new Set(), independentDecks = new Map();
  for (const { persona, rounds, checkpoints: pinned } of plan.participants) {
    const { id, subset, pair, phases } = persona;
    assert(/^u\d+$/.test(id) && !people.has(id), 'invalid or duplicate participant');
    assert(stages.includes(subset) && persona.origin === 'synthetic' && persona.schema_version === 'awf-persona/1.0', id + ': invalid persona origin or subset');
    assert(Array.isArray(rounds) && (variable ? rounds.length >= 1 && rounds.length <= 32 : rounds.length === ROUNDS), id + ': wrong round count');
    assert(typeof persona.public_profile === 'string' && persona.public_profile.length <= 2000 &&
      nonempty(persona.hidden_profile) && persona.hidden_profile.length <= 8000 && !backgrounds.has(persona.hidden_profile), id + ': invalid or repeated profile');
    backgrounds.add(persona.hidden_profile);
    assert(Array.isArray(persona.public_interests) && persona.public_interests.length <= 60 &&
      persona.public_interests.every(value => nonempty(value) && value.length <= 40), id + ': invalid public interests');
    assert(Array.isArray(phases) && phases[0]?.start === 1 && phases.every((phase, index) =>
      Number.isInteger(phase.start) && phase.start <= rounds.length && (!index || phase.start > phases[index - 1].start) &&
      nonempty(phase.goal) && nonempty(phase.focus) && typeof phase.command === 'string' && phase.command.length <= 1000 &&
      validHard(phase.hard)), id + ': invalid phase plan');
    assert(subset === ambiguity ? nonempty(pair) : pair == null, id + ': wrong pair membership');
    if (subset === interactive) {
      if (variable) {
        assert(phases.length === 4 && phases.at(-1).start < rounds.length && phases.slice(1).every((phase, i) =>
          phase.start >= phases[i].start + 2), id + ': invalid instruction schedule');
      } else {
        assert.deepEqual(phases.map(phase => phase.start), [1, 6, 11, 16], id + ': invalid instruction schedule');
      }
      const [initial, current, strict, relaxed] = phases;
      assert(phases.every(phase => nonempty(phase.command)) && initial.focus !== current.focus && strict.focus === current.focus &&
        relaxed.focus === current.focus && current.goal === strict.goal && current.goal === relaxed.goal, id + ': invalid task or constraint transition');
      assert.deepEqual(relaxed.hard, current.hard, id + ': relaxation must preserve other requirements');
      assert(Object.entries(current.hard).every(([key, value]) => strict.hard[key] === value) &&
        Object.keys(strict.hard).length > Object.keys(current.hard).length, id + ': strict phase must add a constraint');
    } else {
      assert(phases.every(phase => !phase.command && !Object.keys(phase.hard).length), id + ': unexpected instructions or hard requirements');
      if (pair) {
        if (variable) assert.equal(phases.length, 3, id + ': invalid ambiguity schedule');
        else assert.deepEqual(phases.map(phase => phase.start), [1, 5, 13], id + ': invalid ambiguity schedule');
      }
    }
    const deck = rounds.map((items, i) => {
      assert(Array.isArray(items) && items.length === 5, id + ': wrong card count at round ' + (i + 1));
      return items.map(({ tag, version_id }) => {
        assert(nonempty(tag) && catalog.has(version_id), id + ': reference card is outside the pinned archive');
        return { tag, card: catalog.get(version_id) };
      });
    });
    if (pair) for (const [i, items] of deck.slice(0, phases[1].start - 1).entries()) {
      assert(items.some(item => item.tag === phases[0].focus), id + ': missing shared opening material at round ' + (i + 1));
    }
    const material = deck.flat().map(({ card }) => card.id);
    assert.equal(new Set(material).size, material.length, id + ': repeated reference card within participant');
    const signature = sha(JSON.stringify(material.sort()));
    const owner = pair ? 'pair:' + pair : id;
    assert(!independentDecks.has(signature) || independentDecks.get(signature) === owner, id + ': duplicate independent deck');
    independentDecks.set(signature, owner);
    for (const phase of phases) {
      const hits = deck.filter((items, i) => phaseAt(persona, i + 1) === phase &&
        items.some(item => item.tag === phase.focus && referenceFit(item.card, phase.hard) === true)).length;
      assert(hits >= (pair ? 2 : 1), id + ': no sufficient reference opportunities at round ' + phase.start);
    }
    if (subset === interactive) for (const round of constraintRoundsFor(persona)) {
      const strict = phases[2], checks = deck[round - 1].filter(item => item.tag === strict.focus).map(item => referenceFit(item.card, strict.hard));
      assert(checks.includes(true) && checks.includes(false), id + ': no verifiable contrast at round ' + round);
    }
    if (pair) pairs.set(pair, [...(pairs.get(pair) || []), persona]);
    people.set(id, persona);
    decks.set(id, deck);
    checkpoints.set(id, variable ? plannedCheckpoints(persona, rounds.length, pinned) : checkpointsFor(persona));
  }
  for (const [id, personas] of pairs) {
    assert.equal(personas.length, 2, id + ': matched pair needs two participants');
    const [a, b] = personas;
    assert.equal(a.public_profile, b.public_profile, id + ': public profiles differ');
    assert.deepEqual(a.public_interests, b.public_interests, id + ': public interests differ');
    assert.deepEqual(decks.get(a.id), decks.get(b.id), id + ': matched exposure differs');
    assert.deepEqual(a.phases.map(phase => phase.start), b.phases.map(phase => phase.start), id + ': matched phase schedule differs');
    assert.deepEqual(checkpoints.get(a.id), checkpoints.get(b.id), id + ': matched checkpoints differ');
    assert(a.phases[0].focus === b.phases[0].focus && a.phases[1].focus !== b.phases[1].focus &&
      (a.phases[1].focus === a.phases[2].focus) !== (b.phases[1].focus === b.phases[2].focus), id + ': matched stages cannot distinguish persistence and switching');
  }
  const pilot = plan.pilot_users?.map(id => people.get(id));
  assert(pilot?.length === 3 && pilot.every(Boolean) && new Set(plan.pilot_users).size === 3, 'three distinct pilot participants are required');
  const pilotPair = pilot.filter(persona => persona.subset === ambiguity);
  assert(pilotPair.length === 2 && pilotPair[0].pair === pilotPair[1].pair && pilot.some(persona => persona.subset === interactive), 'pilot needs a matched pair and one interactive participant');
  const personas = [...people.values()];
  return {
    personas, decks, checkpoints, pilotUsers: plan.pilot_users,
    manifest: { path: resolve(path), sha256: sha(manifest), archive, archive_sha256: plan.reference_archive_sha256 },
    counts: Object.fromEntries(stages.map(subset => [subset, personas.filter(persona => persona.subset === subset).length])),
    unique_materials: new Set([...decks.values()].flat(2).map(({ card }) => card.id)).size,
  };
}
