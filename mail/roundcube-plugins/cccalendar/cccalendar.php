<?php

/**
 * Circuit Center shared calendar - Roundcube 1.6 plugin.
 *
 * A month grid for the five people at Circuit Center, reachable from the task
 * rail inside the webmail. Events live in Postgres on the WEB box behind the
 * existing FastAPI service; this plugin is a thin, entirely server-side client
 * of `/api/calendar/events`.
 *
 * THE ONE RULE THAT SHAPES THIS FILE
 * ----------------------------------
 * The browser never talks to the API. Every request to it is made from PHP,
 * with the shared secret in a request header, mirroring the MAIL_SYNC_SECRET
 * channel that already runs between these two boxes. Consequences, all of them
 * deliberate:
 *
 *   - no CORS to configure, no preflight, no allow-list of origins;
 *   - the secret is never in a JS bundle, an env var the client can read, or a
 *     network tab;
 *   - the API can stay closed to the public internet apart from this one
 *     server-to-server path.
 *
 * The client half (cccalendar.js) only ever talks to Roundcube itself, over
 * Roundcube's own AJAX channel, which already carries the session cookie and
 * the CSRF token. There is no second auth system here.
 *
 * ESCAPING
 * --------
 * `meeting_url` is attacker-influenced text: anyone with a mailbox can type
 * one, and this repo has already been bitten once by a stored `javascript:`
 * URL reaching an href (see the safeHttpUrl gotcha in CLAUDE.md). So it is
 * filtered on the way IN (self::safe_http_url on save) and again on the way
 * OUT (same function when building the view), and the value only ever reaches
 * the page as an href after passing. Every other field is escaped with
 * rcube::Q() before it is concatenated into HTML, or handed to the client as
 * JSON via set_env() - where Roundcube's json_serialize() applies JSON_HEX_TAG
 * - and inserted with textContent, never innerHTML.
 *
 * NEVER A BLANK PAGE
 * ------------------
 * If the API base or the secret is missing, or the API is unreachable, the
 * page still renders: a full month grid plus a plain-English notice saying
 * exactly which piece is missing. No PHP warning, no white screen, no silent
 * empty month that reads as "we have no meetings".
 *
 * @author  Circuit Center
 * @license GPL-3.0-or-later (same terms as Roundcube, exceptions for plugins)
 */
class cccalendar extends rcube_plugin
{
    /**
     * Bind to every task except login/logout.
     *
     * The plugin must initialise on `mail`, `settings`, `addressbook` and so on and not
     * only on its own task, because register_task() is what puts `cccalendar`
     * into rcmail::$main_tasks, and rcmail_output_html::button() consults that
     * list to decide whether the rail button gets a real `?_task=` href plus the
     * core `switch-task` onclick. Bind to our task alone and the button renders
     * dead on every other page.
     */
    public $task = '?(?!login|logout).*';

    /** @var rcmail */
    private $rc;

    /** @var DateTimeZone|null Resolved lazily; the user's Roundcube timezone. */
    private $tz;

    /**
     * View model for the month page, built by action_index() and consumed by the
     * template-object handlers. Kept in one place so the handlers stay dumb.
     *
     * @var array
     */
    private $view = [];

    /** Maximum characters accepted for the short text fields (matches the model). */
    const MAX_TITLE    = 200;
    const MAX_LOCATION = 200;
    const MAX_NOTES    = 5000;
    const MAX_URL      = 2000;

    /**
     * Plugin bootstrap.
     */
    public function init()
    {
        $this->rc = rcmail::get_instance();

        $this->load_config();
        $this->add_texts('localization/');

        // Registers the task AND appends it to rcmail::$main_tasks - see $task.
        $this->register_task('cccalendar');

        // With a task registered, these become `cccalendar.<action>`, reached as
        // ?_task=cccalendar&_action=<action>. `index` is the implicit default.
        $this->register_action('index',  [$this, 'action_index']);
        $this->register_action('save',   [$this, 'action_save']);
        $this->register_action('delete', [$this, 'action_delete']);

        $this->add_hook('startup', [$this, 'hook_startup']);
    }

    /**
     * Put the button in the task rail on every full page.
     *
     * The `calendar` class is not ours - Elastic already ships
     * `.menu a.calendar:before { content: <fa-calendar-alt> }`, so the icon
     * comes from the skin's own self-hosted icon font and this plugin ships no
     * image and fetches nothing.
     *
     * @param array $args startup hook arguments
     *
     * @return array unmodified
     */
    public function hook_startup($args)
    {
        if (!is_object($this->rc->output) || $this->rc->output->type != 'html' || $this->rc->output->framed) {
            return $args;
        }

        $this->add_button([
                'command'    => 'cccalendar',
                'class'      => 'calendar',
                'classsel'   => 'calendar selected',
                'innerclass' => 'inner',
                'label'      => 'cccalendar.calendar',
                'type'       => 'link',
            ], 'taskbar'
        );

        return $args;
    }

    // ---------------------------------------------------------------------
    // Actions
    // ---------------------------------------------------------------------

    /**
     * The month view. GET ?_task=cccalendar[&_date=YYYY-MM]
     */
    public function action_index()
    {
        $this->add_texts('localization/', true);

        $tz    = $this->timezone();
        $month = $this->requested_month($tz);

        $this->view = $this->build_view($month, $tz);

        $this->rc->output->set_pagetitle($this->gettext('calendar'));

        $this->rc->output->set_env('cccalendar_month',    $this->view['month_key']);
        $this->rc->output->set_env('cccalendar_today',    $this->view['today']);
        $this->rc->output->set_env('cccalendar_events',   $this->view['events_by_id']);
        $this->rc->output->set_env('cccalendar_readonly', $this->view['readonly']);

        $this->rc->output->add_handlers([
                'plugin.cccalendar_title'   => [$this, 'object_title'],
                'plugin.cccalendar_toolbar' => [$this, 'object_toolbar'],
                'plugin.cccalendar_notice'  => [$this, 'object_notice'],
                'plugin.cccalendar_grid'    => [$this, 'object_grid'],
        ]);

        $this->include_script('cccalendar.js');

        // Pinned to the circuitcenter path rather than derived from
        // local_skin_path(): the sheet is written for THIS skin's --cc-* tokens
        // and carries its own fallbacks, so it is correct under stock Elastic
        // too, whereas local_skin_path() would resolve to skins/elastic/ (where
        // the template lives) and quietly load nothing at all.
        $this->include_stylesheet('skins/circuitcenter/cccalendar.css');

        $this->rc->output->send('cccalendar.calendar');
    }

    /**
     * Create or update one event. POST, AJAX, via Roundcube's own channel.
     */
    public function action_save()
    {
        $tz = $this->timezone();

        if ($problem = $this->config_problem()) {
            return $this->fail($problem);
        }

        $id       = trim((string) rcube_utils::get_input_value('_id', rcube_utils::INPUT_POST));
        $title    = trim((string) rcube_utils::get_input_value('_title', rcube_utils::INPUT_POST));
        $all_day  = (bool) rcube_utils::get_input_value('_all_day', rcube_utils::INPUT_POST);
        $location = trim((string) rcube_utils::get_input_value('_location', rcube_utils::INPUT_POST));
        $notes    = trim((string) rcube_utils::get_input_value('_notes', rcube_utils::INPUT_POST));
        $url_in   = trim((string) rcube_utils::get_input_value('_url', rcube_utils::INPUT_POST));

        if ($title === '') {
            return $this->fail($this->gettext('errnotitle'));
        }
        if (mb_strlen($title) > self::MAX_TITLE) {
            $title = mb_substr($title, 0, self::MAX_TITLE);
        }
        if (mb_strlen($location) > self::MAX_LOCATION) {
            $location = mb_substr($location, 0, self::MAX_LOCATION);
        }
        if (mb_strlen($notes) > self::MAX_NOTES) {
            $notes = mb_substr($notes, 0, self::MAX_NOTES);
        }

        $meeting_url = '';
        if ($url_in !== '') {
            if (mb_strlen($url_in) > self::MAX_URL) {
                return $this->fail($this->gettext('errbadurl'));
            }
            // Write-boundary half of the two-sided guard. A value that does not
            // survive this never reaches the database, so a forgotten render-site
            // check cannot leak stored content later.
            $meeting_url = self::safe_http_url($url_in);
            if ($meeting_url === '') {
                return $this->fail($this->gettext('errbadurl'));
            }
        }

        $start_date = (string) rcube_utils::get_input_value('_start_date', rcube_utils::INPUT_POST);
        $end_date   = (string) rcube_utils::get_input_value('_end_date', rcube_utils::INPUT_POST);
        $start_time = (string) rcube_utils::get_input_value('_start_time', rcube_utils::INPUT_POST);
        $end_time   = (string) rcube_utils::get_input_value('_end_time', rcube_utils::INPUT_POST);

        if ($end_date === '') {
            $end_date = $start_date;
        }
        if ($all_day) {
            // An all-day event is stored as a real instant range in local time,
            // so the reminder job needs no special case: "the day before" is
            // measured from a concrete starts_at like everything else.
            $start_time = '00:00';
            $end_time   = '23:59';
        }

        $starts = $this->parse_local($start_date, $start_time, $tz);
        $ends   = $this->parse_local($end_date, $end_time, $tz);

        if (!$starts || !$ends) {
            return $this->fail($this->gettext('errbaddate'));
        }
        if ($ends < $starts) {
            return $this->fail($this->gettext('errendbeforestart'));
        }

        $payload = [
            'title'              => $title,
            'starts_at'          => $starts->format(DateTime::ATOM),
            'ends_at'            => $ends->format(DateTime::ATOM),
            'all_day'            => $all_day,
            'location'           => $location !== '' ? $location : null,
            'meeting_url'        => $meeting_url !== '' ? $meeting_url : null,
            'notes'              => $notes !== '' ? $notes : null,
            'remind_day_before'  => (bool) rcube_utils::get_input_value('_remind_day_before', rcube_utils::INPUT_POST),
            'remind_hour_before' => (bool) rcube_utils::get_input_value('_remind_hour_before', rcube_utils::INPUT_POST),
            'notify_email'       => (bool) rcube_utils::get_input_value('_notify_email', rcube_utils::INPUT_POST),
            'notify_sms'         => (bool) rcube_utils::get_input_value('_notify_sms', rcube_utils::INPUT_POST),
        ];

        if ($id !== '') {
            $result = $this->api_request('PATCH', '/calendar/events/' . rawurlencode($id), [], $payload);
        }
        else {
            $result = $this->api_request('POST', '/calendar/events', [], $payload);
        }

        if (!$result['ok']) {
            return $this->fail($result['error']);
        }

        $this->rc->output->show_message($this->gettext('eventsaved'), 'confirmation');

        // Send the client to the month the event actually landed in, not the one
        // it was looking at: someone who opens the dialog on 31 August and moves
        // the date to 2 September should see the thing they just made.
        $this->rc->output->command('plugin.cccalendar-changed', [
                'month' => $starts->format('Y-m'),
        ]);
        $this->rc->output->send();
    }

    /**
     * Delete one event. POST, AJAX.
     */
    public function action_delete()
    {
        if ($problem = $this->config_problem()) {
            return $this->fail($problem);
        }

        $id = trim((string) rcube_utils::get_input_value('_id', rcube_utils::INPUT_POST));

        if ($id === '') {
            return $this->fail($this->gettext('errnoevent'));
        }

        $result = $this->api_request('DELETE', '/calendar/events/' . rawurlencode($id));

        if (!$result['ok']) {
            return $this->fail($result['error']);
        }

        $this->rc->output->show_message($this->gettext('eventdeleted'), 'confirmation');
        $this->rc->output->command('plugin.cccalendar-changed', [
                'month' => $this->clean_month((string) rcube_utils::get_input_value('_month', rcube_utils::INPUT_POST)),
        ]);
        $this->rc->output->send();
    }

    /**
     * Report a failure to the client and stop. Always an error message the user
     * can act on - never a stack trace, never a bare 500.
     *
     * @param string $message Human-readable reason
     */
    private function fail($message)
    {
        $this->rc->output->show_message($message ?: $this->gettext('errsavefailed'), 'error');
        $this->rc->output->command('plugin.cccalendar-failed', []);
        $this->rc->output->send();
    }

    // ---------------------------------------------------------------------
    // Template objects
    // ---------------------------------------------------------------------

    /**
     * "August 2026" for the content header.
     *
     * @param array $attrib template tag attributes
     *
     * @return string
     */
    public function object_title($attrib)
    {
        return rcube::Q($this->view['month_label'] ?? $this->gettext('calendar'));
    }

    /**
     * Previous / today / next / new-event controls.
     *
     * `a.button.icon` is Elastic's own class pair: its :before already carries
     * the icon font, so cccalendar.css only has to name a glyph.
     *
     * @param array $attrib template tag attributes
     *
     * @return string
     */
    public function object_toolbar($attrib)
    {
        $prev = $this->rc->url(['_task' => 'cccalendar', '_action' => 'index', '_date' => $this->view['prev_month']]);
        $next = $this->rc->url(['_task' => 'cccalendar', '_action' => 'index', '_date' => $this->view['next_month']]);
        $now  = $this->rc->url(['_task' => 'cccalendar', '_action' => 'index', '_date' => $this->view['this_month']]);

        $out = '<span class="cccal-nav">';
        $out .= '<a class="button icon cccal-prev" href="' . rcube::Q($prev) . '" title="' . rcube::Q($this->gettext('prevmonth')) . '">'
              . '<span class="inner">' . rcube::Q($this->gettext('prevmonth')) . '</span></a>';
        $out .= '<a class="button cccal-today" href="' . rcube::Q($now) . '">'
              . '<span class="inner">' . rcube::Q($this->gettext('today')) . '</span></a>';
        $out .= '<a class="button icon cccal-next" href="' . rcube::Q($next) . '" title="' . rcube::Q($this->gettext('nextmonth')) . '">'
              . '<span class="inner">' . rcube::Q($this->gettext('nextmonth')) . '</span></a>';

        if (empty($this->view['readonly'])) {
            $out .= '<a class="button icon cccal-new" href="#" data-cccal-new="1" title="' . rcube::Q($this->gettext('newevent')) . '">'
                  . '<span class="inner">' . rcube::Q($this->gettext('newevent')) . '</span></a>';
        }

        $out .= '</span>';

        return $out;
    }

    /**
     * The explanatory empty state. Rendered above the grid whenever the plugin
     * could not read the calendar, and never rendered otherwise.
     *
     * @param array $attrib template tag attributes
     *
     * @return string
     */
    public function object_notice($attrib)
    {
        if (empty($this->view['notice'])) {
            return '';
        }

        $notice = $this->view['notice'];
        $out    = '<div class="cccal-notice" role="status">';
        $out   .= '<h2 class="cccal-notice-head">' . rcube::Q($notice['head']) . '</h2>';
        $out   .= '<p class="cccal-notice-body">' . rcube::Q($notice['body']) . '</p>';

        if (!empty($notice['hint'])) {
            $out .= '<p class="cccal-notice-hint">' . rcube::Q($notice['hint']) . '</p>';
        }

        $out .= '</div>';

        return $out;
    }

    /**
     * The month grid itself. Every value here goes through rcube::Q().
     *
     * @param array $attrib template tag attributes
     *
     * @return string
     */
    public function object_grid($attrib)
    {
        $view = $this->view;
        $ro   = !empty($view['readonly']);

        $out  = '<div id="cccal" class="cccal' . ($ro ? ' cccal-readonly' : '') . '"'
              . ' data-month="' . rcube::Q($view['month_key']) . '">';

        $out .= '<div class="cccal-weekdays" aria-hidden="true">';
        foreach ($view['weekday_labels'] as $label) {
            $out .= '<div class="cccal-wd">' . rcube::Q($label) . '</div>';
        }
        $out .= '</div>';

        // Deliberately role="group", NOT role="grid": role=grid promises a
        // two-dimensional arrow-key model (WAI-ARIA APG), and a screen reader
        // that believes the promise puts the user in a mode where the arrows do
        // not do what they expect. Each cell names its own date instead, and the
        // controls inside the cells are ordinary buttons in reading order.
        $out .= '<div class="cccal-grid" role="group" aria-label="' . rcube::Q($view['month_label']) . '">';

        foreach ($view['weeks'] as $week) {
            $out .= '<div class="cccal-week">';

            foreach ($week as $day) {
                $classes = ['cccal-day'];
                if (!$day['in_month']) {
                    $classes[] = 'is-outside';
                }
                if ($day['is_today']) {
                    $classes[] = 'is-today';
                }
                if (!empty($day['events'])) {
                    $classes[] = 'has-events';
                }

                $out .= '<div class="' . implode(' ', $classes) . '"'
                      . ' data-date="' . rcube::Q($day['date']) . '"'
                      . ' aria-label="' . rcube::Q($day['long_label']) . '">';

                $out .= '<div class="cccal-dayhead">';
                $out .= '<span class="cccal-daynum">' . rcube::Q($day['num']) . '</span>';

                if (!$ro) {
                    $out .= '<button type="button" class="cccal-add" data-cccal-add="' . rcube::Q($day['date']) . '"'
                          . ' title="' . rcube::Q($this->gettext('newevent')) . '">'
                          . '<span class="cccal-sr">' . rcube::Q($this->gettext('newevent')) . ' - ' . rcube::Q($day['long_label']) . '</span>'
                          . '</button>';
                }

                $out .= '</div>';

                $out .= '<ul class="cccal-events">';
                foreach ($day['events'] as $ev) {
                    $out .= '<li><button type="button" class="cccal-ev'
                          . ($ev['join_url'] !== '' ? ' has-join' : '')
                          . ($ev['all_day'] ? ' is-allday' : '')
                          . '" data-cccal-event="' . rcube::Q($ev['id']) . '">';
                    $out .= '<span class="cccal-ev-time">' . rcube::Q($ev['chip_time']) . '</span>';
                    $out .= '<span class="cccal-ev-title">' . rcube::Q($ev['title']) . '</span>';
                    $out .= '</button></li>';
                }
                $out .= '</ul>';

                $out .= '</div>';
            }

            $out .= '</div>';
        }

        $out .= '</div></div>';

        return $out;
    }

    // ---------------------------------------------------------------------
    // View model
    // ---------------------------------------------------------------------

    /**
     * Assemble everything the month page needs, including the failure states.
     *
     * @param DateTime     $month First day of the displayed month, local midnight
     * @param DateTimeZone $tz    The user's timezone
     *
     * @return array
     */
    private function build_view(DateTime $month, DateTimeZone $tz)
    {
        $first_weekday = (int) $this->setting('first_weekday', 'CALENDAR_FIRST_WEEKDAY', 0);
        $first_weekday = ($first_weekday % 7 + 7) % 7;

        $days_in_month = (int) $month->format('t');
        $lead          = ((int) $month->format('w') - $first_weekday + 7) % 7;
        $cells         = (int) (ceil(($lead + $days_in_month) / 7) * 7);

        $grid_start = (clone $month)->modify('-' . $lead . ' day');
        $grid_end   = (clone $grid_start)->modify('+' . ($cells - 1) . ' day')->setTime(23, 59, 59);

        $today = new DateTime('now', $tz);

        $view = [
            'month_key'      => $month->format('Y-m'),
            'month_label'    => $this->month_label($month),
            'prev_month'     => (clone $month)->modify('first day of previous month')->format('Y-m'),
            'next_month'     => (clone $month)->modify('first day of next month')->format('Y-m'),
            'this_month'     => $today->format('Y-m'),
            'today'          => $today->format('Y-m-d'),
            'weekday_labels' => $this->weekday_labels($first_weekday),
            'weeks'          => [],
            'events_by_id'   => [],
            'readonly'       => false,
            'notice'         => null,
        ];

        $by_date = [];

        if ($problem = $this->config_problem()) {
            $view['readonly'] = true;
            $view['notice']   = [
                'head' => $this->gettext('notconfiguredhead'),
                'body' => $problem,
                'hint' => $this->gettext('notconfiguredhint'),
            ];
        }
        else {
            $fetch = $this->fetch_events($grid_start, $grid_end, $tz);

            if (!$fetch['ok']) {
                // Deliberately NOT read-only: an unreachable API is usually
                // transient, and refusing to let someone open the dialog turns a
                // blip into "the calendar is broken".
                $view['notice'] = [
                    'head' => $this->gettext('unreachablehead'),
                    'body' => $fetch['error'],
                    'hint' => $this->gettext('unreachablehint'),
                ];
            }
            else {
                $by_date              = $fetch['by_date'];
                $view['events_by_id'] = $fetch['by_id'];
            }
        }

        $cursor = clone $grid_start;
        $week   = [];

        for ($i = 0; $i < $cells; $i++) {
            $key = $cursor->format('Y-m-d');

            $week[] = [
                'date'       => $key,
                'num'        => $cursor->format('j'),
                'in_month'   => $cursor->format('Y-m') === $view['month_key'],
                'is_today'   => $key === $view['today'],
                'long_label' => $this->long_date_label($cursor),
                'events'     => $by_date[$key] ?? [],
            ];

            if (count($week) === 7) {
                $view['weeks'][] = $week;
                $week            = [];
            }

            $cursor->modify('+1 day');
        }

        return $view;
    }

    /**
     * Pull the window from the API and reduce it to the shape the view wants.
     *
     * @param DateTime     $from Window start (local)
     * @param DateTime     $to   Window end (local)
     * @param DateTimeZone $tz   The user's timezone
     *
     * @return array ['ok' => bool, 'error' => string, 'by_date' => array, 'by_id' => array]
     */
    private function fetch_events(DateTime $from, DateTime $to, DateTimeZone $tz)
    {
        $result = $this->api_request('GET', '/calendar/events', [
                'from' => $from->format(DateTime::ATOM),
                'to'   => $to->format(DateTime::ATOM),
        ]);

        if (!$result['ok']) {
            return ['ok' => false, 'error' => $result['error'], 'by_date' => [], 'by_id' => []];
        }

        $rows = $result['data'];

        // Tolerate both a bare list and the common envelope shapes, so a later
        // change on the API side to `{"events": [...]}` does not blank the page.
        if (is_array($rows) && !isset($rows[0])) {
            foreach (['events', 'items', 'results', 'data'] as $key) {
                if (isset($rows[$key]) && is_array($rows[$key])) {
                    $rows = $rows[$key];
                    break;
                }
            }
        }

        if (!is_array($rows)) {
            return [
                'ok'      => false,
                'error'   => $this->gettext('errbadresponse'),
                'by_date' => [],
                'by_id'   => [],
            ];
        }

        $by_date = [];
        $by_id   = [];

        foreach ($rows as $row) {
            if (!is_array($row)) {
                continue;
            }

            $ev = $this->normalize_event($row, $tz);
            if ($ev === null) {
                continue;
            }

            $by_id[$ev['id']] = $ev;

            // Place the chip on every local day the event touches. Days outside
            // the drawn grid simply never get read; the counter is there so a
            // nonsense pair of dates from the API cannot spin this loop.
            $cursor = DateTime::createFromFormat('!Y-m-d', $ev['start_date'], $tz);
            $last   = DateTime::createFromFormat('!Y-m-d', $ev['end_date'], $tz);

            if (!$cursor || !$last) {
                continue;
            }

            $guard = 0;
            while ($cursor <= $last && $guard++ < 400) {
                $by_date[$cursor->format('Y-m-d')][] = $ev;
                $cursor->modify('+1 day');
            }
        }

        foreach ($by_date as $key => $list) {
            usort($list, function ($a, $b) {
                if ($a['all_day'] !== $b['all_day']) {
                    return $a['all_day'] ? -1 : 1;
                }
                return strcmp($a['sort_key'], $b['sort_key']);
            });
            $by_date[$key] = $list;
        }

        return ['ok' => true, 'error' => '', 'by_date' => $by_date, 'by_id' => $by_id];
    }

    /**
     * Turn one API row into the flat, already-safe structure the view and the
     * client dialog both read. Returns null for a row we cannot place.
     *
     * @param array        $row One event as returned by the API
     * @param DateTimeZone $tz  The user's timezone
     *
     * @return array|null
     */
    private function normalize_event(array $row, DateTimeZone $tz)
    {
        $id = self::str_field($row['id'] ?? null);
        if ($id === '') {
            return null;
        }

        $starts = $this->parse_api_date($row['starts_at'] ?? null, $tz);
        if (!$starts) {
            return null;
        }

        $ends = $this->parse_api_date($row['ends_at'] ?? null, $tz);
        if (!$ends || $ends < $starts) {
            $ends = clone $starts;
        }

        $all_day  = !empty($row['all_day']);
        $timefmt  = $this->rc->config->get('time_format', 'H:i');
        $same_day = $starts->format('Y-m-d') === $ends->format('Y-m-d');

        // The dash is written as a plain hyphen on purpose: this string is
        // escaped into HTML and also handed to the client as JSON, and this repo
        // has a documented history of non-ASCII glyphs in source being mangled
        // into literal \uXXXX by edit tooling.
        if ($all_day) {
            $chip_time = $this->gettext('allday');
            $when      = $this->long_date_label($starts)
                       . ($same_day ? '' : ' - ' . $this->long_date_label($ends))
                       . ' - ' . $this->gettext('allday');
        }
        else {
            $chip_time = $starts->format($timefmt);
            $when      = $this->long_date_label($starts) . ' ' . $starts->format($timefmt)
                       . ' - ' . ($same_day ? '' : $this->long_date_label($ends) . ' ') . $ends->format($timefmt);
        }

        // Render-site half of the URL guard. Even though save() already filtered,
        // rows can predate this code or arrive from a direct API write.
        $join = self::safe_http_url(self::str_field($row['meeting_url'] ?? null));
        $host = '';
        if ($join !== '') {
            $parts = @parse_url($join);
            $host  = is_array($parts) && !empty($parts['host']) ? $parts['host'] : '';
        }

        return [
            'id'                 => $id,
            'title'              => self::str_field($row['title'] ?? null),
            'location'           => self::str_field($row['location'] ?? null),
            'notes'              => self::str_field($row['notes'] ?? null),
            'all_day'            => $all_day,
            'start_date'         => $starts->format('Y-m-d'),
            'start_time'         => $starts->format('H:i'),
            'end_date'           => $ends->format('Y-m-d'),
            'end_time'           => $ends->format('H:i'),
            'sort_key'           => $starts->format('Y-m-d H:i'),
            'chip_time'          => $chip_time,
            'when'               => $when,
            'join_url'           => $join,
            'join_host'          => $host,
            'remind_day_before'  => !empty($row['remind_day_before']),
            'remind_hour_before' => !empty($row['remind_hour_before']),
            'notify_email'       => !empty($row['notify_email']),
            'notify_sms'         => !empty($row['notify_sms']),
        ];
    }

    // ---------------------------------------------------------------------
    // API client - the only code in this repo that holds the shared secret
    // ---------------------------------------------------------------------

    /**
     * Why the plugin cannot talk to the API, or null when it can.
     *
     * @return string|null
     */
    private function config_problem()
    {
        if ($this->api_base() === '') {
            return $this->gettext('errnobase');
        }
        if ($this->api_secret() === '') {
            return $this->gettext('errnosecret');
        }

        return null;
    }

    /**
     * @return string API root with no trailing slash, or '' when unset
     */
    private function api_base()
    {
        $base = trim((string) $this->setting('api_base', 'CALENDAR_API_BASE', ''));

        if ($base === '') {
            return '';
        }

        $base = rtrim($base, '/');

        // REFUSE a non-TLS base. The shared secret rides in an Authorization
        // header on every one of these calls, and it is a long-lived bearer
        // credential with no expiry — one `http://` typo in
        // /opt/circuits-mail/.env would put it in clear text on the wire
        // between two boxes, permanently and silently. Loopback is allowed so
        // a developer can point at a local API without inventing a
        // certificate; nothing else is.
        $scheme = strtolower((string) parse_url($base, PHP_URL_SCHEME));
        $host   = strtolower((string) parse_url($base, PHP_URL_HOST));
        $is_loopback = in_array($host, array('localhost', '127.0.0.1', '::1'), true);

        if ($scheme !== 'https' && !($scheme === 'http' && $is_loopback)) {
            rcube::raise_error(array(
                'code'    => 601,
                'type'    => 'php',
                'message' => 'cccalendar: refusing a non-HTTPS calendar_api_base'
                    . ' (the shared secret travels in a header on every request).'
                    . ' Scheme was: ' . ($scheme === '' ? '(none)' : $scheme),
            ), true, false);

            return '';
        }

        // Forgiving on the one thing people get wrong: both
        // https://circuitcenter.ai and https://circuitcenter.ai/api work.
        $path = (string) parse_url($base, PHP_URL_PATH);
        if (substr($path, -4) !== '/api' && $path !== '/api') {
            $base .= '/api';
        }

        return $base;
    }

    /**
     * @return string The shared secret, or '' when unset
     */
    private function api_secret()
    {
        return trim((string) $this->setting('api_secret', 'CALENDAR_API_SECRET', ''));
    }

    /**
     * One server-side call to the calendar API.
     *
     * Never throws. A transport failure, a non-2xx, or unparsable JSON all come
     * back as ok=false with a sentence a human can act on, because every caller
     * turns that into either the empty state or an error toast.
     *
     * @param string $method HTTP verb
     * @param string $path   Path below the API root, starting with '/'
     * @param array  $query  Query parameters
     * @param array|null $body JSON body for write verbs
     *
     * @return array ['ok' => bool, 'status' => int, 'data' => mixed, 'error' => string]
     */
    private function api_request($method, $path, $query = [], $body = null)
    {
        $out = ['ok' => false, 'status' => 0, 'data' => null, 'error' => ''];

        if ($problem = $this->config_problem()) {
            $out['error'] = $problem;
            return $out;
        }

        $url = $this->api_base() . $path;
        if (!empty($query)) {
            $url .= '?' . http_build_query($query);
        }

        $header_name = (string) $this->setting('auth_header', 'CALENDAR_AUTH_HEADER', 'Authorization');
        // Substituted, not sprintf()'d: a config-supplied format string with a
        // stray % would raise ArgumentCountError on PHP 8, and this is the one
        // code path that must never throw where the caller cannot see it.
        $header_fmt  = (string) $this->setting('auth_format', 'CALENDAR_AUTH_FORMAT', 'Bearer %s');

        $options = [
            'timeout'         => (float) $this->setting('timeout', 'CALENDAR_API_TIMEOUT', 8),
            'connect_timeout' => (float) $this->setting('connect_timeout', 'CALENDAR_API_CONNECT_TIMEOUT', 4),
            'http_errors'     => false,
            'verify'          => (bool) $this->setting('verify_tls', 'CALENDAR_API_VERIFY_TLS', true),
            'headers'         => [
                $header_name => str_replace('%s', $this->api_secret(), $header_fmt),
                'Accept'     => 'application/json',
                'User-Agent' => 'cccalendar (Roundcube plugin)',
                // Who is acting, so the API can attribute the event. The API
                // reads this ONLY after the shared secret above has matched,
                // so it is attribution from a trusted server rather than a
                // claim from a browser. Without it every event the webmail
                // creates is written with a null author.
                'X-Calendar-Actor' => (string) $this->rc->get_user_name(),
            ],
        ];

        if ($body !== null) {
            $options['json'] = $body;
        }

        // Reading the response is inside the try as well: a truncated body is a
        // stream error, not a transport error, and this method's whole contract
        // is that it hands the caller a sentence instead of an exception.
        try {
            $client        = $this->rc->get_http_client();
            $response      = $client->request($method, $url, $options);
            $out['status'] = (int) $response->getStatusCode();
            $raw           = (string) $response->getBody();
        }
        catch (Throwable $e) {
            // The message can carry the URL but never the secret: it lives in a
            // header, and Guzzle does not put headers in exception messages.
            rcube::raise_error([
                    'code' => 600, 'file' => __FILE__, 'line' => __LINE__,
                    'message' => 'cccalendar: request to the calendar API failed: ' . $e->getMessage(),
                ], true, false
            );

            $out['error'] = $this->gettext('errunreachable');
            return $out;
        }

        if ($out['status'] < 200 || $out['status'] >= 300) {
            $out['error'] = $this->api_error_text($out['status'], $raw);
            return $out;
        }

        if ($raw === '' || $out['status'] === 204) {
            $out['ok']   = true;
            $out['data'] = [];
            return $out;
        }

        $data = json_decode($raw, true);

        if (json_last_error() !== JSON_ERROR_NONE) {
            $out['error'] = $this->gettext('errbadresponse');
            return $out;
        }

        $out['ok']   = true;
        $out['data'] = $data;

        return $out;
    }

    /**
     * Turn a non-2xx into something worth reading.
     *
     * The API's own `detail` string is surfaced when there is one - that is how
     * a validation message reaches the person who typed the bad value - but only
     * when it IS a string: FastAPI's 422 detail is an array of error objects and
     * printing that at a user is noise.
     *
     * @param int    $status HTTP status
     * @param string $raw    Response body
     *
     * @return string
     */
    private function api_error_text($status, $raw)
    {
        $detail = null;
        $data   = json_decode($raw, true);

        if (is_array($data) && isset($data['detail']) && is_string($data['detail'])) {
            $detail = trim($data['detail']);
        }

        if ($detail !== null && $detail !== '') {
            return $detail;
        }

        if ($status === 401 || $status === 403) {
            return $this->gettext('errrejected');
        }
        if ($status === 404) {
            return $this->gettext('errnotfound');
        }

        return $this->gettext('errhttp') . ' (' . $status . ')';
    }

    // ---------------------------------------------------------------------
    // Small helpers
    // ---------------------------------------------------------------------

    /**
     * Read a plugin setting: Roundcube config first, then the process
     * environment.
     *
     * The environment is the channel that actually carries the secret in this
     * deployment - the plugin directory is bind-mounted read-only from the git
     * checkout, so a config.inc.php cannot be dropped inside it on the box, and
     * docker-compose passes the values through from /opt/circuits-mail/.env.
     *
     * @param string $key     Suffix of the cccalendar_* config key
     * @param string $env     Environment variable name
     * @param mixed  $default Value when neither is set
     *
     * @return mixed
     */
    private function setting($key, $env, $default = null)
    {
        $value = $this->rc->config->get('cccalendar_' . $key, null);

        if ($value === null || $value === '') {
            $from_env = getenv($env);
            if ($from_env !== false && $from_env !== '') {
                $value = $from_env;
            }
        }

        if ($value === null || $value === '') {
            return $default;
        }

        // Env values are strings; make the booleans behave.
        if (is_bool($default) && is_string($value)) {
            return !in_array(strtolower($value), ['0', 'false', 'no', 'off'], true);
        }

        return $value;
    }

    /**
     * The user's timezone, resolved the way Roundcube itself does it.
     *
     * @return DateTimeZone
     */
    private function timezone()
    {
        if ($this->tz instanceof DateTimeZone) {
            return $this->tz;
        }

        $name = $this->rc->config->get('timezone');

        if ($name === 'auto') {
            $name = isset($_SESSION['timezone']) ? $_SESSION['timezone'] : null;
        }

        try {
            $this->tz = new DateTimeZone($name ?: 'UTC');
        }
        catch (Exception $e) {
            $this->tz = new DateTimeZone('UTC');
        }

        return $this->tz;
    }

    /**
     * Which month to draw. `_date=YYYY-MM`, defaulting to the current one.
     *
     * @param DateTimeZone $tz The user's timezone
     *
     * @return DateTime First day of that month at local midnight
     */
    private function requested_month(DateTimeZone $tz)
    {
        $key = $this->clean_month((string) rcube_utils::get_input_value('_date', rcube_utils::INPUT_GPC));

        if ($key === '') {
            $now = new DateTime('now', $tz);
            $key = $now->format('Y-m');
        }

        $month = DateTime::createFromFormat('!Y-m-d', $key . '-01', $tz);

        if (!$month) {
            $month = new DateTime('now', $tz);
            $month->setDate((int) $month->format('Y'), (int) $month->format('n'), 1);
            $month->setTime(0, 0, 0);
        }

        return $month;
    }

    /**
     * @param string $value Untrusted month string
     *
     * @return string 'YYYY-MM' or ''
     */
    private function clean_month($value)
    {
        $value = trim($value);

        if (!preg_match('/^(\d{4})-(\d{2})$/', $value, $m)) {
            return '';
        }
        if ((int) $m[2] < 1 || (int) $m[2] > 12) {
            return '';
        }
        if ((int) $m[1] < 1970 || (int) $m[1] > 2999) {
            return '';
        }

        return $value;
    }

    /**
     * Parse a local date + time pair from the dialog.
     *
     * @param string       $date 'YYYY-MM-DD'
     * @param string       $time 'HH:MM'
     * @param DateTimeZone $tz   The user's timezone
     *
     * @return DateTime|null
     */
    private function parse_local($date, $time, DateTimeZone $tz)
    {
        $date = trim((string) $date);
        $time = trim((string) $time);

        if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) {
            return null;
        }
        if ($time === '') {
            $time = '00:00';
        }
        if (preg_match('/^(\d{2}:\d{2}):\d{2}$/', $time, $m)) {
            $time = $m[1];
        }
        if (!preg_match('/^\d{2}:\d{2}$/', $time)) {
            return null;
        }

        $dt = DateTime::createFromFormat('!Y-m-d H:i', $date . ' ' . $time, $tz);

        return $dt ?: null;
    }

    /**
     * Parse an ISO-8601 timestamp from the API into the user's timezone.
     *
     * @param mixed        $value Raw value from the API
     * @param DateTimeZone $tz    The user's timezone
     *
     * @return DateTime|null
     */
    private function parse_api_date($value, DateTimeZone $tz)
    {
        if (!is_string($value) || trim($value) === '') {
            return null;
        }

        try {
            // A timestamp with no offset is read as UTC, which is what a naive
            // TIMESTAMPTZ serialisation means in practice.
            $dt = new DateTime($value, new DateTimeZone('UTC'));
        }
        catch (Exception $e) {
            return null;
        }

        return $dt->setTimezone($tz);
    }

    /**
     * "August 2026", localised through Roundcube's own month labels.
     *
     * @param DateTime $date Any date in the month
     *
     * @return string
     */
    private function month_label(DateTime $date)
    {
        $names = ['longjan', 'longfeb', 'longmar', 'longapr', 'longmay', 'longjun',
                  'longjul', 'longaug', 'longsep', 'longoct', 'longnov', 'longdec'];

        $name = $this->rc->gettext($names[(int) $date->format('n') - 1]);

        return $name . ' ' . $date->format('Y');
    }

    /**
     * "Tuesday, 4 August 2026" - for aria-labels and the dialog heading.
     *
     * @param DateTime $date The day
     *
     * @return string
     */
    private function long_date_label(DateTime $date)
    {
        $days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
        $mons = ['longjan', 'longfeb', 'longmar', 'longapr', 'longmay', 'longjun',
                 'longjul', 'longaug', 'longsep', 'longoct', 'longnov', 'longdec'];

        return $this->rc->gettext($days[(int) $date->format('w')])
             . ', ' . $date->format('j')
             . ' ' . $this->rc->gettext($mons[(int) $date->format('n') - 1])
             . ' ' . $date->format('Y');
    }

    /**
     * Short weekday headers, rotated to the configured first day of the week.
     *
     * @param int $first_weekday 0 = Sunday
     *
     * @return string[]
     */
    private function weekday_labels($first_weekday)
    {
        $keys   = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
        $labels = [];

        for ($i = 0; $i < 7; $i++) {
            $labels[] = $this->rc->gettext($keys[($first_weekday + $i) % 7]);
        }

        return $labels;
    }

    /**
     * Coerce one API field to a string, and refuse anything that is not scalar.
     *
     * `(string) $array` is a warning plus the word "Array" on the page, and the
     * shape of a JSON field is not this plugin's to guarantee.
     *
     * @param mixed $value Raw value from the API
     *
     * @return string
     */
    private static function str_field($value)
    {
        return is_scalar($value) ? (string) $value : '';
    }

    /**
     * Accept only a URL that will be safe as an href, and return it verbatim.
     *
     * The mirror of the site's `safeHttpUrl` (frontend/src/shared/utils/url.ts),
     * and deliberately the same shape: prepend a scheme ONLY when there is none,
     * then require the result to be http(s) with a host. A value that already
     * carries a scheme keeps it - which is exactly why `javascript:`, `data:`
     * and `vbscript:` fall out here rather than being silently "fixed" into
     * something that runs.
     *
     * @param mixed $url Untrusted URL text
     *
     * @return string The safe URL, or '' when it is not one
     */
    public static function safe_http_url($url)
    {
        if (!is_string($url)) {
            return '';
        }

        $url = trim($url);

        if ($url === '') {
            return '';
        }

        // Whitespace and control characters inside a URL are how scheme filters
        // get walked past ("java\nscript:"). Nothing legitimate needs them.
        if (preg_match('/[\x00-\x20\x7F]/', $url)) {
            return '';
        }

        if (strpos($url, '//') === 0) {
            $url = 'https:' . $url;
        }
        else if (!preg_match('~^[a-z][a-z0-9+.\-]*:~i', $url)) {
            $url = 'https://' . $url;
        }

        if (!preg_match('~^https?://~i', $url)) {
            return '';
        }

        $parts = @parse_url($url);

        if (!is_array($parts) || empty($parts['host'])) {
            return '';
        }

        return $url;
    }
}
