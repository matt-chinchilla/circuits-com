// What happens to the files: the binding sentence as the heading, then exactly
// what the page sends and when. The field list is PRICING_FIELDS — keyed by the
// pricing request's own field names and pinned by a test to a real request
// body — so the "never" in it cannot rot. Shown in both guide states.
import Icon from '@shared/components/Icon';
import { listInProse } from '../../intakeCopy';
import { PRICING_FIELDS, PRIVACY_SENTENCE } from './guideCopy';
import styles from './Guide.module.scss';

export default function PrivacyBlock() {
  return (
    <section className={styles.privacy} aria-labelledby="viewer-privacy-title">
      <Icon name="lock-simple" className={styles.privacyGlyph} />
      <h2 className={styles.privacyTitle} id="viewer-privacy-title">
        {PRIVACY_SENTENCE}
      </h2>
      <p className={styles.privacyBody}>
        Every file is read on your computer. To price the BOM, the page sends our catalog each line&rsquo;s{' '}
        {listInProse(Object.values(PRICING_FIELDS))}, never its quantities, its designators or the files. A line our catalog
        cannot match may be looked up at our distributors by its part number, or by its value and footprint, and part photos
        load from the distributors&rsquo; own sites. Share publishes the
        BOM&rsquo;s parts, quantities and designators as a link, and only when you click it.
      </p>
    </section>
  );
}
