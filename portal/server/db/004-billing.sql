ALTER TABLE subscriptions ADD COLUMN checkout_id text;
ALTER TABLE subscriptions ADD COLUMN over_capacity boolean NOT NULL DEFAULT false;
ALTER TABLE subscriptions ADD COLUMN cancellation_scheduled boolean NOT NULL DEFAULT false;
