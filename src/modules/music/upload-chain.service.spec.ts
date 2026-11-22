import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';
import { UploadChainService } from './upload-chain.service';

/**
 * La cadena usa el `node-fetch` importado a nivel de módulo, así que se
 * mockea el módulo entero (un `global.fetch` no lo alcanzaría). El fake
 * despacha por host: cada test dice qué contesta cada servicio.
 */
jest.mock('node-fetch', () => ({ __esModule: true, default: jest.fn() }));
import fetch from 'node-fetch';

// Silencio: la cadena loguea cada intento y cada fallback.
jest.mock('../../common/utils/log', () => ({
  createLog: () => ({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

type FakeResponse = {
  ok: boolean;
  status: number;
  statusText: string;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
};

const textRes = (body: string, status = 200): FakeResponse => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: status === 200 ? 'OK' : `HTTP ${status}`,
  text: async () => body,
  json: async () => JSON.parse(body),
});
const jsonRes = (body: unknown, status = 200): FakeResponse => textRes(JSON.stringify(body), status);

/** Lo que tira node-fetch cuando no resuelve el DNS. */
const dnsError = (host: string) => new Error(`request to https://${host}/ failed, reason: getaddrinfo ENOTFOUND ${host}`);
const abortError = () => Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' });

/** Respuesta (o error) de un servicio. Una función recibe el número de llamada a ese host (desde 1). */
type Reply = FakeResponse | Error | ((call: number) => FakeResponse | Error);

const HOSTS = {
  dns: 'dns.google',
  catbox: 'catbox.moe',
  litterbox: 'litterbox.catbox.moe',
  filegarden: 'api.filegarden.com',
  x02: 'up.x02.me',
  uguu: 'uguu.se',
  nullpointer: '0x0.st',
} as const;
type Service = keyof typeof HOSTS;

const CATBOX_URL = 'https://files.catbox.moe/abc.mp3';
const LITTER_URL = 'https://litter.catbox.moe/xyz.mp3';
const X02_URL = 'https://x02.me/f/123.mp3';
const UGUU_URL = 'https://h.uguu.se/qwe.mp3';
const NULL_URL = 'https://0x0.st/Hk.mp3';

describe('UploadChainService', () => {
  let tmpDir: string;
  let filePath: string;
  let fetchMock: jest.Mock;
  let replies: Partial<Record<Service, Reply>>;
  let calls: Array<{ service: Service; url: string; init: any }>;
  let config: Record<string, string | undefined>;
  // Abrir el archivo es asíncrono: hay que esperar a que cada stream se
  // cierre antes de borrarlo, si no el open llega tarde y tira ENOENT.
  const openStreams: fs.ReadStream[] = [];

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-chain-'));
    filePath = path.join(tmpDir, 'cancion de prueba.mp3');
    fs.writeFileSync(filePath, Buffer.alloc(1234, 1));
  });

  afterAll(async () => {
    await Promise.all(
      openStreams.map((st) => (st.closed ? null : new Promise<void>((resolve) => st.once("close", () => resolve())))),
    );
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Windows puede tener el archivo abierto por un stream que nadie leyó.
    }
  });

  beforeEach(() => {
    calls = [];
    config = {};
    replies = { dns: jsonRes({ Answer: [{ data: '1.2.3.4' }] }) };
    fetchMock = fetch as unknown as jest.Mock;
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string, init: any) => {
      const host = new URL(url).hostname;
      const service = (Object.keys(HOSTS) as Service[]).find((s) => HOSTS[s] === host);
      if (!service) throw new Error(`host inesperado en el test: ${host}`);
      calls.push({ service, url, init });
      // El body no se lee nunca: hay que cerrar los ReadStream (sueltos, o
      // dentro del FormData envueltos en DelayedStream) o quedan abriendo
      // el archivo después de que el test lo borra.
      const body = init?.body;
      for (const part of body?._streams ?? [body]) {
        const stream = part?.source ?? part;
        if (stream instanceof fs.ReadStream) {
          openStreams.push(stream);
          stream.destroy();
        }
      }
      const reply = replies[service];
      if (reply === undefined) throw new Error(`sin respuesta configurada para ${service}`);
      const n = calls.filter((c) => c.service === service).length;
      const value = typeof reply === 'function' ? reply(n) : reply;
      if (value instanceof Error) throw value;
      return value;
    });
  });

  /** Construye el servicio con la config actual y anula las esperas entre reintentos. */
  const build = () => {
    const configService = { get: (key: string) => config[key] } as unknown as ConfigService;
    const service = new UploadChainService(configService);
    const sleep = jest.spyOn(service as any, 'sleep').mockResolvedValue(undefined);
    return { service, sleep };
  };

  const uploadCalls = () => calls.filter((c) => c.service !== 'dns').map((c) => c.service);

  const withFileGarden = (publicId?: string) => {
    config['music.filegardenUserId'] = 'user-1';
    config['music.filegardenAuthCookie'] = 'cookie-secreta';
    config['music.filegardenPublicId'] = publicId;
  };
  const fileGardenOk = () => jsonRes({ id: 'f1', path: '/musica/cancion.mp3' });

  describe('chequeo de conectividad', () => {
    it('consulta el DNS una sola vez para subidas seguidas', async () => {
      replies.catbox = textRes(CATBOX_URL);
      const { service } = build();

      await service.uploadFile(filePath);
      await service.uploadFile(filePath);

      expect(calls.filter((c) => c.service === 'dns')).toHaveLength(1);
      expect(uploadCalls()).toEqual(['catbox', 'catbox']);
    });

    it('vuelve a consultar pasado el minuto de validez', async () => {
      replies.catbox = textRes(CATBOX_URL);
      const { service } = build();
      const now = jest.spyOn(Date, 'now');
      try {
        now.mockReturnValue(1_000_000);
        await service.uploadFile(filePath);
        now.mockReturnValue(1_000_000 + 61_000);
        await service.uploadFile(filePath);
      } finally {
        now.mockRestore();
      }

      expect(calls.filter((c) => c.service === 'dns')).toHaveLength(2);
    });

    it('sin red corta antes de intentar cualquier subida', async () => {
      replies.dns = dnsError('dns.google');
      const { service } = build();

      await expect(service.uploadFile(filePath)).rejects.toThrow('Sin conectividad a internet');
      expect(uploadCalls()).toEqual([]);
    });

    it('una respuesta DNS sin registros cuenta como sin red', async () => {
      replies.dns = jsonRes({ Status: 3 });
      const { service } = build();

      await expect(service.uploadFile(filePath)).rejects.toThrow('Sin conectividad a internet');
    });

    it('un fallo de conectividad no se cachea: el siguiente intento vuelve a chequear', async () => {
      replies.dns = (n) => (n === 1 ? dnsError('dns.google') : jsonRes({ Answer: [{}] }));
      replies.catbox = textRes(CATBOX_URL);
      const { service } = build();

      await expect(service.uploadFile(filePath)).rejects.toThrow('Sin conectividad');
      await expect(service.uploadFile(filePath)).resolves.toBe(CATBOX_URL);
    });
  });

  describe('catbox como primario (default)', () => {
    it('sin UPLOAD_SERVICE usa catbox y devuelve la URL', async () => {
      replies.catbox = textRes(CATBOX_URL);
      const { service, sleep } = build();

      await expect(service.uploadFile(filePath)).resolves.toBe(CATBOX_URL);
      expect(uploadCalls()).toEqual(['catbox']);
      expect(sleep).not.toHaveBeenCalled();
      expect(calls[1].url).toBe('https://catbox.moe/user/api.php');
      expect(calls[1].init.method).toBe('POST');
    });

    it('reintenta hasta 3 veces con 2 s de espera', async () => {
      replies.catbox = (n) => (n < 3 ? textRes('error interno') : textRes(CATBOX_URL));
      const { service, sleep } = build();

      await expect(service.uploadFile(filePath)).resolves.toBe(CATBOX_URL);
      expect(uploadCalls()).toEqual(['catbox', 'catbox', 'catbox']);
      expect(sleep.mock.calls).toEqual([[2000], [2000]]);
    });

    it('con un error de DNS espera el doble entre reintentos', async () => {
      replies.catbox = (n) => (n === 1 ? dnsError('catbox.moe') : textRes(CATBOX_URL));
      const { service, sleep } = build();

      await service.uploadFile(filePath);
      expect(sleep.mock.calls).toEqual([[4000]]);
    });

    it('un HTTP de error cuenta como fallo y reintenta', async () => {
      replies.catbox = (n) => (n === 1 ? textRes('', 503) : textRes(CATBOX_URL));
      const { service } = build();

      await expect(service.uploadFile(filePath)).resolves.toBe(CATBOX_URL);
      expect(uploadCalls()).toEqual(['catbox', 'catbox']);
    });

    it('tras 3 fallos cae a litterbox', async () => {
      replies.catbox = textRes('', 500);
      replies.litterbox = textRes(LITTER_URL);
      const { service, sleep } = build();

      await expect(service.uploadFile(filePath)).resolves.toBe(LITTER_URL);
      expect(uploadCalls()).toEqual(['catbox', 'catbox', 'catbox', 'litterbox']);
      // No espera después del último intento.
      expect(sleep).toHaveBeenCalledTimes(2);
    });

    it('con X02 configurado lo prueba antes que litterbox, con su API key', async () => {
      config['music.x02ApiKey'] = 'clave-x02';
      replies.catbox = textRes('', 500);
      replies.x02 = jsonRes({ success: true, data: { url: X02_URL } });
      const { service } = build();

      await expect(service.uploadFile(filePath)).resolves.toBe(X02_URL);
      expect(uploadCalls()).toEqual(['catbox', 'catbox', 'catbox', 'x02']);
      const x02 = calls.find((c) => c.service === 'x02')!;
      expect(x02.url).toBe('https://up.x02.me/api/upload?format=json');
      expect(x02.init.headers['x-api-key']).toBe('clave-x02');
    });

    it('X02 se prueba una sola vez y, si falla, sigue con litterbox', async () => {
      config['music.x02ApiKey'] = 'clave-x02';
      replies.catbox = textRes('', 500);
      replies.x02 = jsonRes({ success: false, error: 'cuota' });
      replies.litterbox = textRes(LITTER_URL);
      const { service } = build();

      await expect(service.uploadFile(filePath)).resolves.toBe(LITTER_URL);
      expect(uploadCalls()).toEqual(['catbox', 'catbox', 'catbox', 'x02', 'litterbox']);
    });

    it('si litterbox también falla, FileGarden es el último recurso', async () => {
      withFileGarden('publico-9');
      replies.catbox = textRes('', 500);
      replies.litterbox = textRes('', 500);
      replies.filegarden = fileGardenOk();
      const { service } = build();

      await expect(service.uploadFile(filePath)).resolves.toBe(
        'https://file.garden/publico-9/musica/cancion.mp3',
      );
      expect(uploadCalls()).toEqual(['catbox', 'catbox', 'catbox', 'litterbox', 'filegarden']);
    });

    it('sin FileGarden y con todo caído lanza el error de la cadena', async () => {
      replies.catbox = textRes('', 500);
      replies.litterbox = textRes('', 502);
      const { service } = build();

      await expect(service.uploadFile(filePath)).rejects.toThrow(
        'Error en Catbox y Litterbox fallback: Error subiendo a Litterbox fallback: HTTP 502',
      );
    });

    it('si el último fallo es de DNS avisa "temporalmente no disponibles" (MusicService conserva el archivo)', async () => {
      replies.catbox = dnsError('catbox.moe');
      replies.litterbox = dnsError('litterbox.catbox.moe');
      const { service } = build();

      await expect(service.uploadFile(filePath)).rejects.toThrow('temporalmente no disponibles');
    });

    it('FileGarden que falla como último recurso no tapa el error original', async () => {
      withFileGarden();
      replies.catbox = textRes('', 500);
      replies.litterbox = textRes('', 500);
      replies.filegarden = textRes('cookie vencida', 401);
      const { service } = build();

      await expect(service.uploadFile(filePath)).rejects.toThrow('Error en Catbox y Litterbox fallback');
    });

    it('traduce el timeout de catbox a un mensaje legible', async () => {
      replies.catbox = abortError();
      replies.litterbox = abortError();
      const { service } = build();

      await expect(service.uploadFile(filePath)).rejects.toThrow(
        'Timeout al subir archivo a Litterbox fallback (45s)',
      );
      expect(uploadCalls()).toEqual(['catbox', 'catbox', 'catbox', 'litterbox']);
    });
  });

  describe('litterbox como primario', () => {
    beforeEach(() => {
      config['music.uploadService'] = 'litterbox';
    });

    it('sube a litterbox y devuelve la URL', async () => {
      replies.litterbox = textRes(LITTER_URL);
      const { service } = build();

      await expect(service.uploadFile(filePath)).resolves.toBe(LITTER_URL);
      expect(uploadCalls()).toEqual(['litterbox']);
    });

    it('tras 3 fallos cae a catbox', async () => {
      replies.litterbox = textRes('respuesta rara');
      replies.catbox = textRes(CATBOX_URL);
      const { service } = build();

      await expect(service.uploadFile(filePath)).resolves.toBe(CATBOX_URL);
      expect(uploadCalls()).toEqual(['litterbox', 'litterbox', 'litterbox', 'catbox']);
    });

    it('con todo caído y sin FileGarden lanza el error de la cadena', async () => {
      replies.litterbox = textRes('', 500);
      replies.catbox = textRes('', 500);
      const { service } = build();

      await expect(service.uploadFile(filePath)).rejects.toThrow('Error en Litterbox y Catbox fallback');
    });
  });

  describe('FileGarden como primario', () => {
    beforeEach(() => {
      config['music.uploadService'] = 'filegarden';
    });

    it('sin credenciales usa catbox como primario (antes caía en litterbox, que expira en 1 h)', async () => {
      replies.catbox = textRes(CATBOX_URL);
      const { service } = build();

      await expect(service.uploadFile(filePath)).resolves.toBe(CATBOX_URL);
      expect(uploadCalls()).toEqual(['catbox']);
    });

    it('sin credenciales sigue la cadena de catbox: X02 y después litterbox', async () => {
      config['music.x02ApiKey'] = 'k';
      replies.catbox = textRes('', 500);
      replies.x02 = textRes('', 500);
      replies.litterbox = textRes(LITTER_URL);
      const { service } = build();

      await expect(service.uploadFile(filePath)).resolves.toBe(LITTER_URL);
      expect(uploadCalls()).toEqual(['catbox', 'catbox', 'catbox', 'x02', 'litterbox']);
    });

    it('manda el binario con Content-Length, X-Data y la cookie', async () => {
      withFileGarden();
      replies.filegarden = fileGardenOk();
      const { service } = build();

      // Sin FILEGARDEN_PUBLIC_ID la URL pública usa el userId.
      await expect(service.uploadFile(filePath)).resolves.toBe(
        'https://file.garden/user-1/musica/cancion.mp3',
      );
      const fg = calls.find((c) => c.service === 'filegarden')!;
      expect(fg.url).toBe('https://api.filegarden.com/users/user-1/pipe');
      expect(fg.init.headers).toMatchObject({
        Cookie: 'auth=cookie-secreta',
        'Content-Type': 'application/octet-stream',
        'Content-Length': '1234',
      });
      // encodeURI, no encodeURIComponent: la API decodifica con decodeURI y
      // necesita ':' y ',' sin codificar.
      expect(fg.init.headers['X-Data']).toBe(
        '%7B%22parent%22:null,%22name%22:%22cancion%20de%20prueba.mp3%22%7D',
      );
      expect(decodeURI(fg.init.headers['X-Data'])).toBe(
        JSON.stringify({ parent: null, name: 'cancion de prueba.mp3' }),
      );
    });

    it('acepta también la respuesta envuelta en items[]', async () => {
      withFileGarden('pub');
      replies.filegarden = jsonRes({ items: [{ path: 'otra/carpeta.mp3' }] });
      const { service } = build();

      await expect(service.uploadFile(filePath)).resolves.toBe('https://file.garden/pub/otra/carpeta.mp3');
    });

    it('una respuesta sin path cuenta como fallo', async () => {
      withFileGarden();
      replies.filegarden = jsonRes({ ok: true });
      replies.catbox = textRes(CATBOX_URL);
      const { service } = build();

      await expect(service.uploadFile(filePath)).resolves.toBe(CATBOX_URL);
      expect(uploadCalls()).toEqual(['filegarden', 'filegarden', 'filegarden', 'catbox']);
    });

    it('si falla todo no reintenta FileGarden como último recurso', async () => {
      withFileGarden();
      replies.filegarden = textRes('cookie vencida', 401);
      replies.catbox = textRes('', 500);
      replies.litterbox = textRes('', 500);
      const { service } = build();

      await expect(service.uploadFile(filePath)).rejects.toThrow(
        'Todos los servicios fallaron — FileGarden, Catbox y Litterbox',
      );
      expect(uploadCalls()).toEqual(['filegarden', 'filegarden', 'filegarden', 'catbox', 'litterbox']);
    });
  });

  describe('uguu como primario', () => {
    beforeEach(() => {
      config['music.uploadService'] = 'uguu';
    });

    it('toma la URL de files[0].url', async () => {
      replies.uguu = jsonRes({ success: true, files: [{ url: UGUU_URL }] });
      const { service } = build();

      await expect(service.uploadFile(filePath)).resolves.toBe(UGUU_URL);
    });

    it('success:false cuenta como fallo y después sigue con catbox', async () => {
      replies.uguu = jsonRes({ success: false, description: 'archivo muy grande' });
      replies.catbox = textRes(CATBOX_URL);
      const { service } = build();

      await expect(service.uploadFile(filePath)).resolves.toBe(CATBOX_URL);
      expect(uploadCalls()).toEqual(['uguu', 'uguu', 'uguu', 'catbox']);
    });

    it('la cadena completa es uguu → X02 → catbox → litterbox → FileGarden', async () => {
      config['music.x02ApiKey'] = 'k';
      withFileGarden();
      replies.uguu = textRes('', 500);
      replies.x02 = textRes('no es json', 500);
      replies.catbox = textRes('', 500);
      replies.litterbox = textRes('', 500);
      replies.filegarden = textRes('', 500);
      const { service } = build();

      await expect(service.uploadFile(filePath)).rejects.toThrow(
        'Todos los servicios fallaron — uguu.se, Catbox y Litterbox',
      );
      expect(uploadCalls()).toEqual(['uguu', 'uguu', 'uguu', 'x02', 'catbox', 'litterbox', 'filegarden']);
    });
  });

  describe('0x0.st como primario', () => {
    beforeEach(() => {
      config['music.uploadService'] = 'nullpointer';
    });

    it('recorta el salto de línea de la respuesta', async () => {
      replies.nullpointer = textRes(`${NULL_URL}\n`);
      const { service } = build();

      await expect(service.uploadFile(filePath)).resolves.toBe(NULL_URL);
      expect(calls.find((c) => c.service === 'nullpointer')!.init.headers['User-Agent']).toMatch(/chat-bot/);
    });

    it('tras 3 fallos cae a catbox y después a litterbox', async () => {
      replies.nullpointer = textRes('', 500);
      replies.catbox = textRes('', 500);
      replies.litterbox = textRes(LITTER_URL);
      const { service } = build();

      await expect(service.uploadFile(filePath)).resolves.toBe(LITTER_URL);
      expect(uploadCalls()).toEqual(['nullpointer', 'nullpointer', 'nullpointer', 'catbox', 'litterbox']);
    });

    it('con todo caído por DNS avisa "temporalmente no disponibles"', async () => {
      replies.nullpointer = dnsError('0x0.st');
      replies.catbox = dnsError('catbox.moe');
      replies.litterbox = dnsError('litterbox.catbox.moe');
      const { service } = build();

      await expect(service.uploadFile(filePath)).rejects.toThrow('temporalmente no disponibles');
    });
  });

  describe('X02', () => {
    it('una URL que no es https cuenta como fallo', async () => {
      config['music.x02ApiKey'] = 'k';
      replies.catbox = textRes('', 500);
      replies.x02 = jsonRes({ success: true, data: { url: 'http://inseguro/x.mp3' } });
      replies.litterbox = textRes(LITTER_URL);
      const { service } = build();

      await expect(service.uploadFile(filePath)).resolves.toBe(LITTER_URL);
    });
  });
});
