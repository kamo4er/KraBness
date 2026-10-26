// Уровень рассуждений модели («сколько думает»): названия — как у движка (low, high, max…), "" — по умолчанию модели.
import type { StyleProp, ViewStyle } from "react-native";
import { t } from "@kamharn/client";
import { Picker } from "./ui.tsx";

export function EffortPicker({ efforts, value, onChange, style }: { efforts: string[]; value: string; onChange: (v: string) => void; style?: StyleProp<ViewStyle> }) {
  if (!efforts.length) return null;
  // сохранённый уровень мог не подойти новой модели — показываем «по умолчанию»
  const v = efforts.includes(value) ? value : "";
  return (
    <Picker
      title={t("Сколько модель думает перед ответом", "How hard the model thinks before answering")}
      value={v}
      options={[
        { value: "", label: t("думает: авто", "effort: auto"), hint: t("по умолчанию: как решит модель", "default: as the model decides") },
        ...efforts.map((x) => ({ value: x, label: `${t("думает", "effort")}: ${x}` })),
      ]}
      onChange={onChange}
      style={style}
    />
  );
}

/** Ключ «последний уровень для модели»: SecureStore пускает в ключи только буквы, цифры и «._-». */
export const effortKey = (model: string): string => `effort.${model.replace(/[^A-Za-z0-9._-]/g, "_")}`;
