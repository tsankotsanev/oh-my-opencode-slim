import { describe, expect, test } from 'bun:test';
import { LANES_HELP, parseLanesArgs } from './args';

describe('parseLanesArgs', () => {
  test('bare invocation lists', () => {
    expect(parseLanesArgs([])).toEqual({
      command: 'list',
      dir: undefined,
      json: false,
    });
  });

  test('list accepts --dir and --json, in either spelling', () => {
    expect(parseLanesArgs(['list', '--dir', '/p', '--json'])).toEqual({
      command: 'list',
      dir: '/p',
      json: true,
    });
    expect(parseLanesArgs(['--dir=/p'])).toEqual({
      command: 'list',
      dir: '/p',
      json: false,
    });
  });

  test('--help wins over everything', () => {
    expect(parseLanesArgs(['stop', 'fix-1', '--help'])).toEqual({
      command: 'help',
    });
    expect(parseLanesArgs(['-h'])).toEqual({ command: 'help' });
  });

  test('show defaults to 20 messages and caps the count', () => {
    expect(parseLanesArgs(['show', 'fix-1'])).toMatchObject({
      command: 'show',
      selector: 'fix-1',
      count: 20,
    });
    expect(parseLanesArgs(['show', 'fix-1', '-n', '5'])).toMatchObject({
      count: 5,
    });
    expect(parseLanesArgs(['show', 'fix-1', '--count=100000'])).toMatchObject({
      count: 500,
    });
  });

  test('a non-positive or non-integer count is an error, not a guess', () => {
    for (const value of ['0', '-3', 'abc', '2.5']) {
      expect(parseLanesArgs(['show', 'fix-1', '-n', value])).toMatchObject({
        command: 'error',
      });
    }
  });

  test('stop takes an optional reason', () => {
    expect(
      parseLanesArgs(['stop', 'fix-1', '--reason', 'wrong file set']),
    ).toEqual({
      command: 'stop',
      selector: 'fix-1',
      reason: 'wrong file set',
      dir: undefined,
      json: false,
      server: undefined,
      force: false,
    });
  });

  test('say joins the rest of argv as the message', () => {
    expect(
      parseLanesArgs(['say', 'fix-1', 'also', 'update', 'the', 'codemap']),
    ).toMatchObject({
      command: 'say',
      selector: 'fix-1',
      text: 'also update the codemap',
    });
  });

  test('say passes dash-leading text through after --', () => {
    expect(
      parseLanesArgs(['say', 'fix-1', '--', '--json', 'is', 'literal']),
    ).toMatchObject({
      command: 'say',
      selector: 'fix-1',
      text: '--json is literal',
      json: false,
    });
  });

  test('say with no message is refused (never sends an empty prompt)', () => {
    expect(parseLanesArgs(['say', 'fix-1'])).toMatchObject({
      command: 'error',
    });
    expect(parseLanesArgs(['say', 'fix-1', '   '])).toMatchObject({
      command: 'error',
    });
  });

  test('a targeted command with no selector is refused', () => {
    for (const command of ['show', 'stop', 'say']) {
      expect(parseLanesArgs([command])).toMatchObject({ command: 'error' });
    }
  });

  test('a missing flag value is an error rather than eating a positional', () => {
    expect(parseLanesArgs(['say', 'fix-1', '--reason'])).toMatchObject({
      command: 'error',
    });
    expect(parseLanesArgs(['list', '--dir='])).toMatchObject({
      command: 'error',
    });
    expect(parseLanesArgs(['show', 'fix-1', '--server'])).toMatchObject({
      command: 'error',
    });
  });

  test('unknown options are refused', () => {
    expect(parseLanesArgs(['list', '--wat'])).toMatchObject({
      command: 'error',
    });
    expect(parseLanesArgs(['-x'])).toMatchObject({ command: 'error' });
  });

  test('--force is meaningless for the read-only list', () => {
    const parsed = parseLanesArgs(['list', '--force']);
    expect(parsed.command).toBe('error');
    expect(parsed).toMatchObject({
      message: expect.stringContaining('--force'),
    });
  });

  test('a stray positional on list suggests show', () => {
    const parsed = parseLanesArgs(['fix-1']);
    expect(parsed).toMatchObject({
      command: 'error',
      message: expect.stringContaining('omo lanes show fix-1'),
    });
  });

  test('extra positionals are refused for show and stop', () => {
    expect(parseLanesArgs(['show', 'fix-1', 'extra'])).toMatchObject({
      command: 'error',
    });
    expect(parseLanesArgs(['stop', 'fix-1', 'because'])).toMatchObject({
      command: 'error',
      message: expect.stringContaining('--reason'),
    });
  });

  test('revive is reserved and points at task_revive instead of guessing', () => {
    const parsed = parseLanesArgs(['revive', 'fix-1']);
    expect(parsed).toMatchObject({
      command: 'error',
      message: expect.stringContaining('task_revive'),
    });
  });

  test('--force reaches the targeted commands', () => {
    expect(parseLanesArgs(['stop', 'ses_x', '--force'])).toMatchObject({
      force: true,
    });
    expect(parseLanesArgs(['say', 'ses_x', 'hi', '--force'])).toMatchObject({
      force: true,
      text: 'hi',
    });
  });

  test('help text documents every command and the force caveat', () => {
    for (const fragment of [
      'omo lanes',
      'list',
      'show',
      'stop',
      'say',
      '--force',
      'not a source of truth',
      'task_revive',
    ]) {
      expect(LANES_HELP).toContain(fragment);
    }
  });
});
