import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as path from 'path';
import * as fs from 'fs';
import { UtilsService } from './utils.service';

@Injectable()
export class LoggingService {
  constructor(
    private readonly configService: ConfigService,
    private readonly utilsService: UtilsService,
  ) {}

  async getLastMessages(): Promise<any[]> {
    const filePath = path.join(process.cwd(), 'data', 'messages_log.json');
    
    // Crear directorio si no existe
    const dirPath = path.dirname(filePath);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
    
    const messagesLog = fs.existsSync(filePath)
      ? JSON.parse(fs.readFileSync(filePath, 'utf-8'))
      : [];
    return messagesLog;
  }

  async saveLog(user: string, message: string): Promise<void> {
    const filePath = path.join(process.cwd(), 'data', 'messages_log.json');
    
    // Crear directorio si no existe
    const dirPath = path.dirname(filePath);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
    
    const messagesLog = fs.existsSync(filePath)
      ? JSON.parse(fs.readFileSync(filePath, 'utf-8'))
      : [];
    
    // Limpiar HTML tanto del usuario como del mensaje
    const cleanUser = this.utilsService.cleanHtmlFromMessage(user);
    const cleanMessage = this.utilsService.cleanHtmlFromMessage(message);
    
    messagesLog.push({ user: cleanUser, message: cleanMessage });
    fs.writeFileSync(filePath, JSON.stringify(messagesLog.slice(-200)));
  }

  async clearMessagesLog(): Promise<number> {
    const filePath = path.join(process.cwd(), 'data', 'messages_log.json');
    
    // Crear directorio si no existe
    const dirPath = path.dirname(filePath);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
    
    const messagesLog = fs.existsSync(filePath)
      ? JSON.parse(fs.readFileSync(filePath, 'utf-8'))
      : [];
    
    const messageCount = messagesLog.length;
    fs.writeFileSync(filePath, JSON.stringify([]));
    
    console.log(`📝 Log de mensajes limpiado: ${messageCount} mensajes eliminados`);
    return messageCount;
  }

  async saveEventsLog(event: string, user: string): Promise<void> {
    const filePath = path.join(process.cwd(), 'data', 'events_log.json');
    
    // Crear directorio si no existe
    const dirPath = path.dirname(filePath);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
    
    const eventsLog = fs.existsSync(filePath)
      ? JSON.parse(fs.readFileSync(filePath, 'utf-8'))
      : [];
    
    // Limpiar HTML del usuario
    const cleanUser = this.utilsService.cleanHtmlFromMessage(user);
    
    eventsLog.push({ event, user: cleanUser, date: new Date().toISOString() });
    fs.writeFileSync(filePath, JSON.stringify(eventsLog.slice(-200)));
  }

  async getLastEvents(): Promise<any[]> {
    const filePath = path.join(process.cwd(), 'data', 'events_log.json');
    
    // Crear directorio si no existe
    const dirPath = path.dirname(filePath);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
    
    const eventsLog = fs.existsSync(filePath)
      ? JSON.parse(fs.readFileSync(filePath, 'utf-8'))
      : [];
    return eventsLog;
  }

  async getLastEventType(event: string): Promise<{ minutesLeft: number; lastResumenEvent: any }> {
    const eventsLog: any[] = await this.getLastEvents();
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
  }

  async cleanBotMessagesFromLog(botUsername: string): Promise<void> {
    const filePath = path.join(process.cwd(), 'data', 'messages_log.json');
    
    // Crear directorio si no existe
    const dirPath = path.dirname(filePath);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
    
    if (!fs.existsSync(filePath)) return;

    const messagesLog = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const filteredMessages = messagesLog.filter((msg: any) => msg.user !== botUsername);
    
    const removedCount = messagesLog.length - filteredMessages.length;
    if (removedCount > 0) {
      fs.writeFileSync(filePath, JSON.stringify(filteredMessages));
      console.log(`🧹 Limpieza del log: ${removedCount} mensajes del bot removidos`);
    }
  }
}