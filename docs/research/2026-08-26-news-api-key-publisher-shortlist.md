# News API / publisher shortlist for #950

**Date:** 2026-08-26  
**Scope:** Documentation-only investigation using first-party provider pages. “Pass” means the provider documents an official access path, a fixed HTTP header for the key, a stable bounded endpoint, and headline/article metadata that can be reduced to `NewsHeadline`. This is a technical shortlist, not a legal/terms determination.

## Recommendation at a glance

| Candidate | Provider type | Header-key evidence | Bounded validation endpoint / metadata | Result |
|---|---|---|---|---|
| **NewsAPI** | Aggregator of many news sources | `X-Api-Key` or `Authorization` are documented: [authentication](https://newsapi.org/docs/authentication) | `GET https://newsapi.org/v2/top-headlines`; docs describe live top/breaking headlines and document `title`, `description`, `url`, `publishedAt`: [endpoint](https://newsapi.org/docs/endpoints/top-headlines) | **Strong candidate** |
| **Currents API** | Aggregator/global news provider | First-party OpenAPI declares `ApiKeyAuth`, `name: Authorization`, `in: header`: [official OpenAPI](https://currentsapi.services/json/swagger.json) | `GET https://api.currentsapi.services/v1/latest-news` (OpenAPI `host` + `/v1` base path + `/latest-news`); response example has `title`, `description`, `url`, `published`, `author`: [docs](https://currentsapi.services/en/docs/) / [OpenAPI](https://currentsapi.services/json/swagger.json) | **Strong candidate; smoke-test before registry** |
| **World News API** | Aggregator of thousands of sources | `x-api-key` request header explicitly documented (query string also supported): [authentication](https://worldnewsapi.com/docs/authentication/) | `GET https://api.worldnewsapi.com/search-news`; docs say results are news articles and show `title`/`url`: [search endpoint](https://worldnewsapi.com/docs/search-news/) | **Strong candidate** |
| **GNews** | Aggregator; docs say articles are selected using Google News ranking | `X-Api-Key` documented: [authentication](https://docs.gnews.io/authentication) | `GET https://gnews.io/api/v4/top-headlines`; docs bound `max` to 1–100, expose `title`, `description`, and pagination: [endpoint](https://docs.gnews.io/endpoints/top-headlines-endpoint) | **Strong candidate** |
| **The Guardian Open Platform** | **Specific publisher connection** (Guardian content) | **No header-key method verified.** Official docs show `api-key` in the query string in examples and describe it as a query parameter: [content docs](https://open-platform.theguardian.com/documentation/), [content search reference](https://open-platform.theguardian.com/documentation/md/content_search.md) | `GET https://content.guardianapis.com/search`; results include `webTitle`, `webUrl`, `apiUrl`: [content search reference](https://open-platform.theguardian.com/documentation/md/content_search.md) | **Does not meet #950 v1 header-only gate; public RSS/API may be a later non-key or separate reviewed path** |
| **New York Times APIs** | **Specific publisher connection** (NYT content) | **Unverified for a fixed HTTP-header key.** The official developer documentation is an SPA and the official route documentation identifies the API-key credential, but no header transport was verifiable from the rendered docs available here. Do not assume one: [Article Search overview](https://developer.nytimes.com/docs/articlesearch-product/1/overview), [Article Search route](https://developer.nytimes.com/docs/articlesearch-product/1/routes/articlesearch.json) | Official route is `GET https://api.nytimes.com/svc/search/v2/articlesearch.json`; suitability/fields should be rechecked in the live NYT developer console before implementation | **Unverified; exclude until header auth and bounded metadata are confirmed** |

## Evidence and limitations

### NewsAPI — aggregator, pass

- Official authentication documentation lists three options, including `X-Api-Key` and `Authorization` HTTP headers; implementation can choose the fixed `X-Api-Key` header and never put the secret in a URL: [https://newsapi.org/docs/authentication](https://newsapi.org/docs/authentication).
- The top-headlines page identifies `/v2/top-headlines`, says it supplies live top/breaking headlines, and describes fields including `title`, `description`, `url`, and `publishedAt`: [https://newsapi.org/docs/endpoints/top-headlines](https://newsapi.org/docs/endpoints/top-headlines).
- Development limitation: the authentication page says keys are free while in development. The provider’s plan/usage terms and production availability should be checked before shipping; this report makes no legal conclusion.
- This is an aggregator/provider connection, not proof that Jarv1s has a direct contractual connection to each publisher represented in its results. A source filter can narrow results, but the provider remains the upstream service.

### Currents API — aggregator, pass subject to endpoint smoke test

- The provider’s official OpenAPI declares API-key security as `Authorization` in the HTTP header (`type: apiKey`, `in: header`) and applies header security to `/latest-news`: [https://currentsapi.services/json/swagger.json](https://currentsapi.services/json/swagger.json).
- The `/latest-news` response example includes `title`, `description`, `url`, `author`, and `published`; the docs landing page identifies the JSON API and links the OpenAPI document: [https://currentsapi.services/en/docs/](https://currentsapi.services/en/docs/).
- The OpenAPI currently declares host `api.currentsapi.services`, HTTPS, base path `/v1`, and path `/latest-news`; still smoke-test with a bounded invalid-key request before adding a reviewed connection declaration.
- The OpenAPI documents `401 Unauthorized` and `429 Token limit reached` responses. Plan/free-tier quota and current commercial terms need provider confirmation before production use; no legal conclusion is made here.

### World News API — aggregator, pass

- Official authentication docs explicitly allow the key in `x-api-key` request headers and recommend the header method for production; they also document a query-string alternative that Jarv1s should not use: [https://worldnewsapi.com/docs/authentication/](https://worldnewsapi.com/docs/authentication/).
- The provider describes itself as an aggregation API covering thousands of sources, and the search endpoint is a fixed `GET https://api.worldnewsapi.com/search-news`. Its documented result includes article `title` and `url`, with filtering and source limits: [https://worldnewsapi.com/docs/search-news/](https://worldnewsapi.com/docs/search-news/).
- Free-tier limitation: the authentication documentation says the free key requires no credit card and includes 50 daily points; rate-limit docs say the free tier allows 60 requests/minute and one concurrent request: [authentication](https://worldnewsapi.com/docs/authentication/), [quotas](https://worldnewsapi.com/docs/quotas-and-rate-limiting/).
- This is a provider aggregation connection, not a direct publisher connection. The documented search endpoint can be bounded with a narrow query/source filter and one result page.

### GNews — aggregator, pass

- Official authentication docs document both query-string `apikey` and the `X-Api-Key` header; use only the header for #950: [https://docs.gnews.io/authentication](https://docs.gnews.io/authentication).
- The top-headlines endpoint is fixed at `https://gnews.io/api/v4/top-headlines`; its docs state that it returns current trending articles, cap `max` at 100, and show `title` and `description` fields: [https://docs.gnews.io/endpoints/top-headlines-endpoint](https://docs.gnews.io/endpoints/top-headlines-endpoint).
- Free-plan limitation: the endpoint docs state that `content` is automatically truncated for free users; the endpoint also limits pagination to 1,000 articles. These are operational/product limitations, not a legal assessment.
- The docs describe ranking from Google News and broad source coverage, so this is an aggregator/provider connection rather than a specific publisher connection.

### The Guardian — specific publisher, fail for v1 header-only auth

- Guardian’s official access page says an API key is required and distinguishes a free developer key for non-commercial use from a commercial key request: [https://open-platform.theguardian.com/access](https://open-platform.theguardian.com/access).
- The official documentation’s examples append `api-key=test` to the URL, and its common parameter table describes `api-key` as a query parameter: [https://open-platform.theguardian.com/documentation/md/index.md](https://open-platform.theguardian.com/documentation/md/index.md), [https://open-platform.theguardian.com/documentation/md/common.md](https://open-platform.theguardian.com/documentation/md/common.md). No fixed HTTP-header key placement was verified.
- The content search endpoint is stable and metadata-rich (`webTitle`, `webUrl`, `apiUrl`): [https://open-platform.theguardian.com/documentation/md/content_search.md](https://open-platform.theguardian.com/documentation/md/content_search.md).
- The docs warn that keys are rate-limited and polling-heavy applications can exceed the daily quota. Access category and terms must be confirmed for Jarv1s’ deployment; this report does not give a legal conclusion: [https://open-platform.theguardian.com/access](https://open-platform.theguardian.com/access), [https://www.theguardian.com/open-platform/terms-and-conditions](https://www.theguardian.com/open-platform/terms-and-conditions).

### New York Times — specific publisher, unverified / do not shortlist yet

- The official NYT developer portal provides Article Search API documentation and the route documentation: [https://developer.nytimes.com/docs/articlesearch-product/1/overview](https://developer.nytimes.com/docs/articlesearch-product/1/overview), [https://developer.nytimes.com/docs/articlesearch-product/1/routes/articlesearch.json](https://developer.nytimes.com/docs/articlesearch-product/1/routes/articlesearch.json).
- The portal was not exposing stable rendered auth/response details in this investigation, and I could not verify from first-party documentation that the key can be sent in a fixed HTTP header rather than the commonly shown `api-key` query parameter. Per the requested rule, this is **unverified**, not a claim that header auth is impossible.
- A NYT website subscription, password, cookie, or authenticated page session is not evidence of an API-key connection and is outside #950’s v1 scope. Confirm API credential transport, rate/development limits, and fields such as headline/web URL in the live official portal before reconsidering it.

## Implementation shortlist

For an initial reviewed connection set, prioritize **NewsAPI**, **World News API**, and **GNews**; add **Currents** after the endpoint-host smoke test. Treat all four as aggregator connections and preserve the upstream provider/source attribution in `NewsHeadline`. Do not add Guardian or NYT to the header-only v1 registry until their official documentation verifies the required header transport.
