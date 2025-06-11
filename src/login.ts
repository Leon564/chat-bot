//import { HttpsProxyAgent } from "https-proxy-agent";
import fetch from "node-fetch";

export type LoginParams = {
  username: string;
  password: string;
  boxId: string;
  boxTag: string;
  iframeUrl: string;
};

export const login = async ({
  boxId,
  boxTag,
  iframeUrl,
  password,
  username,
}: LoginParams) => {
  const baseUrl = iframeUrl?.split("?")[0];
  //const agent = new HttpsProxyAgent(process.env.HTTPS_PROXY!);
  console.log("use agent", process.env.HTTPS_PROXY!);
  console.log(
    `${baseUrl}?sec=profile&boxid=${boxId || ""}&boxtag=${
      boxTag || ""
    }&_v=1063&json=1`
  );
  const response = await fetch(
    `${baseUrl}?sec=profile&boxid=${boxId || ""}&boxtag=${
      boxTag || ""
    }&_v=1063&json=1`,
    {
      headers: {
        accept: "*/*",
        "accept-language": "es-419,es;q=0.9",
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
      body: `n=${username}&k=&pword=${password}&pword2=&auth_prov=&auth_id=&do=login`,
      method: "POST",
      //agent,
    }
  );
  const result = (await response.text()).slice(1);
  const data = JSON.parse(result);
  if (data.state && data.state === "CANNOT_REGISTER") {
    return {
      state: "LOGGED_IN",
      auth_methods: [""],
      udata: {
        nme: username,
        uid: undefined,
        lvl: undefined,
        url: "",
        pic: undefined,
        key: undefined,
      },
      message: "Not password required, you are logged in as %s.",
      error: "",
    };
  }

  return data;
};
