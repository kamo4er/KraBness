// Уровень рассуждений модели («сколько думает»): названия — как у движка (low, high, max…), "" — по умолчанию модели.
import { t } from "@kamharn/client";

export function EffortSelect({ efforts, value, onChange, inline }: { efforts: string[]; value: string; onChange: (v: string) => void; inline?: boolean }) {
  if (!efforts.length) return null;
  // сохранённый уровень мог не подойти новой модели — показываем «по умолчанию»
  const v = efforts.includes(value) ? value : "";
  return (
    <select
      className={`select ${inline ? "select--inline" : ""}`}
      style={inline ? undefined : { width: "auto" }}
      title={t("Сколько модель думает перед ответом. Больше — умнее, но дольше и дороже. Применяется со следующего сообщения.", "How hard the model thinks before answering. More is smarter but slower and pricier. Applies from the next message.")}
      value={v}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{t("думает: по умолчанию", "effort: default")}</option>
      {efforts.map((x) => (
        <option key={x} value={x}>
          {t("думает", "effort")}: {x}
        </option>
      ))}
    </select>
  );
}
