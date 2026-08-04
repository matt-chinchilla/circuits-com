/**
 * Circuit Center shared calendar - client script.
 *
 * @licstart  The following is the entire license notice for the JavaScript
 * code in this file.
 *
 * Copyright (c) Circuit Center. Licensed under the GNU General Public License
 * version 3 or any later version, with exceptions for skins & plugins - the
 * same terms Roundcube itself ships under.
 *
 * @licend  The above is the entire license notice for the JavaScript code in
 * this file.
 *
 *
 * WHAT THIS FILE IS AND IS NOT
 * ----------------------------
 * It is the day-click and the event dialog, and nothing else. It never talks
 * to the calendar API: every request goes to Roundcube's own AJAX endpoint
 * (rcmail.http_post), which already carries the session cookie and the
 * X-Roundcube-Request CSRF header, and the PHP half is what holds the shared
 * secret and calls the API server-side. There is deliberately no API base URL
 * and no credential anywhere in this file.
 *
 * The month grid is rendered by PHP and is NOT re-rendered here. After a save
 * or a delete the page navigates, so there is exactly one place that turns an
 * event into HTML - the escaped PHP path - instead of two that can disagree.
 *
 * EVERY string that came from an event is written with .text(), never .html().
 * The one value that reaches an attribute is the meeting link, and it is
 * re-checked against the http(s) grammar here even though PHP already filtered
 * it on the way in and again on the way out. Three checks for one field is not
 * paranoia in this repo: a stored `javascript:` URL landing in an href is a
 * bug it has shipped before.
 */

window.rcmail && rcmail.addEventListener('init', function() {

    if (rcmail.env.task != 'cccalendar') {
        return;
    }

    var grid     = $('#cccal'),
        readonly = !!rcmail.env.cccalendar_readonly,
        events   = rcmail.env.cccalendar_events || {},
        dialog   = null;

    if (!grid.length) {
        return;
    }

    // -----------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------

    function t(name)
    {
        return rcmail.gettext(name, 'cccalendar');
    }

    /**
     * The client-side half of the URL guard. Mirrors cccalendar::safe_http_url.
     * Returns the URL when it is safe to put in an href, otherwise null.
     */
    function safe_http_url(url)
    {
        if (typeof url != 'string') {
            return null;
        }

        url = url.trim();

        // Control characters and spaces are how scheme filters get walked past
        // ("java\nscript:..."). The class is written with \u escapes so that no
        // editor, transfer or minifier can turn it back into literal control bytes.
        if (!url || /[\u0000-\u0020\u007f]/.test(url)) {
            return null;
        }

        return /^https?:\/\//i.test(url) ? url : null;
    }

    /**
     * Today in the browser's local time, as YYYY-MM-DD. Only used to pick a
     * sensible default date for the toolbar's "New event"; every stored value
     * is formatted server-side in the user's Roundcube timezone.
     */
    function today_key()
    {
        var d   = new Date(),
            pad = function(n) { return (n < 10 ? '0' : '') + n; };

        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    }

    function default_date()
    {
        var now   = today_key(),
            month = rcmail.env.cccalendar_month;

        return now.substr(0, 7) === month ? now : month + '-01';
    }

    function input(type, name, value, attrs)
    {
        var el = $('<input>')
            .attr({type: type, id: 'cccal-f-' + name, name: name})
            .addClass(type == 'checkbox' ? 'cccal-check' : 'form-control');

        if (type == 'checkbox') {
            el.prop('checked', !!value);
        }
        else {
            el.val(value == null ? '' : value);
        }

        if (attrs) {
            el.attr(attrs);
        }

        return el;
    }

    function field(label_text, control, hint_text)
    {
        var wrap = $('<div class="cccal-field">');

        $('<label>').attr('for', control.attr('id')).text(label_text).appendTo(wrap);
        wrap.append(control);

        if (hint_text) {
            $('<p class="cccal-hint">').text(hint_text).appendTo(wrap);
        }

        return wrap;
    }

    function check_field(label_text, control)
    {
        var wrap = $('<div class="cccal-check-row">');

        wrap.append(control);
        $('<label>').attr('for', control.attr('id')).text(label_text).appendTo(wrap);

        return wrap;
    }

    // -----------------------------------------------------------------
    // The dialog
    // -----------------------------------------------------------------

    /**
     * @param {object|null} ev   Event to edit, or null to create
     * @param {string|null} date YYYY-MM-DD to prefill when creating
     */
    function open_dialog(ev, date)
    {
        if (readonly) {
            return;
        }

        var body    = $('<div class="cccal-form">'),
            is_edit = !!ev,
            start   = ev ? ev.start_date : (date || default_date()),
            end     = ev ? ev.end_date   : (date || default_date());

        // The join control comes first: when someone opens an event two minutes
        // before it starts, joining is the only thing they want.
        if (is_edit) {
            var join = safe_http_url(ev.join_url);

            if (join) {
                var join_row = $('<div class="cccal-joinrow">');

                $('<a class="cccal-join btn btn-primary" target="_blank" rel="noopener noreferrer">')
                    .attr('href', join)
                    .text(t('join'))
                    .appendTo(join_row);

                if (ev.join_host) {
                    $('<span class="cccal-joinhost">').text(ev.join_host).appendTo(join_row);
                }

                body.append(join_row);
            }

            if (ev.when) {
                $('<p class="cccal-when">').text(ev.when).appendTo(body);
            }
        }

        var title_in = input('text', 'title', is_edit ? ev.title : '', {maxlength: 200, 'aria-required': 'true', 'data-submit': '1'}),
            allday   = input('checkbox', 'all_day', is_edit ? ev.all_day : false),
            sdate    = input('date', 'start_date', start),
            stime    = input('time', 'start_time', is_edit ? ev.start_time : '09:00'),
            edate    = input('date', 'end_date', end),
            etime    = input('time', 'end_time', is_edit ? ev.end_time : '10:00'),
            loc      = input('text', 'location', is_edit ? ev.location : '', {maxlength: 200}),
            url_in   = input('text', 'url', is_edit ? ev.join_url : '', {maxlength: 2000, inputmode: 'url'}),
            notes    = $('<textarea class="form-control" rows="3">')
                        .attr({id: 'cccal-f-notes', name: 'notes'})
                        .val(is_edit ? ev.notes : ''),
            r_day    = input('checkbox', 'remind_day_before',  is_edit ? ev.remind_day_before  : true),
            r_hour   = input('checkbox', 'remind_hour_before', is_edit ? ev.remind_hour_before : true),
            n_mail   = input('checkbox', 'notify_email',       is_edit ? ev.notify_email       : true),
            n_sms    = input('checkbox', 'notify_sms',         is_edit ? ev.notify_sms         : false);

        // `type="url"` is banned in this codebase: an HTML5-invalid value kills
        // form submit silently, with no :invalid styling and no console error.
        // Plain text plus inputmode, validated in PHP. (CLAUDE.md gotcha.)

        body.append(field(t('title'), title_in));
        body.append(check_field(t('isallday'), allday));

        var times = $('<div class="cccal-times">');
        times.append(field(t('starts'), sdate));
        times.append(field(t('starttime'), stime).addClass('cccal-timecol'));
        times.append(field(t('ends'), edate));
        times.append(field(t('endtime'), etime).addClass('cccal-timecol'));
        body.append(times);

        body.append(field(t('location'), loc));
        body.append(field(t('meetingurl'), url_in, t('meetingurlhint')));
        body.append(field(t('notes'), notes));

        var reminders = $('<fieldset class="cccal-reminders">');
        $('<legend>').text(t('reminders')).appendTo(reminders);
        reminders.append(check_field(t('remindaybefore'), r_day));
        reminders.append(check_field(t('remindhourbefore'), r_hour));
        reminders.append(check_field(t('notifyemail'), n_mail));
        reminders.append(check_field(t('notifysms'), n_sms));
        $('<p class="cccal-hint">').text(t('remindershint')).appendTo(reminders);
        body.append(reminders);

        function sync_allday()
        {
            var on = allday.prop('checked');
            times.toggleClass('is-allday', on);
            stime.prop('disabled', on);
            etime.prop('disabled', on);
        }

        allday.on('change', sync_allday);
        sync_allday();

        // Keep the end date from silently trailing the start date.
        sdate.on('change', function() {
            if (!edate.val() || edate.val() < sdate.val()) {
                edate.val(sdate.val());
            }
        });

        function collect()
        {
            return {
                _id:                 is_edit ? ev.id : '',
                _month:              rcmail.env.cccalendar_month,
                _title:              title_in.val(),
                _all_day:            allday.prop('checked') ? 1 : 0,
                _start_date:         sdate.val(),
                _start_time:         stime.val(),
                _end_date:           edate.val(),
                _end_time:           etime.val(),
                _location:           loc.val(),
                _url:                url_in.val(),
                _notes:              notes.val(),
                _remind_day_before:  r_day.prop('checked') ? 1 : 0,
                _remind_hour_before: r_hour.prop('checked') ? 1 : 0,
                _notify_email:       n_mail.prop('checked') ? 1 : 0,
                _notify_sms:         n_sms.prop('checked') ? 1 : 0
            };
        }

        var buttons = [];

        buttons.push({
            text: t('save'),
            'class': 'mainaction save',
            click: function() {
                if (!String(title_in.val() || '').trim()) {
                    rcmail.display_message(t('errnotitle'), 'error');
                    title_in.trigger('focus');
                    return;
                }

                rcmail.http_post('save', collect(), rcmail.set_busy(true, 'loading'));
            }
        });

        if (is_edit) {
            buttons.push({
                text: t('delete'),
                'class': 'cccal-delete',
                click: function() {
                    rcmail.confirm_dialog(t('confirmdelete'), 'delete', function() {
                        rcmail.http_post('delete', {
                                _id:    ev.id,
                                _month: rcmail.env.cccalendar_month
                            }, rcmail.set_busy(true, 'loading'));
                    });
                }
            });
        }

        buttons.push({
            text: t('cancel'),
            'class': 'cancel',
            click: function() { $(this).dialog('close'); }
        });

        dialog = rcmail.show_popup_dialog(body, is_edit ? t('editevent') : t('newevent'), buttons, {
                width: 560,
                close: function() { $(this).remove(); dialog = null; }
        });

        title_in.trigger('focus');
    }

    function close_dialog()
    {
        if (dialog) {
            try { $(dialog).dialog('close'); } catch (e) { /* already gone */ }
            dialog = null;
        }
    }

    // -----------------------------------------------------------------
    // Wiring
    // -----------------------------------------------------------------

    grid.on('click', '.cccal-ev', function(e) {
        e.preventDefault();
        e.stopPropagation();

        var ev = events[$(this).attr('data-cccal-event')];

        if (ev) {
            open_dialog(ev, null);
        }
    });

    grid.on('click', '.cccal-add', function(e) {
        e.preventDefault();
        e.stopPropagation();
        open_dialog(null, $(this).attr('data-cccal-add'));
    });

    // Clicking anywhere else in a day cell is the same as clicking its "+".
    // Guarded so a tap that lands on the chip or the button does not fire twice.
    grid.on('click', '.cccal-day', function(e) {
        if ($(e.target).closest('button, a, input, label').length) {
            return;
        }

        open_dialog(null, $(this).attr('data-date'));
    });

    $('[data-cccal-new]').on('click', function(e) {
        e.preventDefault();
        open_dialog(null, default_date());
    });

    rcmail.addEventListener('plugin.cccalendar-changed', function(p) {
        close_dialog();
        // Re-render server-side: one escaped rendering path, not two.
        rcmail.goto_url('index', {_date: (p && p.month) || rcmail.env.cccalendar_month});
    });

    rcmail.addEventListener('plugin.cccalendar-failed', function() {
        // Leave the dialog open with the person's typing intact - the error
        // toast PHP sent alongside this says what to change.
    });
});
