// frontend/vendor/kicanvas/entry.ts
// Circuit Center's entry: registers <kicanvas-embed> and <kicanvas-source> only.
// Upstream's src/index.ts also loads the standalone shell and a livereload
// helper the site does not use. The sprite URL is what the shell normally sets;
// without it the embed's svg: icons (zoom buttons) render nothing.
import { KCUIIconElement } from "./src/kc-ui";
import { sprites_url } from "./src/kicanvas/icons/sprites";
import "./src/kicanvas/elements/kicanvas-embed";

KCUIIconElement.sprites_url = sprites_url;
