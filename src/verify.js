'use strict';

/**
 * Recompute every hash of one or more saved runs and report mismatches.
 *
 *   npm run verify                      all runs under output/
 *   npm run verify -- <runDir> [...]    specific run folders
 *   npm run verify -- --hash <runDir>   add hashes to a run saved without them (backfill)
 *
 * Exit code 1 if any run fails verification.
 */

const path = require('node:path');
const fs = require('node:fs');
const { hashRun, verifyRun, listRunDirs } = require('./hash');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.join(ROOT, 'output');
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--hash') {
    for (const d of args.slice(1)) {
      const r = await hashRun(path.resolve(d));
      console.log(`Hashed ${rel(path.resolve(d))}: ${r.posts} posts, ${r.images} images, posts.json ${r.postsJsonSha256}`);
    }
    return;
  }
  const dirs = args.length ? args.map((d) => path.resolve(d)) : listRunDirs(OUTPUT);
  if (dirs.length === 0) {
    console.log('No runs found under output/.');
    return;
  }
  let bad = 0;
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      console.log(`FAIL  ${dir}: folder not found`);
      bad++;
      continue;
    }
    const r = await verifyRun(dir);
    const images = r.posts.flatMap((p) => p.images);
    const imgOk = images.filter((i) => i.ok).length;
    console.log(`${r.ok ? 'OK  ' : 'FAIL'}  ${rel(dir)}  posts.json ${r.manifest.ok ? 'ok' : 'MISMATCH'} · ` +
      `posts ${r.posts.filter((p) => p.content.ok).length}/${r.posts.length} · images ${imgOk}/${images.length} · ` +
      `${r.totals.passed}/${r.totals.checks} checks passed`);
    for (const p of r.problems) console.log(`        - ${p}`);
    if (!r.ok) bad++;
  }
  console.log(bad ? `\n${bad} of ${dirs.length} run(s) FAILED verification.` : `\nAll ${dirs.length} run(s) verified.`);
  process.exitCode = bad ? 1 : 0;
}

main().catch((e) => {
  console.error(e?.message || e);
  process.exitCode = 1;
});
