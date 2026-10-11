-- Bound self-service device scans to the signed-in user and pagination order.
CREATE INDEX device_user_enrolment ON devices (user_id,enrolled_at DESC,id DESC);
