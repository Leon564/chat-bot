import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as path from 'path';
import * as fs from 'fs';
import { UtilsService } from './utils.service';

@Injectable()
export class MemoryService {
  constructor(
    private readonly configService: ConfigService,
    private readonly utilsService: UtilsService,
  ) {}

  async saveMemory(memory: string, username?: string): Promise<void> {
    // No hacer nada si la memoria está deshabilitada
    if (!this.configService.get<boolean>('bot.useMemory')) return;
    
    if (!memory || memory.trim().length === 0) return;
    
    const filePath = path.join(process.cwd(), 'data', 'memory.json');
    
    // Crear directorio si no existe
    const dirPath = path.dirname(filePath);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
    
    const memoryData = fs.existsSync(filePath)
      ? JSON.parse(fs.readFileSync(filePath, 'utf-8'))
      : { global: [], users: {} };
    
    // Asegurar estructura correcta
    if (!memoryData.global) memoryData.global = [];
    if (!memoryData.users) memoryData.users = {};
    
    // Limpiar HTML del contenido de memoria y del username
    const cleanMemory = this.utilsService.cleanHtmlFromMessage(memory.trim());
    const cleanUsername = username ? this.utilsService.cleanHtmlFromMessage(username) : undefined;
    const timestamp = new Date().toISOString();
    
    // Crear objeto de memoria con metadata
    const memoryEntry = {
      content: cleanMemory,
      timestamp,
      user: cleanUsername || 'unknown'
    };
    
    if (cleanUsername) {
      // Memoria específica del usuario
      if (!memoryData.users[cleanUsername]) {
        memoryData.users[cleanUsername] = [];
      }
      
      // Evitar duplicados para este usuario específico
      const userMemories = memoryData.users[cleanUsername];
      const isDuplicate = userMemories.some((existingMemory: any) => {
        const similarity = this.utilsService.calculateSimilarity(
          cleanMemory.toLowerCase(), 
          existingMemory.content.toLowerCase()
        );
        return similarity > 0.8;
      });
      
      if (!isDuplicate) {
        memoryData.users[cleanUsername].push(memoryEntry);
        // Mantener solo las últimas 30 memorias por usuario
        memoryData.users[cleanUsername] = memoryData.users[cleanUsername].slice(-30);
      }
    } else {
      // Memoria global
      const isDuplicate = memoryData.global.some((existingMemory: any) => {
        const similarity = this.utilsService.calculateSimilarity(
          cleanMemory.toLowerCase(), 
          existingMemory.content.toLowerCase()
        );
        return similarity > 0.8;
      });
      
      if (!isDuplicate) {
        memoryData.global.push(memoryEntry);
        // Mantener solo las últimas 20 memorias globales
        memoryData.global = memoryData.global.slice(-20);
      }
    }
    
    fs.writeFileSync(filePath, JSON.stringify(memoryData, null, 2));
  }

  async getMemory(username?: string): Promise<string[]> {
    // Retornar array vacío si la memoria está deshabilitada
    if (!this.configService.get<boolean>('bot.useMemory')) return [];
    
    const filePath = path.join(process.cwd(), 'data', 'memory.json');
    
    // Crear directorio si no existe
    const dirPath = path.dirname(filePath);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
    
    const memoryData = fs.existsSync(filePath)
      ? JSON.parse(fs.readFileSync(filePath, 'utf-8'))
      : { global: [], users: {} };
    
    // Asegurar estructura correcta
    if (!memoryData.global) memoryData.global = [];
    if (!memoryData.users) memoryData.users = {};
    
    // Limpiar HTML del username si existe
    const cleanUsername = username ? this.utilsService.cleanHtmlFromMessage(username) : undefined;
    
    let relevantMemories: any[] = [];
    
    if (cleanUsername && memoryData.users[cleanUsername]) {
      // Obtener memorias específicas del usuario
      const userMemories = memoryData.users[cleanUsername];
      relevantMemories = [...userMemories];
      
      // Agregar algunas memorias globales relevantes si hay espacio
      const globalMemories = memoryData.global.slice(-3);
      relevantMemories = [...relevantMemories, ...globalMemories];
    } else {
      // Solo memorias globales si no hay usuario específico
      relevantMemories = memoryData.global;
    }
    
    // Ordenar por timestamp (más recientes primero)
    relevantMemories.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    
    // Categorizar y filtrar las memorias
    const memoryContents = relevantMemories.map(m => m.content);
    const categorizedMemories = this.categorizeMemoriesByUser(memoryContents, cleanUsername);
    
    // Seleccionar las más importantes (máximo 5 elementos)
    return this.selectMostRelevantMemoriesForUser(categorizedMemories, 5);
  }

  async cleanExistingMemories(): Promise<void> {
    // No hacer nada si la memoria está deshabilitada
    if (!this.configService.get<boolean>('bot.useMemory')) return;
    
    const filePath = path.join(process.cwd(), 'data', 'memory.json');
    
    // Crear directorio si no existe
    const dirPath = path.dirname(filePath);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
    
    if (!fs.existsSync(filePath)) return;
    
    const memoryData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    
    // Manejar formato antiguo (array) y nuevo formato (objeto)
    if (Array.isArray(memoryData)) {
      // Formato antiguo - migrar primero
      await this.migrateMemoriesToUserFormat();
      return;
    }
    
    // Asegurar estructura correcta
    if (!memoryData.global) memoryData.global = [];
    if (!memoryData.users) memoryData.users = {};
    
    // Limpiar memorias globales
    const cleanedGlobal: any[] = [];
    memoryData.global.forEach((memoryEntry: any) => {
      const memory = typeof memoryEntry === 'string' ? memoryEntry : memoryEntry.content;
      
      // Skip memorias muy cortas o genéricas
      if (memory.length < 10) return;
      
      // Skip memorias que son demasiado generales
      const genericPhrases = [
        'información general',
        'el usuario preguntó',
        'debo variar',
        'recordar',
        'generando resumen'
      ];
      
      const isGeneric = genericPhrases.some(phrase => 
        memory.toLowerCase().includes(phrase.toLowerCase())
      );
      
      if (isGeneric) return;
      
      // Evitar duplicados
      const isDuplicate = cleanedGlobal.some(existing => {
        const existingContent = typeof existing === 'string' ? existing : existing.content;
        const similarity = this.utilsService.calculateSimilarity(memory.toLowerCase(), existingContent.toLowerCase());
        return similarity > 0.8;
      });
      
      if (!isDuplicate) {
        // Mantener formato de objeto con metadata
        if (typeof memoryEntry === 'object') {
          cleanedGlobal.push(memoryEntry);
        } else {
          cleanedGlobal.push({
            content: memory,
            timestamp: new Date().toISOString(),
            user: 'unknown'
          });
        }
      }
    });
    
    // Escribir cambios
    memoryData.global = cleanedGlobal.slice(-20);
    fs.writeFileSync(filePath, JSON.stringify(memoryData, null, 2));
    
    const removedGlobal = memoryData.global.length - cleanedGlobal.length;
    console.log(`🧠 Memorias limpiadas: ${removedGlobal} globales removidas`);
  }

  async migrateMemoriesToUserFormat(): Promise<void> {
    // No hacer nada si la memoria está deshabilitada
    if (!this.configService.get<boolean>('bot.useMemory')) return;
    
    const filePath = path.join(process.cwd(), 'data', 'memory.json');
    
    // Crear directorio si no existe
    const dirPath = path.dirname(filePath);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
    
    if (!fs.existsSync(filePath)) return;
    
    const memoryData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    
    // Solo migrar si es el formato antiguo (array)
    if (!Array.isArray(memoryData)) return;
    
    console.log('🔄 Migrando memorias al nuevo formato usuario/global...');
    
    const newFormat = {
      global: memoryData.map((memory: string) => ({
        content: memory,
        timestamp: new Date().toISOString(),
        user: 'unknown'
      })),
      users: {}
    };
    
    fs.writeFileSync(filePath, JSON.stringify(newFormat, null, 2));
    console.log(`✅ Migración completada: ${memoryData.length} memorias migradas`);
  }

  private categorizeMemoriesByUser(memories: string[], username?: string): any {
    const categories = {
      userPreferences: [] as string[],
      factualInfo: [] as string[],
      interactions: [] as string[],
      recommendations: [] as string[],
      personalInfo: [] as string[],
      other: [] as string[]
    };
    
    memories.forEach(memory => {
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

  private selectMostRelevantMemoriesForUser(categories: any, maxCount: number): string[] {
    const selected: string[] = [];
    
    // Prioridad para usuario específico: información personal > preferencias > recomendaciones > factual > interacciones
    
    // Información personal del usuario (máxima prioridad)
    if (categories.personalInfo.length > 0 && selected.length < maxCount) {
      selected.push(...categories.personalInfo.slice(-1));
    }
    
    // Preferencias del usuario
    if (categories.userPreferences.length > 0 && selected.length < maxCount) {
      const remaining = maxCount - selected.length;
      selected.push(...categories.userPreferences.slice(-Math.min(2, remaining)));
    }
    
    // Recomendaciones específicas
    if (categories.recommendations.length > 0 && selected.length < maxCount) {
      const remaining = maxCount - selected.length;
      selected.push(...categories.recommendations.slice(-Math.min(1, remaining)));
    }
    
    // Información factual importante
    if (categories.factualInfo.length > 0 && selected.length < maxCount) {
      const remaining = maxCount - selected.length;
      selected.push(...categories.factualInfo.slice(-Math.min(1, remaining)));
    }
    
    // Interacciones recientes si hay espacio
    if (categories.interactions.length > 0 && selected.length < maxCount) {
      const remaining = maxCount - selected.length;
      selected.push(...categories.interactions.slice(-remaining));
    }
    
    return selected.slice(0, maxCount);
  }
}