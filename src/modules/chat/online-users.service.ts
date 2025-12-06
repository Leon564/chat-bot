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

    console.log(`🔍 [DEBUG] HTML recibido (primeros 500 chars):`, html.substring(0, 500));

    // Expresión regular más robusta para extraer usuarios registrados
    // Busca divs con clase "usr" que contengan los atributos data-id, data-lvl, etc.
    const userRegex = /<div\s+class="usr[^"]*"\s+data-id="([^"]*)"\s+data-lvl="([^"]*)"\s+data-pres="([^"]*)"\s+data-pres-time="([^"]*)"[^>]*>([\s\S]*?)<\/div>/g;

    let match;
    while ((match = userRegex.exec(html)) !== null) {
      const [fullMatch, id, level, presence, presenceTime, innerHtml] = match;
      
      console.log(`🔍 [DEBUG] Match encontrado:`, { id, level, presence, presenceTime });
      
      // Extraer imagen
      const picMatch = innerHtml.match(/<img\s+class="pic"\s+src="([^"]*)"/);
      const picture = picMatch ? picMatch[1] : '';
      
      // Extraer nombre del div nme (puede contener HTML anidado)
      const nameMatch = innerHtml.match(/<div\s+class="nme"[^>]*>([\s\S]*?)<\/div>/);
      let name = '';
      if (nameMatch) {
        let nameContent = nameMatch[1].trim();
        
        console.log(`🔍 [DEBUG] Contenido original del div nme:`, nameContent);
        
        // Si hay elementos anidados como <span>, extraer solo el texto
        // Remover etiquetas HTML pero conservar el texto
        nameContent = nameContent.replace(/<[^>]*>/g, '');
        
        // Limpiar entidades HTML y espacios extra
        name = nameContent
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/\s+/g, ' ')
          .trim();
          
        console.log(`✅ [DEBUG] Nombre extraído:`, name);
      } else {
        console.log(`❌ [DEBUG] No se encontró div nme en:`, innerHtml.substring(0, 200));
      }
      
      // Extraer URL del perfil (opcional)
      const profileUrlMatch = innerHtml.match(/<a\s+href="([^"]*)"[^>]*class="nmeurl"/);
      const profileUrl = profileUrlMatch ? profileUrlMatch[1] : undefined;
      
      const numericLevel = parseInt(level, 10);
      
      // Mapear nivel numérico a nombre de rol
      const levelName = this.mapLevelToRoleName(numericLevel);
      
      // Verificar si es usuario registrado
      const isRegistered = this.isUserRegistered(numericLevel);
      
      const cleanName = this.cleanUserName(name);
      
      users.push({
        id: id.trim(),
        name: cleanName,
        level: numericLevel,
        levelName,
        presence: presence as 'active' | 'idle',
        presenceTime: parseInt(presenceTime, 10),
        picture: picture.trim(),
        profileUrl: profileUrl?.trim()
      });
      
      // Log para debug
      console.log(`👤 [DEBUG] Usuario procesado: ${cleanName} | ID: ${id} | Level: ${numericLevel} (${levelName}) | Registrado: ${isRegistered}`);
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
      '': 'No registrado'
    };

    // Buscar la clase de nivel en el string (puede contener múltiples clases)
    for (const [cssClass, levelName] of Object.entries(levelMap)) {
      if (cssClass === '' && levelClass.trim() === '') {
        return levelName; // Para usuarios no registrados (sin clase)
      } else if (cssClass !== '' && levelClass.includes(cssClass)) {
        return levelName;
      }
    }

    return 'Usuario'; // Fallback
  }

  /**
   * Mapea el nivel numérico a nombre de rol
   */
  private mapLevelToRoleName(level: number): string {
    switch (level) {
      case 1:
        return 'No registrado';
      case 2:
        return 'Registrado';
      case 3:
        return 'Moderador';
      case 4:
        return 'Admin';
      default:
        return 'Usuario'; // Fallback
    }
  }

  /**
   * Determina si un usuario está registrado basado en data-lvl
   */
  private isUserRegistered(level: number): boolean {
    return level >= 2;
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
      // Agrupar usuarios por nivel numérico para mejor orden
      const usersByLevel: { [key: number]: OnlineUser[] } = {};
      users.forEach(user => {
        if (!usersByLevel[user.level]) {
          usersByLevel[user.level] = [];
        }
        usersByLevel[user.level].push(user);
      });

      // Orden de niveles por jerarquía (de mayor a menor: 4, 3, 2, 1)
      const levelOrder = [4, 3, 2, 1];

      levelOrder.forEach(levelNum => {
        if (usersByLevel[levelNum]?.length > 0) {
          const levelUsers = usersByLevel[levelNum];
          const levelName = this.mapLevelToRoleName(levelNum);
          const plural = levelNum === 1 ? 'No registrados' : `${levelName}s`;
          
          summary += `**${plural} (${levelUsers.length}):**[br]`;
          
          levelUsers.forEach(user => {
            const statusIcon = user.presence === 'active' ? '🟢' : '🟡';
            // Mostrar solo el nombre, sin ID para mejor legibilidad
            summary += `${statusIcon} ${user.name}[br]`;
          });
          summary += '[br]';
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

  /**
   * Obtiene estadísticas detalladas de usuarios en línea
   */
  getOnlineUserStats(onlineData: OnlineUsersResponse): string {
    const { users, guestCount, totalCount } = onlineData;
    
    const registeredCount = users.filter(u => u.level >= 2).length;
    const nonRegisteredCount = users.filter(u => u.level === 1).length;
    const moderatorsCount = users.filter(u => u.level === 3).length;
    const adminsCount = users.filter(u => u.level === 4).length;
    const activeCount = users.filter(u => u.presence === 'active').length;
    const idleCount = users.filter(u => u.presence === 'idle').length;

    return `📊 **Estadísticas detalladas:**
👑 Admins: ${adminsCount}
🛡️ Moderadores: ${moderatorsCount}
✅ Registrados: ${registeredCount - moderatorsCount - adminsCount}
❓ No registrados: ${nonRegisteredCount}
👤 Invitados: ${guestCount}

📈 **Estado de actividad:**
🟢 Activos: ${activeCount}
🟡 Ausentes: ${idleCount}

📋 **Total: ${totalCount} personas**`;
  }

  /**
   * Verifica si un usuario específico está en línea por ID
   */
  isUserOnlineById(onlineData: OnlineUsersResponse, userId: string): OnlineUser | null {
    return onlineData.users.find(user => user.id === userId) || null;
  }
}