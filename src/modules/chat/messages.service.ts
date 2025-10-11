import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SendMessageOptions, MessageData } from '../../common/interfaces';
import { UtilsService } from '../../common/utils/utils.service';
import { load } from 'cheerio';
import WebSocket from 'ws';
import * as he from 'he';

@Injectable()
export class MessagesService {
  constructor(
    private readonly configService: ConfigService,
    private readonly utilsService: UtilsService,
  ) {}

  async sendMessage({
    key,
    message,
    pic,
    username,
    boxId,
    boxTag,
    iframeUrl,
  }: SendMessageOptions): Promise<void> {
    // Validar que el mensaje no esté vacío y no sea solo una mención incompleta
    if (!message || message.trim().length === 0) {
      console.log('🚫 Mensaje vacío no enviado');
      return;
    }

    // Filtrar mensajes que solo contengan menciones incompletas o vacías
    const cleanMessage = message.trim();
    if (cleanMessage === '<@' || cleanMessage.match(/^<@\s*>?$/)) {
      console.log('🚫 Mensaje con mención incompleta no enviado:', cleanMessage);
      return;
    }

    // Filtrar mensajes que solo contengan menciones sin contenido útil
    const mentionOnlyPattern = /^<@[^>]*>\s*$/;
    if (mentionOnlyPattern.test(cleanMessage)) {
      console.log('🚫 Mensaje con solo mención vacía no enviado:', cleanMessage);
      return;
    }
    console.log('Enviando mensaje:', cleanMessage);
    const baseUrl = iframeUrl?.split('?')[0];
    
    try {
      const response = await fetch(
        `${baseUrl}?sec=submit&boxid=${boxId || ''}&boxtag=${boxTag || ''}&_v=1063`,
        {
          headers: {
            accept: '*/*',
            'accept-language':
              'es-419,es;q=0.9,es-ES;q=0.8,en;q=0.7,en-GB;q=0.6,en-US;q=0.5',
            'content-type': 'application/x-www-form-urlencoded',
            'sec-ch-ua':
              '"Not_A Brand";v="8", "Chromium";v="120", "Microsoft Edge";v="120"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"Windows"',
            'sec-fetch-dest': 'empty',
            'sec-fetch-mode': 'cors',
            'sec-fetch-site': 'same-origin',
            Referer: 'https://www4.cbox.ws/',
            'Referrer-Policy': 'origin',
          },
          body: `aj=1063&lp=2529196&pst=${message?.substring(
            0,
            300
          )}&key=${key}&fp=0&lid=55837&nme=${username}&pic=${pic}`,
          method: 'POST',
        }
      );
      
      // Optional: log response for debugging
      if (!response.ok) {
        console.error('Failed to send message:', response.statusText);
      }
    } catch (error) {
      console.error('Error sending message:', error);
      throw error;
    }
  }

  toDomain(data: WebSocket.Data): MessageData {
    const splitedData = data.toString().split('\t');
    if (splitedData.length <= 1) return {} as MessageData;

    const [n, id, date, name, lvl, x, message, y, z, id2, w, id3] = splitedData;
    
    return {
      id,
      date,
      name: this.cleanMessage(name), // Limpiar HTML del nombre también
      lvl,
      message: this.cleanMessage(message),
    };
  }

  private cleanMessage(message: string): string {
    try {
      const text = he.decode(message);
      return text.replace(/<[^>]*>/g, '');
    } catch (e) {
      console.log(e);
      return message;
    }
  }
}