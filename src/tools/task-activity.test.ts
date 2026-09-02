import { describe, expect, test } from 'bun:test';
import { resolveEventSessionID } from './task-activity';

describe('resolveEventSessionID', () => {
  test('keys message.updated by info.sessionID, not the message id', () => {
    expect(
      resolveEventSessionID({
        type: 'message.updated',
        properties: { info: { id: 'msg_123', sessionID: 'ses_child1' } },
      }),
    ).toBe('ses_child1');
  });

  test('keys step-finish by info.sessionID, not the step/message id', () => {
    expect(
      resolveEventSessionID({
        type: 'step-finish',
        properties: { info: { id: 'step_9', sessionID: 'ses_child1' } },
      }),
    ).toBe('ses_child1');
  });

  test('keys session-scoped events by info.id (the session id)', () => {
    expect(
      resolveEventSessionID({
        type: 'session.status',
        properties: { info: { id: 'ses_child1' }, status: { type: 'busy' } },
      }),
    ).toBe('ses_child1');
    expect(
      resolveEventSessionID({
        type: 'session.deleted',
        properties: { info: { id: 'ses_child1' } },
      }),
    ).toBe('ses_child1');
  });

  test('falls back to properties.sessionID', () => {
    expect(
      resolveEventSessionID({
        type: 'session.status',
        properties: { sessionID: 'ses_child1', status: { type: 'retry' } },
      }),
    ).toBe('ses_child1');
  });

  test('returns undefined without any session id', () => {
    expect(
      resolveEventSessionID({
        type: 'message.updated',
        properties: { info: { id: 'msg_1' } },
      }),
    ).toBeUndefined();
  });
});
