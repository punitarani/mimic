import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  type FootprintDoc,
  type ParseReport,
  parseGitHub,
  parseLinkedIn,
  parseReddit,
  parseText,
  parseXArchive,
} from '@mimic/core';

/**
 * `mimic-eval footprint` (ADR-0059): finds the person's own export files in a folder and runs the core parsers on
 * them. The folder is read as the person dropped it: an X archive's `data/tweets.js`, LinkedIn's CSVs, Reddit's
 * `posts.csv` and `comments.csv`, a `github.json` with `{ user, repos }`, and any `.txt` or `.md` notes.
 */

export interface FileReport {
  file: string;
  docs: number;
  dropped: ParseReport['dropped'];
}

function walk(dir: string, depth = 0): string[] {
  if (depth > 3 || !existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, depth + 1));
    else out.push(p);
  }
  return out;
}

const read = (p: string) => readFileSync(p, 'utf8');

export function parseFootprintDir(dir: string): { docs: FootprintDoc[]; reports: FileReport[] } {
  const files = walk(dir);
  const byName = (name: string) => files.find((f) => basename(f).toLowerCase() === name.toLowerCase());
  const reports: FileReport[] = [];
  const docs: FootprintDoc[] = [];
  const add = (file: string, r: ParseReport) => {
    reports.push({ file: basename(file), docs: r.docs.length, dropped: r.dropped });
    docs.push(...r.docs);
  };
  const tweets = byName('tweets.js') ?? byName('tweet.js');
  if (tweets) add(tweets, parseXArchive(read(tweets)));
  const li = {
    profile: byName('Profile.csv'),
    positions: byName('Positions.csv'),
    education: byName('Education.csv'),
    skills: byName('Skills.csv'),
    shares: byName('Shares.csv'),
  };
  const liFiles = Object.values(li).filter((f): f is string => !!f);
  if (liFiles.length)
    add(
      'LinkedIn (*.csv)',
      parseLinkedIn({
        ...(li.profile ? { profile: read(li.profile) } : {}),
        ...(li.positions ? { positions: read(li.positions) } : {}),
        ...(li.education ? { education: read(li.education) } : {}),
        ...(li.skills ? { skills: read(li.skills) } : {}),
        ...(li.shares ? { shares: read(li.shares) } : {}),
      }),
    );
  const posts = byName('posts.csv');
  const comments = byName('comments.csv');
  if (posts || comments)
    add(
      'Reddit (posts, comments)',
      parseReddit({
        ...(posts ? { posts: read(posts) } : {}),
        ...(comments ? { comments: read(comments) } : {}),
      }),
    );
  const gh = byName('github.json');
  if (gh) add(gh, parseGitHub(JSON.parse(read(gh)) as Parameters<typeof parseGitHub>[0]));
  for (const f of files.filter((x) => /\.(txt|md)$/i.test(x))) add(f, parseText(read(f)));
  // A document that two files both carry (a note pasted twice) counts once.
  const seen = new Set<string>();
  return { docs: docs.filter((d) => !seen.has(d.id) && seen.add(d.id)), reports };
}
