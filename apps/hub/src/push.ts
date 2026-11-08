// Пуши через FCM HTTP v1 без SDK: OAuth-токен из ключа сервисного аккаунта (JWT RS256 через node:crypto).
// Шлём data-сообщения: expo-notifications в приложении само показывает их (title/message/categoryId/body),
// в том числе с кнопками действий и когда приложение закрыто.
import { createSign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export interface PushMessage {
  title: string;
  message: string;
  /** категория с кнопками в приложении (permission) */
  categoryId?: string;
  /** данные для приложения: куда перейти, на что отвечать */
  data: Record<string, string>;
  /** одинаковый тег заменяет предыдущее уведомление в шторке */
  tag?: string;
}

export type SendResult = "ok" | "unregistered" | "error";

type Fetch = typeof fetch;

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export class PushSender {
  private access?: { token: string; until: number };

  constructor(
    private keyPath: string,
    private log: (m: string) => void = () => {},
    private http: Fetch = fetch,
  ) {}

  /** ключ сервисного аккаунта на месте */
  get enabled(): boolean {
    return existsSync(this.keyPath);
  }

  private account(): ServiceAccount {
    return JSON.parse(readFileSync(this.keyPath, "utf8")) as ServiceAccount;
  }

  /** OAuth-токен для FCM, кэшируется почти на час */
  private async token(sa: ServiceAccount): Promise<string> {
    if (this.access && Date.now() < this.access.until) return this.access.token;
    const tokenUri = sa.token_uri ?? "https://oauth2.googleapis.com/token";
    const now = Math.floor(Date.now() / 1000);
    const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = b64url(
      JSON.stringify({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/firebase.messaging", aud: tokenUri, iat: now, exp: now + 3600 }),
    );
    const sig = createSign("RSA-SHA256").update(`${head}.${claims}`).sign(sa.private_key).toString("base64url");
    const r = await this.http(tokenUri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${claims}.${sig}` }).toString(),
    });
    const j = (await r.json()) as { access_token?: string; expires_in?: number; error_description?: string };
    if (!r.ok || !j.access_token) throw new Error(`OAuth: ${j.error_description ?? r.status}`);
    this.access = { token: j.access_token, until: Date.now() + ((j.expires_in ?? 3600) - 300) * 1000 };
    return j.access_token;
  }

  async send(deviceToken: string, m: PushMessage): Promise<SendResult> {
    try {
      const sa = this.account();
      const access = await this.token(sa);
      const data: Record<string, string> = {
        title: m.title,
        message: m.message,
        body: JSON.stringify(m.data),
        // канал с высокой важностью (всплывающее уведомление), создаётся приложением
        channelId: "kamharn",
        ...(m.categoryId ? { categoryId: m.categoryId } : {}),
      };
      const r = await this.http(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${access}` },
        body: JSON.stringify({ message: { token: deviceToken, data, android: { priority: "high", ...(m.tag ? { collapse_key: m.tag } : {}) } } }),
      });
      if (r.ok) return "ok";
      const text = await r.text();
      // устройство удалило приложение или токен устарел
      if (r.status === 404 || /UNREGISTERED|registration-token-not-registered|not a valid FCM registration token/.test(text)) return "unregistered";
      this.log(`[push] FCM ${r.status}: ${text.slice(0, 300)}`);
      return "error";
    } catch (e) {
      this.log(`[push] ${(e as Error).message}`);
      return "error";
    }
  }
}
