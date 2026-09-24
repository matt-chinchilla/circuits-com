// "Click a part once, find it everywhere": the one hidden feature worth
// teaching before anyone drops a file, shown on the example with real captures
// of this viewer (U30, the example's FPGA, selected once and followed across
// the views). Set on a soldermask-green panel with ENIG pads as the caption
// markers — the board's own vocabulary. The frames' shapes live in
// PartTour.module.scss; the three views fill theirs (`fill`), the part panel
// keeps its own aspect so none of its text is cropped.
//
// The tour ends on a link that opens the example WITH U30 selected — the
// selection it just showed, live. It is not another "Try the example project":
// that pair is docked at the bottom of the screen whenever the tour is in view,
// and two identical buttons a hand apart would only ask which one to press.
//
// On a full-screen monitor the words stand in a column beside the pictures, with
// a legend drawn like KiCad's Layers panel: one row per view, a swatch in the
// colour that view draws with, the same swatch on its caption. Pointing at or
// focusing a row lights its picture; pressing it moves focus to that picture.
// The legend exists only in that layout (PartTour.module.scss).
import { useState } from 'react';
import Icon from '@shared/components/Icon';
import { IMAGES, TOUR_REF, type GuideImage } from './guideCopy';
import styles from './PartTour.module.scss';

/** The four views, in the legend's order (the grid's reading order). */
const VIEWS = [
  { key: 'three', label: '3D' },
  { key: 'sch', label: 'Schematic' },
  { key: 'brd', label: 'Board' },
  { key: 'panel', label: 'Part panel' },
] as const;

type View = (typeof VIEWS)[number]['key'];

const shotId = (id: string, view: View) => `${id}-${view}`;

interface ShotProps {
  id: string;
  view: View;
  lit: boolean;
  image: GuideImage;
  area: string;
  frame: string;
  fill: boolean;
  label: string;
  caption: string;
}

function Shot({ id, view, lit, image, area, frame, fill, label, caption }: ShotProps) {
  return (
    <figure
      id={shotId(id, view)}
      tabIndex={-1}
      className={`${styles.shot} ${area}`}
      data-view={view}
      data-lit={lit || undefined}
    >
      <div className={`${styles.frame} ${frame}`}>
        <img
          className={fill ? styles.view : undefined}
          src={image.src}
          width={image.width}
          height={image.height}
          alt={image.alt}
          loading="lazy"
          decoding="async"
        />
      </div>
      <figcaption className={styles.caption}>
        <span className={styles.enig} aria-hidden="true" />
        <span>
          <b>{label}.</b> {caption}
        </span>
      </figcaption>
    </figure>
  );
}

interface Props {
  id: string;
  hidden: boolean;
  busy: boolean;
  /** Open the example with this reference selected. */
  onSeeRef: (ref: string) => void;
}

export default function PartTour({ id, hidden, busy, onSeeRef }: Props) {
  // Pointer and focus are kept apart so leaving one never clears the other.
  const [hovered, setHovered] = useState<View | null>(null);
  const [focused, setFocused] = useState<View | null>(null);
  const lit = hovered ?? focused;
  const shot = (view: View) => ({ id, view, lit: lit === view });

  return (
    <section id={id} hidden={hidden} className={styles.tour} aria-labelledby="viewer-tour-title">
      <div className={styles.tourRow}>
        <div className={styles.tourHead}>
          <h2 className={styles.tourTitle} id="viewer-tour-title">
            Click a part once, find it everywhere
          </h2>
          <p className={styles.tourLead}>
            Pick {TOUR_REF} on any view, or type its reference, and the schematic, the board and the 3D view all point
            at the same chip. The part panel says where it sits on the board and, once the BOM is priced, what our
            catalog knows about it.
          </p>
          <div className={styles.legend}>
            <p className={styles.legendTitle} id={`${id}-views`}>
              Views
            </p>
            <ul className={styles.legendList} aria-labelledby={`${id}-views`}>
              {VIEWS.map(({ key, label }) => (
                <li key={key}>
                  <button
                    type="button"
                    className={styles.legendRow}
                    data-view={key}
                    data-lit={lit === key || undefined}
                    onMouseEnter={() => setHovered(key)}
                    onMouseLeave={() => setHovered(null)}
                    onFocus={() => setFocused(key)}
                    onBlur={() => setFocused(null)}
                    onClick={() => document.getElementById(shotId(id, key))?.focus()}
                  >
                    <span className={styles.swatch} aria-hidden="true" />
                    {label}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <div className={styles.tourGrid} data-lit={lit ?? undefined}>
          <Shot
            {...shot('three')}
            image={IMAGES.tour3d}
            area={styles.shot3d}
            frame={styles.frame3d}
            fill
            label="3D"
            caption="Its body lights up with a label."
          />
          <Shot
            {...shot('sch')}
            image={IMAGES.tourSchematic}
            area={styles.shotSch}
            frame={styles.frameFlat}
            fill
            label="Schematic"
            caption="The unit is shaded on its sheet."
          />
          <Shot
            {...shot('brd')}
            image={IMAGES.tourBoard}
            area={styles.shotBrd}
            frame={styles.frameFlat}
            fill
            label="Board"
            caption="Show on Board centres the view on its footprint."
          />
          <Shot
            {...shot('panel')}
            image={IMAGES.tourPanel}
            area={styles.shotPanel}
            frame={styles.framePanel}
            fill={false}
            label="Part panel"
            caption="From the file first; the catalog match once the BOM is priced."
          />
        </div>
        <div className={styles.tourFoot}>
          <p className={styles.keys}>
            <kbd>/</kbd> searches for a reference, <kbd>Esc</kbd> clears it. Designators in the BOM select parts the
            same way.
          </p>
          <p className={styles.tourTry}>
            <button type="button" className={styles.tryLink} onClick={() => onSeeRef(TOUR_REF)} disabled={busy}>
              See {TOUR_REF} on the example
              <Icon name="arrow-right" className={styles.tryGlyph} />
            </button>
          </p>
        </div>
      </div>
    </section>
  );
}
