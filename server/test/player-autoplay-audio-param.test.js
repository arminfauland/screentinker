'use strict';

/*
 * #627: `?autoplay_audio=1` lets a kiosk browser that allows sound without a gesture (Fully Kiosk
 * Browser with "Autoplay Audio") start with sound, by taking the "Tap anywhere to start" tap itself.
 *
 * Two ways this goes wrong, both seen or nearly seen on a real device:
 *
 *  1. THE TAP RUNS TOO EARLY. The tap handler calls connect(), which reaches `let` bindings declared
 *     further down the boot script. Run synchronously from the overlay setup, it hit them in their
 *     temporal dead zone, threw, and the player never connected. It has to run after the script.
 *  2. THE BROWSER SAYS NO. With the parameter set but sound not actually allowed, the player must
 *     carry on exactly as without it: overlay stays, a tap still works, auto-dismiss connects muted.
 *
 * The block is evaluated on its own with stand-ins for the overlay, the probe and the timers, so
 * both are checked by behaviour rather than by the shape of the source.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PLAYER_DIR = path.join(__dirname, '..', 'player');
const PLAYER = fs.readFileSync(path.join(PLAYER_DIR, 'index.html'), 'utf8');

// The `if (autoplayAudioRequested()) { … }` block from the boot section, braces balanced.
function autoplayBlock(src) {
  const start = src.indexOf('if (autoplayAudioRequested()) {');
  assert.ok(start > 0, 'autoplay_audio block not found in the boot section');
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error('unbalanced braces in the autoplay_audio block');
}

function fnSource(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start > 0, `${name}() not found`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces in ${name}()`);
}

/*
 * Runs the block the way boot does: inside one script, followed by a `let` declared AFTER it that
 * the tap handler reads (standing in for what connect() reaches). A synchronous tap throws a
 * ReferenceError right here; a deferred one sees the initialised value.
 */
function runBoot({ requested = true, allowed = true, tappedBeforeTimer = false } = {}) {
  const timers = [];
  const taps = [];
  const sandbox = {
    console: { log() {}, warn() {} },
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    autoplayAudioRequested: () => requested,
    probeUnmutedAutoplay: () => Promise.resolve(allowed),
    taps,
  };
  const script = `
    (function boot() {
      const tapOverlay = { parentNode: {}, onclick() { taps.push(connectState); this.parentNode = null; } };
      globalThis.__overlay = tapOverlay;
      ${autoplayBlock(PLAYER)}
      let connectState = 'initialised';   // declared after the block, like the bindings connect() reads
    })();`;
  vm.runInNewContext(script, sandbox);
  return {
    taps,
    async flush() {
      if (tappedBeforeTimer) sandbox.__overlay.parentNode = null;
      while (timers.length) timers.shift()();
      for (let i = 0; i < 5; i++) await Promise.resolve();   // let the probe's .then run
    },
  };
}

test('the automatic tap is deferred past the end of the boot script (no TDZ throw)', async () => {
  let boot;
  assert.doesNotThrow(() => { boot = runBoot(); },
    'the block tapped synchronously and read a `let` declared after it — the player would never connect');
  assert.equal(boot.taps.length, 0, 'no tap may happen during the boot script itself');
  await boot.flush();
  assert.deepEqual(boot.taps, ['initialised'], 'after the script, the tap runs once and sees initialised bindings');
});

test('sound refused: the overlay is left alone, so the muted 5-second path runs as before', async () => {
  const boot = runBoot({ allowed: false });
  await boot.flush();
  assert.equal(boot.taps.length, 0);
});

test('without the parameter nothing changes', async () => {
  const boot = runBoot({ requested: false });
  await boot.flush();
  assert.equal(boot.taps.length, 0);
});

test('a person who tapped first is not tapped for a second time', async () => {
  const boot = runBoot({ tappedBeforeTimer: true });
  await boot.flush();
  assert.equal(boot.taps.length, 0);
});

test('autoplayAudioRequested() is true only for autoplay_audio=1', () => {
  const check = (search) => vm.runInNewContext(
    `${fnSource(PLAYER, 'autoplayAudioRequested')}; autoplayAudioRequested()`,
    { location: { search }, URLSearchParams });
  assert.equal(check('?autoplay_audio=1'), true);
  assert.equal(check('?host=android&autoplay_audio=1'), true);
  assert.equal(check(''), false);
  assert.equal(check('?autoplay_audio=0'), false);
  assert.equal(check('?autoplay_audio=true'), false);
});

describeProbe();
function describeProbe() {
  const run = (play, { paused = true } = {}) => {
    const timers = [];
    const sandbox = {
      setTimeout: (fn, ms) => { timers.push({ fn, ms }); },
      document: { createElement: () => ({ play, pause() {}, paused, muted: true }) },
      Promise,
    };
    const p = vm.runInNewContext(`${fnSource(PLAYER, 'probeUnmutedAutoplay')}; probeUnmutedAutoplay()`, sandbox);
    return { p, fireTimers: () => timers.splice(0).forEach((t) => t.fn()) };
  };

  test('probe: play() resolves → sound allowed', async () => {
    const { p } = run(() => Promise.resolve());
    assert.equal(await p, true);
  });

  test('probe: play() rejects (NotAllowedError) → refused', async () => {
    const { p } = run(() => Promise.reject(Object.assign(new Error('x'), { name: 'NotAllowedError' })));
    assert.equal(await p, false);
  });

  test('probe: play() never settles → refused after the timeout, never hangs', async () => {
    const { p, fireTimers } = run(() => new Promise(() => {}));
    fireTimers();
    assert.equal(await p, false);
  });

  test('probe: play() throws → refused, does not reject', async () => {
    const { p } = run(() => { throw new Error('boom'); });
    assert.equal(await p, false);
  });

  test('probe: the clip is a playable inline WAV (no request, no CORS)', () => {
    const src = fnSource(PLAYER, 'probeUnmutedAutoplay');
    const m = src.match(/a\.src = '(data:audio\/wav;base64,[^']+)'/);
    assert.ok(m, 'probe clip must be an inline data: WAV');
    const buf = Buffer.from(m[1].split(',')[1], 'base64');
    assert.equal(buf.toString('ascii', 0, 4), 'RIFF');
    assert.equal(buf.toString('ascii', 8, 12), 'WAVE');
    assert.equal(buf.readUInt32LE(4), buf.length - 8, 'RIFF size must match the clip');
  });
}

test('the legacy player was rebuilt with the same change', () => {
  const legacy = fs.readFileSync(path.join(PLAYER_DIR, 'legacy.html'), 'utf8');
  assert.ok(legacy.includes('autoplayAudioRequested') && legacy.includes('probeUnmutedAutoplay'),
    'legacy.html lacks the autoplay_audio change; run npm run build:legacy-player');
});
