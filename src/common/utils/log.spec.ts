import { Logger } from '@nestjs/common';
import { createLog, logLevelsFromEnv } from './log';

describe('createLog', () => {
  afterEach(() => jest.restoreAllMocks());

  it('arma el mensaje como console (varios args, objetos) y no usa el último como contexto', () => {
    const spy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    createLog('Prueba').info('Subido:', 'https://x/y.mp3', { ok: true }, 3);
    expect(spy).toHaveBeenCalledWith("Subido: https://x/y.mp3 { ok: true } 3");
  });

  it('cada nivel va al método de Nest que corresponde', () => {
    const debug = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    const log = createLog('Prueba');
    log.debug('d');
    log.warn('w');
    log.error('falló:', new Error('boom'));
    expect(debug).toHaveBeenCalledWith('d');
    expect(warn).toHaveBeenCalledWith('w');
    expect(error.mock.calls[0][0]).toContain('falló: Error: boom'); // con stack, como console
  });
});

describe('logLevelsFromEnv', () => {
  it.each([
    [undefined, ['error', 'warn', 'log']],
    ['', ['error', 'warn', 'log']],
    ['basura', ['error', 'warn', 'log']],
    ['error', ['error']],
    ['WARN', ['error', 'warn']],
    ['debug', ['error', 'warn', 'log', 'debug']],
    ['verbose', ['error', 'warn', 'log', 'debug', 'verbose']],
  ])('%s → %j', (raw, levels) => {
    expect(logLevelsFromEnv(raw)).toEqual(levels);
  });
});
