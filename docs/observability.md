# Knowing what the service is doing

Three things report, and they answer different questions.

| | Answers | Where |
| --- | --- | --- |
| `/health` | Is it up, and can it reach Postgres, the object store and Redis? | `GET /health`, public |
| Request log | What happened to *this* request? | stdout, one JSON object per line |
| Metrics | What is happening to *all* of them, and has it changed? | `GET /v1/metrics`, token required |

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

## What is not here yet

Errors are logged as structured lines and are not aggregated anywhere, so
"which exception is this, and how often has it happened?" still means grepping
container logs. That is the next piece.

Dashboards are deliberately absent: they depend on where this runs, which is not
settled, and a dashboard checked into a repository that nobody opens is worse
than none.
