<?php

/*
 +-----------------------------------------------------------------------+
 | Localization file for the Circuit Center shared calendar plugin       |
 |                                                                       |
 | Loaded by rcube_plugin::add_texts('localization/'), which prefixes     |
 | every key with the plugin id - so 'calendar' below is reachable as     |
 | 'cccalendar.calendar' from a template <roundcube:label>, from          |
 | $this->gettext('calendar') in PHP, and (once add_texts() is called     |
 | with $add2client = true, which action_index() does) as                 |
 | rcmail.gettext('calendar', 'cccalendar') in the browser.               |
 |                                                                       |
 | Only en_US ships. Roundcube always reads en_US first and merges the    |
 | user's language over it, so a missing translation degrades to English  |
 | rather than to a raw key.                                             |
 +-----------------------------------------------------------------------+
*/

$labels = [];

// Chrome
$labels['calendar']   = 'Calendar';
$labels['prevmonth']  = 'Previous month';
$labels['nextmonth']  = 'Next month';
$labels['today']      = 'Today';
$labels['newevent']   = 'New event';
$labels['editevent']  = 'Edit event';
$labels['allday']     = 'All day';

// Dialog fields
$labels['title']            = 'Title';
$labels['starts']           = 'Starts';
$labels['ends']             = 'Ends';
$labels['starttime']        = 'Start time';
$labels['endtime']          = 'End time';
$labels['isallday']         = 'All day';
$labels['location']         = 'Location';
$labels['meetingurl']       = 'Meeting link';
$labels['meetingurlhint']   = 'A https:// link people can click to join. Anything else is refused.';
$labels['notes']            = 'Notes';
$labels['reminders']        = 'Reminders';
$labels['remindaybefore']   = 'The day before';
$labels['remindhourbefore'] = 'An hour before';
$labels['notifyemail']      = 'Send by email';
$labels['notifysms']        = 'Send by SMS';
$labels['remindershint']    = 'Reminders go to the whole team. SMS is only sent if the API has an SMS topic configured.';

// Dialog actions
$labels['save']       = 'Save';
$labels['cancel']     = 'Cancel';
$labels['delete']     = 'Delete';
$labels['join']       = 'Join meeting';

$messages = [];

// Outcomes
$messages['eventsaved']   = 'Event saved.';
$messages['eventdeleted'] = 'Event deleted.';
$messages['confirmdelete'] = 'Delete this event? Everyone loses it, and its reminders will not be sent.';

// Validation - shown against the field the person just filled in
$messages['errnotitle']         = 'Give the event a title.';
$messages['errbaddate']         = 'That start or end time is not a real date and time.';
$messages['errendbeforestart']  = 'The event ends before it starts.';
$messages['errbadurl']          = 'The meeting link must be a http:// or https:// web address.';
$messages['errnoevent']         = 'That event no longer exists.';

// Configuration - the empty state, written so the person reading it knows
// which box and which file to go and look at.
$messages['notconfiguredhead'] = 'The calendar is not connected yet';
$messages['notconfiguredhint'] = 'Set the values in /opt/circuits-mail/.env on the mail box, then recreate the roundcube container. Until then this month is shown empty and events cannot be created.';
$messages['errnobase']         = 'CALENDAR_API_BASE is not set, so the webmail does not know where the calendar service is.';
// Distinct from errnobase on purpose: api_base() returns '' for BOTH "unset"
// and "rejected as non-TLS", and reporting the second as the first sends an
// operator hunting for a variable that is present and looks correct, while
// the real reason sits only in the Roundcube error log.
$messages['errbadbase']        = 'CALENDAR_API_BASE must be an https:// address — the shared secret travels in a request header, so a plain http:// base would put it on the wire in clear text.';
$messages['errnosecret']       = 'CALENDAR_API_SECRET is not set, so the webmail has no credential to read the calendar with.';

// Transport
$messages['unreachablehead'] = 'The calendar service did not answer';
$messages['unreachablehint'] = 'This is usually temporary. Reload in a moment; if it keeps happening, check the API container on the web box.';
$messages['errunreachable']  = 'The webmail could not reach the calendar service.';
$messages['errrejected']     = 'The calendar service refused the webmail credential. The shared secret on the two boxes does not match.';
$messages['errnotfound']     = 'The calendar service does not have that endpoint or that event.';
$messages['errbadresponse']  = 'The calendar service sent something this page could not read.';
$messages['errhttp']         = 'The calendar service returned an error.';
$messages['errsavefailed']   = 'The event could not be saved.';
