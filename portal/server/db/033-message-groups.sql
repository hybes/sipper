ALTER TABLE conversations ADD COLUMN revision bigint NOT NULL DEFAULT 1 CHECK (revision>0);
ALTER TABLE conversations ADD COLUMN owner_id text REFERENCES auth_user(id) ON DELETE SET NULL;
UPDATE conversations c SET owner_id=CASE WHEN EXISTS(SELECT 1 FROM conversation_members m WHERE m.conversation_id=c.id AND m.user_id=c.created_by)
  THEN created_by ELSE (SELECT user_id FROM conversation_members WHERE conversation_id=c.id ORDER BY user_id LIMIT 1) END WHERE kind='group';
ALTER TABLE conversation_members ADD COLUMN joined_sequence bigint NOT NULL DEFAULT 0 CHECK (joined_sequence>=0);

-- Customer membership removal also removes participation. Keep ownership and
-- the edit revision current without granting workspace staff content access.
CREATE FUNCTION conversation_member_removed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE conversations SET revision=revision+1,updated_at=clock_timestamp(),
    owner_id=CASE WHEN kind='group' AND (owner_id IS NULL OR owner_id=OLD.user_id)
      THEN (SELECT user_id FROM conversation_members WHERE conversation_id=OLD.conversation_id ORDER BY joined_sequence,user_id LIMIT 1)
      ELSE owner_id END
    WHERE id=OLD.conversation_id;
  RETURN OLD;
END;
$$;
CREATE TRIGGER conversation_member_removed AFTER DELETE ON conversation_members
FOR EACH ROW EXECUTE FUNCTION conversation_member_removed();
