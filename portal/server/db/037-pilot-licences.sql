ALTER TABLE subscriptions DROP CONSTRAINT subscriptions_provider_check;
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_provider_check
  CHECK (provider IN ('stripe', 'test', 'pilot'));
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_pilot_bounds CHECK (
  provider <> 'pilot' OR (
    paid_until IS NOT NULL AND grace_until IS NULL
    AND customer_id IS NULL AND subscription_id IS NULL AND checkout_id IS NULL
    AND purchased_seats BETWEEN 1 AND 1000
  )
);
