// The right of the project sheet: what each file becomes in the viewer, each
// with a real capture of this viewer on the example project. The "from …"
// line carries the file→view mapping as TEXT, so it survives where the traces
// are not drawn (below 1100px) and never rests on line or colour alone.
import { OUTPUTS, type Net } from './guideCopy';
import NoteRef from './NoteRef';
import styles from './Guide.module.scss';

export default function OutputList({ id, hidden, hot }: { id: string; hidden: boolean; hot: Net | null }) {
  return (
    <div id={id} hidden={hidden} className={styles.outputs} data-trace-right="">
      <h2 className={styles.outputsTitle}>
        What each file becomes <NoteRef n={5} />
      </h2>
      <ul className={styles.outs}>
        {OUTPUTS.map((o) => (
          <li
            key={o.key}
            className={o.image == null ? `${styles.outCard} ${styles.outSlim}` : styles.outCard}
            data-key={o.key}
            data-net={o.net}
            data-net-dst=""
            data-hot={hot === o.net ? 'true' : undefined}
          >
            {o.image != null && (
              <img
                className={styles.outImg}
                src={o.image.src}
                width={o.image.width}
                height={o.image.height}
                alt={o.image.alt}
                loading="lazy"
                decoding="async"
              />
            )}
            <div>
              <h3 className={styles.outTitle}>{o.title}</h3>
              {o.body != null && <p className={styles.outBody}>{o.body}</p>}
              <span className={styles.from}>{o.from}</span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
