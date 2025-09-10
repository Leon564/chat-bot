import { load } from "cheerio";
import "dotenv/config";
import WebSocket from "ws";
import he from "he";
import fetch from "node-fetch";

export type SendMessageOptions = {
  message: string;
  username: string;
  key: string;
  pic: string;
  boxId: string;
  boxTag: string;
  iframeUrl: string;
};

export type ToDomainResponse = {
  id: string;
  date: string;
  name: string;
  lvl: string;
  message: string;
};

export const sendMessage = async ({
  key,
  message,
  pic,
  username,
  boxId,
  boxTag,
  iframeUrl,
}: SendMessageOptions) => {
  const baseUrl = iframeUrl?.split("?")[0];

  // Codificar parámetros para evitar problemas con caracteres especiales como &
  const encodedMessage = encodeURIComponent(message);
  const encodedKey = encodeURIComponent(key);
  const encodedPic = encodeURIComponent(pic || "");
  const encodedUsername = encodeURIComponent(username);
  const encodedBoxId = encodeURIComponent(boxId || "");
  const encodedBoxTag = encodeURIComponent(boxTag || "");

  fetch(
    `${baseUrl}?sec=submit&boxid=${encodedBoxId}&boxtag=${encodedBoxTag}&_v=1063`,
    {
      headers: {
        accept: "*/*",
        "accept-language":
          "es-419,es;q=0.9,es-ES;q=0.8,en;q=0.7,en-GB;q=0.6,en-US;q=0.5",
        "content-type": "application/x-www-form-urlencoded",
        "sec-ch-ua":
          '"Not_A Brand";v="8", "Chromium";v="120", "Microsoft Edge";v="120"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
        Referer: "https://www4.cbox.ws/",
        "Referrer-Policy": "origin",
      },
      body: `aj=1063&lp=2529196&pst=${encodedMessage}&key=${encodedKey}&fp=0&lid=55837&nme=${encodedUsername}&pic=${encodedPic}`,
      method: "POST",
    }
  );
};

export const toDomain = (data: WebSocket.Data): ToDomainResponse => {
  const splitedData = data.toString().split("\t");
  if (splitedData.length <= 1) {
    return {
      id: '',
      date: '',
      name: '',
      lvl: '',
      message: ''
    };
  }

  const [n, id, date, name, lvl, x, message, y, z, id2, w, id3] = splitedData;
  return {
    id: id || '',
    date: date || '',
    name: name || '',
    lvl: lvl || '',
    message: cleanMessage(message) || '',
  };
};

function cleanMessage(message: string): string {
  try {
    // Manejar casos donde message es undefined, null o no es string
    if (!message || typeof message !== 'string') {
      return '';
    }
    
    // Primero remover tags HTML
    let text = message.replace(/<[^>]*>/g, "");
    
    // Luego decodificar entidades HTML (&amp; -> &, &lt; -> <, etc.)
    text = he.decode(text);
    
    return text;
  } catch (e) {
    console.log('Error cleaning message:', e);
    return message || '';
  }
}
