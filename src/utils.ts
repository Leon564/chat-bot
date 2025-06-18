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

export const clearMessagesLog = async () => {
  const filePath = path.join(__dirname, "../data/messages_log.json");
  fs.writeFileSync(filePath, "[]");
};

export const saveMemory = async (memory: string) => {
  const filePath = path.join(__dirname, "../data/memory.json");
  const memoryLog = fs.existsSync(filePath)
    ? JSON.parse(fs.readFileSync(filePath, "utf-8"))
    : [];
  memoryLog.push(memory);
  fs.writeFileSync(filePath, JSON.stringify(memoryLog.slice(-200)));
};

export const getMemory = async () => {
  const filePath = path.join(__dirname, "../data/memory.json");
  const memoryLog = fs.existsSync(filePath)
    ? JSON.parse(fs.readFileSync(filePath, "utf-8"))
    : [];
  return memoryLog;
};

export const sleep = (ms: number) => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

