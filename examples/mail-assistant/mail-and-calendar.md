---
name: mail-and-calendar
description: Send email through the Resend API and read the calendar's ICS feed, using curl.
---

# Sending mail and reading the calendar

Both jobs go through `run_bash` with `curl`. The environment already holds
`RESEND_API_KEY` and `CALENDAR_ICS_URL` - never print them, never ask for
them, always reference them as shell variables.

## Sending an email

POST to Resend's send endpoint. `from` must be your own sending address (the
one named in your purpose); `to` is usually your operator.

```sh
curl -s https://api.resend.com/emails \
  -H "Authorization: Bearer $RESEND_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"from":"assistant@agents.example.com","to":["ratul@example.com"],"subject":"Standup in 30 minutes","text":"Starts at 09:30."}'
```

A JSON response with an `id` means it was sent. Anything else is an error;
read the message, fix the payload and try once more at most.

## Reading the calendar

`$CALENDAR_ICS_URL` returns the whole calendar in iCal format. It can be far
too large to read whole, so always filter it down with `grep` before it
reaches you. Use `current_time` first so you know today's date, then window
by date (ICS dates look like `20260707` and times are usually UTC):

```sh
curl -s "$CALENDAR_ICS_URL" \
  | grep -E '^(DTSTART|UID|SUMMARY)' \
  | grep -A2 'DTSTART.*20260707'
```

Each hit gives you an event's start time, UID and title. Two things to watch:

- Times in the feed are usually UTC (`Z` suffix) or carry a `TZID=` - convert
  to your operator's timezone before writing a reminder.
- Field order inside an event can differ between providers. If `-A2` returns
  the wrong lines, widen it (`-A4`) and pick out the fields you need.

## House conventions for memory

- `spam_list` - one key holding a comma-separated list of addresses. To add
  or remove one: `recall spam_list`, edit the list, `remember` it back.
- `reminded:<event UID>` - set (value: today's date) after you send a
  reminder for that event, so later ticks stay silent about it. Forget
  stale ones during the morning tick.
