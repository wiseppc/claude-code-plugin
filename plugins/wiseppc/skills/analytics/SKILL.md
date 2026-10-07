---
name: analytics
description: Analyze WisePPC business data using live capability and dataset discovery.
---

Discover current server capabilities, accessible business profiles/accounts and available datasets before choosing tools or fields. Follow current server instructions and schemas rather than assuming a fixed operation catalog. Pick a `profileId` first (`list_profiles`, `select_business_profile`), then call `get_session_context` once at session start for preferences, account guidance and the credential's grants (`key_grants`); refresh preferences with `list_preferences` and do not repeat the primer mid-session. Use authorized read operations for schema discovery and analysis: prefer `query` with `describe_dataset`, and use `run_query` (raw SQL, an ordinary read under Amazon Ads read access) only for what `query` cannot express.

Confirm the seller/marketplace, date range, time zone and reporting grain from the request and available data. State freshness and metric definitions when they affect the answer. Ground conclusions in retrieved data, identify incomplete scope, and avoid comparing incompatible periods or grains. No data observation authorizes a business mutation. If an account or dataset is denied, report the scope limitation without requesting broader privileges automatically.
