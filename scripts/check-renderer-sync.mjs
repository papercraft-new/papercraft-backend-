#!/usr/bin/env node
// Verifies the shared paper renderer is identical in the frontend and backend repos.
//
//   frontend:  src/lib/paperRenderer.ts
//   backend:   src/services/paperRenderer.ts
//
// Usage (same file lives in both repos):
//   npm run check:renderer                     # looks for the other repo next to this one
//   npm run check:renderer -- --peer ../my-backend-folder
//   PAPER_RENDERER_PEER=../my-backend-folder npm run check:renderer
//
// Exit codes: 0 = identical, 1 = copies differ, 2 = other repo not found.
// Line endings (CRLF vs LF) and trailing blank lines are ignored.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const FRONTEND_FILE = 'src/lib/paperRenderer.ts';
const BACKEND_FILE = 'src/services/paperRenderer.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const isFrontend = existsSync(join(repoRoot, FRONTEND_FILE));
const isBackend = existsSync(join(repoRoot, BACKEND_FILE));

if (!isFrontend && !isBackend) {
  console.error('This repo has neither ' + FRONTEND_FILE + ' nor ' + BACKEND_FILE + '.');
  process.exit(2);
}

const here = isFrontend ? 'frontend' : 'backend';
const hereFile = join(repoRoot, isFrontend ? FRONTEND_FILE : BACKEND_FILE);
const peerRel = isFrontend ? BACKEND_FILE : FRONTEND_FILE;
const peerName = isFrontend ? 'backend' : 'frontend';

function findPeerRoot() {
  const argIdx = process.argv.indexOf('--peer');
  const explicit = (argIdx > -1 && process.argv[argIdx + 1]) || process.env.PAPER_RENDERER_PEER;
  if (explicit) return resolve(process.cwd(), explicit);
  const parent = dirname(repoRoot);
  for (const name of readdirSync(parent)) {
    const dir = join(parent, name);
    if (dir === repoRoot || !statSync(dir).isDirectory()) continue;
    if (existsSync(join(dir, peerRel))) return dir;
  }
  return null;
}

const normalise = (text) => text.replace(/\r\n/g, '\n').replace(/\s+$/, '') + '\n';
const sha = (text) => createHash('sha256').update(text).digest('hex').slice(0, 12);

const peerRoot = findPeerRoot();
const peerFile = peerRoot ? join(peerRoot, peerRel) : null;
if (!peerFile || !existsSync(peerFile)) {
  console.error('Could not find the ' + peerName + ' copy (' + peerRel + ').');
  console.error('Pass its folder:  npm run check:renderer -- --peer ../your-' + peerName + '-folder');
  process.exit(2);
}

const mine = normalise(readFileSync(hereFile, 'utf8'));
const theirs = normalise(readFileSync(peerFile, 'utf8'));

if (mine === theirs) {
  console.log('OK  paperRenderer.ts is identical in frontend and backend (' + sha(mine) + ').');
  process.exit(0);
}

const a = mine.split('\n');
const b = theirs.split('\n');
let line = 0;
while (line < Math.max(a.length, b.length) && a[line] === b[line]) line++;
console.error('MISMATCH  paperRenderer.ts differs between frontend and backend.');
console.error('  ' + here + ' : ' + hereFile + '  (' + sha(mine) + ')');
console.error('  ' + peerName + ': ' + peerFile + '  (' + sha(theirs) + ')');
console.error('First difference at line ' + (line + 1) + ':');
console.error('  ' + here + ' : ' + (a[line] ?? '<end of file>').slice(0, 140));
console.error('  ' + peerName + ': ' + (b[line] ?? '<end of file>').slice(0, 140));
console.error('Fix: copy the frontend file (src/lib/paperRenderer.ts) over the backend one (src/services/paperRenderer.ts).');
process.exit(1);
