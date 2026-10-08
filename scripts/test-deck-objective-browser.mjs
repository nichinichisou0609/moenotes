#!/usr/bin/env node
// Targeted production-component and actual Worker/WASM browser checks with synthetic inputs.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [corpusPath, enginePath, outputPath] = process.argv.slice(2);
if (!corpusPath || !enginePath) throw new Error('usage: node scripts/test-deck-objective-browser.mjs CORPUS_DIRECTORY WEB_ENGINE_DIRECTORY [REPORT_JSON]');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const esbuild = await import(process.env.DECK_BROWSER_ESBUILD_MODULE || 'esbuild');
const { chromium } = await import(process.env.DECK_BROWSER_PLAYWRIGHT_MODULE || 'playwright');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const assets = new Map();
for (const [url, path, type] of [
  ['/data.json', resolve(corpusPath, 'data.json'), 'application/json'],
  ['/engine.js', resolve(enginePath, 'ournotes_recommend_wasm.js'), 'text/javascript'],
  ['/engine.wasm', resolve(enginePath, 'ournotes_recommend_wasm_bg.wasm'), 'application/wasm'],
  ['/deck/deck-worker.js', resolve(root, 'public/deck/deck-worker.js'), 'text/javascript'],
  ['/deck/deck-worker-core.mjs', resolve(root, 'public/deck/deck-worker-core.mjs'), 'text/javascript'],
]) assets.set(url, { bytes: await readFile(path), type });
const accountJson = await readFile(resolve(corpusPath, 'account.json'), 'utf8');
const { outputFiles } = await esbuild.build({ entryPoints: [resolve(root, 'tests/browser/deck-objective.tsx')], bundle: true, write: false,
  format: 'esm', platform: 'browser', jsx: 'automatic', tsconfig: resolve(root, 'tsconfig.json'),
  nodePaths: process.env.DECK_BROWSER_NODE_PATH ? [process.env.DECK_BROWSER_NODE_PATH] : [],
  define: { 'import.meta.env': '{}', 'process.env.NODE_ENV': '"production"' } });
assets.set('/test.js', { bytes: outputFiles[0].contents, type: 'text/javascript' });
let origin;
const server = createServer((req, res) => {
  if (req.url === '/') {
    const entry = url => ({ url: origin + url, sha256: hash(assets.get(url).bytes), bytes: assets.get(url).bytes.byteLength });
    const bootstrap = { accountJson, runtime: { server: 'jp', pointer: { kind: 'build', url: origin + '/synthetic-build.json' },
      manifest: { url: origin + '/synthetic-manifest.json', sha256: '0'.repeat(64) }, deckData: entry('/data.json'),
      engine: { model: null, js: entry('/engine.js'), wasm: entry('/engine.wasm'), build: null }, modelCommit: null, override: true },
      event: { id: 7, name: 'Synthetic event', startAt: '2030/01/01 00:00:00+09:00', endAt: '2030/02/01 00:00:00+09:00', itemId: 9,
        challengeMusics: [{ id: 70, musicId: 10 }] },
      input: { musicId: 10, difficulty: 'expert', challengeMusicId: 70, arenaMusicId: 80,
        playMode: 'pattern', missEvery: 3, greatPercent: 20, justPercent: 80, boosts: 3, challengePoints: 200,
        othersAverageScore: 12345, selectedRewards: [5], rewardContextConfirmed: true, localEventPoints: 0, localChallengePoints: 500 } };
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><div id="root"></div><script>window.deckBootstrap=' + JSON.stringify(bootstrap).replace(/</g, '\\u003c') + '</script><script type="module" src="/test.js"></script>');
  } else if (assets.has(req.url)) { const asset = assets.get(req.url); res.writeHead(200, { 'Content-Type': asset.type }); res.end(asset.bytes); }
  else { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
origin = `http://127.0.0.1:${server.address().port}`;
let browser;
const report = { scope: 'synthetic production components and actual Worker/WASM; not deployed-site E2E',
  runtime: Object.fromEntries(['/data.json', '/engine.js', '/engine.wasm'].map(url => [url.slice(1), { sha256: hash(assets.get(url).bytes), bytes: assets.get(url).bytes.byteLength }])),
  accountSha256: hash(accountJson), checks: [], searches: [] };
try {
  browser = await chromium.launch({ headless: true, ...(process.env.DECK_BROWSER_CHROMIUM ? { executablePath: process.env.DECK_BROWSER_CHROMIUM } : {}), args: ['--no-sandbox'] });
  report.browser = browser.version();
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  await page.waitForFunction(() => !!window.deckTest, null, { timeout: 60_000 });
  const snapshot = () => page.evaluate(() => ({ input: window.deckTest.input, requestRaw: window.deckTest.request, request: JSON.parse(window.deckTest.request),
    canRun: window.deckTest.canRun, effective: window.deckTest.effective }));
  const select = async goal => { await page.getByLabel('Test scene').selectOption(goal); await page.waitForFunction(goal => window.deckTest.input.goal === goal, goal); };
  const toggle = async aggregation => { await page.locator(`input[value="${aggregation}"]`).check(); await page.waitForFunction(aggregation => window.deckTest.input.aggregation === aggregation, aggregation); };
  for (const goal of ['free', 'challenge']) {
    await select(goal); await toggle('expected'); const before = await snapshot();
    assert.equal(before.canRun, true); await toggle('maximum'); const after = await snapshot();
    assert.deepEqual(after.input, { ...before.input, aggregation: 'maximum' });
    assert.deepEqual(after.request, { ...before.request, aggregation: 'maximum' });
    assert.equal(after.requestRaw.replace(',"aggregation":"maximum"', ''), before.requestRaw);
    for (const aggregation of ['maximum', 'expected']) {
      await toggle(aggregation); const state = await snapshot();
      const answer = await page.evaluate(() => window.deckTest.run());
      assert.equal(answer.status, 'ok'); assert.equal(answer.final, true); assert.equal(answer.result.aggregation, aggregation);
      assert.equal(answer.result.exitReason, 'exhausted'); assert.equal(answer.result.optimality.proven, true);
      assert.equal(answer.result.teams.length, 5);
      if (aggregation === 'maximum') assert.equal(answer.result.maximumModel, 'independentNativeDrawSupport');
      report.searches.push({ goal, aggregation, requestSha256: hash(state.requestRaw), status: answer.status,
        proven: answer.result.optimality.proven, exitReason: answer.result.exitReason, teamCount: answer.result.teams.length });
    }
    report.checks.push(`${goal}: objective switch preserves every other input and generated request field`);
  }
  await select('free'); await toggle('maximum'); const beforeGekisou = await snapshot();
  for (const goal of ['battle', 'mission', 'arena']) {
    await select(goal); assert.equal(await page.locator('input[type="radio"]').count(), 0);
    const state = await snapshot(); assert.equal(state.effective.aggregation, 'expected'); assert.equal(state.request.aggregation, undefined);
    assert.deepEqual(state.input, { ...beforeGekisou.input, goal });
  }
  await select('free'); assert.equal(await page.locator('input[value="maximum"]').isChecked(), true);
  assert.deepEqual((await snapshot()).input, beforeGekisou.input);
  report.checks.push('Gekisou hides the objective switch, requests Expected, and retains Maximum for returning to Free');
  for (const state of ['unsupported', 'loading']) {
    await page.evaluate(state => window.deckTest.setEngine(state), state);
    await page.waitForFunction(() => !window.deckTest.canRun);
    assert.equal(await page.locator('input[value="maximum"]').isChecked(), true);
    assert.equal(await page.locator('input[value="maximum"]').isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: 'Search', exact: true }).isDisabled(), true);
    await assert.rejects(page.evaluate(() => window.deckTest.run()), /Search is blocked/);
    assert.deepEqual((await snapshot()).input, beforeGekisou.input);
    report.checks.push(`${state}: Maximum stays selected and disabled; search is blocked without changing inputs`);
  }
  assert.deepEqual(errors, []);
  report.status = 'passed';
  if (outputPath) await writeFile(resolve(outputPath), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
