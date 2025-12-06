import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import fetch from 'node-fetch';
import { OnlineUser, OnlineUsersResponse } from '../../common/interfaces';

@Injectable()
export class OnlineUsersService {
  constructor(private readonly configService: ConfigService) {}

  /**
   * Obtiene la lista de usuarios en línea del CBox
   */
  async getOnlineUsers(boxId: string, boxTag: string): Promise<OnlineUsersResponse> {
    try {
      const url = `https://www3.cbox.ws/box/?sec=onliners&boxid=${boxId}&boxtag=${boxTag}&_v=1063&xhr=1`;
      
      console.log(`👥 [ONLINE] Obteniendo usuarios en línea...`);
      
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'accept': '*/*',
          'accept-language': 'es-419,es;q=0.9,es-ES;q=0.8,en;q=0.7,en-GB;q=0.6,en-US;q=0.5,es-US;q=0.4',
          'priority': 'u=1, i',
          'referer': 'https://www3.cbox.ws/',
          'sec-ch-ua': '"Microsoft Edge";v="143", "Chromium";v="143", "Not A(Brand";v="24"',
          'sec-ch-ua-mobile': '?0',
          'sec-ch-ua-platform': '"Windows"',
          'sec-fetch-dest': 'empty',
          'sec-fetch-mode': 'cors',
          'sec-fetch-site': 'same-origin',
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0'
        }
      });

      if (!response.ok) {
        throw new Error(`Error obteniendo usuarios en línea: ${response.status} ${response.statusText}`);
      }

      const html = await response.text();
      return this.parseOnlineUsersHtml(html);
    } catch (error) {
      console.error('❌ [ONLINE] Error obteniendo usuarios en línea:', error);
      return {
        users: [],
        guestCount: 0,
        totalCount: 0
      };
    }
  }

  /**
   * Parsea el HTML de usuarios en línea y extrae la información
   */
  private parseOnlineUsersHtml(html: string): OnlineUsersResponse {
    const users: OnlineUser[] = [];
    let guestCount = 0;

    // Expresión regular para extraer usuarios registrados
    const userRegex = /<div class="usr ([^"]*)" data-id="([^"]*)" data-lvl="([^"]*)" data-pres="([^"]*)" data-pres-time="([^"]*)"[^>]*>[\s\S]*?<img class="pic" src="([^"]*)"[\s\S]*?<div class="nme">(?:<span[^>]*>)?([^<]+)(?:<\/span>)?<\/div>(?:[\s\S]*?<a href="([^"]*)"[^>]*><\/a>)?/g;

    let match;
    while ((match = userRegex.exec(html)) !== null) {
      const [, levelClass, id, level, presence, presenceTime, picture, name, profileUrl] = match;
      
      // Mapear clase a nombre de nivel
      const levelName = this.mapLevelClassToName(levelClass);
      
      users.push({
        id: id.trim(),
        name: this.cleanUserName(name),
        level: parseInt(level, 10),
        levelName,
        presence: presence as 'active' | 'idle',
        presenceTime: parseInt(presenceTime, 10),
        picture: picture.trim(),
        profileUrl: profileUrl?.trim()
      });
    }

    // Extraer número de invitados
    const guestMatch = html.match(/<span id="usrAnonCount">(\d+)<\/span>/);
    if (guestMatch) {
      guestCount = parseInt(guestMatch[1], 10);
    }

    const totalCount = users.length + guestCount;

    console.log(`👥 [ONLINE] Encontrados ${users.length} usuarios registrados y ${guestCount} invitados (total: ${totalCount})`);

    return {
      users,
      guestCount,
      totalCount
    };
  }

  /**
   * Mapea las clases CSS de nivel a nombres legibles
   */
  private mapLevelClassToName(levelClass: string): string {
    const levelMap: { [key: string]: string } = {
      'Adm': 'Admin',
      'Mod': 'Moderador',
      'Reg': 'Registrado',
      '': 'Invitado'
    };

    // Buscar la clase de nivel en el string (puede contener múltiples clases)
    for (const [cssClass, levelName] of Object.entries(levelMap)) {
      if (levelClass.includes(cssClass)) {
        return levelName;
      }
    }

    return 'Usuario'; // Fallback
  }

  /**
   * Limpia el nombre de usuario removiendo HTML y espacios extra
   */
  private cleanUserName(name: string): string {
    return name
      .replace(/<[^>]*>/g, '') // Remover etiquetas HTML
      .replace(/&nbsp;/g, ' ') // Reemplazar &nbsp; con espacios
      .replace(/&amp;/g, '&') // Reemplazar &amp; con &
      .replace(/&lt;/g, '<') // Reemplazar &lt; con <
      .replace(/&gt;/g, '>') // Reemplazar &gt; con >
      .replace(/&quot;/g, '"') // Reemplazar &quot; con "
      .trim();
  }

  /**
   * Genera un resumen legible de los usuarios en línea
   */
  generateOnlineUsersSummary(onlineData: OnlineUsersResponse): string {
    const { users, guestCount, totalCount } = onlineData;

    if (totalCount === 0) {
      return '👤 No hay nadie en línea en este momento.';
    }

    let summary = `👥 **${totalCount} personas en línea:**\n\n`;

    if (users.length > 0) {
      // Agrupar usuarios por nivel
      const usersByLevel: { [key: string]: OnlineUser[] } = {};
      users.forEach(user => {
        if (!usersByLevel[user.levelName]) {
          usersByLevel[user.levelName] = [];
        }
        usersByLevel[user.levelName].push(user);
      });

      // Orden de niveles (de mayor a menor jerarquía)
      const levelOrder = ['Admin', 'Moderador', 'Registrado', 'Usuario', 'Invitado'];

      levelOrder.forEach(levelName => {
        if (usersByLevel[levelName]?.length > 0) {
          const levelUsers = usersByLevel[levelName];
          summary += `**${levelName}s (${levelUsers.length}):**\n`;
          
          levelUsers.forEach(user => {
            const statusIcon = user.presence === 'active' ? '🟢' : '🟡';
            summary += `${statusIcon} ${user.name}\n`;
          });
          summary += '\n';
        }
      });
    }

    if (guestCount > 0) {
      summary += `👤 **${guestCount} invitados anónimos**\n`;
    }

    return summary.trim();
  }

  /**
   * Busca un usuario específico en la lista de usuarios en línea
   */
  findUserOnline(onlineData: OnlineUsersResponse, username: string): OnlineUser | null {
    const cleanSearchName = username.toLowerCase().trim();
    
    return onlineData.users.find(user => 
      user.name.toLowerCase().includes(cleanSearchName) ||
      cleanSearchName.includes(user.name.toLowerCase())
    ) || null;
  }
}