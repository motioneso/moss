/* global document */
import { moduleClient } from "./guest-bridge.mjs";
import { sportsApi } from "./api.mjs";
import { userLocale } from "./locale.mjs";
import { mountSportsPage } from "./page.mjs";

const client = moduleClient();
mountSportsPage({
  root: document.getElementById("root"),
  api: sportsApi(client),
  ctx: { locale: userLocale(), navigate: (path) => client.navigate(path) }
});
