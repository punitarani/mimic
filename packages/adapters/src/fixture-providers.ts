import {
  type Enricher,
  type EnrichmentResult,
  type PeopleSearch,
  type PeopleSearchResult,
  type ProviderCallRunner,
  profileKey,
} from '@mimic/core';
import exaFixture from '../fixtures/exa-people-search.json';
import parallelFixture from '../fixtures/parallel-task-result.json';
import { exaCandidate, parallelFacts } from './search';

/**
 * Offline providers backed by the recorded fixtures (fictional people). For demos, screenshots and working without
 * search keys: `SEARCH_PROVIDER=fixture`, `ENRICH_PROVIDER=fixture`. Never used unless selected explicitly.
 */
export class FixturePeopleSearch implements PeopleSearch {
  readonly provider = 'fixture';
  calls = 0;
  readonly queries: string[] = [];
  async search(query: string, opts: { numResults: number }): Promise<PeopleSearchResult> {
    this.calls++;
    this.queries.push(query);
    const results = (exaFixture as { results: Parameters<typeof exaCandidate>[0][] }).results;
    return {
      candidates: results.slice(0, opts.numResults).map(exaCandidate),
      costUsd: 0,
      latencyMs: 0,
      raw: exaFixture,
    };
  }
  lookups = 0;
  /** Resolves a link to the fixture person with that URL, like Exa `/contents` on a known profile. */
  async lookup(url: string): Promise<PeopleSearchResult> {
    this.lookups++;
    const results = (exaFixture as { results: Parameters<typeof exaCandidate>[0][] }).results;
    const hit = results.find((r) => profileKey(r.url) === profileKey(url));
    return {
      candidates: hit ? [{ ...exaCandidate(hit), url }] : [],
      costUsd: 0,
      latencyMs: 0,
      raw: hit ?? null,
    };
  }
}

export class FixtureEnricher implements Enricher {
  readonly provider = 'fixture';
  calls = 0;
  enrich(subject: Parameters<Enricher['enrich']>[0], run: ProviderCallRunner): Promise<EnrichmentResult> {
    return run('fixture:task', subject, async () => {
      this.calls++;
      return {
        facts: parallelFacts(parallelFixture as Parameters<typeof parallelFacts>[0]),
        costUsd: 0,
        latencyMs: 0,
        raw: parallelFixture,
      };
    });
  }
}
