-- Removes the Team Quests feature.
-- Drops the TeamQuest table (including its FK back to Branch).
-- Deletes the TEAM_QUESTS FeatureRegistry row; HospitalFeatureFlag rows
-- referencing it are removed automatically via onDelete: Cascade.

DROP TABLE IF EXISTS "TeamQuest" CASCADE;

DELETE FROM "FeatureRegistry" WHERE "key" = 'TEAM_QUESTS';
