"""Scheduled jobs run outside the request path.

Each module here is executable with ``python -m app.jobs.<name>`` and is invoked
by cron on the API box, e.g.::

    docker compose exec -T api python -m app.jobs.send_reminders < /dev/null

``-T`` and the ``< /dev/null`` redirect are BOTH load-bearing: ``docker compose
exec`` consumes the stdin of a wrapping heredoc otherwise, which this repo has
already been caught by (see CLAUDE.md).
"""
