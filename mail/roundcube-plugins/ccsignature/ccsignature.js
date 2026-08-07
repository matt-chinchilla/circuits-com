/**
 * ccsignature — the headshot picker.
 *
 * This is the plugin's ONLY JavaScript, and it exists for exactly one reason:
 * the identity form is urlencoded, and Roundcube's field builder rewrites
 * `type => file` into a text input at rcube_output_html.php:356. A file simply
 * cannot ride that form. So the photo goes up on its own, over XHR, to a
 * registered action — the same channel core uses for the identity image on this
 * very page.
 *
 * Everything else in the section is a plain input inside the normal form and
 * needs no script at all. The five link rows are static for that reason: an
 * add/remove widget would have bought a little tidiness and a lot of this file.
 *
 * The upload does NOT commit anything. It writes the file and hands back a
 * name, which sits in a hidden field until the person presses Save — so
 * cancelling out of the form leaves their current photo exactly where it was.
 */

window.rcmail && rcmail.addEventListener('init', function() {
    var env = rcmail.env.ccsignature;

    if (!env || !env.id) {
        return;
    }

    var file   = document.getElementById('ccsig-file'),
        // The id Roundcube's <label for> names for the photo row, so the label
        // and the control it describes are actually connected.
        choose = document.getElementById('rcmfd_ccsig_photo'),
        clear  = document.getElementById('ccsig-clear'),
        hidden = document.getElementById('ccsig-headshot'),
        avatar = document.getElementById('ccsig-avatar'),
        status = document.getElementById('ccsig-status');

    if (!file || !choose || !hidden || !avatar) {
        return;
    }

    var idle = status ? status.textContent : '';

    function say(text) {
        if (status) {
            status.textContent = text;
        }
    }

    function busy(on) {
        choose.disabled = on;
        if (clear) {
            clear.disabled = on;
        }
    }

    function show(url) {
        while (avatar.firstChild) {
            avatar.removeChild(avatar.firstChild);
        }

        if (!url) {
            var empty = document.createElement('span');
            empty.className = 'ccsig-avatar-empty';
            empty.textContent = rcmail.get_label('nophoto', 'ccsignature');
            avatar.appendChild(empty);
            return;
        }

        var img = document.createElement('img');
        // The URL is built server-side from a filename this code never composes,
        // and it is assigned as a property rather than through innerHTML.
        img.src = url;
        img.width = 72;
        img.height = 72;
        img.alt = '';
        avatar.appendChild(img);
    }

    choose.addEventListener('click', function() {
        file.click();
    });

    if (clear) {
        clear.addEventListener('click', function() {
            hidden.value = '';
            file.value = '';
            show('');
            say(rcmail.get_label('photocleared', 'ccsignature'));
        });
    }

    file.addEventListener('change', function() {
        var f = file.files && file.files[0];

        if (!f) {
            return;
        }

        // Checked here as a courtesy, and again on the server as the actual
        // rule. A browser check saves someone a slow upload that was always
        // going to be refused; it is not what makes the limit true.
        if (env.maxbytes && f.size > env.maxbytes) {
            rcmail.display_message(rcmail.get_label('errtoobig', 'ccsignature'), 'error');
            file.value = '';
            return;
        }

        var data = new FormData();
        data.append('_ccsig_file', f);
        data.append('_ccsig_id', env.id);
        data.append('_token', rcmail.env.request_token);

        busy(true);
        say(rcmail.get_label('uploading', 'ccsignature'));

        $.ajax({
            type: 'POST',
            // _remote=1 is NOT optional and NOT decoration. rcmail::startup()
            // picks the output class from it: without it Roundcube builds an
            // rcmail_output_html and this request comes back as a whole HTML
            // page, so `dataType: json` fails and the upload never works once.
            // rcmail.http_post() adds it for you; a hand-rolled request has to.
            url: rcmail.url('plugin.ccsignature-upload', {_remote: 1}),
            data: data,
            processData: false,
            contentType: false,
            dataType: 'json'
        })
        .done(function(response) {
            // Hand the envelope back to Roundcube rather than reading it here.
            // This is what core's own file_upload() does with its response, and
            // it is what turns the plugin.* commands the action sent into the
            // events registered below.
            rcmail.http_response(response);
        })
        .fail(function() {
            busy(false);
            say(idle);
            rcmail.display_message(rcmail.get_label('erruploadfailed', 'ccsignature'), 'error');
        })
        .always(function() {
            file.value = '';
            // Re-enabled here as well as in the two event handlers. They are
            // the normal path, but a 200 carrying JSON that triggers neither
            // would otherwise leave Choose and Remove dead with no way back
            // except reloading the page. No reachable trigger is known; the
            // cost of closing it off is one line.
            busy(false);
        });
    });

    rcmail.addEventListener('plugin.ccsignature-uploaded', function(p) {
        busy(false);
        hidden.value = p.file || '';
        show(p.url || '');
        say(rcmail.get_label('photoready', 'ccsignature'));
    });

    rcmail.addEventListener('plugin.ccsignature-failed', function(p) {
        busy(false);
        say(idle);
        rcmail.display_message(p.message || rcmail.get_label('erruploadfailed', 'ccsignature'), 'error');
    });
});
