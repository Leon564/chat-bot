/**
 * Semáforo FIFO mínimo (sin dependencias) para limitar cuántas tareas de una
 * etapa del pipeline de música corren a la vez.
 *
 * Existe porque el pipeline dejó de ser un único `while` serial: ahora cada
 * pedido avanza por su cuenta a través de tres etapas con límites distintos
 * (búsqueda barata / descarga+ffmpeg cara / subida de red), y así la descarga
 * de una canción se superpone con la subida de la anterior.
 *
 * El orden FIFO importa: los pedidos entran al pipeline en el orden en que el
 * usuario los pidió, y la cola de espera preserva ese orden en cada etapa. Un
 * semáforo basado en reintentos/polling podría colar al que despierte primero
 * y la cola dejaría de respetar el turno.
 */
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {
    if (!Number.isFinite(limit) || limit < 1) {
      throw new Error(`Semaphore: límite inválido (${limit})`);
    }
  }

  /** Permisos en uso ahora mismo. */
  get inFlight(): number {
    return this.active;
  }

  /** Tareas esperando un permiso. */
  get waiting(): number {
    return this.waiters.length;
  }

  /**
   * Corre `task` con un permiso tomado y lo devuelve pase lo que pase. Si
   * `task` lanza, el error se propaga al llamador — el permiso no se filtra.
   */
  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  /**
   * Se le pasa el permiso directamente al siguiente en la cola en vez de
   * bajar el contador y que vuelva a competir: eso es lo que hace que el
   * traspaso sea estrictamente FIFO y que nunca se exceda `limit`.
   */
  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
      return;
    }
    this.active--;
  }
}
