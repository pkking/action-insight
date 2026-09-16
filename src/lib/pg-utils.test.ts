import { describe, expect, it } from 'vitest';

import { pgTuplePlaceholders } from './pg-utils';

describe('pgTuplePlaceholders', () => {
  it('groups numbered placeholders into PostgreSQL row tuples', () => {
    expect(pgTuplePlaceholders(3, 2)).toBe('($2,$3),($4,$5),($6,$7)');
  });
});
