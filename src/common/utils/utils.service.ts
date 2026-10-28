import { Injectable } from '@nestjs/common';
import path from 'path';
import fs from 'fs';
import * as he from 'he';

@Injectable()
export class UtilsService {
  /**
   * Limpia un mensaje removiendo etiquetas HTML y decodificando entidades
   */
  cleanHtmlFromMessage(message: string): string {
    try {
      if (!message || typeof message !== 'string') {
        return '';
      }

      // Primero decodificar entidades HTML (&amp; -> &, &lt; -> <, etc.)
      let cleanMessage = he.decode(message);

      // Luego remover todas las etiquetas HTML
      cleanMessage = cleanMessage.replace(/<[^>]*>/g, '');

      // Limpiar espacios extra y caracteres de control
      cleanMessage = cleanMessage.trim().replace(/\s+/g, ' ');

      return cleanMessage;
    } catch (e) {
      console.log('Error cleaning HTML from message:', e);
      return message || '';
    }
  }

  /**
   * Stronger cleanup for anything that gets persisted into memory.json.
   * The LLM occasionally echoes user input verbatim, so before we trust the
   * extracted SAVE_MEMORY content we strip everything that could either
   * (a) re-trigger a bot feature when the memory is read back into the prompt
   * or (b) be rendered verbatim by the chat client and abuse other users:
   *   - HTML tags + entities (delegated to cleanHtmlFromMessage)
   *   - Bot intent tokens like {{resumen}} / {{usuarios_online}}
   *   - Every memory verb: SAVE/LOAD_MEMORY, _FACT, _FACT_ABOUT and _ERRAND
   *     (defence against nested injection — SAVE_FACT was added in Task 4 of
   *     fase 4b, when it replaced SAVE_MEMORY as the memory-emitting token;
   *     SAVE_FACT_ABOUT and SAVE_ERRAND came with cross-user context. Without
   *     stripping them too, a user could nest one inside the object of
   *     another fact — or inside the text of an errand — and have it survive
   *     sanitisation)
   *   - BBCode media tags [img|image|audio|video]url[/...]
   *   - The leading ^#hex color prefix used by sendBotMessage
   *   - <@user> mentions (kept as @user so the recall reads naturally
   *     without firing notifications when echoed back to chat)
   *   - Control chars (\x00-\x1f, \x7f)
   * Finally truncates to `maxLen` chars at a word boundary and discards
   * anything shorter than `minLen` after cleanup.
   */
  sanitizeMemoryContent(raw: string, opts: { maxLen?: number; minLen?: number } = {}): string {
    if (!raw || typeof raw !== 'string') return '';
    const { maxLen = 280, minLen = 5 } = opts;

    // Convert <@user> to @user *before* the HTML strip so cleanHtmlFromMessage
    // doesn't treat the angle brackets as a generic tag and erase the username.
    let s = raw.replace(/<@([^>\n\r]+)>/g, '@$1');
    s = this.cleanHtmlFromMessage(s);
    if (!s) return '';

    s = s.replace(/\{\{[^}]*\}\}/g, '');
    // El `)` de cierre es opcional (re-review de la corrección de
    // `SAVE_FACT`, misma idea que `createSaveFactRegex` en chat.service.ts):
    // sin esto, un `SAVE_(MEMORY|FACT)(...)` truncado a mitad — por el mismo
    // corte de `maxLengthResponse` que motiva esa corrección, o por una
    // captura fusionada que arrastra la llamada sin cerrar hasta el final
    // del objeto — sobrevivía tal cual porque `[^)]*\)` exige un ')' que no
    // existe. `[^)]*` ya no puede cruzar un ')', así que si no hay ninguno
    // en el resto del string, consume hasta el final y el `)` opcional
    // simplemente no matchea nada.
    // Re-revisión (2.2): las tres familias de verbos, no sólo
    // `SAVE_(MEMORY|FACT)`. La rama de contexto cruzado agregó
    // `SAVE_FACT_ABOUT` y `SAVE_ERRAND` y este patrón no se movió, así que
    // pasaban enteros. Medido:
    //   'que suba SAVE_FACT_ABOUT(lyna, likes, basura) y SAVE_ERRAND(kei, hola)'
    // se persistía TAL CUAL como texto de recado. No hay ingesta desde ahí
    // (la entrega no pasa por los extractores), pero el texto puede salir al
    // chat con la voz del bot.
    //
    // `FACT_ABOUT` va ANTES que `FACT` en la alternancia: la alternancia de
    // JavaScript es de primera coincidencia, así que con el orden inverso
    // `FACT` matchearía el prefijo y el `\s*\(` siguiente fallaría contra el
    // `_ABOUT` que queda, dejando la llamada intacta. Mismo orden y mismo
    // motivo que `ChatService.createLeftoverVerbRegex` — si alguien agrega un
    // cuarto verbo, hay que sumarlo en los dos lados.
    s = s.replace(/\b(SAVE|LOAD)_(FACT_ABOUT|MEMORY|FACT|ERRAND)\s*\([^)]*\)?/gi, '');
    s = s.replace(/\[(img|image|audio|video)(?:\s+[a-z]+="[^"]*")*\][^[\]]*\[\/\1\]/gi, '');
    s = s.replace(/^\s*\^#[0-9a-fA-F]{3,8}\s+/, '');
    s = s.replace(/[\x00-\x1f\x7f]+/g, ' ');
    s = s.trim().replace(/\s+/g, ' ');

    if (s.length > maxLen) {
      const cut = s.slice(0, maxLen);
      const lastSpace = cut.lastIndexOf(' ');
      s = (lastSpace > maxLen * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd() + '…';
    }

    return s.length >= minLen ? s : '';
  }

  /**
   * Divide un texto en múltiples partes respetando el límite de caracteres y sin cortar palabras
   */
  splitMessageIntoParts(text: string, maxLength: number): string[] {
    if (!text || text.length <= maxLength) {
      return [text];
    }

    const parts: string[] = [];
    
    // Primero intentar dividir por párrafos (doble salto de línea)
    const paragraphs = text.split(/\n\s*\n/).filter(p => p.trim().length > 0);
    
    let currentPart = '';
    
    for (const paragraph of paragraphs) {
      const trimmedParagraph = paragraph.trim();
      
      // Si el párrafo completo cabe en la parte actual
      if ((currentPart + (currentPart ? '\n\n' : '') + trimmedParagraph).length <= maxLength) {
        currentPart += (currentPart ? '\n\n' : '') + trimmedParagraph;
      } else {
        // Guardar la parte actual si tiene contenido
        if (currentPart.trim()) {
          parts.push(currentPart.trim());
          currentPart = '';
        }
        
        // Si el párrafo es muy largo, dividirlo por oraciones
        if (trimmedParagraph.length > maxLength) {
          const sentences = trimmedParagraph.split(/[.!?]\s+/).filter(s => s.trim().length > 0);
          
          for (let sentence of sentences) {
            // Agregar puntuación si no la tiene
            if (!sentence.trim().match(/[.!?]$/)) {
              sentence = sentence.trim() + '.';
            }
            
            // Si la oración cabe en la parte actual
            if ((currentPart + (currentPart ? ' ' : '') + sentence).length <= maxLength) {
              currentPart += (currentPart ? ' ' : '') + sentence;
            } else {
              // Guardar la parte actual si tiene contenido
              if (currentPart.trim()) {
                parts.push(currentPart.trim());
                currentPart = '';
              }
              
              // Si la oración sola es muy larga, dividirla por palabras
              if (sentence.length > maxLength) {
                const words = sentence.split(' ');
                let wordPart = '';
                
                for (const word of words) {
                  if ((wordPart + (wordPart ? ' ' : '') + word).length <= maxLength) {
                    wordPart += (wordPart ? ' ' : '') + word;
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
  }

  /**
   * Función sleep para usar con await
   */
  sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Calcula similitud entre strings usando distancia de Levenshtein
   */
  calculateSimilarity(str1: string, str2: string): number {
    const longer = str1.length > str2.length ? str1 : str2;
    const shorter = str1.length > str2.length ? str2 : str1;
    
    if (longer.length === 0) return 1.0;
    
    const distance = this.levenshteinDistance(longer, shorter);
    return (longer.length - distance) / longer.length;
  }

  /**
   * Función auxiliar para calcular distancia de Levenshtein
   */
  private levenshteinDistance(str1: string, str2: string): number {
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
  }
}