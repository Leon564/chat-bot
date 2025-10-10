import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LoginParams, LoginResponse, BoxDetails } from '../../common/interfaces';
import { load } from 'cheerio';

@Injectable()
export class AuthService {
  constructor(private readonly configService: ConfigService) {}

  async getBoxDetails(cboxUrl: string): Promise<BoxDetails> {
    let boxId: string | undefined = cboxUrl?.split('boxid=')[1]?.split('&')[0];
    let boxTag: string | undefined = cboxUrl?.split('boxtag=')[1];
    let socketUrl: string | undefined;
    let iframeUrl: string | undefined = cboxUrl;

    if (!cboxUrl.includes('boxid=')) {
      const response = await fetch(cboxUrl, {
        headers: {
          accept: '*/*',
          'accept-language': 'es-419,es;q=0.9',
          'content-type': 'application/x-www-form-urlencoded',
          'sec-ch-ua':
            '"Not_A Brand";v="8", "Chromium";v="120", "Microsoft Edge";v="120"',
        },
        method: 'GET',
      });

      const data = await response.text();
      const $ = load(data);
      const iframe = $('iframe').attr('src')?.slice(2);
      iframeUrl = `https://${iframe}`;
      boxId = iframeUrl?.split('boxid=')[1].split('&')[0];
      boxTag = iframeUrl?.split('boxtag=')[1];
    }

    const response = await fetch(iframeUrl!, {
      headers: {
        accept: '*/*',
        'accept-language': 'es-419,es;q=0.9',
        'content-type': 'application/x-www-form-urlencoded',
        'sec-ch-ua':
          '"Not_A Brand";v="8", "Chromium";v="120", "Microsoft Edge";v="120"',
      },
      method: 'GET',
    });
    
    const data2 = await response.text();
    const $ = load(data2);
    const scriptContent = $('script').last().html();

    if (scriptContent) {
      // Buscar el valor de wsuri_https dentro de la función
      const wsuriHttpsMatch = scriptContent.match(/wsuri_https:"(.*?)"/);
      const wsuriHttpsValue = wsuriHttpsMatch ? wsuriHttpsMatch[1] : null;

      // Buscar el valor de flrqs dentro de la función
      const flrqsMatch = scriptContent.match(/flrqs:"(.*?)"/);
      const flrqsValue = flrqsMatch ? flrqsMatch[1] : null;

      // Construir socketUrl
      socketUrl = `${wsuriHttpsValue}${flrqsValue}`;
    }
    
    return { boxId, boxTag, socketUrl, iframeUrl };
  }

  async login({
    boxId,
    boxTag,
    iframeUrl,
    password,
    username,
  }: LoginParams): Promise<LoginResponse> {
    const baseUrl = iframeUrl?.split('?')[0];
    console.log(
      `${baseUrl}?sec=profile&boxid=${boxId || ''}&boxtag=${
        boxTag || ''
      }&_v=1063&json=1`
    );
    
    const response = await fetch(
      `${baseUrl}?sec=profile&boxid=${boxId || ''}&boxtag=${
        boxTag || ''
      }&_v=1063&json=1`,
      {
        headers: {
          accept: '*/*',
          'accept-language': 'es-419,es;q=0.9',
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
        body: `n=${username}&k=&pword=${password}&pword2=&auth_prov=&auth_id=&do=login`,
        method: 'POST',
      }
    );
    
    const result = (await response.text()).slice(1);
    const data = JSON.parse(result);
    
    if (data.state && data.state === 'CANNOT_REGISTER') {
      return {
        state: 'LOGGED_IN',
        auth_methods: [''],
        udata: {
          nme: username,
          uid: undefined,
          lvl: undefined,
          url: '',
          pic: undefined,
          key: undefined,
        },
        message: 'Not password required, you are logged in as %s.',
        error: '',
      };
    }

    return data;
  }
}