import path from "path";
import fs from "fs";

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

export const saveMemory = async (memory: string) => {
  // No hacer nada si la memoria está deshabilitada
  if (!Boolean(process.env.USE_MEMORY)) return;
  
  if (!memory || memory.trim().length === 0) return;
  
  const filePath = path.join(__dirname, "../data/memory.json");
  const memoryLog = fs.existsSync(filePath)
    ? JSON.parse(fs.readFileSync(filePath, "utf-8"))
    : [];
  
  // Limpiar la memoria de información duplicada o muy similar
  const cleanMemory = memory.trim();
  
  // Evitar duplicados exactos
  if (memoryLog.includes(cleanMemory)) return;
  
  // Evitar duplicados similares (más del 80% de similitud)
  const isDuplicate = memoryLog.some((existingMemory: string) => {
    const similarity = calculateSimilarity(cleanMemory.toLowerCase(), existingMemory.toLowerCase());
    return similarity > 0.8;
  });
  
  if (isDuplicate) return;
  
  memoryLog.push(cleanMemory);
  fs.writeFileSync(filePath, JSON.stringify(memoryLog.slice(-50))); // Mantener solo 50 memorias
};

export const getMemory = async (): Promise<string[]> => {
  // Retornar array vacío si la memoria está deshabilitada
  if (!Boolean(process.env.USE_MEMORY)) return [];
  
  const filePath = path.join(__dirname, "../data/memory.json");
  const memoryLog = fs.existsSync(filePath)
    ? JSON.parse(fs.readFileSync(filePath, "utf-8"))
    : [];
  
  // Filtrar y categorizar memorias por relevancia
  const categorizedMemories = categorizeMemories(memoryLog);
  
  // Seleccionar las más importantes (máximo 5 elementos)
  return selectMostRelevantMemories(categorizedMemories, 5);
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

// Función para limpiar memorias duplicadas o irrelevantes existentes
export const cleanExistingMemories = async () => {
  // No hacer nada si la memoria está deshabilitada
  if (!Boolean(process.env.USE_MEMORY)) return;
  
  const filePath = path.join(__dirname, "../data/memory.json");
  if (!fs.existsSync(filePath)) return;
  
  const memoryLog = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  const cleanedMemories: string[] = [];
  
  memoryLog.forEach((memory: string) => {
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
    const isDuplicate = cleanedMemories.some(existing => {
      const similarity = calculateSimilarity(memory.toLowerCase(), existing.toLowerCase());
      return similarity > 0.8;
    });
    
    if (!isDuplicate) {
      cleanedMemories.push(memory);
    }
  });
  
  fs.writeFileSync(filePath, JSON.stringify(cleanedMemories.slice(-30)));
  console.log(`Memorias limpiadas: ${memoryLog.length} -> ${cleanedMemories.length}`);
};

export const sleep = (ms: number) => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};
