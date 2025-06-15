import { load } from "cheerio";
import "dotenv/config";
import WebSocket from "ws";
import he from "he";
//import { HttpsProxyAgent } from "https-proxy-agent";
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

  //const agent = new HttpsProxyAgent(process.env.HTTPS_PROXY!);

  fetch(
    `${baseUrl}?sec=submit&boxid=${boxId || ""}&boxtag=${boxTag || ""}&_v=1063`,
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
      body: `aj=1063&lp=2529196&pst=${message?.substring(
        0,
        Number (process.env.MAX_LENGTH_RESPONSE || 300)
      )}&key=${key}&fp=0&lid=55837&nme=${username}&pic=${pic}`,
      method: "POST",
     // agent,
    }
  );
  // .then((res) => res.text())
  // .then(console.log);
};

export const toDomain = (data: WebSocket.Data): ToDomainResponse => {
  const splitedData = data.toString().split("\t");
  if (splitedData.length <= 1) return {} as ToDomainResponse;

  const [n, id, date, name, lvl, x, message, y, z, id2, w, id3] = splitedData;
  return {
    id,
    date,
    name,
    lvl,
    message: cleanMessage(message),
  };
};

function cleanMessage(message: string): string {
  try {
    const text = he.decode(String(message || ""));

    return text.replace(/<[^>]*>/g, "");
  } catch (e) {
    console.log(e);
    return message;
  }
}
