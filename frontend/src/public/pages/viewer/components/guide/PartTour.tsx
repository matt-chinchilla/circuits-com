// "Click a part once, find it everywhere": the one hidden feature worth
// teaching before anyone drops a file, shown on the example with real captures
// of this viewer (U30, the example's FPGA, selected once and followed across
// the views). Set on a soldermask-green panel with ENIG pads as the caption
// markers — the board's own vocabulary. The frames' shapes live in
// PartTour.module.scss; the three views fill theirs (`fill`), the part panel
// keeps its own aspect so none of its text is cropped.
import Icon from '@shared/components/Icon';
import { IMAGES, type GuideImage } from './guideCopy';
import styles from './PartTour.module.scss';

interface ShotProps {
  image: GuideImage;
  area: string;
  frame: string;
  fill: boolean;
  label: string;
  caption: string;
}

function Shot({ image, area, frame, fill, label, caption }: ShotProps) {
  return (
    <figure className={`${styles.shot} ${area}`}>
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
  onTryExample: () => void;
}

export default function PartTour({ id, hidden, busy, onTryExample }: Props) {
  return (
    <section id={id} hidden={hidden} className={styles.tour} aria-labelledby="viewer-tour-title">
      <h2 className={styles.tourTitle} id="viewer-tour-title">
        Click a part once, find it everywhere
      </h2>
      <p className={styles.tourLead}>
        Pick U30 on any view, or type its reference, and the schematic, the board and the 3D view all point at the same
        chip. The part panel says where it sits on the board and what our catalog knows about it.
      </p>
      <div className={styles.tourGrid}>
        <Shot
          image={IMAGES.tour3d}
          area={styles.shot3d}
          frame={styles.frame3d}
          fill
          label="3D"
          caption="Its body lights up with a label."
        />
        <Shot
          image={IMAGES.tourSchematic}
          area={styles.shotSch}
          frame={styles.frameFlat}
          fill
          label="Schematic"
          caption="The unit is shaded on its sheet."
        />
        <Shot
          image={IMAGES.tourBoard}
          area={styles.shotBrd}
          frame={styles.frameFlat}
          fill
          label="Board"
          caption="Show on Board centres the view on its footprint."
        />
        <Shot
          image={IMAGES.tourPanel}
          area={styles.shotPanel}
          frame={styles.framePanel}
          fill={false}
          label="Part panel"
          caption="From the file first, then from the catalog."
        />
      </div>
      <p className={styles.keys}>
        <kbd>/</kbd> searches for a reference, <kbd>Esc</kbd> clears it. Designators in the BOM select parts the same way.
      </p>
      <p className={styles.tourTry}>
        <button type="button" className={styles.tryLink} onClick={onTryExample} disabled={busy}>
          Try the example project
          <Icon name="arrow-right" className={styles.tryGlyph} />
        </button>
      </p>
    </section>
  );
}
