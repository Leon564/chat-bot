import path from "path";
import fs from "fs";

/**
 * Divide un texto en múltiples partes respetando el límite de caracteres y sin cortar palabras
 * @param text - Texto a dividir
 * @param maxLength - Longitud máxima por parte
 * @returns Array de strings con las partes divididas
 */
export const splitMessageIntoParts = (text: string, maxLength: number): string[] => {
  if (!text || text.length <= maxLength) {
    return [text];
  }

  const parts: string[] = [];
  
  // Primero intentar dividir por párrafos (doble salto de línea)
  const paragraphs = text.split(/\n\s*\n/).filter(p => p.trim().length > 0);
  
  let currentPart = "";
  
  for (const paragraph of paragraphs) {
    const trimmedParagraph = paragraph.trim();
    
    // Si el párrafo completo cabe en la parte actual
    if ((currentPart + (currentPart ? "\n\n" : "") + trimmedParagraph).length <= maxLength) {
      currentPart += (currentPart ? "\n\n" : "") + trimmedParagraph;
    } else {
      // Guardar la parte actual si tiene contenido
      if (currentPart.trim()) {
        parts.push(currentPart.trim());
        currentPart = "";
      }
      
      // Si el párrafo es muy largo, dividirlo por oraciones
      if (trimmedParagraph.length > maxLength) {
        const sentences = trimmedParagraph.split(/[.!?]\s+/).filter(s => s.trim().length > 0);
        
        for (let sentence of sentences) {
          // Agregar puntuación si no la tiene
          if (!sentence.trim().match(/[.!?]$/)) {
            sentence = sentence.trim() + ".";
          }
          
          // Si la oración cabe en la parte actual
          if ((currentPart + (currentPart ? " " : "") + sentence).length <= maxLength) {
            currentPart += (currentPart ? " " : "") + sentence;
          } else {
            // Guardar la parte actual si tiene contenido
            if (currentPart.trim()) {
              parts.push(currentPart.trim());
              currentPart = "";
            }
            
            // Si la oración sola es muy larga, dividirla por palabras
            if (sentence.length > maxLength) {
              const words = sentence.split(" ");
              let wordPart = "";
              
              for (const word of words) {
                if ((wordPart + (wordPart ? " " : "") + word).length <= maxLength) {
                  wordPart += (wordPart ? " " : "") + word;
                } else {
                  if (wordPart.trim()) {
                    parts.push(wordPart.trim());
                  }
                  wordPart = word;
                }
              }
              
              if (wordPart.trim()) {
                currentPart = wordPart;
              }
            } else {
              currentPart = sentence;
            }
          }
        }
      } else {
        currentPart = trimmedParagraph;
      }
    }
  }
  
  // Agregar la última parte si tiene contenido
  if (currentPart.trim()) {
    parts.push(currentPart.trim());
  }
  
  // Si no hay partes válidas, devolver el texto original truncado
  if (parts.length === 0) {
    return [text.substring(0, maxLength)];
  }
  
  return parts;
};

export const getLastMessages = async () => {
  //get last 200 messages
  const filePath = path.join(__dirname, "../data/messages_log.json");
  const messagesLog = fs.existsSync(filePath)
    ? JSON.parse(fs.readFileSync(filePath, "utf-8"))
    : [];
  return messagesLog;
};

export const saveLog = async (user: string, message: string) => {
  const filePath = path.join(__dirname, "../data/messages_log.json");
  const messagesLog = fs.existsSync(filePath)
    ? JSON.parse(fs.readFileSync(filePath, "utf-8"))
    : [];
  messagesLog.push({ user, message });
  fs.writeFileSync(filePath, JSON.stringify(messagesLog.slice(-200)));
};

export const clearMessagesLog = async () => {
  const filePath = path.join(__dirname, "../data/messages_log.json");
  fs.writeFileSync(filePath, JSON.stringify([]));
};

export const saveEventsLog = async (event: string, user: string) => {
  const filePath = path.join(__dirname, "../data/events_log.json");
  const eventsLog = fs.existsSync(filePath)
    ? JSON.parse(fs.readFileSync(filePath, "utf-8"))
    : [];
  eventsLog.push({ event, user, date: new Date().toISOString() });
  fs.writeFileSync(filePath, JSON.stringify(eventsLog.slice(-200)));
};

export const getLastEvents = async () => {
  //get last 200 messages
  const filePath = path.join(__dirname, "../data/events_log.json");
  const eventsLog = fs.existsSync(filePath)
    ? JSON.parse(fs.readFileSync(filePath, "utf-8"))
    : [];
  return eventsLog;
};

export const getLastEventType = async (event: string) => {
  const eventsLog: any[] = await getLastEvents();
  const lastEvent = eventsLog
    .slice()
    .reverse()
    .find((_event: any) => _event.event === event);
  if (!lastEvent) return { minutesLeft: 1000, lastResumenEvent: null };
  const lastEventDate = new Date(lastEvent.date);
  const now = new Date();
  const diff = now.getTime() - lastEventDate.getTime();
  const minutesLeft = Math.floor(diff / (1000 * 60));
  return { minutesLeft, lastResumenEvent: lastEvent };
};

export const saveMemory = async (memory: string, username?: string) => {
  // No hacer nada si la memoria está deshabilitada
  if (!Boolean(process.env.USE_MEMORY)) return;
  
  if (!memory || memory.trim().length === 0) return;
  
  const filePath = path.join(__dirname, "../data/memory.json");
  const memoryData = fs.existsSync(filePath)
    ? JSON.parse(fs.readFileSync(filePath, "utf-8"))
    : { global: [], users: {} };
  
  // Asegurar estructura correcta
  if (!memoryData.global) memoryData.global = [];
  if (!memoryData.users) memoryData.users = {};
  
  const cleanMemory = memory.trim();
  const timestamp = new Date().toISOString();
  
  // Crear objeto de memoria con metadata
  const memoryEntry = {
    content: cleanMemory,
    timestamp,
    user: username || 'unknown'
  };
  
  if (username) {
    // Memoria específica del usuario
    if (!memoryData.users[username]) {
      memoryData.users[username] = [];
    }
    
    // Evitar duplicados para este usuario específico
    const userMemories = memoryData.users[username];
    const isDuplicate = userMemories.some((existingMemory: any) => {
      const similarity = calculateSimilarity(
        cleanMemory.toLowerCase(), 
        existingMemory.content.toLowerCase()
      );
      return similarity > 0.8;
    });
    
    if (!isDuplicate) {
      memoryData.users[username].push(memoryEntry);
      // Mantener solo las últimas 30 memorias por usuario
      memoryData.users[username] = memoryData.users[username].slice(-30);
    }
  } else {
    // Memoria global
    const isDuplicate = memoryData.global.some((existingMemory: any) => {
      const similarity = calculateSimilarity(
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
};

export const getMemory = async (username?: string): Promise<string[]> => {
  // Retornar array vacío si la memoria está deshabilitada
  if (!Boolean(process.env.USE_MEMORY)) return [];
  
  const filePath = path.join(__dirname, "../data/memory.json");
  const memoryData = fs.existsSync(filePath)
    ? JSON.parse(fs.readFileSync(filePath, "utf-8"))
    : { global: [], users: {} };
  
  // Asegurar estructura correcta
  if (!memoryData.global) memoryData.global = [];
  if (!memoryData.users) memoryData.users = {};
  
  let relevantMemories: any[] = [];
  
  if (username && memoryData.users[username]) {
    // Obtener memorias específicas del usuario
    const userMemories = memoryData.users[username];
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
  const categorizedMemories = categorizeMemoriesByUser(memoryContents, username);
  
  // Seleccionar las más importantes (máximo 5 elementos)
  return selectMostRelevantMemoriesForUser(categorizedMemories, 5);
};

// Nueva función para calcular similitud entre strings
const calculateSimilarity = (str1: string, str2: string): number => {
  const longer = str1.length > str2.length ? str1 : str2;
  const shorter = str1.length > str2.length ? str2 : str1;
  
  if (longer.length === 0) return 1.0;
  
  const distance = levenshteinDistance(longer, shorter);
  return (longer.length - distance) / longer.length;
};

// Función auxiliar para calcular distancia de Levenshtein
const levenshteinDistance = (str1: string, str2: string): number => {
  const matrix = [];
  
  for (let i = 0; i <= str2.length; i++) {
    matrix[i] = [i];
  }
  
  for (let j = 0; j <= str1.length; j++) {
    matrix[0][j] = j;
  }
  
  for (let i = 1; i <= str2.length; i++) {
    for (let j = 1; j <= str1.length; j++) {
      if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }
  
  return matrix[str2.length][str1.length];
};

// Categorizar memorias por tipo de información
const categorizeMemories = (memories: string[]): {
  userPreferences: string[];
  factualInfo: string[];
  interactions: string[];
  recommendations: string[];
  other: string[];
} => {
  const categories = {
    userPreferences: [] as string[],
    factualInfo: [] as string[],
    interactions: [] as string[],
    recommendations: [] as string[],
    other: [] as string[]
  };
  
  memories.forEach(memory => {
    const lowerMemory = memory.toLowerCase();
    
    if (lowerMemory.includes('le gusta') || lowerMemory.includes('favorito') || lowerMemory.includes('prefiere')) {
      categories.userPreferences.push(memory);
    } else if (lowerMemory.includes('recomendación') || lowerMemory.includes('anime:') || lowerMemory.includes('manga:')) {
      categories.recommendations.push(memory);
    } else if (lowerMemory.includes('leon564') || lowerMemory.includes('sleepy ash') || lowerMemory.includes('creador')) {
      categories.factualInfo.push(memory);
    } else if (lowerMemory.includes('usuario') || lowerMemory.includes('preguntó') || lowerMemory.includes('interesado')) {
      categories.interactions.push(memory);
    } else {
      categories.other.push(memory);
    }
  });
  
  return categories;
};

// Seleccionar las memorias más relevantes
const selectMostRelevantMemories = (categories: any, maxCount: number): string[] => {
  const selected: string[] = [];
  
  // Prioridad: preferencias del usuario > información factual > interacciones recientes
  
  // Tomar las preferencias más recientes del usuario
  if (categories.userPreferences.length > 0) {
    selected.push(...categories.userPreferences.slice(-2));
  }
  
  // Información factual importante
  if (categories.factualInfo.length > 0 && selected.length < maxCount) {
    selected.push(...categories.factualInfo.slice(-1));
  }
  
  // Recomendaciones recientes
  if (categories.recommendations.length > 0 && selected.length < maxCount) {
    selected.push(...categories.recommendations.slice(-1));
  }
  
  // Interacciones importantes
  if (categories.interactions.length > 0 && selected.length < maxCount) {
    const remaining = maxCount - selected.length;
    selected.push(...categories.interactions.slice(-remaining));
  }
  
  return selected.slice(0, maxCount);
};

// Categorizar memorias por tipo de información específica para un usuario
const categorizeMemoriesByUser = (memories: string[], username?: string): {
  userPreferences: string[];
  factualInfo: string[];
  interactions: string[];
  recommendations: string[];
  personalInfo: string[];
  other: string[];
} => {
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
    const userMention = username ? lowerMemory.includes(username.toLowerCase()) : false;
    
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
};

// Seleccionar las memorias más relevantes para un usuario específico
const selectMostRelevantMemoriesForUser = (categories: any, maxCount: number): string[] => {
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
};

// Función para limpiar memorias duplicadas o irrelevantes existentes
export const cleanExistingMemories = async () => {
  // No hacer nada si la memoria está deshabilitada
  if (!Boolean(process.env.USE_MEMORY)) return;
  
  const filePath = path.join(__dirname, "../data/memory.json");
  if (!fs.existsSync(filePath)) return;
  
  const memoryData = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  
  // Manejar formato antiguo (array) y nuevo formato (objeto)
  if (Array.isArray(memoryData)) {
    // Formato antiguo - migrar primero
    await migrateMemoriesToUserFormat();
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
      const similarity = calculateSimilarity(memory.toLowerCase(), existingContent.toLowerCase());
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
  
  // Limpiar memorias por usuario
  const cleanedUsers: { [key: string]: any[] } = {};
  Object.entries(memoryData.users).forEach(([username, userMemories]: [string, any]) => {
    if (!Array.isArray(userMemories)) return;
    
    const cleanedUserMemories: any[] = [];
    userMemories.forEach((memoryEntry: any) => {
      const memory = typeof memoryEntry === 'string' ? memoryEntry : memoryEntry.content;
      
      if (memory.length < 10) return;
      
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
      
      const isDuplicate = cleanedUserMemories.some(existing => {
        const existingContent = typeof existing === 'string' ? existing : existing.content;
        const similarity = calculateSimilarity(memory.toLowerCase(), existingContent.toLowerCase());
        return similarity > 0.8;
      });
      
      if (!isDuplicate) {
        if (typeof memoryEntry === 'object') {
          cleanedUserMemories.push(memoryEntry);
        } else {
          cleanedUserMemories.push({
            content: memory,
            timestamp: new Date().toISOString(),
            user: username
          });
        }
      }
    });
    
    if (cleanedUserMemories.length > 0) {
      cleanedUsers[username] = cleanedUserMemories.slice(-25); // Máximo 25 por usuario
    }
  });
  
  const newMemoryData = {
    global: cleanedGlobal.slice(-15), // Máximo 15 memorias globales
    users: cleanedUsers
  };
  
  const originalGlobalCount = memoryData.global.length;
  const originalUserCount = Object.values(memoryData.users).reduce((acc: number, memories: any) => acc + (Array.isArray(memories) ? memories.length : 0), 0);
  const newGlobalCount = newMemoryData.global.length;
  const newUserCount = Object.values(newMemoryData.users).reduce((acc: number, memories: any) => acc + memories.length, 0);
  
  fs.writeFileSync(filePath, JSON.stringify(newMemoryData, null, 2));
  console.log(`✅ Memorias limpiadas:`);
  console.log(`   Global: ${originalGlobalCount} -> ${newGlobalCount}`);
  console.log(`   Usuarios: ${originalUserCount} -> ${newUserCount}`);
  console.log(`   Total usuarios: ${Object.keys(cleanedUsers).length}`);
};

// Obtener memorias específicas de un usuario
export const getUserMemories = async (username: string): Promise<any[]> => {
  if (!Boolean(process.env.USE_MEMORY)) return [];
  
  const filePath = path.join(__dirname, "../data/memory.json");
  if (!fs.existsSync(filePath)) return [];
  
  const memoryData = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  
  if (!memoryData.users || !memoryData.users[username]) return [];
  
  return memoryData.users[username];
};

// Limpiar memorias de un usuario específico
export const clearUserMemories = async (username: string): Promise<void> => {
  if (!Boolean(process.env.USE_MEMORY)) return;
  
  const filePath = path.join(__dirname, "../data/memory.json");
  if (!fs.existsSync(filePath)) return;
  
  const memoryData = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  
  if (memoryData.users && memoryData.users[username]) {
    delete memoryData.users[username];
    fs.writeFileSync(filePath, JSON.stringify(memoryData, null, 2));
  }
};

// Obtener estadísticas de memoria por usuario
export const getMemoryStats = async (): Promise<{
  totalUsers: number;
  totalMemories: number;
  globalMemories: number;
  topUsers: { username: string; memories: number }[];
}> => {
  if (!Boolean(process.env.USE_MEMORY)) {
    return { totalUsers: 0, totalMemories: 0, globalMemories: 0, topUsers: [] };
  }
  
  const filePath = path.join(__dirname, "../data/memory.json");
  if (!fs.existsSync(filePath)) {
    return { totalUsers: 0, totalMemories: 0, globalMemories: 0, topUsers: [] };
  }
  
  const memoryData = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  
  const totalUsers = Object.keys(memoryData.users || {}).length;
  const globalMemories = (memoryData.global || []).length;
  
  let totalMemories = globalMemories;
  const userMemoryCounts: { username: string; memories: number }[] = [];
  
  if (memoryData.users) {
    Object.entries(memoryData.users).forEach(([username, memories]: [string, any]) => {
      const memoryCount = Array.isArray(memories) ? memories.length : 0;
      totalMemories += memoryCount;
      userMemoryCounts.push({ username, memories: memoryCount });
    });
  }
  
  // Ordenar usuarios por cantidad de memorias (descendente)
  const topUsers = userMemoryCounts
    .sort((a, b) => b.memories - a.memories)
    .slice(0, 10);
  
  return {
    totalUsers,
    totalMemories,
    globalMemories,
    topUsers
  };
};

// Migrar memorias existentes al nuevo formato
export const migrateMemoriesToUserFormat = async (): Promise<void> => {
  if (!Boolean(process.env.USE_MEMORY)) return;
  
  const filePath = path.join(__dirname, "../data/memory.json");
  if (!fs.existsSync(filePath)) return;
  
  const existingData = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  
  // Si ya está en el nuevo formato, no hacer nada
  if (existingData.global !== undefined && existingData.users !== undefined) {
    return;
  }
  
  // Si es un array (formato antiguo), migrar
  if (Array.isArray(existingData)) {
    const newData = {
      global: existingData.map((memory: string) => ({
        content: memory,
        timestamp: new Date().toISOString(),
        user: 'unknown'
      })),
      users: {}
    };
    
    // Crear backup del formato anterior
    const backupPath = path.join(__dirname, "../data/memory_backup.json");
    fs.writeFileSync(backupPath, JSON.stringify(existingData, null, 2));
    
    // Guardar en nuevo formato
    fs.writeFileSync(filePath, JSON.stringify(newData, null, 2));
    
    console.log('✅ Memorias migradas al nuevo formato con categorización por usuario');
    console.log(`📁 Backup creado en: ${backupPath}`);
  }
};

export const sleep = (ms: number) => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};
