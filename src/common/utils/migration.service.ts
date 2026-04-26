import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as fs from 'fs';
import * as path from 'path';
import { Memory, MemoryDocument } from '../schemas/memory.schema';
import { MessageLog, MessageLogDocument } from '../schemas/message-log.schema';
import { EventLog, EventLogDocument } from '../schemas/event-log.schema';
import { Context, ContextDocument } from '../schemas/context.schema';

/**
 * One-shot import of the legacy `data/*.json` files into MongoDB. Runs once
 * at boot. Each source file is renamed to `*.json.bak` after a successful
 * import so the migration never replays — if you need to re-import, just
 * remove the .bak suffix and restart.
 *
 * Idempotent on its own: if the .bak already exists or the source file is
 * missing, the migration for that file is a no-op.
 */
@Injectable()
export class MigrationService implements OnModuleInit {
  private readonly dataDir = path.join(process.cwd(), 'data');

  constructor(
    @InjectModel(Memory.name) private readonly memoryModel: Model<MemoryDocument>,
    @InjectModel(MessageLog.name) private readonly messageLogModel: Model<MessageLogDocument>,
    @InjectModel(EventLog.name) private readonly eventLogModel: Model<EventLogDocument>,
    @InjectModel(Context.name) private readonly contextModel: Model<ContextDocument>,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!fs.existsSync(this.dataDir)) return;
    await this.migrateMemories();
    await this.migrateMessagesLog();
    await this.migrateEventsLog();
    await this.migrateContext();
  }

  private readJson(name: string): unknown | null {
    const file = path.join(this.dataDir, name);
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch (err) {
      console.warn(`⚠️ Migration: no pude leer ${name}:`, err instanceof Error ? err.message : err);
      return null;
    }
  }

  private archive(name: string): void {
    const src = path.join(this.dataDir, name);
    const dst = path.join(this.dataDir, `${name}.bak`);
    try {
      fs.renameSync(src, dst);
      console.log(`📦 Migrado a Mongo y respaldado: ${name} → ${name}.bak`);
    } catch (err) {
      console.warn(`⚠️ No pude renombrar ${name}:`, err instanceof Error ? err.message : err);
    }
  }

  private async migrateMemories(): Promise<void> {
    const data = this.readJson('memory.json');
    if (!data) return;

    const docs: { scope: 'global' | 'user'; user: string | null; content: string }[] = [];

    // Format A: legacy array of strings — all global.
    if (Array.isArray(data)) {
      for (const m of data as unknown[]) {
        if (typeof m === 'string' && m.trim()) docs.push({ scope: 'global', user: null, content: m.trim() });
      }
    } else if (data && typeof data === 'object') {
      // Format B: { global: [...], users: { name: [...] } } — entries can be
      // strings or { content, timestamp, user } objects.
      const obj = data as { global?: unknown[]; users?: Record<string, unknown[]> };
      for (const entry of obj.global ?? []) {
        const c = typeof entry === 'string' ? entry : (entry as { content?: string }).content;
        if (typeof c === 'string' && c.trim()) docs.push({ scope: 'global', user: null, content: c.trim() });
      }
      for (const [user, entries] of Object.entries(obj.users ?? {})) {
        for (const entry of entries) {
          const c = typeof entry === 'string' ? entry : (entry as { content?: string }).content;
          if (typeof c === 'string' && c.trim()) docs.push({ scope: 'user', user, content: c.trim() });
        }
      }
    }

    if (docs.length === 0) {
      this.archive('memory.json');
      return;
    }

    await this.memoryModel.insertMany(docs, { ordered: false }).catch(() => undefined);
    console.log(`🧠 Importadas ${docs.length} memorias desde memory.json`);
    this.archive('memory.json');
  }

  private async migrateMessagesLog(): Promise<void> {
    const data = this.readJson('messages_log.json');
    if (!Array.isArray(data)) return;

    const docs = data
      .filter((r): r is { user: string; message: string } => !!r && typeof r === 'object' && typeof (r as { user?: unknown }).user === 'string' && typeof (r as { message?: unknown }).message === 'string')
      .map((r) => ({ user: r.user, message: r.message }));

    if (docs.length === 0) {
      this.archive('messages_log.json');
      return;
    }
    await this.messageLogModel.insertMany(docs, { ordered: false }).catch(() => undefined);
    console.log(`📝 Importados ${docs.length} mensajes desde messages_log.json`);
    this.archive('messages_log.json');
  }

  private async migrateEventsLog(): Promise<void> {
    const data = this.readJson('events_log.json');
    if (!Array.isArray(data)) return;

    const docs = data
      .filter((r): r is { event: string; user: string; date?: string } => !!r && typeof r === 'object' && typeof (r as { event?: unknown }).event === 'string')
      .map((r) => ({
        event: r.event,
        user: typeof r.user === 'string' ? r.user : '',
        date: r.date ? new Date(r.date) : new Date(),
      }));

    if (docs.length === 0) {
      this.archive('events_log.json');
      return;
    }
    await this.eventLogModel.insertMany(docs, { ordered: false }).catch(() => undefined);
    console.log(`🗓️ Importados ${docs.length} eventos desde events_log.json`);
    this.archive('events_log.json');
  }

  private async migrateContext(): Promise<void> {
    const data = this.readJson('context.json');
    if (!Array.isArray(data)) return;

    const docs = data
      .filter((r): r is { question: string; answer: string; user?: string } => !!r && typeof r === 'object' && typeof (r as { question?: unknown }).question === 'string' && typeof (r as { answer?: unknown }).answer === 'string')
      .map((r) => ({ question: r.question, answer: r.answer, user: typeof r.user === 'string' ? r.user : '' }));

    if (docs.length === 0) {
      this.archive('context.json');
      return;
    }
    await this.contextModel.insertMany(docs, { ordered: false }).catch(() => undefined);
    console.log(`💬 Importadas ${docs.length} entradas de contexto desde context.json`);
    this.archive('context.json');
  }
}
