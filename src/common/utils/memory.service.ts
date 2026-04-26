import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { UtilsService } from './utils.service';
import { Memory, MemoryDocument } from '../schemas/memory.schema';

const MAX_GLOBAL = 20;
const MAX_PER_USER = 30;
const SIMILARITY_THRESHOLD = 0.8;

@Injectable()
export class MemoryService {
  constructor(
    private readonly configService: ConfigService,
    private readonly utilsService: UtilsService,
    @InjectModel(Memory.name) private readonly memoryModel: Model<MemoryDocument>,
  ) {}

  async saveMemory(memory: string, username?: string): Promise<void> {
    if (!this.configService.get<boolean>('bot.useMemory')) return;
    if (!memory || memory.trim().length === 0) return;

    // Aggressive sanitisation — strips bot intent tokens, BBCode, etc. so an
    // attacker can't inject anything that re-triggers a feature when the
    // memory is replayed into the prompt or rendered by the chat.
    const cleanMemory = this.utilsService.sanitizeMemoryContent(memory);
    if (!cleanMemory) {
      console.log('🧹 Memoria descartada tras sanitización (vacía o demasiado corta).');
      return;
    }
    const cleanUsername = username ? this.utilsService.cleanHtmlFromMessage(username) : '';
    const scope: 'global' | 'user' = cleanUsername ? 'user' : 'global';
    const owner = cleanUsername || null;

    // Deduplicate against a small recent window — same logic as the JSON era,
    // but now scoped via a query instead of loading the whole file.
    const recent = await this.memoryModel
      .find({ scope, user: owner })
      .sort({ createdAt: -1 })
      .limit(scope === 'user' ? MAX_PER_USER : MAX_GLOBAL)
      .lean()
      .exec();

    const isDuplicate = recent.some((existing) => {
      const sim = this.utilsService.calculateSimilarity(
        cleanMemory.toLowerCase(),
        (existing.content ?? '').toLowerCase(),
      );
      return sim > SIMILARITY_THRESHOLD;
    });
    if (isDuplicate) return;

    await this.memoryModel.create({ scope, user: owner, content: cleanMemory });

    // Trim the queue: keep only the latest N rows for this scope/user.
    const cap = scope === 'user' ? MAX_PER_USER : MAX_GLOBAL;
    const overflow = await this.memoryModel
      .find({ scope, user: owner })
      .sort({ createdAt: -1 })
      .skip(cap)
      .select({ _id: 1 })
      .lean()
      .exec();
    if (overflow.length > 0) {
      await this.memoryModel.deleteMany({ _id: { $in: overflow.map((d) => d._id) } });
    }
  }

  async getMemory(username?: string): Promise<string[]> {
    if (!this.configService.get<boolean>('bot.useMemory')) return [];

    const cleanUsername = username ? this.utilsService.cleanHtmlFromMessage(username) : '';

    const userRows = cleanUsername
      ? await this.memoryModel
          .find({ scope: 'user', user: cleanUsername })
          .sort({ createdAt: -1 })
          .limit(MAX_PER_USER)
          .lean()
          .exec()
      : [];

    const globalRows = await this.memoryModel
      .find({ scope: 'global' })
      .sort({ createdAt: -1 })
      .limit(cleanUsername ? 3 : MAX_GLOBAL)
      .lean()
      .exec();

    const memoryContents = [...userRows, ...globalRows]
      .map((m) => this.utilsService.sanitizeMemoryContent(m.content ?? ''))
      .filter((c) => c.length > 0);

    const categorized = this.categorizeMemoriesByUser(memoryContents, cleanUsername || undefined);
    return this.selectMostRelevantMemoriesForUser(categorized, 5);
  }

  /**
   * Removes overly generic global entries (legacy from the JSON file) and
   * trims to the cap. Kept idempotent so it's safe to call on every boot.
   */
  async cleanExistingMemories(): Promise<void> {
    if (!this.configService.get<boolean>('bot.useMemory')) return;

    const genericPhrases = [
      'información general',
      'el usuario preguntó',
      'debo variar',
      'recordar',
      'generando resumen',
    ];

    const all = await this.memoryModel.find({ scope: 'global' }).sort({ createdAt: 1 }).lean().exec();
    let removed = 0;
    for (const row of all) {
      const c = (row.content ?? '').toLowerCase();
      if (c.length < 10 || genericPhrases.some((p) => c.includes(p.toLowerCase()))) {
        await this.memoryModel.deleteOne({ _id: row._id });
        removed++;
      }
    }

    // Cap to last MAX_GLOBAL after cleaning.
    const overflow = await this.memoryModel
      .find({ scope: 'global' })
      .sort({ createdAt: -1 })
      .skip(MAX_GLOBAL)
      .select({ _id: 1 })
      .lean()
      .exec();
    if (overflow.length > 0) {
      await this.memoryModel.deleteMany({ _id: { $in: overflow.map((d) => d._id) } });
    }

    if (removed > 0) console.log(`🧠 Memorias limpiadas: ${removed} globales removidas`);
  }

  /**
   * Legacy bridge: the JSON file used to be either an array or a
   * { global, users } object. With Mongo there's nothing to migrate at the
   * shape level — this stays as a no-op so callers (BotService.onModuleInit)
   * keep working. The actual import from the old JSON file is handled by
   * MigrationService at boot.
   */
  async migrateMemoriesToUserFormat(): Promise<void> {
    if (!this.configService.get<boolean>('bot.useMemory')) return;
  }

  private categorizeMemoriesByUser(memories: string[], username?: string): {
    userPreferences: string[];
    factualInfo: string[];
    interactions: string[];
    recommendations: string[];
    personalInfo: string[];
    other: string[];
  } {
    const categories = {
      userPreferences: [] as string[],
      factualInfo: [] as string[],
      interactions: [] as string[],
      recommendations: [] as string[],
      personalInfo: [] as string[],
      other: [] as string[],
    };

    memories.forEach((memory) => {
      const lowerMemory = memory.toLowerCase();
      const cleanUsername = username ? this.utilsService.cleanHtmlFromMessage(username) : undefined;
      const userMention = cleanUsername ? lowerMemory.includes(cleanUsername.toLowerCase()) : false;

      if (lowerMemory.includes('le gusta') || lowerMemory.includes('favorito') || lowerMemory.includes('prefiere')) {
        categories.userPreferences.push(memory);
      } else if (lowerMemory.includes('recomendación') || lowerMemory.includes('anime:') || lowerMemory.includes('manga:') || lowerMemory.includes('manhwa:')) {
        categories.recommendations.push(memory);
      } else if (lowerMemory.includes('leon564') || lowerMemory.includes('sleepy ash') || lowerMemory.includes('creador')) {
        categories.factualInfo.push(memory);
      } else if (userMention && (lowerMemory.includes('nombre') || lowerMemory.includes('edad') || lowerMemory.includes('país'))) {
        categories.personalInfo.push(memory);
      } else if (lowerMemory.includes('usuario') || lowerMemory.includes('preguntó') || lowerMemory.includes('interesado')) {
        categories.interactions.push(memory);
      } else {
        categories.other.push(memory);
      }
    });

    return categories;
  }

  private selectMostRelevantMemoriesForUser(categories: {
    userPreferences: string[];
    factualInfo: string[];
    interactions: string[];
    recommendations: string[];
    personalInfo: string[];
    other: string[];
  }, maxCount: number): string[] {
    const selected: string[] = [];

    if (categories.personalInfo.length > 0 && selected.length < maxCount) {
      selected.push(...categories.personalInfo.slice(-1));
    }
    if (categories.userPreferences.length > 0 && selected.length < maxCount) {
      const remaining = maxCount - selected.length;
      selected.push(...categories.userPreferences.slice(-Math.min(2, remaining)));
    }
    if (categories.recommendations.length > 0 && selected.length < maxCount) {
      const remaining = maxCount - selected.length;
      selected.push(...categories.recommendations.slice(-Math.min(1, remaining)));
    }
    if (categories.factualInfo.length > 0 && selected.length < maxCount) {
      const remaining = maxCount - selected.length;
      selected.push(...categories.factualInfo.slice(-Math.min(1, remaining)));
    }
    if (categories.interactions.length > 0 && selected.length < maxCount) {
      const remaining = maxCount - selected.length;
      selected.push(...categories.interactions.slice(-remaining));
    }

    return selected.slice(0, maxCount);
  }
}
