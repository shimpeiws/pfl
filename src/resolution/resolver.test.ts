import { describe, expect, it } from 'vitest';
import { elementIdFor, runtimeId } from '../core/ids.js';
import type { Activation, ApplicabilityType, ResolutionStrategy } from '../core/resolved.js';
import { resolveElement, resolveElements, type ElementResolutionInput } from './resolver.js';

const rid = runtimeId('claude-code');

function id(path: string): ElementResolutionInput['id'] {
  return elementIdFor({ runtimeId: rid, origin: 'project', path });
}

function input(overrides: Partial<ElementResolutionInput> = {}): ElementResolutionInput {
  return {
    id: id('a'),
    applicability: { type: 'project' },
    strategy: 'accumulate',
    activation: 'always',
    ...overrides,
  };
}

describe('resolveElement — status derivation', () => {
  it.each<{
    name: string;
    applicability: ApplicabilityType;
    strategy: ResolutionStrategy;
    activation: Activation;
    expected: string;
  }>([
    {
      name: 'accumulated instructions are effective',
      applicability: 'project',
      strategy: 'accumulate',
      activation: 'always',
      expected: 'effective',
    },
    {
      name: 'an on-demand skill is effective, not conditional',
      applicability: 'project',
      strategy: 'available',
      activation: 'on-demand',
      expected: 'effective',
    },
    {
      name: 'an event-driven hook is effective',
      applicability: 'tool-event',
      strategy: 'event-pipeline',
      activation: 'event-driven',
      expected: 'effective',
    },
    {
      name: 'a policy setting is effective',
      applicability: 'global',
      strategy: 'policy',
      activation: 'always',
      expected: 'effective',
    },
    {
      name: 'an opaque runtime-defined layer can still be effective',
      applicability: 'runtime-defined',
      strategy: 'runtime-defined',
      activation: 'always',
      expected: 'effective',
    },
    {
      name: 'a conditional activation is conditional',
      applicability: 'project',
      strategy: 'override',
      activation: 'conditional',
      expected: 'conditional',
    },
    {
      name: 'a config rule is conditional',
      applicability: 'config-rule',
      strategy: 'policy',
      activation: 'always',
      expected: 'conditional',
    },
    {
      name: 'a config rule stays conditional even with an unknown strategy',
      applicability: 'config-rule',
      strategy: 'unknown',
      activation: 'unknown',
      expected: 'conditional',
    },
    {
      name: 'an unknown strategy is unknown',
      applicability: 'project',
      strategy: 'unknown',
      activation: 'always',
      expected: 'unknown',
    },
    {
      name: 'an unknown activation is unknown',
      applicability: 'project',
      strategy: 'accumulate',
      activation: 'unknown',
      expected: 'unknown',
    },
    {
      name: 'an unknown applicability is unresolved',
      applicability: 'unknown',
      strategy: 'accumulate',
      activation: 'always',
      expected: 'unresolved',
    },
  ])('$name', ({ applicability, strategy, activation, expected }) => {
    const resolved = resolveElement(
      input({ applicability: { type: applicability }, strategy, activation }),
    );
    expect(resolved.status).toBe(expected);
  });

  it('marks an overridden element shadowed and names what shadows it', () => {
    const winner = id('winner');
    const resolved = resolveElement(input({ shadowedBy: winner }));

    expect(resolved.status).toBe('shadowed');
    expect(resolved.resolution.reason).toContain(winner);
  });

  it('carries the axes through and always gives a reason', () => {
    const resolved = resolveElement(
      input({ applicability: { type: 'directory-subtree', target: 'docs' } }),
    );

    expect(resolved.applicability).toEqual({ type: 'directory-subtree', target: 'docs' });
    expect(resolved.activation).toBe('always');
    expect(resolved.resolution.strategy).toBe('accumulate');
    expect(resolved.resolution.reason).toBeTruthy();
  });
});

describe('resolveElements', () => {
  it('resolves every input in order', () => {
    const first = input({ id: id('first') });
    const second = input({ id: id('second'), shadowedBy: id('first') });

    const resolved = resolveElements([first, second]);

    expect(resolved.map((element) => element.id)).toEqual([first.id, second.id]);
    expect(resolved[0]?.status).toBe('effective');
    expect(resolved[1]?.status).toBe('shadowed');
  });
});
