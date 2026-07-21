import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Chat } from './views/Chat';
import type { EngineClient } from './api/client';

/**
 * D79 regression test (the flaw fix). The owner flagged that the composer in
 * design.png overflowed under the References rail. These assertions fail if the
 * composer is ever moved out of the center column's track, placed under the
 * rail, or absolutely/fixed-positioned to span across regions.
 */

const fakeClient = {
  version: '0.0.0',
  listTasks: () => Promise.resolve([]),
  chatMessages: () => Promise.resolve([]),
} as unknown as EngineClient;

afterEach(() => cleanup());

describe('composer layout (D79)', () => {
  it('the composer is a child of the center column, never the References rail', () => {
    const { container } = render(
      <Chat client={fakeClient} workspaceId="ws-general" chatId={null} onChatChanged={() => {}} />,
    );
    const composer = container.querySelector('[data-testid="composer"]');
    const center = container.querySelector('[data-region="center"]');
    const references = container.querySelector('[data-region="references"]');

    expect(composer).not.toBeNull();
    expect(center).not.toBeNull();
    expect(references).not.toBeNull();

    // Structurally inside the center column, and NOT inside the References rail.
    expect(center!.contains(composer)).toBe(true);
    expect(references!.contains(composer)).toBe(false);
  });

  it('the composer is never absolutely/fixed positioned, and the column width is 560–640px', () => {
    const css = readFileSync(join(process.cwd(), 'src', 'styles.css'), 'utf8');

    for (const selector of ['.composer-wrap', '.composer', '.composer-inner']) {
      const block = extractBlock(css, selector);
      expect(block, `${selector} block should exist`).not.toBeNull();
      expect(/position:\s*(absolute|fixed)/i.test(block!)).toBe(false);
    }

    const max = Number(/--ql-column-max:\s*(\d+)px/.exec(css)?.[1] ?? 0);
    expect(max).toBeGreaterThanOrEqual(560);
    expect(max).toBeLessThanOrEqual(640);
  });
});

/** Extract the body of the CSS rule for exactly `sel` (e.g. `.composer` but not
 * `.composer-wrap`). */
function extractBlock(css: string, sel: string): string | null {
  const escaped = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  return match ? match[1]! : null;
}
