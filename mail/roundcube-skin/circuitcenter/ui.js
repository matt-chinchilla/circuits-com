/**
 * Circuit Center skin — the one behaviour the skin adds.
 *
 * A CLOSE control for the compose window, which Roundcube does not give you on
 * a desktop layout, and which saves your draft on the way out.
 *
 * WHY THIS EXISTS
 * ---------------
 * Elastic does ship a back control — templates/compose.html carries
 * `<a class="button icon back-content-button" data-hidden="big">` — but
 * `data-hidden="big"` hides it on wide layouts by design. On a desktop the only
 * ways out of compose are to click a folder or a task, and when you do,
 * Roundcube's own guard (app.js, "check input before leaving compose step")
 * offers you a dialog whose action is DISCARD. So the interface's answer to
 * "I want to stop writing this" was "throw it away", with no visible control
 * that meant "keep it".
 *
 * WHY IT IS JAVASCRIPT AND NOT A TEMPLATE
 * ---------------------------------------
 * The alternative was overriding templates/compose.html, which means forking a
 * ~200-line upstream template and re-reconciling it on every Roundcube release
 * — the same maintenance tax that kept this deployment off a derived Docker
 * image. This file is additive: it reads Roundcube's documented state and adds
 * one button. If it fails to load, compose behaves exactly as it does today.
 *
 * HOW THE SAVE IS SEQUENCED — the part that must not be wrong
 * ----------------------------------------------------------
 * Saving and navigating are not simultaneous. `rcmail.command('savedraft')`
 * posts the form into a hidden iframe; navigating in the same tick would
 * abandon that request and lose the draft. Roundcube fires NO event when a
 * draft save completes (checked: there is no triggerEvent anywhere on that
 * path), so the only reliable completion signal is the server calling
 * `rcmail.set_draft_id(id)` in its response. That method is wrapped here —
 * original first, always — and the navigation happens from inside it.
 *
 * The fallback timer is not belt-and-braces, it is the failure mode: if the
 * save errors, `set_draft_id` is never called and without a timeout the button
 * would appear dead forever. On timeout we stay put and surface the error
 * rather than navigating, because leaving is the destructive half.
 */
(function () {
    'use strict';

    if (typeof rcmail === 'undefined' || !rcmail.addEventListener) {
        return;
    }

    /** Milliseconds to wait for the server to acknowledge the draft save. */
    var SAVE_TIMEOUT = 15000;

    var closing = false;
    var timer = null;

    /** Is there unsaved work? Roundcube's own dirty check, not a guess. */
    function isDirty() {
        try {
            return !rcmail.env.is_sent && rcmail.cmp_hash !== rcmail.compose_field_hash();
        } catch (e) {
            // If the check itself fails, assume dirty: saving a clean message
            // costs a round trip, losing a dirty one costs someone's writing.
            return true;
        }
    }

    /** Leave compose for the mail list. */
    function leave() {
        clearTimeout(timer);
        closing = false;
        // Roundcube re-arms its unsaved-changes guard at the end of
        // set_draft_id. Without this it would prompt on the way out about the
        // very draft we just saved.
        rcmail.compose_skip_unsavedcheck = true;
        rcmail.command('list', '', null, null);
    }

    function abandonSave() {
        clearTimeout(timer);
        closing = false;
        rcmail.display_message(rcmail.get_label('errortitle') || 'Could not save the draft', 'error');
    }

    // Wrap the completion hook. Original first and unconditionally, so this
    // cannot change what Roundcube does — only what happens afterwards.
    var setDraftId = rcmail.set_draft_id;
    rcmail.set_draft_id = function () {
        var result = setDraftId.apply(this, arguments);
        if (closing) {
            leave();
        }
        return result;
    };

    function closeCompose() {
        if (closing) {
            return;
        }

        if (!isDirty()) {
            // Nothing to preserve — an empty or untouched compose window. Skip
            // the round trip AND skip Roundcube's warning, which would
            // otherwise ask about discarding a message that does not exist.
            rcmail.compose_skip_unsavedcheck = true;
            rcmail.command('list', '', null, null);
            return;
        }

        closing = true;
        timer = setTimeout(abandonSave, SAVE_TIMEOUT);
        rcmail.command('savedraft');
    }

    /** Put the control in the compose header, left of Send. */
    function addButton() {
        if (rcmail.env.action !== 'compose' || document.getElementById('cc-compose-close')) {
            return;
        }

        var header = document.querySelector('#layout-content > .header');
        if (!header) {
            return;
        }

        var btn = document.createElement('a');
        btn.id = 'cc-compose-close';
        btn.href = '#';
        btn.className = 'button icon cc-compose-close';
        btn.setAttribute('role', 'button');
        // Named for what it DOES, not for the glyph. "Close" alone would not
        // say whether the draft survives, which is the only thing anyone
        // hesitating over this button actually wants to know.
        btn.title = 'Save draft and close';
        btn.setAttribute('aria-label', 'Save draft and close');

        var inner = document.createElement('span');
        inner.className = 'inner';
        inner.textContent = 'Save draft and close';
        btn.appendChild(inner);

        btn.addEventListener('click', function (e) {
            e.preventDefault();
            closeCompose();
        });

        header.insertBefore(btn, header.firstChild);
    }

    /* ── Checkbox mode, in one button ──────────────────────────────────────
     *
     * Turning on checkboxes took three clicks and a discovery: open Select,
     * choose All, reopen Select, choose Selection. Nothing signposted that
     * order, and the obvious route — Select > Selection — did nothing at all.
     *
     * That is not a misunderstanding of the menu, it is a bug in Elastic:
     *
     *     function toggle_list_selection(obj, list_id) {
     *         if ($(obj).is('.active')) { ...toggle... }
     *     }
     *
     * The menu item is rendered `class="selection disabled"` and only gains
     * `.active` once a selection exists, so the control that turns selection
     * mode ON is disabled until you have already selected something. Picking
     * "All" first is not a step, it is a workaround for the guard.
     *
     * Rather than reimplement the toggle, this calls Elastic's own function
     * with a detached element carrying `.active` — satisfying the guard so the
     * real code runs, including `set_pref('list-selection', ...)`. The
     * preference key, the persistence and the class stay Elastic's; if a future
     * release changes any of them, this follows automatically instead of
     * drifting out of sync with a private copy.
     */
    function listEl() {
        return document.getElementById('messagelist');
    }

    function selectionOn() {
        var l = listEl();
        return !!l && l.classList.contains('withselection');
    }

    function syncToggle(btn) {
        var on = selectionOn();
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        btn.classList.toggle('is-on', on);
    }

    function addSelectionToggle() {
        if (rcmail.env.task !== 'mail' || rcmail.env.action || !listEl()) {
            return;
        }
        if (document.getElementById('cc-select-toggle')) {
            return;
        }

        var header = document.querySelector('#layout-list > .header');
        if (!header) {
            return;
        }

        var btn = document.createElement('a');
        btn.id = 'cc-select-toggle';
        btn.href = '#';
        btn.className = 'button icon cc-select-toggle';
        btn.setAttribute('role', 'button');
        // One name for both states — the pressed state says which way it is,
        // so the label does not have to flip and mean two things.
        btn.title = 'Select items';
        btn.setAttribute('aria-label', 'Select items');

        var inner = document.createElement('span');
        inner.className = 'inner';
        inner.textContent = 'Select items';
        btn.appendChild(inner);

        btn.addEventListener('click', function (e) {
            e.preventDefault();
            if (typeof UI === 'undefined' || !UI.toggle_list_selection) {
                return;
            }
            // The detached `.active` element is the whole trick: it satisfies
            // Elastic's guard so its own toggle runs, preference and all.
            var proxy = document.createElement('span');
            proxy.className = 'active';
            UI.toggle_list_selection(proxy, 'messagelist');
            syncToggle(btn);
        });

        // Elastic restores the saved preference while building the list, so the
        // button has to read the world rather than assume it starts off.
        syncToggle(btn);
        header.appendChild(btn);
    }

    rcmail.addEventListener('init', function () {
        addButton();
        addSelectionToggle();
    });
})();
