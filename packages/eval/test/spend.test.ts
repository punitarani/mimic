import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseSpendLimits } from '@mimic/core';
import { describe, expect, it } from 'vitest';

type Check = (value: string) => string | null;

describe('spend settings (ADR-0035)', () => {
  it('lets deploy preflight accept exactly the values the Workers read', async () => {
    const url = pathToFileURL(join(__dirname, '../../../scripts/deploy/settings.mjs')).href;
    const { SETTINGS } = (await import(url)) as {
      SETTINGS: { BUDGET_USD: Check; BUDGET_SESSION_SHARE: Check };
    };
    const values = [
      '1',
      '0.75',
      ' 2 ',
      '1e3',
      '0',
      '-1',
      'abc',
      '$1',
      '1,00',
      'Infinity',
      '0.5',
      '1.01',
      '80%',
    ];
    for (const name of ['BUDGET_USD', 'BUDGET_SESSION_SHARE'] as const) {
      for (const value of values) {
        const preflight = SETTINGS[name](value.trim()) === null;
        const runtime = parseSpendLimits({ [name]: value }).problems.length === 0;
        expect({ name, value, accepted: runtime }).toEqual({ name, value, accepted: preflight });
      }
    }
  });
});
