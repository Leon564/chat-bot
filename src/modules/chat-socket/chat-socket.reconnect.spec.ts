import { EventEmitter } from 'events';

/** Socket falso: guarda handlers y deja disparar eventos del server a mano. */
class FakeSocket extends EventEmitter {
  connected = false;
  emitted: Array<[string, unknown]> = [];
  disconnect = jest.fn(() => {
    const was = this.connected;
    this.connected = false;
    // Igual que socket.io-client: desconectar uno conectado emite 'disconnect'.
    if (was) super.emit('disconnect', 'io client disconnect');
    return this;
  });
  // `emit` del lado cliente (hacia el server) se registra; los eventos del
  // server se disparan con `serverEmit`.
  emit(event: string, payload?: unknown): boolean {
    this.emitted.push([event, payload]);
    return true;
  }
  serverEmit(event: string, payload?: unknown): void {
    if (event === 'connect') this.connected = true;
    super.emit(event, payload);
  }
}

const sockets: FakeSocket[] = [];
jest.mock('socket.io-client', () => ({
  io: jest.fn(() => {
    const s = new FakeSocket();
    sockets.push(s);
    return s;
  }),
}));

import { ChatSocketService, reconnectDelay, RECONNECT_BASE_MS, RECONNECT_MAX_MS } from './chat-socket.service';

describe('reconnectDelay', () => {
  it('se duplica en cada intento y tiene techo', () => {
    const noJitter = () => 0;
    expect(reconnectDelay(0, noJitter)).toBe(RECONNECT_BASE_MS);
    expect(reconnectDelay(1, noJitter)).toBe(RECONNECT_BASE_MS * 2);
    expect(reconnectDelay(3, noJitter)).toBe(RECONNECT_BASE_MS * 8);
    expect(reconnectDelay(50, noJitter)).toBe(RECONNECT_MAX_MS);
  });

  it('suma hasta un 20 % al azar', () => {
    expect(reconnectDelay(0, () => 1)).toBe(RECONNECT_BASE_MS * 1.2);
  });
});

describe('ChatSocketService — reconexión', () => {
  const realFetch = global.fetch;
  let service: ChatSocketService;

  const okAuth = () =>
    ({
      ok: true,
      json: async () => ({ access_token: 'jwt', user: { username: 'Aria' } }),
    }) as Response;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0);
    sockets.length = 0;
    global.fetch = jest.fn().mockResolvedValue(okAuth()) as unknown as typeof fetch;
    const config = { get: (k: string) => ({ 'chat.apiUrl': 'http://chat', 'chat.apiKey': 'key' })[k] };
    service = new ChatSocketService(config as never, { update: jest.fn() } as never);
    jest.spyOn(service['logger'], 'log').mockImplementation(() => {});
    jest.spyOn(service['logger'], 'warn').mockImplementation(() => {});
    jest.spyOn(service['logger'], 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    service.onModuleDestroy();
    jest.useRealTimers();
    jest.restoreAllMocks();
    global.fetch = realFetch;
  });

  /** Avanza el reloj y deja correr el `connect()` asíncrono del reintento. */
  const advance = async (ms: number) => {
    await jest.advanceTimersByTimeAsync(ms);
  };

  it('los reintentos seguidos esperan cada vez más', async () => {
    (global.fetch as jest.Mock).mockRejectedValue(new Error('backend caído'));
    await service.onModuleInit();
    expect(global.fetch).toHaveBeenCalledTimes(1);

    await advance(RECONNECT_BASE_MS - 1);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(global.fetch).toHaveBeenCalledTimes(2); // 5 s

    await advance(RECONNECT_BASE_MS * 2 - 1);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(global.fetch).toHaveBeenCalledTimes(3); // + 10 s
  });

  it('entrar al chat resetea el backoff', async () => {
    (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('caído')).mockRejectedValueOnce(new Error('caído'));
    await service.onModuleInit();
    await advance(RECONNECT_BASE_MS); // intento 2: falla
    await advance(RECONNECT_BASE_MS * 2); // intento 3: autentica y crea el socket
    const s = sockets[0];
    s.serverEmit('connect');
    s.serverEmit('joinedChat', { success: true });

    s.serverEmit('disconnect', 'transport close');
    const calls = (global.fetch as jest.Mock).mock.calls.length;
    await advance(RECONNECT_BASE_MS);
    expect((global.fetch as jest.Mock).mock.calls.length).toBe(calls + 1); // otra vez 5 s, no 20 s
  });

  it('un joinError suelta el socket y reintenta (antes quedaba sordo)', async () => {
    await service.onModuleInit();
    const first = sockets[0];
    first.serverEmit('connect');
    expect(first.emitted.some(([e]) => e === 'joinChat')).toBe(true);

    first.serverEmit('joinError', { message: 'Rol no permitido' });
    expect(first.disconnect).toHaveBeenCalled();
    expect(first.listenerCount('disconnect')).toBe(0);

    await advance(RECONNECT_BASE_MS);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(sockets).toHaveLength(2);
  });

  it('apagar el módulo no programa una reconexión', async () => {
    await service.onModuleInit();
    sockets[0].serverEmit('connect');

    service.onModuleDestroy();
    expect(sockets[0].disconnect).toHaveBeenCalled();
    await advance(RECONNECT_MAX_MS * 2);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('un corte de conexión programa un único reintento aunque lleguen varios eventos', async () => {
    await service.onModuleInit();
    const s = sockets[0];
    s.serverEmit('connect');
    s.serverEmit('connect_error', new Error('x'));
    s.serverEmit('disconnect', 'transport close');

    await advance(RECONNECT_BASE_MS);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});
