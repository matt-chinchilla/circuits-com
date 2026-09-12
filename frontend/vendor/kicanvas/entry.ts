// frontend/vendor/kicanvas/entry.ts
// Circuit Center's entry: registers the embed and the two viewer apps it needs,
// and nothing else. Upstream's src/index.ts also loads the standalone shell and
// a livereload helper the site does not use. The sprite URL is what the shell
// normally sets; without it the embed's svg: icons (zoom buttons) render nothing.
import { KCUIIconElement } from "./src/kc-ui";
import { sprites_url } from "./src/kicanvas/icons/sprites";
// kicanvas-embed builds <kc-board-app> and <kc-schematic-app> from an html
// template, but imports their classes as `import type` — erased at compile
// time, so nothing would ever call customElements.define for them. Upstream
// picks them up transitively through kicanvas-shell, the standalone shell this
// entry deliberately skips, so we have to load them for their side effect
// ourselves. Without these two lines the embed mounts an empty box and the
// bundle sheds the WebGL renderer, both viewers, the stroke fonts and
// pan-and-zoom with them (~462 KB -> ~142 KB, which is the tell).
import "./src/kicanvas/elements/kc-board/app";
import "./src/kicanvas/elements/kc-schematic/app";
import "./src/kicanvas/elements/kicanvas-embed";

KCUIIconElement.sprites_url = sprites_url;
