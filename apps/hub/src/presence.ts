// Пользователь сейчас за каким-то клиентом (веб-вкладка активна) — тогда пуши на телефон не нужны.
// Клиент повторяет presence{active:true} как пульс; пропал пульс (вкладка заморожена, сеть) — присутствие истекает.
export const PRESENCE_TTL_MS = 75_000;

export class Presence {
  private seen = new Map<object, number>();

  constructor(private now: () => number = Date.now) {}

  /** conn — WS-соединение клиента */
  set(conn: object, active: boolean): void {
    if (active) this.seen.set(conn, this.now());
    else this.seen.delete(conn);
  }

  drop(conn: object): void {
    this.seen.delete(conn);
  }

  get active(): boolean {
    const t = this.now();
    for (const [conn, at] of this.seen) {
      if (t - at < PRESENCE_TTL_MS) return true;
      this.seen.delete(conn);
    }
    return false;
  }
}
