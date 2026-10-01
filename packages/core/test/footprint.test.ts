import { describe, expect, it } from 'vitest';
import {
  footprintDistribution,
  parseCsv,
  parseGitHub,
  parseLinkedIn,
  parseReddit,
  parseText,
  parseXArchive,
  parseYtd,
  scrubIdentifiers,
  selectDocs,
  sensitiveAreasOf,
} from '../src';

const tweets = `window.YTD.tweets.part0 = [
  { "tweet": { "id_str": "1", "created_at": "Wed Mar 05 10:00:00 +0000 2025", "full_text": "Shipped the rough version today instead of polishing for another week. Feedback beats guessing. https://t.co/abc" } },
  { "tweet": { "id_str": "2", "created_at": "Thu Mar 06 10:00:00 +0000 2025", "full_text": "RT @someone_else: a thread about polishing" } },
  { "tweet": { "id_str": "3", "created_at": "Fri Mar 07 10:00:00 +0000 2025", "full_text": "@friend_handle agreed, I'd rather book the direct flight and keep the evening", "in_reply_to_status_id_str": "99" } },
  { "tweet": { "id_str": "4", "created_at": "Sat Mar 08 10:00:00 +0000 2025", "full_text": "Voted early this morning, the election queue was short" } },
  { "tweet": { "id_str": "5", "created_at": "Sun Mar 09 10:00:00 +0000 2025", "full_text": "ok" } },
  { "tweet": { "id_str": "6", "created_at": "Mon Mar 10 10:00:00 +0000 2025", "full_text": "Shipped the rough version today instead of polishing for another week. Feedback beats guessing." } }
]`;

describe('footprint parsers and hygiene (ADR-0057)', () => {
  it('reads an X archive: own posts only, scrubbed, deduplicated, with sensitive posts dropped', () => {
    expect(parseYtd(tweets)).toHaveLength(6);
    const r = parseXArchive(tweets);
    expect(r.docs.map((d) => d.text)).toEqual([
      'Shipped the rough version today instead of polishing for another week. Feedback beats guessing.',
    ]);
    expect(r.docs[0]!.at).toBe(Date.parse('Wed Mar 05 10:00:00 +0000 2025'));
    expect(r.dropped).toEqual({ empty: 1, notOwn: 1, sensitive: 1, duplicate: 1 });
    // Replies are the person's words too, when asked for; the handle they answered is never kept.
    const withReplies = parseXArchive(tweets, { replies: true });
    expect(withReplies.docs.map((d) => d.kind)).toEqual(['post', 'comment']);
    expect(withReplies.docs[1]!.text).toBe(
      "@someone agreed, I'd rather book the direct flight and keep the evening",
    );
    // Content-hashed ids are stable across parses.
    expect(parseXArchive(tweets).docs[0]!.id).toBe(r.docs[0]!.id);
  });

  it('scrubs handles, links, emails and phone numbers, and spots sensitive text', () => {
    expect(
      scrubIdentifiers('Mail me at pat@example.com or +44 7700 900123, see https://x.y/z and @pat_doe'),
    ).toBe('Mail me at or , see and @someone');
    expect(sensitiveAreasOf('I pray every morning before work')).toEqual(['religion']);
    expect(sensitiveAreasOf('Got my diagnosis back from the doctor')).toEqual(['health']);
    expect(sensitiveAreasOf('Picked the cheaper flight with a layover')).toEqual([]);
  });

  it("reads LinkedIn and Reddit CSV exports and GitHub JSON, keeping only the person's own words", () => {
    expect(parseCsv('a,b\n"x, y","he said ""hi"""\r\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'he said "hi"'],
    ]);
    const li = parseLinkedIn({
      profile:
        'First Name,Last Name,Headline,Summary,Industry\nPat,Doe,Builds data tools,"I like shipping small things often, then fixing what breaks.",Software',
      positions:
        'Company Name,Title,Description,Location,Started On,Finished On\nAcme,Data engineer,"Built the pipeline that nobody wanted to own, because it was blocking three teams.",Leeds,Jan 2022,\n',
      skills: 'Name\nSQL\nPython\n',
      shares:
        'Date,ShareLink,ShareCommentary,SharedUrl,MediaUrl,Visibility\n2025-01-02,l,"Hiring managers: a short take-home beats a long interview loop",u,,MEMBER_NETWORK\n2025-01-03,l,,u,,MEMBER_NETWORK\n',
    });
    expect(li.docs.map((d) => d.kind)).toEqual(['profile', 'position', 'skills', 'post']);
    expect(li.docs[1]!.text).toContain('Data engineer at Acme (Jan 2022 – now)');
    expect(JSON.stringify(li.docs)).not.toContain('Pat');
    expect(li.dropped.empty).toBe(1); // the share with no commentary
    const rd = parseReddit({
      posts:
        'id,permalink,date,ip,subreddit,gildings,title,url,body\n1,p,2025-02-01 10:00:00 UTC,0.0.0.0,personalfinance,0,Paying off the car early,,"I would rather be debt free than hold cash, even at a low rate."',
      comments:
        'id,permalink,date,ip,subreddit,gildings,link,parent,body\n2,p,2025-02-02 10:00:00 UTC,0.0.0.0,cooking,0,l,p,"> someone said to brine\nI never brine, too much planning for a weeknight."',
    });
    expect(rd.docs.map((d) => [d.kind, d.where])).toEqual([
      ['post', 'personalfinance'],
      ['comment', 'cooking'],
    ]);
    expect(rd.docs[1]!.text).toBe('I never brine, too much planning for a weeknight.');
    const gh = parseGitHub({
      user: { bio: 'Tools for people who hate tools.' },
      repos: [
        {
          name: 'quickship',
          description: 'Deploy in one command',
          language: 'Go',
          topics: ['cli', 'deploy'],
          stargazers_count: 12,
          pushed_at: '2025-05-01T00:00:00Z',
        },
        { name: 'forked-thing', description: 'A fork', fork: true },
      ],
    });
    expect(gh.docs.map((d) => d.kind)).toEqual(['profile', 'repo']);
    expect(gh.docs[1]!.text).toContain('Repository quickship (Go), 12 stars');
    expect(gh.dropped.notOwn).toBe(1);
  });

  it('selects the most recent documents within a budget and spreads an implied answer', () => {
    const docs = parseText(
      'An old note about planning.\n\nA newer note about shipping early and often, which is longer.',
    ).docs;
    docs[0]!.at = 1;
    docs[1]!.at = 2;
    expect(selectDocs(docs, 20).map((d) => d.at)).toEqual([2]);
    expect(selectDocs(docs, 100).map((d) => d.at)).toEqual([2, 1]);
    const dist = footprintDistribution(
      {
        options: [
          { key: 'a', label: 'A' },
          { key: 'b', label: 'B' },
          { key: 'c', label: 'C' },
        ],
      },
      { answer: 'b', confidence: 0.7, docIds: [], sources: [] },
    );
    expect(dist.b).toBeCloseTo(0.7);
    expect(dist.a).toBeCloseTo(0.15);
  });
});
