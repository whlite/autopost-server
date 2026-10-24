-- 001_core.sql - prospecting engine core schema (px_* namespace)
--
-- Purely additive. Nothing here references or alters autopost_* (billing) or
-- ap_* (Teams, alerts) tables; customers are matched by email/clerk_user_id at
-- query time. Rollback: 001_core.down.sql drops every px_* table.

-- -- Control plane -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS px_settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_by  TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS px_admins (
  clerk_user_id TEXT PRIMARY KEY,
  email         TEXT,
  added_by      TEXT,
  added_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS px_agent_status (
  agent            TEXT PRIMARY KEY,
  enabled          BOOLEAN NOT NULL DEFAULT FALSE,
  current_task     TEXT,
  last_run_at      TIMESTAMPTZ,
  last_ok_at       TIMESTAMPTZ,
  items_processed  BIGINT NOT NULL DEFAULT 0,
  errors           BIGINT NOT NULL DEFAULT 0,
  last_error       TEXT,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS px_audit (
  id           BIGSERIAL PRIMARY KEY,
  actor        TEXT NOT NULL,
  action       TEXT NOT NULL,
  target_type  TEXT,
  target_id    TEXT,
  detail       JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS px_audit_time ON px_audit (created_at DESC);

-- -- Dealerships -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS px_dealerships (
  id                    BIGSERIAL PRIMARY KEY,
  name                  TEXT NOT NULL,
  domain                TEXT,                      -- normalized registrable host, no www
  website_url           TEXT,
  inventory_url         TEXT,
  phone                 TEXT,
  street                TEXT,
  city                  TEXT,
  state                 CHAR(2),
  postcode              TEXT,
  lat                   DOUBLE PRECISION,
  lon                   DOUBLE PRECISION,
  timezone              TEXT,
  dealership_type       TEXT NOT NULL DEFAULT 'unknown'
                        CHECK (dealership_type IN ('franchise','independent','group','unknown')),
  franchise_brands      TEXT[] NOT NULL DEFAULT '{}',
  location_count        INTEGER NOT NULL DEFAULT 1,
  platform              TEXT,                      -- ddc, dealer_inspire, dealeron, ...
  platform_supported    BOOLEAN,                   -- NULL = not checked yet
  platform_checked_at   TIMESTAMPTZ,
  status                TEXT NOT NULL DEFAULT 'DISCOVERED'
                        CHECK (status IN ('DISCOVERED','RESEARCHED','QUALIFIED','DISQUALIFIED','CUSTOMER','DO_NOT_CONTACT')),
  qualification_score   INTEGER,
  disqualify_reason     TEXT,
  is_existing_customer  BOOLEAN NOT NULL DEFAULT FALSE,
  last_verified_at      TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS px_dealer_domain ON px_dealerships (domain) WHERE domain IS NOT NULL;
CREATE INDEX IF NOT EXISTS px_dealer_state_status ON px_dealerships (state, status);
CREATE INDEX IF NOT EXISTS px_dealer_research_queue ON px_dealerships (status, platform_checked_at) WHERE status = 'DISCOVERED';

CREATE TABLE IF NOT EXISTS px_dealership_sources (
  id                BIGSERIAL PRIMARY KEY,
  dealership_id     BIGINT NOT NULL REFERENCES px_dealerships(id) ON DELETE CASCADE,
  source            TEXT NOT NULL,                 -- overture, osm, extension, manual
  source_record_id  TEXT NOT NULL,
  license           TEXT,
  name              TEXT,
  street            TEXT,
  city              TEXT,
  state             CHAR(2),
  postcode          TEXT,
  category          TEXT,
  fetched_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source, source_record_id)
);
CREATE INDEX IF NOT EXISTS px_dsrc_dealer ON px_dealership_sources (dealership_id);

-- -- Contacts (the lead) -----------------------------------------------------
CREATE TABLE IF NOT EXISTS px_contacts (
  id                   BIGSERIAL PRIMARY KEY,
  dealership_id        BIGINT NOT NULL REFERENCES px_dealerships(id) ON DELETE CASCADE,
  first_name           TEXT,
  last_name            TEXT,
  full_name            TEXT NOT NULL,
  title                TEXT,
  role_category        TEXT NOT NULL DEFAULT 'other'
                       CHECK (role_category IN ('salesperson','internet_sales','sales_manager','used_car_manager',
                                                'general_sales_manager','general_manager','owner','marketing','other')),
  email                TEXT,                       -- always stored lowercased
  email_status         TEXT NOT NULL DEFAULT 'none'
                       CHECK (email_status IN ('none','unverified','valid','invalid','catch_all','unknown','risky')),
  email_source         TEXT,
  email_verified_at    TIMESTAMPTZ,
  phone                TEXT,
  phone_source         TEXT,
  sms_consent          BOOLEAN NOT NULL DEFAULT FALSE,   -- a listed phone is NOT consent to text
  profile_url          TEXT,
  state                TEXT NOT NULL DEFAULT 'DISCOVERED',
  lead_score           INTEGER NOT NULL DEFAULT 0,
  score_band           TEXT NOT NULL DEFAULT 'COLD' CHECK (score_band IN ('HOT','WARM','COLD','SUPPRESSED')),
  score_evidence       JSONB NOT NULL DEFAULT '[]',
  outreach_eligible    BOOLEAN NOT NULL DEFAULT FALSE,
  eligibility_reason   TEXT,
  contact_attempts     INTEGER NOT NULL DEFAULT 0,
  last_contacted_at    TIMESTAMPTZ,
  last_interaction_at  TIMESTAMPTZ,
  owner                TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS px_contact_email ON px_contacts (email) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS px_contact_dealer_name ON px_contacts (dealership_id, LOWER(full_name));
CREATE INDEX IF NOT EXISTS px_contact_state ON px_contacts (state);
CREATE INDEX IF NOT EXISTS px_contact_band ON px_contacts (score_band, lead_score DESC);

CREATE TABLE IF NOT EXISTS px_contact_sources (
  id          BIGSERIAL PRIMARY KEY,
  contact_id  BIGINT NOT NULL REFERENCES px_contacts(id) ON DELETE CASCADE,
  source      TEXT NOT NULL,                       -- staff_page, apollo, manual, reply
  source_url  TEXT,
  evidence    TEXT,                                -- the snippet the fact came from
  fetched_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS px_csrc_contact ON px_contact_sources (contact_id);

CREATE TABLE IF NOT EXISTS px_contact_verifications (
  id          BIGSERIAL PRIMARY KEY,
  contact_id  BIGINT REFERENCES px_contacts(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  provider    TEXT NOT NULL,
  result      TEXT NOT NULL,
  sub_status  TEXT,
  cost_cents  NUMERIC(12,4) NOT NULL DEFAULT 0,
  raw         JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS px_verif_email ON px_contact_verifications (email, created_at DESC);

-- Global suppression. Checked before every enqueue AND every send (fail closed).
CREATE TABLE IF NOT EXISTS px_suppression (
  id          BIGSERIAL PRIMARY KEY,
  email       TEXT,
  domain      TEXT,
  reason      TEXT NOT NULL CHECK (reason IN ('unsubscribe','complaint','bounce','declined','customer','manual','invalid','wrong_person')),
  source      TEXT NOT NULL,
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (email IS NOT NULL OR domain IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS px_supp_email ON px_suppression (email) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS px_supp_domain ON px_suppression (domain) WHERE domain IS NOT NULL AND email IS NULL;

-- Every state change and notable fact, append-only. Feeds Live Prospecting.
CREATE TABLE IF NOT EXISTS px_events (
  id             BIGSERIAL PRIMARY KEY,
  event_type     TEXT NOT NULL,
  contact_id     BIGINT REFERENCES px_contacts(id) ON DELETE SET NULL,
  dealership_id  BIGINT REFERENCES px_dealerships(id) ON DELETE SET NULL,
  from_state     TEXT,
  to_state       TEXT,
  actor          TEXT NOT NULL,
  detail         JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS px_events_time ON px_events (created_at DESC);
CREATE INDEX IF NOT EXISTS px_events_contact ON px_events (contact_id, created_at DESC);

CREATE TABLE IF NOT EXISTS px_tasks (
  id           BIGSERIAL PRIMARY KEY,
  contact_id   BIGINT REFERENCES px_contacts(id) ON DELETE CASCADE,
  task_type    TEXT NOT NULL,
  due_at       TIMESTAMPTZ,
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','canceled')),
  notes        TEXT,
  assigned_to  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  done_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS px_tasks_open ON px_tasks (status, due_at) WHERE status = 'open';

-- -- Campaigns ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS px_campaigns (
  id                    BIGSERIAL PRIMARY KEY,
  name                  TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused','completed')),
  states                TEXT[] NOT NULL DEFAULT '{}',
  dealership_types      TEXT[] NOT NULL DEFAULT '{}',
  roles                 TEXT[] NOT NULL DEFAULT '{}',
  daily_limit           INTEGER NOT NULL DEFAULT 20,
  per_dealer_limit      INTEGER NOT NULL DEFAULT 2,
  send_days             INTEGER[] NOT NULL DEFAULT '{1,2,3,4,5}',   -- ISO weekday, 1 = Monday
  send_start_hour       INTEGER NOT NULL DEFAULT 9,
  send_end_hour         INTEGER NOT NULL DEFAULT 16,
  sender_provider       TEXT,
  provider_campaign_id  TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS px_campaign_steps (
  id           BIGSERIAL PRIMARY KEY,
  campaign_id  BIGINT NOT NULL REFERENCES px_campaigns(id) ON DELETE CASCADE,
  step_no      INTEGER NOT NULL,
  variant      TEXT NOT NULL DEFAULT 'A',
  delay_days   INTEGER NOT NULL,
  subject      TEXT NOT NULL,
  body         TEXT NOT NULL,
  approved_at  TIMESTAMPTZ,
  approved_by  TEXT,
  UNIQUE (campaign_id, step_no, variant)
);

CREATE TABLE IF NOT EXISTS px_enrollments (
  id                BIGSERIAL PRIMARY KEY,
  campaign_id       BIGINT NOT NULL REFERENCES px_campaigns(id) ON DELETE CASCADE,
  contact_id        BIGINT NOT NULL REFERENCES px_contacts(id) ON DELETE CASCADE,
  status            TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','active','paused','stopped','completed')),
  variant           TEXT NOT NULL DEFAULT 'A',
  current_step      INTEGER NOT NULL DEFAULT 0,
  next_send_at      TIMESTAMPTZ,
  stop_reason       TEXT,
  tracking_token    TEXT NOT NULL UNIQUE,
  provider_lead_id  TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- One live sequence per person, across all campaigns.
CREATE UNIQUE INDEX IF NOT EXISTS px_enroll_one_live ON px_enrollments (contact_id) WHERE status IN ('queued','active','paused');
CREATE INDEX IF NOT EXISTS px_enroll_due ON px_enrollments (status, next_send_at);

CREATE TABLE IF NOT EXISTS px_outbound_messages (
  id                   BIGSERIAL PRIMARY KEY,
  enrollment_id        BIGINT NOT NULL REFERENCES px_enrollments(id) ON DELETE CASCADE,
  contact_id           BIGINT NOT NULL REFERENCES px_contacts(id) ON DELETE CASCADE,
  step_no              INTEGER NOT NULL,
  variant              TEXT NOT NULL DEFAULT 'A',
  provider             TEXT,
  provider_message_id  TEXT,
  subject              TEXT,
  status               TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','delivered','bounced','failed','canceled')),
  error                TEXT,
  sent_at              TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (enrollment_id, step_no)
);
CREATE UNIQUE INDEX IF NOT EXISTS px_out_provider_id ON px_outbound_messages (provider, provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS px_out_sent ON px_outbound_messages (sent_at DESC);

-- -- Conversations -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS px_threads (
  id                 BIGSERIAL PRIMARY KEY,
  contact_id         BIGINT NOT NULL REFERENCES px_contacts(id) ON DELETE CASCADE,
  enrollment_id      BIGINT REFERENCES px_enrollments(id) ON DELETE SET NULL,
  subject            TEXT,
  status             TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','needs_reply','waiting','closed')),
  intent             TEXT,
  intent_confidence  NUMERIC(4,3),
  summary            TEXT,
  requested_action   TEXT,
  ai_draft           TEXT,
  draft_status       TEXT CHECK (draft_status IN ('none','pending_review','approved','sent','discarded')),
  last_message_at    TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS px_threads_contact ON px_threads (contact_id);
CREATE INDEX IF NOT EXISTS px_threads_status ON px_threads (status, last_message_at DESC);

CREATE TABLE IF NOT EXISTS px_inbound_messages (
  id                   BIGSERIAL PRIMARY KEY,
  thread_id            BIGINT REFERENCES px_threads(id) ON DELETE CASCADE,
  contact_id           BIGINT REFERENCES px_contacts(id) ON DELETE SET NULL,
  provider             TEXT NOT NULL,
  provider_message_id  TEXT NOT NULL,
  from_email           TEXT,
  subject              TEXT,
  body_text            TEXT,
  received_at          TIMESTAMPTZ NOT NULL,
  intent               TEXT,
  classification       JSONB,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, provider_message_id)
);

-- Replay protection for every inbound webhook / polled event.
CREATE TABLE IF NOT EXISTS px_provider_events (
  provider     TEXT NOT NULL,
  event_id     TEXT NOT NULL,
  event_type   TEXT,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (provider, event_id)
);

CREATE TABLE IF NOT EXISTS px_notifications (
  id          BIGSERIAL PRIMARY KEY,
  contact_id  BIGINT REFERENCES px_contacts(id) ON DELETE SET NULL,
  channel     TEXT NOT NULL,
  kind        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','skipped')),
  payload     JSONB,
  error       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at     TIMESTAMPTZ
);

-- -- Jobs, costs, attribution ------------------------------------------------
CREATE TABLE IF NOT EXISTS px_jobs (
  id               BIGSERIAL PRIMARY KEY,
  job_type         TEXT NOT NULL,
  payload          JSONB NOT NULL DEFAULT '{}',
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed','dead','canceled')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  max_attempts     INTEGER NOT NULL DEFAULT 5,
  run_after        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_at        TIMESTAMPTZ,
  locked_by        TEXT,
  last_error       TEXT,
  idempotency_key  TEXT UNIQUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS px_jobs_ready ON px_jobs (status, run_after) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS px_job_runs (
  id           BIGSERIAL PRIMARY KEY,
  job_id       BIGINT REFERENCES px_jobs(id) ON DELETE SET NULL,
  agent        TEXT NOT NULL,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at  TIMESTAMPTZ,
  ok           BOOLEAN,
  items        INTEGER NOT NULL DEFAULT 0,
  error        TEXT
);
CREATE INDEX IF NOT EXISTS px_runs_agent ON px_job_runs (agent, started_at DESC);

-- Every paid unit we consume. Budgets are enforced against this table.
CREATE TABLE IF NOT EXISTS px_costs (
  id          BIGSERIAL PRIMARY KEY,
  provider    TEXT NOT NULL,
  category    TEXT NOT NULL CHECK (category IN ('ai','enrichment','verification','email_platform','mailbox','domain','data','infra','other')),
  units       NUMERIC(14,4) NOT NULL DEFAULT 0,
  unit        TEXT,
  cost_cents  NUMERIC(12,4) NOT NULL,
  recurring   BOOLEAN NOT NULL DEFAULT FALSE,
  ref_type    TEXT,
  ref_id      TEXT,
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS px_costs_time ON px_costs (created_at DESC);
CREATE INDEX IF NOT EXISTS px_costs_cat ON px_costs (category, created_at DESC);

CREATE TABLE IF NOT EXISTS px_attribution (
  id                      BIGSERIAL PRIMARY KEY,
  tracking_token          TEXT,
  contact_id              BIGINT REFERENCES px_contacts(id) ON DELETE SET NULL,
  enrollment_id           BIGINT REFERENCES px_enrollments(id) ON DELETE SET NULL,
  event                   TEXT NOT NULL CHECK (event IN ('click','checkout_started','subscribed','canceled')),
  touch                   TEXT CHECK (touch IN ('first','last','only')),
  email                   TEXT,
  clerk_user_id           TEXT,
  stripe_customer_id      TEXT,
  stripe_subscription_id  TEXT,
  amount_cents            INTEGER,
  confidence              TEXT NOT NULL DEFAULT 'tracked' CHECK (confidence IN ('tracked','email_match','manual')),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS px_attr_contact ON px_attribution (contact_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS px_attr_sub_once ON px_attribution (stripe_subscription_id, event) WHERE stripe_subscription_id IS NOT NULL;
