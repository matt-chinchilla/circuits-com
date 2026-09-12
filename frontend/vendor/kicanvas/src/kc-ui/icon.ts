/*
    Copyright (c) 2023 Alethea Katherine Flowers.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import { css, html } from "../base/web-components";
import { KCUIElement } from "./element";

// Circuit Center patch (0002-icon-codepoints): the site serves a 16-glyph subset
// of Material Symbols Outlined with no ligature table, so the icon NAME in the
// element's text is mapped to its codepoint here. Names not in the map render
// as their text, which is visibly wrong rather than silently blank.
const CODEPOINTS: Record<string, string> = {
    category: "\ue72c",
    check: "\ue668",
    close: "\ue5cd",
    download: "\uf090",
    flip: "\ue3e8",
    folder: "\ue2c7",
    help: "\ue8fd",
    hub: "\ue9f4",
    info: "\ue88e",
    interests: "\ue7c8",
    layers: "\ue53b",
    list: "\ue896",
    memory: "\ue322",
    settings: "\ue8b8",
    visibility: "\ue8f4",
    "question-mark": "\ueb8b",
    question_mark: "\ueb8b",
};

export class KCUIIconElement extends KCUIElement {
    public static sprites_url: string = "";

    static override styles = [
        css`
            :host {
                box-sizing: border-box;
                font-family: "Material Symbols Outlined";
                font-weight: normal;
                font-style: normal;
                font-size: inherit;
                line-height: 1;
                letter-spacing: normal;
                text-transform: none;
                white-space: nowrap;
                word-wrap: normal;
                direction: ltr;
                -webkit-font-smoothing: antialiased;
                user-select: none;
            }

            svg {
                width: 1.2em;
                height: auto;
                fill: currentColor;
            }
        `,
    ];

    override render() {
        const text = (this.textContent ?? "").trim();
        if (text.startsWith("svg:")) {
            const name = text.slice(4);
            const url = `${KCUIIconElement.sprites_url}#${name}`;
            return html`<svg viewBox="0 0 48 48" width="48">
                <use xlink:href="${url}" />
            </svg>`;
        }
        const glyph = CODEPOINTS[text];
        return glyph === undefined ? html`<slot></slot>` : html`${glyph}`;
    }
}

window.customElements.define("kc-ui-icon", KCUIIconElement);
