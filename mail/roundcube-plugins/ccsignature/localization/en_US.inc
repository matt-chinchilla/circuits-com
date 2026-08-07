<?php

/**
 * ccsignature — English (US).
 *
 * Written from the reader's side of the screen. Nothing here names a hook, a
 * preference key, a container path or an exception: an error tells the person
 * what happened and what to do about it, and the operator-facing detail goes to
 * the Roundcube error log where it belongs.
 */

$labels = [];

$labels['sectiontitle']     = 'Signature details';
$labels['usesignature']     = 'Circuit Center signature';
$labels['usesignaturehint'] = 'Build my signature from the details below';

$labels['jobtitle'] = 'Job title';
$labels['phone']    = 'Phone';
$labels['website']  = 'Website';
$labels['links']    = 'Links';
$labels['headshot'] = 'Photo';

$labels['placeholdertitle']   = 'Head of Sales';
$labels['placeholderphone']   = '(631) 555-0142';
$labels['placeholderwebsite'] = 'circuitcenter.ai';

$labels['nolink'] = 'None';

$labels['nophoto']       = 'No photo';
$labels['choosephoto']   = 'Choose photo';
$labels['removephoto']   = 'Remove';
$labels['headshothint']  = 'JPEG, PNG or WebP. It will be cropped to a square.';
$labels['headshotlater'] = 'Save this identity first, then come back to add a photo.';

$labels['uploading']    = 'Uploading photo...';
$labels['photoready']   = 'Photo ready. Save to apply it.';
$labels['photocleared'] = 'Photo removed. Save to apply it.';

$labels['unavailable']     = 'Unavailable';
$labels['unavailablebody'] = 'Signature details cannot be edited right now because part of the signature software is missing. Mail is unaffected. Ask an administrator to check these files:';

$messages = [];

$messages['errrequest']      = 'That request expired. Reload the page and try again.';
$messages['errnoidentity']   = 'Save this identity first, then add a photo.';
$messages['errnofile']       = 'No photo was received. Try choosing the file again.';
$messages['errtoobig']       = 'That photo is too large. Please choose one under 8 MB.';
$messages['errtoolarge']     = 'That photo has too many pixels to process. A normal phone or camera photo will work.';
$messages['errnotimage']     = 'That file is not a JPEG, PNG or WebP image.';
$messages['errnostorage']    = 'Photos cannot be saved right now. Mail is unaffected; please tell an administrator.';
$messages['erruploadfailed'] = 'The photo could not be processed. Try a different one.';
