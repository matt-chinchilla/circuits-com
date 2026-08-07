<?php

/**
 * Self-service email signatures — Roundcube 1.6 plugin.
 *
 * Adds a "Signature details" section to Settings > Identities so each person
 * fills in their own title, phone, website, links and headshot, and the
 * Circuit Center signature card is rebuilt from those fields every time they
 * save. Nobody edits signature-roster.php on the mail box to change a phone
 * number any more.
 *
 * WHAT THIS FILE IS NOT
 * -------------------
 * It does not compose the signature and it does not render it. sig_build()
 * renders; ccsig_person() composes. This file only moves values between a form,
 * the preferences table and those two functions. That is deliberate — the
 * seeder writes the same column from the same two functions, so the two writers
 * cannot drift apart into subtly different signatures that only show up in sent
 * mail.
 *
 * THE ROSTER IS STILL HERE, AND STAYS
 * -----------------------------------
 * signature-roster.php remains the DEFAULTS. ccsig_fields_for() returns stored
 * preferences when a person has any and the roster row when they do not, so
 * this plugin needed no migration to install: on the day it ships every
 * signature still renders exactly what it rendered the day before, and a
 * person's own values take over the first time they press Save.
 *
 * A mailbox that is not on the roster at all — a new hire, or a second identity
 * someone added for an alias — takes its name from the identity row itself, so
 * it gets a correct signature without anyone touching a file. no-reply@ is NOT
 * that case: it IS on the roster, carrying an empty name on purpose, and that
 * empty name is what makes it render the company band alone.
 *
 * NEVER A WHITE SCREEN
 * --------------------
 * signature-template.php lives in a different bind mount from this plugin, so
 * "the plugin is installed but its library is not" is a reachable state — and a
 * fatal inside a plugin's init() takes the whole webmail down, not just the
 * settings page. So the requires are guarded, a failed load disables every hook
 * instead of half of them, and the identity form explains what is missing
 * rather than rendering a broken half-form.
 *
 * @author  Circuit Center
 * @license GPL-3.0-or-later (same terms as Roundcube, exceptions for plugins)
 */
class ccsignature extends rcube_plugin
{
    /** Only ever needed where identities are edited. */
    public $task = 'settings';

    /** @var rcmail */
    private $rc;

    /** @var bool Did the shared library load? Every hook is a no-op when false. */
    private $ready = false;

    /** @var string[] Files that were expected and are not there. */
    private $missing = [];

    /** @var array|null The roster, loaded once. */
    private $roster;

    /**
     * Hidden-field value meaning "the photo on screen is the roster's, leave it".
     *
     * Without a sentinel, "I did not touch the photo" and "I pressed Remove"
     * both arrive as an empty _ccsig_headshot, because the roster's photo is a
     * URL rather than one of our filenames. Treating them the same lost the
     * photo: the first person to save ANY unrelated change to their identity
     * would silently drop their own face out of every email they sent, and the
     * only place it shows is in the recipient's inbox.
     *
     * Cannot collide with a real value — ccsig_is_avatar_name() only accepts
     * `slug-8hex.jpg`, so this is rejected there and sanitises to ''.
     */
    const KEEP_PHOTO = '@keep';

    /**
     * Plugin bootstrap. Must not throw, and must not fatal.
     */
    public function init()
    {
        $this->rc = rcmail::get_instance();

        $this->load_config();
        $this->add_texts('localization/', true);

        $this->ready = $this->load_library();

        // Registered even when the library is missing: each one checks $ready
        // and returns its arguments untouched. Registering conditionally would
        // mean a half-installed plugin silently stopped saving preferences while
        // still showing the form.
        $this->add_hook('identity_form', [$this, 'hook_identity_form']);
        $this->add_hook('identity_update', [$this, 'hook_identity_update']);
        $this->add_hook('identity_create', [$this, 'hook_identity_create']);
        $this->add_hook('identity_create_after', [$this, 'hook_identity_create_after']);
        $this->add_hook('identity_delete', [$this, 'hook_identity_delete']);

        $this->register_action('plugin.ccsignature-upload', [$this, 'action_upload']);
    }

    /**
     * Pull in signature-template.php and this plugin's two halves.
     *
     * All-or-nothing on purpose. ccsignature_fields.php calls sig_safe_url(),
     * which lives in the template, so loading the fields without the template
     * would move the failure from here — where it is reported — to the middle of
     * a save, where it is a fatal.
     *
     * @return bool true when everything is present and loaded
     */
    private function load_library()
    {
        $lib    = rtrim((string) $this->setting('lib_dir', 'CCSIGNATURE_LIB_DIR', '/var/lib/ccsignature/lib'), '/');
        $roster = $lib . '/signature-roster.php';

        $code = [
            $lib . '/signature-template.php',
            __DIR__ . '/ccsignature_fields.php',
            __DIR__ . '/ccsignature_image.php',
        ];

        // The roster is REQUIRED, not optional. It carries the company band —
        // the part that says which company this is — and the icon_slugs list
        // that decides which links get a mark. Without it the plugin would still
        // run and would render an unbranded, icon-less signature into people's
        // outgoing mail, which is worse than not running.
        //
        // signature-icon-slugs.php is checked although nothing here requires it
        // directly: the roster does, with a bare `require`, so its absence is a
        // fatal inside init() rather than a missing feature.
        $required = array_merge($code, [$roster, $lib . '/signature-icon-slugs.php']);

        foreach ($required as $file) {
            if (!is_file($file) || !is_readable($file)) {
                $this->missing[] = $file;
            }
        }

        if (!empty($this->missing)) {
            rcube::raise_error([
                    'code' => 620, 'type' => 'php', 'file' => __FILE__, 'line' => __LINE__,
                    'message' => 'ccsignature: disabled, missing ' . implode(', ', $this->missing),
                ], true, false
            );

            return false;
        }

        foreach ($code as $file) {
            require_once $file;
        }

        // Not require_once: this one returns a value rather than declaring.
        $this->roster = (array) (require $roster);

        return true;
    }

    // ---------------------------------------------------------------------
    // The form
    // ---------------------------------------------------------------------

    /**
     * Add the "Signature details" fieldset to the identity form.
     *
     * Roundcube renders every fieldset in $args['form'], so a plugin only has to
     * put one there. Each field is [label, value]; supplying `value` as a string
     * hands us the whole cell, which is the only way to render the link rows and
     * the upload widget — the identity form is urlencoded and its field builder
     * rewrites `type => file` into a text input.
     *
     * @param array $args identity_form hook arguments
     *
     * @return array
     */
    public function hook_identity_form($args)
    {
        if (empty($args['form']) || !is_array($args['form'])) {
            return $args;
        }

        if (!$this->ready) {
            $args['form']['ccsignature'] = [
                'name'    => $this->gettext('sectiontitle'),
                'content' => ['ccsig_problem' => [
                    'label' => $this->gettext('unavailable'),
                    'value' => $this->notice_html(),
                ]],
            ];

            return $args;
        }

        $record  = (array) ($args['record'] ?? []);
        $id      = isset($record['identity_id']) ? (string) $record['identity_id'] : '';
        $mailbox = strtolower(trim((string) ($record['email'] ?? '')));
        $fields  = ccsig_fields_for($id, $this->prefs(), $mailbox, $this->roster);
        $enabled = ($fields['enabled'] ?? '1') !== '0';

        $content = [
            'ccsig_enabled' => [
                'label' => $this->gettext('usesignature'),
                'value' => html::tag('input', [
                    'type'    => 'checkbox',
                    'name'    => '_ccsig_enabled',
                    'id'      => 'rcmfd_ccsig_enabled',
                    'value'   => '1',
                    'checked' => $enabled,
                ])
                . html::span('ccsig-hint', rcube::Q($this->gettext('usesignaturehint')))
                // The marker that tells the save hooks our fieldset was on the
                // page. Without it an unchecked checkbox and an absent form look
                // identical, and any other write to the identities table would
                // read as "the person just turned their signature off".
                . html::tag('input', ['type' => 'hidden', 'name' => '_ccsig_submitted', 'value' => '1']),
            ],
            'ccsig_title'   => ['label' => $this->gettext('jobtitle'), 'value' => $this->text_field('title', $fields)],
            'ccsig_phone'   => ['label' => $this->gettext('phone'), 'value' => $this->text_field('phone', $fields)],
            'ccsig_website' => ['label' => $this->gettext('website'), 'value' => $this->text_field('website', $fields)],
            'ccsig_links'   => ['label' => $this->gettext('links'), 'value' => $this->socials_field($fields)],
            'ccsig_photo'   => ['label' => $this->gettext('headshot'), 'value' => $this->headshot_field($fields, $id)],
        ];

        $args['form']['ccsignature'] = [
            'name'    => $this->gettext('sectiontitle'),
            'content' => $content,
        ];

        // Only an HTML page has somewhere to put a script tag. Same guard
        // cccalendar uses on its taskbar button, and for the same reason: a hook
        // can fire on an output object that is not a page, and asking that
        // object for page furniture is how a plugin turns a working request
        // into a 500.
        if (!is_object($this->rc->output) || $this->rc->output->type != 'html') {
            return $args;
        }

        $this->rc->output->set_env('ccsignature', [
            'id'       => $id,
            'maxbytes' => CCSIG_MAX_BYTES,
        ]);

        $this->include_script('ccsignature.js');
        // Pinned rather than derived from local_skin_path(), for the reason
        // cccalendar.css documents: the sheet carries its own fallbacks and is
        // correct under stock Elastic too, whereas local_skin_path() would
        // resolve somewhere this file is not.
        $this->include_stylesheet('skins/circuitcenter/ccsignature.css');

        return $args;
    }

    /**
     * One plain text input, pre-filled from stored preferences or the roster.
     *
     * @param string $key    Field name, without the _ccsig_ prefix
     * @param array  $fields Current values
     *
     * @return string
     */
    private function text_field($key, array $fields)
    {
        return html::tag('input', [
            'type'         => 'text',
            'name'         => '_ccsig_' . $key,
            'id'           => 'rcmfd_ccsig_' . $key,
            'value'        => (string) ($fields[$key] ?? ''),
            'size'         => 40,
            'maxlength'    => CCSIG_MAX[$key] ?? 200,
            'class'        => 'ccsig-input',
            'autocomplete' => 'off',
            'placeholder'  => $this->gettext('placeholder' . $key),
        ]);
    }

    /**
     * CCSIG_MAX_SOCIALS fixed rows of [platform, URL].
     *
     * Fixed rather than add/remove: five static rows need no JavaScript at all,
     * and an empty row costs a person one glance to ignore. The platform is a
     * picker rather than free text because the LABEL is what selects the icon —
     * a typed "Slack" has no mark on disk and would render as a bare text link,
     * which reads as a broken icon rather than as a choice.
     *
     * @param array $fields Current values
     *
     * @return string
     */
    private function socials_field(array $fields)
    {
        $current = [];
        foreach ((array) ($fields['socials'] ?? []) as $label => $url) {
            $current[] = ['slug' => sig_social_slug((string) $label), 'url' => (string) $url];
        }

        $rows = '';
        for ($i = 0; $i < CCSIG_MAX_SOCIALS; $i++) {
            $slug = (string) ($current[$i]['slug'] ?? '');
            $url  = (string) ($current[$i]['url'] ?? '');

            $options = html::tag('option', ['value' => ''], rcube::Q($this->gettext('nolink')));

            // A stored label with no mark on disk (anything predating the
            // picker) keeps its own option, so opening the form and saving it
            // again cannot silently delete a link the person never touched.
            // posted_socials() then restores the ORIGINAL label rather than
            // rebuilding it from this slug, which is what stops a roster entry
            // of 'Google Scholar' coming back as "Googlescholar".
            //
            // THE ONE CASE THIS CANNOT COVER is a label that slugifies to
            // nothing at all — '微博', or a label of pure punctuation. A picker
            // keyed by slug has no way to represent it, so it shows as None and
            // the next Save drops it. Nothing in the roster is like that today,
            // and the picker is how links are meant to be set; saying so beats
            // a comment that claims a guarantee this loop does not give.
            $choices = $this->slugs();
            if ($slug !== '' && !in_array($slug, $choices, true)) {
                $choices[] = $slug;
                sort($choices);
            }

            foreach ($choices as $choice) {
                $options .= html::tag('option',
                    ['value' => $choice] + ($choice === $slug ? ['selected' => 'selected'] : []),
                    rcube::Q(ccsig_social_label($choice))
                );
            }

            $rows .= html::div('ccsig-social',
                // Roundcube emits <label for="rcmfd_ccsig_links"> for this row,
                // so something must carry that id or the label points at
                // nothing and clicking it does nothing. It belongs on the first
                // real control, not on the wrapping div — `for` has to name a
                // form element to mean anything to a screen reader.
                html::tag('select', [
                    'name'  => '_ccsig_social_slug[]',
                    'class' => 'ccsig-platform',
                ] + ($i === 0 ? ['id' => 'rcmfd_ccsig_links'] : []), $options)
                . html::tag('input', [
                    'type'         => 'text',
                    'name'         => '_ccsig_social_url[]',
                    'class'        => 'ccsig-input ccsig-url',
                    'value'        => $url,
                    'maxlength'    => CCSIG_MAX['url'],
                    'autocomplete' => 'off',
                    'placeholder'  => 'https://',
                ])
            );
        }

        return html::div('ccsig-socials', $rows);
    }

    /**
     * The headshot widget: current photo, a file picker, and a remove button.
     *
     * On the ADD-identity form there is no identity id yet, so there is nothing
     * to name the file after and nothing to attach it to. Rather than invent an
     * id and leave a stray file behind if the person cancels, the widget says to
     * save first. One sentence beats a whole class of orphaned uploads.
     *
     * @param array  $fields Current values
     * @param string $id     Identity id, '' on the add form
     *
     * @return string
     */
    private function headshot_field(array $fields, $id)
    {
        if ($id === '') {
            return html::div('ccsig-hint', rcube::Q($this->gettext('headshotlater')));
        }

        $url = ccsig_headshot_url($fields, $this->avatar_base());

        $preview = html::div(['class' => 'ccsig-avatar', 'id' => 'ccsig-avatar'],
            $url !== ''
                ? html::img(['src' => $url, 'alt' => '', 'width' => 72, 'height' => 72])
                : html::span('ccsig-avatar-empty', rcube::Q($this->gettext('nophoto')))
        );

        // The value is a FILENAME, never a URL: the base is configuration, so
        // rehosting is a config change rather than a rewrite of every stored
        // row, and a stored absolute URL is the shape that lets an arbitrary
        // value reach an <img src>. The one exception is the sentinel, which
        // stands in for "the roster's hosted photo, unchanged" — see KEEP_PHOTO.
        $name    = (string) ($fields['headshot'] ?? '');
        $current = ccsig_is_avatar_name($name)
            ? $name
            : ((string) ($fields['headshot_url'] ?? '') !== '' ? self::KEEP_PHOTO : '');

        $hidden = html::tag('input', [
            'type'  => 'hidden',
            'name'  => '_ccsig_headshot',
            'id'    => 'ccsig-headshot',
            'value' => $current,
        ]);

        $picker = html::tag('input', [
            'type'  => 'file',
            'id'    => 'ccsig-file',
            'accept' => 'image/jpeg,image/png,image/webp',
            'class' => 'ccsig-file',
        ]);

        $buttons = html::div('ccsig-avatar-actions',
            // Carries the id Roundcube's <label for> names for this row — see
            // the socials block. ccsignature.js looks it up by the same id.
            html::tag('button', ['type' => 'button', 'id' => 'rcmfd_ccsig_photo', 'class' => 'btn btn-secondary'],
                rcube::Q($this->gettext('choosephoto')))
            . html::tag('button', ['type' => 'button', 'id' => 'ccsig-clear', 'class' => 'btn btn-secondary'],
                rcube::Q($this->gettext('removephoto')))
            . html::div(['class' => 'ccsig-hint', 'id' => 'ccsig-status', 'role' => 'status'],
                rcube::Q($this->gettext('headshothint')))
        );

        return html::div('ccsig-headshot', $preview . $hidden . $picker . $buttons);
    }

    /**
     * Why the plugin is disabled, in a form an operator can act on.
     *
     * @return string
     */
    private function notice_html()
    {
        $out = html::div('ccsig-notice', rcube::Q($this->gettext('unavailablebody')));

        foreach ($this->missing as $path) {
            $out .= html::div('ccsig-notice-path', rcube::Q($path));
        }

        return $out;
    }

    // ---------------------------------------------------------------------
    // Saving
    // ---------------------------------------------------------------------

    /**
     * An existing identity was saved.
     *
     * @param array $args identity_update hook arguments
     *
     * @return array
     */
    public function hook_identity_update($args)
    {
        if (!$this->ready || empty($args['id'])) {
            return $args;
        }

        // identity_update fires BEFORE Roundcube checks the identity belongs to
        // the session user, so an id from the request cannot be trusted here on
        // the strength of having arrived. Re-read it through get_identity(),
        // which is scoped to the current user.
        $identity = $this->rc->user->get_identity($args['id']);

        if (empty($identity)) {
            return $args;
        }

        $args['record'] = $this->apply((string) $args['id'], (array) $identity, (array) ($args['record'] ?? []));

        return $args;
    }

    /**
     * A new identity, before the insert: sign it, but store nothing yet.
     *
     * @param array $args identity_create hook arguments
     *
     * @return array
     */
    public function hook_identity_create($args)
    {
        if (!$this->ready || !$this->submitted()) {
            return $args;
        }

        $record = (array) ($args['record'] ?? []);
        $fields = $this->posted($this->defaults_for($record));

        if (($fields['enabled'] ?? '1') !== '0') {
            $record['signature']      = $this->render($fields, $record);
            $record['html_signature'] = 1;
        }

        $args['record'] = $record;

        return $args;
    }

    /**
     * The new identity now has an id, so its fields have somewhere to live.
     *
     * @param array $args identity_create_after hook arguments
     *
     * @return array
     */
    public function hook_identity_create_after($args)
    {
        if ($this->ready && !empty($args['id']) && $this->submitted()) {
            $this->store((string) $args['id'], $this->posted($this->defaults_for((array) ($args['record'] ?? []))));
        }

        return $args;
    }

    /**
     * The roster's values for a brand-new identity, which has no stored fields
     * of its own yet. Keyed by address, so an identity created for someone
     * already on the roster starts out looking like them.
     *
     * @param array $record Identity columns, for the address
     *
     * @return array
     */
    private function defaults_for(array $record)
    {
        $mailbox = strtolower(trim((string) ($record['email'] ?? '')));

        return ccsig_fields_for('', [], $mailbox, $this->roster);
    }

    /**
     * Drop the stored fields and the headshot when an identity goes away.
     *
     * @param array $args identity_delete hook arguments
     *
     * @return array
     */
    public function hook_identity_delete($args)
    {
        if (!$this->ready || empty($args['id'])) {
            return $args;
        }

        // CORE HAS NOT DECIDED YET. identity_delete fires BEFORE
        // rcube_user::delete_identity(), which refuses and returns false when
        // this is the account's last identity. Cleaning up here unconditionally
        // meant a REFUSED delete still destroyed the data: the person clicks
        // Delete on their only identity, core says no and leaves it in place,
        // and their title, phone, links and photo are gone anyway — with the
        // identity still sitting there looking untouched.
        //
        // So mirror core's own condition and only clean up when EVERY id being
        // deleted will actually go through. Miscounting high just leaves an
        // orphan entry, which is harmless; miscounting low destroys data, which
        // is not — so the comparison below is deliberately the conservative one.
        //
        // _iid is validated upstream as /^[0-9]+(,[0-9]+)*$/ — a COMMA LIST, not
        // a single id. Reading it as one value cast "3,5" to 3, so identity 5
        // kept its stored fields forever and its headshot was never unlinked.
        // It also means a multi-delete can PARTIALLY succeed: core deletes until
        // one identity is left and refuses the rest. Rather than guess which
        // half survived, skip entirely unless at least one identity remains
        // afterwards, which is exactly when core refuses nothing.
        $identities = $this->rc->user->list_identities();
        $ids        = array_filter(
            array_map('trim', explode(',', (string) $args['id'])),
            static fn($id) => $id !== '' && ctype_digit($id)
        );

        if (!is_array($identities) || $ids === [] || count($identities) - count($ids) < 1) {
            return $args;
        }

        $prefs = $this->prefs();

        foreach ($ids as $id) {
            $entry = ccsig_prefs_entry($prefs, $id);
            $this->unlink_avatar((string) ($entry['headshot'] ?? ''));
            unset($prefs[(string) $id], $prefs[(int) $id]);
        }

        $this->rc->user->save_prefs(['ccsignature' => $prefs]);

        return $args;
    }

    /**
     * Store the submitted fields and rebuild the signature column.
     *
     * @param string $id       Identity id
     * @param array  $identity The identity as the database has it
     * @param array  $record   The row Roundcube is about to write
     *
     * @return array $record, with the signature columns set when enabled
     */
    private function apply($id, array $identity, array $record)
    {
        if (!$this->submitted()) {
            return $record;
        }

        $prefs    = $this->prefs();
        $previous = ccsig_prefs_entry($prefs, $id);
        $mailbox  = strtolower(trim((string) ($identity['email'] ?? '')));

        // What the form was showing when they pressed Save, recomputed here
        // rather than trusted from the request.
        $fields = $this->posted(ccsig_fields_for($id, $prefs, $mailbox, $this->roster));

        $this->store($id, $fields);

        // Only now, once the replacement is committed to preferences. Deleting
        // at upload time would destroy the current photo for someone who picked
        // a new one and then pressed Cancel.
        $old = (string) ($previous['headshot'] ?? '');
        if ($old !== '' && $old !== (string) ($fields['headshot'] ?? '')) {
            $this->unlink_avatar($old);
        }

        if (($fields['enabled'] ?? '1') === '0') {
            // Explicitly opted out: their signature is their own, and this
            // plugin does not touch the column at all.
            return $record;
        }

        $record['signature'] = $this->render($fields, $record + $identity);
        // wash_html() has already run by the time this hook fires, so the value
        // set here is stored byte-for-byte. That is required rather than lucky:
        // the wash allow-list is `body, link` and would strip the entire table.
        $record['html_signature'] = 1;

        return $record;
    }

    /**
     * Fields -> signature HTML. The only call to sig_build() in this file.
     *
     * @param array $fields   Sanitized fields
     * @param array $identity Identity columns, for the address and the fallback name
     *
     * @return string
     */
    private function render(array $fields, array $identity)
    {
        $mailbox = strtolower(trim((string) ($identity['email'] ?? '')));
        $person  = ccsig_person($fields, $this->person_defaults($identity), $this->avatar_base());

        return sig_build($person, (array) ($this->roster['company'] ?? []), $mailbox);
    }

    /**
     * The name and printed address for a mailbox.
     *
     * @param array $identity Identity columns
     *
     * @return array
     */
    private function person_defaults(array $identity)
    {
        $mailbox = strtolower(trim((string) ($identity['email'] ?? '')));

        if (isset($this->roster['people'][$mailbox])) {
            return (array) $this->roster['people'][$mailbox];
        }

        // Off the roster entirely — a new hire, or a second identity for an
        // alias. Take the name from the identity row so the signature says who
        // they are without anyone editing a file on the mail box.
        return ['name' => (string) ($identity['name'] ?? ''), 'email' => $mailbox];
    }

    /**
     * Was our fieldset part of this request? Distinguishes a save from the
     * identity form from any other write to the identities table.
     *
     * @return bool
     */
    private function submitted()
    {
        return rcube_utils::get_input_value('_ccsig_submitted', rcube_utils::INPUT_POST) !== null;
    }

    /**
     * The posted fields, sanitized, in the shape that gets stored.
     *
     * @param array $current What the form was showing, read server-side
     *
     * @return array
     */
    private function posted(array $current = [])
    {
        $photo = rcube_utils::get_input_value('_ccsig_headshot', rcube_utils::INPUT_POST);

        // A crafted `_ccsig_headshot[]=x` arrives as an ARRAY, and the (string)
        // cast downstream would raise "Array to string conversion" — a warning
        // that, on this AJAX path, corrupts the JSON body before Roundcube ever
        // sees it. ccsig_sanitize_socials() already guards its own inputs this
        // way; leaving this one unguarded meant the two input paths disagreed
        // about the same hazard. Not null: a crafted value is not "absent", so
        // it must not be read as "leave the photo alone".
        if (is_array($photo)) {
            $photo = '';
        }

        $raw = [
            'title'    => rcube_utils::get_input_value('_ccsig_title', rcube_utils::INPUT_POST, true),
            'phone'    => rcube_utils::get_input_value('_ccsig_phone', rcube_utils::INPUT_POST, true),
            'website'  => rcube_utils::get_input_value('_ccsig_website', rcube_utils::INPUT_POST, true),
            'headshot' => $photo,
            'socials'  => $this->posted_socials((array) ($current['socials'] ?? [])),
        ];

        $fields = ccsig_sanitize($raw);

        // Carry the roster's hosted photo forward unless it was deliberately
        // dropped. null means the widget was not on the page at all (the add
        // form says to save first), which is "unchanged" rather than "remove" —
        // otherwise creating an identity would discard a photo nobody was shown.
        //
        // Taken from $current, which this process read from the roster or from
        // preferences. NEVER from the request: a client-supplied URL here would
        // put an arbitrary remote image into an outgoing signature.
        if ($photo === null || $photo === self::KEEP_PHOTO) {
            $fields['headshot_url'] = (string) ($current['headshot_url'] ?? '');
        }

        // Kept beside the fields rather than inside ccsig_sanitize(): the seam
        // is shared with the seeder, which has no notion of a person opting out
        // of a signature it is being asked to install.
        $fields['enabled'] = rcube_utils::get_input_value('_ccsig_enabled', rcube_utils::INPUT_POST) ? '1' : '0';

        return $fields;
    }

    /**
     * The two parallel link arrays -> the label => url map the template takes.
     *
     * @return array
     */
    private function posted_socials(array $existing = [])
    {
        $slugs = rcube_utils::get_input_value('_ccsig_social_slug', rcube_utils::INPUT_POST);
        $urls  = rcube_utils::get_input_value('_ccsig_social_url', rcube_utils::INPUT_POST);

        if (!is_array($slugs) || !is_array($urls)) {
            return [];
        }

        // KEEP THE LABEL SOMEBODY ALREADY WROTE. The picker only round-trips a
        // slug, so rebuilding the label from it alone renames anything that is
        // not already in CCSIG_SOCIAL_NAMES: a roster entry of 'Google Scholar'
        // slugifies to googlescholar and comes back as "Googlescholar", which
        // is then what the signature says. The roster documents free labels, so
        // this has to survive a save the person never meant as a rename.
        $byslug = [];
        foreach ($existing as $label => $url) {
            $byslug[sig_social_slug((string) $label)] = (string) $label;
        }

        $out = [];
        foreach ($slugs as $i => $slug) {
            $slug = is_string($slug) ? trim($slug) : '';
            $url  = isset($urls[$i]) && is_string($urls[$i]) ? trim($urls[$i]) : '';

            if ($slug === '' || $url === '' || !preg_match('/^[a-z][a-z0-9-]*$/', $slug)) {
                continue;
            }

            // Last row wins on a duplicated platform. The map is keyed by label
            // because that is the shape the template and the roster share; two
            // rows naming the same platform is a mistake the person can see.
            $out[$byslug[$slug] ?? ccsig_social_label($slug)] = $url;
        }

        return $out;
    }

    /**
     * Write one identity's fields into the user's preferences.
     *
     * @param string $id     Identity id
     * @param array  $fields Sanitized fields
     */
    private function store($id, array $fields)
    {
        $prefs      = $this->prefs();
        $prefs[$id] = $fields;

        // Nothing in $fields is ever null: a null inside a preference array is a
        // DELETE instruction to rcube_user::save_prefs, so "the person cleared
        // this field" would remove the key and the next read would fall back to
        // the roster value they had just deleted.
        $this->rc->user->save_prefs(['ccsignature' => $prefs]);
    }

    // ---------------------------------------------------------------------
    // Headshot upload
    // ---------------------------------------------------------------------

    /**
     * Receive one photo, normalise it, and hand back its filename.
     *
     * Reached by XHR from ccsignature.js, never by the identity form: that form
     * is urlencoded, so a file input in it arrives as nothing at all.
     */
    public function action_upload()
    {
        if (!$this->ready) {
            return $this->upload_failed($this->gettext('unavailable'));
        }

        // The request token is checked explicitly rather than relied upon. This
        // action writes a file into a publicly served directory; it is worth
        // three lines to not depend on where in the request cycle the framework
        // happens to validate.
        if (method_exists($this->rc, 'check_request') && !$this->rc->check_request()) {
            return $this->upload_failed($this->gettext('errrequest'));
        }

        // ctype_digit BEFORE get_identity(), because get_identity() opens with
        // `$id = (int) $id`. A non-numeric id therefore becomes 0 and falls
        // through to the account's FIRST identity — so `$identity` comes back
        // populated and this reads as a passed ownership check when no such
        // identity was named. Same user either way, so the damage is a headshot
        // filename minted from the wrong mailbox rather than a leak; but a
        // guard that answers a question it was not asked is worth closing.
        // is_scalar BEFORE the cast, not just ctype_digit after it. A crafted
        // `_ccsig_id[]=1` arrives as an array, and `(string) $array` raises
        // "Array to string conversion" — on THIS route, which is the JSON one,
        // that warning is emitted into the response body and corrupts it before
        // Roundcube writes a byte. ctype_digit does correctly reject the
        // resulting "Array", so the identity never resolves; but it runs one
        // step too late to stop the warning.
        $raw      = rcube_utils::get_input_value('_ccsig_id', rcube_utils::INPUT_POST);
        $id       = is_scalar($raw) ? trim((string) $raw) : '';
        $identity = $id !== '' && ctype_digit($id) ? $this->rc->user->get_identity($id) : null;

        if (empty($identity)) {
            return $this->upload_failed($this->gettext('errnoidentity'));
        }

        $file = isset($_FILES['_ccsig_file']) && is_array($_FILES['_ccsig_file']) ? $_FILES['_ccsig_file'] : null;

        // THE ERROR CODE IS READ FIRST, and the order is the whole point. On
        // UPLOAD_ERR_INI_SIZE and UPLOAD_ERR_FORM_SIZE PHP leaves tmp_name
        // EMPTY, so an is_uploaded_file() test in front of this would answer
        // "no photo was received" for the one case where we know exactly what
        // went wrong — and those two codes are the only ones this branch
        // distinguishes, which made it unreachable.
        if (!empty($file['error'])) {
            $code = (int) $file['error'];
            // UPLOAD_ERR_NO_FILE is listed so it keeps the accurate message it
            // had before the reorder. Moving this check in front of
            // is_uploaded_file() made the branch reachable, and would otherwise
            // have swapped "No photo was received" for the vaguer "could not be
            // processed" on exactly the case that IS just a missing file.
            $known = [
                UPLOAD_ERR_INI_SIZE  => 'errtoobig',
                UPLOAD_ERR_FORM_SIZE => 'errtoobig',
                UPLOAD_ERR_NO_FILE   => 'errnofile',
            ];

            return $this->upload_failed($this->gettext($known[$code] ?? 'erruploadfailed'));
        }
        if (empty($file) || !isset($file['tmp_name']) || !is_uploaded_file($file['tmp_name'])) {
            return $this->upload_failed($this->gettext('errnofile'));
        }

        $dir = $this->avatar_dir();

        if (!is_dir($dir) || !is_writable($dir)) {
            rcube::raise_error([
                    'code' => 621, 'type' => 'php', 'file' => __FILE__, 'line' => __LINE__,
                    'message' => 'ccsignature: avatar directory is not writable: ' . $dir,
                ], true, false
            );

            return $this->upload_failed($this->gettext('errnostorage'));
        }

        $name = ccsig_avatar_name((string) $identity['email']);

        try {
            ccsig_image_process($file['tmp_name'], $dir . '/' . $name);
        }
        catch (CcsigImageError $e) {
            // The exception's message is a short code chosen by the image half,
            // never a library string: an ImageMagick error can name a path.
            return $this->upload_failed($this->gettext($this->image_error_key($e->getMessage())));
        }
        catch (Throwable $e) {
            rcube::raise_error([
                    'code' => 622, 'type' => 'php', 'file' => __FILE__, 'line' => __LINE__,
                    'message' => 'ccsignature: headshot processing failed: ' . $e->getMessage(),
                ], true, false
            );

            return $this->upload_failed($this->gettext('erruploadfailed'));
        }

        // AN UNSAVED UPLOAD IS DELIBERATELY LEFT ALONE, and it is worth saying
        // why, because collecting it looks free and is not.
        //
        // Trying three photos before picking one leaves two files nothing ever
        // reaps — apply() only retires the name that was PREVIOUSLY STORED, and
        // these never were. The obvious fix is to remember the last upload per
        // identity in the session and unlink it when the next one arrives. It
        // was written, and then removed: with the same identity open in two
        // tabs, the second tab's upload deletes the file the FIRST tab is still
        // holding in its hidden field, so saving that tab stores a filename
        // whose file is gone — a broken image in every email that person sends.
        // No amount of comparing against the stored name closes it, because the
        // server cannot know what another tab has on screen.
        //
        // So: kilobytes, weighed against a way to destroy a photo somebody was
        // about to save. Each orphan is one ~54KB JPEG, in a volume, for five
        // people. Leaving them is the cheaper mistake by a wide margin, and it
        // is the one that fails visibly (disk) rather than silently (mail).
        //
        // Deliberately NOT stored here either. The file exists; which file an identity
        // POINTS at is only decided when the person presses Save, so cancelling
        // leaves their current photo in place.
        $this->rc->output->command('plugin.ccsignature-uploaded', [
            'file' => $name,
            'url'  => ccsig_headshot_url(['headshot' => $name], $this->avatar_base()),
        ]);
        $this->rc->output->send();
    }

    /**
     * Map an image error code to a message key, defaulting to something honest.
     *
     * @param string $code Short code from CcsigImageError
     *
     * @return string
     */
    private function image_error_key($code)
    {
        $known = [
            'notimage' => 'errnotimage',
            'badtype'  => 'errnotimage',
            'nofile'   => 'errnofile',
            'toobig'   => 'errtoobig',
            'toolarge' => 'errtoolarge',
        ];

        return $known[$code] ?? 'erruploadfailed';
    }

    /**
     * Tell the client the upload did not happen, and why, and stop.
     *
     * @param string $message Human-readable reason
     */
    private function upload_failed($message)
    {
        $this->rc->output->command('plugin.ccsignature-failed', [
            'message' => $message ?: $this->gettext('erruploadfailed'),
        ]);
        $this->rc->output->send();
    }

    /**
     * Remove one avatar file, if it is one we minted.
     *
     * ccsig_is_avatar_name() is the only gate in front of this unlink, and it is
     * a whole-string grammar rather than a traversal blacklist — a value that is
     * not `slug-8hex.jpg` cannot describe a path at all.
     *
     * @param string $name Stored filename
     */
    private function unlink_avatar($name)
    {
        if ($name === '' || !ccsig_is_avatar_name($name)) {
            return;
        }

        $path = $this->avatar_dir() . '/' . $name;

        if (is_file($path)) {
            @unlink($path);
        }
    }

    // ---------------------------------------------------------------------
    // Small helpers
    // ---------------------------------------------------------------------

    /** @return array Every identity's stored fields, keyed by identity id */
    private function prefs()
    {
        return ccsig_prefs_read($this->rc->config->get('ccsignature'));
    }

    /** @return string[] Icon slugs that have a mark on disk */
    private function slugs()
    {
        $have = (array) ($this->roster['company']['icon_slugs'] ?? []);
        sort($have);

        return $have;
    }

    /** @return string Filesystem directory headshots are written to */
    private function avatar_dir()
    {
        return rtrim((string) $this->setting('avatar_dir', 'CCSIGNATURE_AVATAR_DIR', '/var/lib/ccsignature/avatars'), '/');
    }

    /** @return string Public URL prefix the same directory is served from */
    private function avatar_base()
    {
        return rtrim((string) $this->setting('avatar_base', 'CCSIGNATURE_AVATAR_BASE', 'https://mail.circuitcenter.ai/avatars'), '/');
    }

    /**
     * Read a setting: Roundcube config first, then the environment.
     *
     * Same two channels, in the same order, as cccalendar — the plugin
     * directory is bind-mounted read-only from the checkout, so a config.inc.php
     * cannot be dropped in on the box and docker-compose passes values through
     * from /opt/circuits-mail/.env instead.
     *
     * @param string $key     Suffix of the ccsignature_* config key
     * @param string $env     Environment variable name
     * @param mixed  $default Value when neither is set
     *
     * @return mixed
     */
    private function setting($key, $env, $default = null)
    {
        $value = $this->rc->config->get('ccsignature_' . $key, null);

        if ($value === null || $value === '') {
            $from_env = getenv($env);
            if ($from_env !== false && $from_env !== '') {
                $value = $from_env;
            }
        }

        return $value === null || $value === '' ? $default : $value;
    }
}
