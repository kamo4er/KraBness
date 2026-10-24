// фоновая задача уведомлений объявляется до всего остального: бандл может стартовать без UI (кнопка в уведомлении)
import "./src/push.ts";
import { registerRootComponent } from "expo";

import App from "./App";

registerRootComponent(App);
