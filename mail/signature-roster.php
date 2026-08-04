<?php
/**
 * THE ROSTER — the only file you edit to change an email signature.
 *
 * Everything the signature renders comes from here. There is no other place a
 * name, a phone number or a link is written down, so filling someone in is a
 * matter of typing their details below and re-running seed-signatures.sh.
 *
 * HOW TO FILL SOMEONE IN
 * Every field except 'name' is optional and every field DEGRADES: an empty
 * value removes its whole row, label and all. There is no such thing as a
 * dangling "Mobile" with nothing after it, and a person with nothing but a
 * name and an address still renders a deliberate-looking block. So it is
 * always correct to leave a field empty, and never correct to guess at one —
 * a signature carrying a wrong phone number is worse than one carrying none.
 *
 * Daniel, Anthony and Ronald are deliberately left as name + address only.
 * Nobody has supplied their titles, numbers, handles or photographs, so
 * nothing is invented here. Fill them in when they tell you what they are.
 *
 * WHICH ADDRESS IS WHICH
 * The array KEY is the MAILBOX — the account the signature is installed into,
 * and the address mail actually leaves from. The 'email' FIELD is the address
 * printed in the signature, which is not always the same thing: Matthew's mail
 * leaves matthew@circuitcenter.ai but he publishes mc@matthew-chirichella.com,
 * exactly as his WiseStamp signature did. Leave 'email' empty and it falls
 * back to the mailbox, which is what you want for everyone else.
 *
 * NAMES MUST AGREE WITH seed-contacts.php
 * That script seeds the same four people into everyone's address book from its
 * own list. The two lists are separate because they are consumed by different
 * things at different times, but a person renamed in one and not the other
 * will show up under two names. Change both.
 *
 * @see signature-template.php  turns a row of this into HTML
 * @see seed-signatures.php     writes that HTML into Roundcube
 */

return [

    /* -------------------------------------------------------------------
     * COMPANY — the band at the foot of every signature, identical for all
     * five mailboxes.
     * ----------------------------------------------------------------- */
    'company' => [
        'name'    => 'Circuit Center',
        'url'     => 'https://circuitcenter.ai',
        'label'   => 'circuitcenter.ai',           // the URL as printed
        'tagline' => 'Electronic components directory',

        /**
         * The company mark. It MUST be an absolute https URL to a RASTER
         * image, because:
         *   - data: URIs are stripped by Gmail and Outlook, so the mark has
         *     to be hosted rather than embedded;
         *   - SVG is not rendered by Outlook or Gmail at all, which rules out
         *     /images/logo-mark.svg however much nicer it looks in a browser.
         *
         * This file is the 180x180 favicon-ladder rung already served from
         * frontend/public/images/, so nothing new has to be deployed for the
         * signature to work. It is a FULL-BLEED dark tile with the glyph
         * knocked out of it — that is the reason it was chosen over a
         * transparent-background mark. A transparent glyph borrows whatever
         * surface the mail client happens to be painting, and several clients
         * invert that surface in dark mode; a tile carries its own background,
         * so the glyph's contrast is fixed by the file and cannot be broken by
         * the client. See signature-template.php for the measured ratios.
         */
        'mark'      => 'https://circuitcenter.ai/images/apple-touch-icon.png',
        'mark_size' => 40,
    ],

    /* -------------------------------------------------------------------
     * PEOPLE — keyed by mailbox. Order is the order they are installed.
     * ----------------------------------------------------------------- */
    'people' => [

        'matthew@circuitcenter.ai' => [
            'name'    => 'Matthew Chirichella',
            'title'   => 'Data Scientist',
            'phone'   => '(631) 560-9048',
            'website' => 'matthew-chirichella.com',
            'email'   => 'mc@matthew-chirichella.com',

            /**
             * Optional overrides, both empty because both derive correctly.
             *
             * 'phone_href' is worked out from 'phone' for US numbers (ten
             * digits, or eleven starting with a 1). Set it by hand for
             * anything international — '+44 20 7946 0958' has no US reading,
             * so the template will print the number without linking it rather
             * than guess a country code.
             *
             * 'website_href' is 'website' with https:// in front unless it
             * already carries a scheme.
             */
            'phone_href'   => '',
            'website_href' => '',

            /**
             * Headshot. Empty, because no photograph of anyone here exists in
             * this repository and one is not going to be invented.
             *
             * To add one:
             *   1. save a SQUARE image, at least 144px on a side (it renders
             *      at 72, and half the world is on a 2x screen), as
             *      frontend/public/images/team/matthew.jpg
             *   2. deploy the site — ./deploy.sh --frontend — because the mail
             *      client fetches this over the public internet and will show
             *      a broken box until the file is actually being served
             *   3. put the deployed URL here:
             *      https://circuitcenter.ai/images/team/matthew.jpg
             *   4. re-run ./seed-signatures.sh
             *
             * Empty removes the entire left-hand column; it does not leave a
             * gap where a face should be.
             */
            'headshot' => '',

            /**
             * Socials. Label => absolute https URL, rendered as a LINKS row in
             * the same aligned grid as the phone and the address, in the order
             * written here. Adding one is this one line:
             *
             *     'socials' => [
             *         'GitHub'   => 'https://github.com/<handle>',
             *         'LinkedIn' => 'https://www.linkedin.com/in/<handle>',
             *         'X'        => 'https://x.com/<handle>',
             *     ],
             *
             * Any label works — 'Scholar', 'Calendly', 'Bluesky' — because
             * nothing about the row is hard-coded to a known network. They are
             * text links rather than icons on purpose: an icon has to be
             * hosted, is blocked by default in a good share of clients, and a
             * monochrome glyph disappears the moment a client inverts the
             * background. Text cannot fail any of those ways.
             *
             * Empty, because no handles have been supplied. Do not fill these
             * in from a guess at someone's username.
             */
            'socials' => [],
        ],

        'daniel@circuitcenter.ai' => [
            'name'         => 'Daniel Turano',
            'title'        => '',   // unknown — ask Daniel
            'phone'        => '',   // unknown — ask Daniel
            'website'      => '',
            'email'        => '',   // falls back to daniel@circuitcenter.ai
            'phone_href'   => '',
            'website_href' => '',
            'headshot'     => '',
            'socials'      => [],
        ],

        'anthony@circuitcenter.ai' => [
            'name'         => 'Anthony Martinez',
            'title'        => '',   // unknown — ask Anthony
            'phone'        => '',   // unknown — ask Anthony
            'website'      => '',
            'email'        => '',   // falls back to anthony@circuitcenter.ai
            'phone_href'   => '',
            'website_href' => '',
            'headshot'     => '',
            'socials'      => [],
        ],

        'ronald@circuitcenter.ai' => [
            'name'         => 'Ronald Hausske',
            'title'        => '',   // unknown — ask Ronald
            'phone'        => '',   // unknown — ask Ronald
            'website'      => '',
            'email'        => '',   // falls back to ronald@circuitcenter.ai
            'phone_href'   => '',
            'website_href' => '',
            'headshot'     => '',
            'socials'      => [],
        ],

        /**
         * The shared mailbox. An empty 'name' drops the personal block whole —
         * no name, no title, no contact grid — and leaves the company band on
         * its own, which is the right signature for a mailbox that is not a
         * person. This is the same degradation rule as every other field, not
         * a special case in the template.
         */
        'no-reply@circuitcenter.ai' => [
            'name'         => '',
            'title'        => '',
            'phone'        => '',
            'website'      => '',
            'email'        => '',
            'phone_href'   => '',
            'website_href' => '',
            'headshot'     => '',
            'socials'      => [],

            /**
             * The From name Roundcube will use if it has to CREATE this
             * identity. Only consulted for a brand new identity row; an
             * existing one is never renamed. Without it a nameless mailbox
             * would send as a bare address.
             */
            'identity_name' => 'Circuit Center',
        ],
    ],
];
