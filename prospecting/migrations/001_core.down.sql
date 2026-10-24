-- 001_core.down.sql - removes the whole prospecting schema. Billing (autopost_*)
-- and Teams/alerts (ap_*) tables are untouched. Run only via the operator route.
DROP TABLE IF EXISTS
  px_attribution, px_costs, px_job_runs, px_jobs, px_notifications,
  px_provider_events, px_inbound_messages, px_threads, px_outbound_messages,
  px_enrollments, px_campaign_steps, px_campaigns, px_tasks, px_events,
  px_suppression, px_contact_verifications, px_contact_sources, px_contacts,
  px_dealership_sources, px_dealerships, px_audit, px_agent_status, px_admins,
  px_settings
CASCADE;
