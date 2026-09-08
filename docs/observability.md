# Knowing what the service is doing

Three things report, and they answer different questions.

| | Answers | Where |
| --- | --- | --- |
| `/health` | Is it up, and can it reach Postgres, the object store and Redis? | `GET /health`, public |
| Request log | What happened to *this* request? | stdout, one JSON object per line |
| Metrics | What is happening to *all* of them, and has it changed? | `GET /v1/metrics`, token required |
| Error report | Which exception is this, and how often? | `GET /v1/errors`, token required |

The health endpoint answers one question and the log answers questions you
already know to ask. Neither tells you that the 99th percentile has been
climbing all week, or that capture from every machine stopped three hours ago —
which is the failure this product cannot survive, because everything already
archived still reads perfectly while it is happening.

## Scraping

Metrics exist only while `MEMOAR_METRICS_TOKEN` is set, and always require it:

```sh
curl -H "Authorization: Bearer $MEMOAR_METRICS_TOKEN" http://localhost:4000/v1/metrics
```

Unset, the endpoint returns 404 rather than 403. An endpoint that answers
differently when it is unconfigured tells a stranger it is there and waiting for
a secret. There is no `NODE_ENV` branch anywhere in this: the last thing that
decided its own security from the absence of an environment variable was the
authentication guard, and it was wrong for exactly that reason.

The worker is not a web server. It does the slow, failure-prone half of the
product — parsing, conversion, the retention sweep — and reported nothing at all
until now, so it listens on `MEMOAR_WORKER_METRICS_PORT` (9464) for scrapes and
nothing else, behind the same token.

```yaml
scrape_configs:
  - job_name: memoar-api
    authorization: { credentials: "<MEMOAR_METRICS_TOKEN>" }
    metrics_path: /v1/metrics
    static_configs: [{ targets: ["api:4000"] }]
  - job_name: memoar-worker
    authorization: { credentials: "<MEMOAR_METRICS_TOKEN>" }
    static_configs: [{ targets: ["worker:9464"] }]

rule_files:
  - /etc/prometheus/alerts.yml   # deploy/alerts.yml
```

The job names matter: `MemoarApiDown` and `MemoarWorkerDown` are written against
`up{job="memoar-api"}` and `up{job="memoar-worker"}`.

## What is measured

| Metric | Why it is here |
| --- | --- |
| `memoar_http_requests_total` | Error rate and traffic, by route pattern and status |
| `memoar_http_request_duration_seconds` | Latency distribution; buckets run to 10s because export and ingest are not sub-second |
| `memoar_ingest_artifacts_total` | Capture arriving, split `stored` / `duplicate` |
| `memoar_ingest_bytes_total` | How much raw transcript is being accepted |
| `memoar_sessions_archived_total` | Sessions written, by the tool they came from |
| `memoar_jobs_total`, `memoar_job_duration_seconds` | Background work, by kind and outcome |
| `memoar_queue_depth` | Whether the queue is draining, read from the queue at scrape time |
| `memoar_auth_failures_total` | Rejected credentials, by why |
| `memoar_rate_limit_rejections_total` | Requests a limit refused, split `flood` / `credential` |
| `memoar_nodejs_*`, `memoar_process_*` | Heap, event-loop lag, GC — why everything is slow at once |

Two rules hold across all of them.

**No tenant labels.** A metric labelled by tenant grows a new time series per
customer, which is how a metrics store is brought down by the service it
watches. It also puts who-uses-what into a system that is scraped, stored and
shared far more freely than the archive is. Per-tenant questions belong to the
archive, which has row-level security; metrics answer questions about the
service. A test asserts no tenant id appears in the exposition.

**Route patterns, never paths.** `/v1/sessions/:sessionId` is one series. The
path it was reached by is one series per session — an unbounded label set.

`memoar_queue_depth` is read from the queue when someone scrapes, rather than
kept in step by hand. The queue is shared by the API and every worker, so no one
process knows what is in it; a local tally would drift the first time a job was
retried, and a drifting queue-depth graph is worse than none — it gets trusted
for months before anybody notices it is wrong.

## Alerts

`deploy/alerts.yml`. Five of them page, and only for failures that lose or hide
data: the API down, the worker down, more than 5% of requests failing, capture
stopped for three hours, and the queue not draining for thirty minutes.
Everything else — slow reads, failing jobs, credential guessing, event-loop lag
— is a warning, because a pager that fires for slow queries at three in the
morning is a pager people turn off.

`server/test/alerts.test.ts` checks that every metric the rules mention is one
this service actually exposes. The failure that guards against: a metric gets
renamed, the dashboards get fixed because somebody is looking at them, and the
alert that was meant to notice capture stopping quietly stops evaluating. An
alert on a metric that does not exist never fires and never complains.

## Errors, grouped

`GET /v1/errors`, behind the same operator token:

```json
{
  "groups": [
    {
      "id": "8835f21be743036e",
      "type": "QueryFailedError",
      "shape": "invalid input syntax for type uuid: \"?\"",
      "origin": "postgres-archive-store.js:214",
      "count": 47,
      "firstSeen": "2026-09-08T06:12:04.001Z",
      "lastSeen": "2026-09-08T08:55:41.882Z",
      "lastRequestId": "0f3a…",
      "lastRoute": "/v1/sessions/:sessionId"
    }
  ],
  "distinct": 3,
  "dropped": 0
}
```

This answers the question neither of the others could: *which* exception is
this, and how often. The metric counts failures by class, which says something
is wrong but not what; the log has every detail and no grouping, so finding out
meant grepping a container. The fingerprint is in the log line too, so a group
here leads straight to its full occurrences with stacks.

**No message is ever stored as it was written.** Error messages quote their
input, and the input is somebody's transcript — a real one from this archive
read `invalid input syntax for type uuid: "0191cafe-…-take0e"`, a value out of a
captured session, sitting in a string an operator would paste into a chat
window. Quoted literals, uuids, hashes, paths and numbers are replaced before
anything is kept, so what is stored is the shape of a failure rather than its
data. A test asserts a private value cannot come back out of this endpoint.

Two more properties worth knowing. It is in memory and per process: writing
failures to the archive would put database writes on the failure path, which is
the one moment the database may be the thing that is broken. And it is capped at
200 distinct groups, reporting what it dropped, because a fingerprint comes from
a message and an unbounded one would grow fastest during the incident it exists
to explain.

## What is not here yet

Nothing keeps this across a restart, so the error list answers "what has been
failing recently" rather than "what happened last Tuesday" — the log lines,
carrying the same fingerprints, are what reach further back. Shipping them
somewhere durable is a decision about where this runs and what may leave the
machine, which is not settled.

Dashboards are deliberately absent for the same reason: a dashboard checked into
a repository that nobody opens is worse than none.
