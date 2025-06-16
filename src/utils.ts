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
  fs.writeFileSync(filePath, JSON.stringify(messagesLog.slice(0, 200)));
};

export const saveEventsLog = async (event: string, user: string) => {
  const filePath = path.join(__dirname, "../data/events_log.json");
  const eventsLog = fs.existsSync(filePath)
    ? JSON.parse(fs.readFileSync(filePath, "utf-8"))
    : [];
  eventsLog.push({ event, user, date: new Date().toISOString() });
  fs.writeFileSync(filePath, JSON.stringify(eventsLog.slice(0, 200)));
};

export const getLastEvents = async () => {
  //get last 200 messages
  const filePath = path.join(__dirname, "../data/events_log.json");
  const eventsLog = fs.existsSync(filePath)
    ? JSON.parse(fs.readFileSync(filePath, "utf-8"))
    : [];
  return eventsLog;
};

//una funcion para verificar si el ultimo evento {event: 'Resumen'} fue hace menos de 10 minutos
export const isLastEvent = async (event: string) => {
  const eventsLog = await getLastEvents();
  const lastResumenEvent = eventsLog.find(
    (event: any) => event.event === event
  );
  if (!lastResumenEvent) return false;
  const lastEventDate = new Date(lastResumenEvent.date);
  const now = new Date();
  const diff = now.getTime() - lastEventDate.getTime();
  const minutes = Math.floor(diff / (1000 * 60));
  return minutes < 10;
};
