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